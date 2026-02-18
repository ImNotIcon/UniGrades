const express = require('express');
require('dotenv').config();
const puppeteer = require('puppeteer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { MongoClient } = require('mongodb');

const { scrapeGrades } = require('./scraper');
const { solveCaptcha } = require('./captcha_solver');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

/**
 * Custom Logger with Context (IP & Session)
 */
class Logger {
    static getContext(req, token) {
        const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').replace('::ffff:', '') : 'system';
        const session = token ? token.substring(0, 8) : 'server';
        const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
        return `[${timestamp}] [${ip}] [${session}]`;
    }

    static info(message, req, token) {
        console.log(`${this.getContext(req, token)} ${message}`);
    }

    static warn(message, req, token) {
        console.warn(`${this.getContext(req, token)} WRN: ${message}`);
    }

    static error(message, req, token) {
        console.error(`${this.getContext(req, token)} ERR: ${message}`);
    }
}

// Global logger available to other modules if needed (not strictly necessary if we pass context)
global.Logger = Logger;

// Request Logging Middleware
app.use((req, res, next) => {
    const start = Date.now();
    const token = req.body?.token || req.query?.token;

    res.on('finish', () => {
        const duration = Date.now() - start;
        // Only log completion for now to keep it clean, or we can log start too
        Logger.info(`${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`, req, token);
    });
    next();
});

const PORT = Number(process.env.PORT || 3001);
const DB_NAME = 'unigrades';
const SUBSCRIPTIONS_COLLECTION = 'subscriptions';
const STATISTICS_COLLECTION = 'statistics';

const DEFAULT_INTERVAL_MINUTES = 30;
const ALLOWED_INTERVALS = new Set([10, 30, 60, 360, 720, 1440]);
const MAX_SUBSCRIPTIONS_PER_USER = 2;
const INACTIVE_DEVICE_MS = 14 * 24 * 60 * 60 * 1000;
const BACKGROUND_CHECK_TICK_MS = 60 * 1000;

const SESSIONS = new Map();
let backgroundWorkerBusy = false;

const mongoState = {
    client: null,
    db: null,
    enabled: false
};

const ACADEMIC_IVIEW_URL = 'https://progress.upatras.gr/irj/servlet/prt/portal/prtroot/com.sap.portal.pagebuilder.IviewModeProxy?iview_id=pcd%3Aportal_content%2Fcom.ups.UPS%2Fcom.ups.UPS_ROLES%2Fcom.ups.UPS%29STUDENT_ROLE%2Fcom.ups.ups_student_ws%2FPIQ_ST_ACAD_WORK_OV&iview_mode=default&sapDocumentRenderingMode=EmulateIE8';
const CAPTCHA_IMG_SELECTORS = 'img[src*="zups_piq_st_acad_work_ov"], img[id*="captcha"], img[src*="captcha"]';

const BROWSER_LAUNCH_OPTIONS = {
    args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security',
        '--window-size=1920,1080', '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
    ],
    protocolTimeout: 240000
};

if (process.env.BROWSER_PATH) {
    BROWSER_LAUNCH_OPTIONS.executablePath = process.env.BROWSER_PATH;
}

const hasVapidConfig = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (hasVapidConfig) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    Logger.info('Web Push configured with VAPID keys.');
}

class PublicHttpError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, { maxLength = 512, trim = true } = {}) {
    if (typeof value !== 'string') return '';
    const normalized = trim ? value.trim() : value;
    if (!normalized) return '';
    return normalized.slice(0, maxLength);
}

function isValidIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._@:-]{1,128}$/.test(value);
}

function isValidBase64(value) {
    if (typeof value !== 'string' || value.length < 2 || value.length > 4096) return false;
    const clean = value.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(clean)) return false;
    try {
        Buffer.from(clean, 'base64').toString('utf8');
        return true;
    } catch {
        return false;
    }
}

function parseBoolean(value, defaultValue = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
    }
    return defaultValue;
}

function parseNonNegativeInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
}

function normalizeInterval(value) {
    const parsed = parseNonNegativeInt(value, DEFAULT_INTERVAL_MINUTES);
    if (!ALLOWED_INTERVALS.has(parsed)) return DEFAULT_INTERVAL_MINUTES;
    return parsed;
}

function normalizeDeviceModel(input) {
    const model = safeString(input, { maxLength: 160 });
    return model || 'Unknown device';
}

function isIncorrectCaptchaError(error) {
    const message = safeString(error && error.message ? error.message : '', { maxLength: 400 }).toLowerCase();
    return message.includes('incorrect captcha');
}

function isExpiredPushSubscriptionError(error) {
    const statusCode = error && typeof error.statusCode === 'number' ? error.statusCode : 0;
    return statusCode === 404 || statusCode === 410;
}

function buildGradeIdentity(grade) {
    const code = safeString(grade.code, { maxLength: 64 });
    const year = safeString(grade.year, { maxLength: 32 });
    const semester = safeString(grade.semester, { maxLength: 32 });
    const session = safeString(grade.session || grade.acadSession, { maxLength: 64 });
    return `${code}::${year}::${semester}::${session}`;
}

function normalizeTrackedGrade(grade) {
    return {
        code: safeString(grade.code, { maxLength: 64 }),
        year: safeString(grade.year, { maxLength: 32 }),
        semester: safeString(grade.semester, { maxLength: 32 }),
        session: safeString(grade.session || grade.acadSession, { maxLength: 64 }),
        grade: safeString(grade.grade, { maxLength: 32 }),
        title: safeString(grade.title, { maxLength: 220 })
    };
}

function normalizeTrackedGrades(grades) {
    if (!Array.isArray(grades)) return [];
    return grades
        .map(normalizeTrackedGrade)
        .filter(g => g.code && g.year && g.semester);
}

function hasGradeValue(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function sanitizeCookies(cookies) {
    if (!Array.isArray(cookies)) return [];

    const sanitized = [];
    for (const cookie of cookies) {
        if (!isPlainObject(cookie)) continue;
        const name = safeString(cookie.name, { maxLength: 128, trim: false });
        const value = safeString(cookie.value, { maxLength: 2048, trim: false });
        if (!name || !value) continue;

        let domain = safeString(cookie.domain, { maxLength: 255, trim: false });
        if (!domain || domain.includes('localhost')) domain = 'progress.upatras.gr';
        domain = domain.replace(/https?:\/\//, '').split(':')[0];

        sanitized.push({
            name,
            value,
            domain,
            path: safeString(cookie.path, { maxLength: 255, trim: false }) || '/',
            secure: typeof cookie.secure === 'boolean' ? cookie.secure : true,
            httpOnly: typeof cookie.httpOnly === 'boolean' ? cookie.httpOnly : false,
            sameSite: safeString(cookie.sameSite, { maxLength: 16, trim: false }) || 'Lax'
        });
    }

    return sanitized;
}

function validatePushSubscription(subscription) {
    if (!isPlainObject(subscription)) return false;
    const endpoint = safeString(subscription.endpoint, { maxLength: 4096 });
    if (!endpoint) return false;

    if (!isPlainObject(subscription.keys)) return false;
    const p256dh = safeString(subscription.keys.p256dh, { maxLength: 1024, trim: false });
    const auth = safeString(subscription.keys.auth, { maxLength: 1024, trim: false });

    return !!(p256dh && auth);
}

function getMongoCollections() {
    if (!mongoState.enabled || !mongoState.db) return null;
    return {
        subscriptions: mongoState.db.collection(SUBSCRIPTIONS_COLLECTION),
        statistics: mongoState.db.collection(STATISTICS_COLLECTION)
    };
}

function isMongoEnabled() {
    return !!mongoState.enabled;
}

async function initMongo() {
    const uri = safeString(process.env.MONGODB_URI, { maxLength: 2048, trim: true });
    if (!uri) {
        Logger.info('MongoDB URI not configured. Notifications/statistics features are disabled.');
        return;
    }

    try {
        const client = new MongoClient(uri, {
            maxPoolSize: 10,
            minPoolSize: 0,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 20000
        });
        await client.connect();
        mongoState.client = client;
        mongoState.db = client.db(DB_NAME);
        mongoState.enabled = true;
        Logger.info(`MongoDB connected (${DB_NAME}).`);
    } catch (error) {
        mongoState.client = null;
        mongoState.db = null;
        mongoState.enabled = false;
        Logger.error(`MongoDB connection failed: ${error.message}`);
    }
}

function defaultStatsDocument(username) {
    return {
        _id: username,
        gradeRefreshCount: 0,
        gradeRefreshCountCaptcha: 0,
        failedRefreshCount: 0,
        failedRefreshCountCaptcha: 0,
        incorrectCaptchaCount: 0,
        captchaRefreshCount: 0,
        incorrectCaptchaCountAuto: 0,
        failedLoginCount: 0,
        devices: []
    };
}

async function ensureStatisticsDocument(username) {
    if (!isMongoEnabled() || !isValidIdentifier(username)) return;
    const cols = getMongoCollections();
    if (!cols) return;

    await cols.statistics.updateOne(
        { _id: username },
        {
            $setOnInsert: defaultStatsDocument(username),
            $set: { updatedAt: new Date() }
        },
        { upsert: true }
    );
}

async function touchStatisticsDevice(username, deviceId, deviceModel, {
    appOpenOnlineDelta = 0,
    appOpenOfflineDelta = 0,
    touchLastSeen = true
} = {}) {
    if (!isMongoEnabled()) return;
    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) return;

    const cols = getMongoCollections();
    if (!cols) return;

    await ensureStatisticsDocument(username);

    const doc = await cols.statistics.findOne(
        { _id: username },
        { projection: { devices: 1 } }
    );

    const now = new Date();
    const devices = Array.isArray(doc && doc.devices) ? [...doc.devices] : [];
    const index = devices.findIndex(d => d && d.deviceId === deviceId);

    if (index === -1) {
        devices.push({
            deviceId,
            model: normalizeDeviceModel(deviceModel),
            lastSeen: now,
            appOpenCountOnline: Math.max(0, appOpenOnlineDelta),
            appOpenCountOffline: Math.max(0, appOpenOfflineDelta)
        });
    } else {
        const existing = devices[index] || {};
        devices[index] = {
            ...existing,
            deviceId,
            model: normalizeDeviceModel(deviceModel) || normalizeDeviceModel(existing.model),
            lastSeen: touchLastSeen ? now : (existing.lastSeen || now),
            appOpenCountOnline: (Number(existing.appOpenCountOnline) || 0) + Math.max(0, appOpenOnlineDelta),
            appOpenCountOffline: (Number(existing.appOpenCountOffline) || 0) + Math.max(0, appOpenOfflineDelta)
        };
    }

    await cols.statistics.updateOne(
        { _id: username },
        {
            $set: {
                devices,
                updatedAt: now
            }
        }
    );
}

function sanitizeStatsIncrements(increments) {
    const allowed = [
        'gradeRefreshCount',
        'gradeRefreshCountCaptcha',
        'failedRefreshCount',
        'failedRefreshCountCaptcha',
        'incorrectCaptchaCount',
        'captchaRefreshCount',
        'incorrectCaptchaCountAuto',
        'failedLoginCount'
    ];

    const output = {};
    if (!isPlainObject(increments)) return output;

    for (const key of allowed) {
        const value = parseNonNegativeInt(increments[key], 0);
        if (value > 0) output[key] = value;
    }

    return output;
}

async function incrementStatistics(username, increments = {}, {
    deviceId = '',
    deviceModel = '',
    appOpenOnlineDelta = 0,
    appOpenOfflineDelta = 0,
    touchLastSeen = false
} = {}) {
    if (!isMongoEnabled() || !isValidIdentifier(username)) return;
    const cols = getMongoCollections();
    if (!cols) return;

    await ensureStatisticsDocument(username);

    const cleanIncrements = sanitizeStatsIncrements(increments);
    if (Object.keys(cleanIncrements).length > 0) {
        await cols.statistics.updateOne(
            { _id: username },
            {
                $inc: cleanIncrements,
                $set: { updatedAt: new Date() }
            }
        );
    }

    if (isValidIdentifier(deviceId)) {
        await touchStatisticsDevice(username, deviceId, deviceModel, {
            appOpenOnlineDelta,
            appOpenOfflineDelta,
            touchLastSeen
        });
    }
}

async function syncStoredPasswordIfSubscriptionExists(username, passwordBase64) {
    if (!isMongoEnabled()) return;
    if (!isValidIdentifier(username) || !isValidBase64(passwordBase64)) return;

    const cols = getMongoCollections();
    if (!cols) return;

    await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                passwordBase64,
                updatedAt: new Date()
            }
        }
    );
}

async function removeDeviceSubscription(username, deviceId) {
    if (!isMongoEnabled()) {
        return { removed: false, deletedUserDoc: false, remaining: null };
    }

    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return { removed: false, deletedUserDoc: false, remaining: null };
    }

    const cols = getMongoCollections();
    if (!cols) {
        return { removed: false, deletedUserDoc: false, remaining: null };
    }

    const doc = await cols.subscriptions.findOne({ _id: username });
    if (!doc || !Array.isArray(doc.subscriptions)) {
        return { removed: false, deletedUserDoc: false, remaining: 0 };
    }

    const filtered = doc.subscriptions.filter(entry => entry && entry.deviceId !== deviceId);
    if (filtered.length === doc.subscriptions.length) {
        return { removed: false, deletedUserDoc: false, remaining: filtered.length };
    }

    if (filtered.length === 0) {
        await cols.subscriptions.deleteOne({ _id: username });
        return { removed: true, deletedUserDoc: true, remaining: 0 };
    }

    await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                subscriptions: filtered,
                updatedAt: new Date()
            }
        }
    );

    return { removed: true, deletedUserDoc: false, remaining: filtered.length };
}

async function removeAllSubscriptions(username) {
    if (!isMongoEnabled()) return { removed: false };
    if (!isValidIdentifier(username)) return { removed: false };

    const cols = getMongoCollections();
    if (!cols) return { removed: false };

    const result = await cols.subscriptions.deleteOne({ _id: username });
    return { removed: result.deletedCount > 0 };
}

async function sendPushSafely(subscription, payload) {
    if (!hasVapidConfig) {
        throw new PublicHttpError('Push is not configured on the server.', 503, 'PUSH_NOT_CONFIGURED');
    }
    await webpush.sendNotification(subscription, JSON.stringify(payload));
}

async function debugScreenshot(page, name) {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
        const screenshotsDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.join(screenshotsDir, `${timestamp}_${name}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        Logger.info(`Debug screenshot saved: ${filename}`);
    } catch (error) {
        Logger.error(`Failed to create debug screenshot: ${error.message}`);
    }
}

function createSession(browser, page, {
    username = '',
    deviceId = '',
    deviceModel = '',
    autoSolveEnabled = true
} = {}) {
    const token = Math.random().toString(36).substring(2, 12);
    SESSIONS.set(token, {
        browser,
        page,
        status: 'loading',
        username,
        deviceId,
        deviceModel,
        autoSolveEnabled,
        manualCaptchaCounted: false,
        lastActive: Date.now()
    });
    return token;
}

async function closeSession(token) {
    const session = SESSIONS.get(token);
    if (!session) return;

    try {
        if (session.browser) {
            await session.browser.close().catch(() => { });
        }
    } finally {
        SESSIONS.delete(token);
    }
}

function getActiveFrame(page, frame) {
    if (frame && !frame.isDetached()) return frame;
    return page.frames().find(f =>
        f.url().includes('zups_piq_st_acad_work_ov') || f.url().includes('sap/bc/webdynpro')
    ) || null;
}

async function waitForImageLoad(frame, imgElement) {
    await frame.waitForFunction(
        el => el.complete && el.naturalWidth > 0,
        { timeout: 5000 },
        imgElement
    ).catch(() => {
        Logger.warn('Image load wait timed out, continuing anyway.');
    });
}

async function findCaptchaImage(frame) {
    let element = null;

    try {
        await frame.waitForSelector(CAPTCHA_IMG_SELECTORS, { timeout: 10000 });
        element = await frame.$(CAPTCHA_IMG_SELECTORS);
    } catch {
        Logger.warn('Primary captcha selector timed out. Trying fallback image selector.');
    }

    if (!element) element = await frame.$('img');
    if (!element) throw new Error('Captcha element not found');

    await waitForImageLoad(frame, element);
    return element;
}

async function isBodyEmpty(page) {
    return page.evaluate(() => {
        const body = document.querySelector('body');
        if (!body) return true;
        return body.children.length === 0 || body.innerHTML.trim() === '';
    });
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: process.env.HEADLESS !== 'false',
        ...BROWSER_LAUNCH_OPTIONS
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    return { browser, page };
}

async function navigateToIview(page, token) {
    Logger.info('Navigating to Academic Work iView...', null, token);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await page.goto(ACADEMIC_IVIEW_URL, {
                waitUntil: 'networkidle2',
                timeout: 45000
            });
            if (response && response.status() !== 404) return;
        } catch (error) {
            Logger.warn(`iView navigation attempt ${attempt + 1} failed: ${error.message}`, null, token);
        }
    }

    await page.goto('https://progress.upatras.gr/irj/portal', {
        waitUntil: 'networkidle2',
        timeout: 45000
    });
}

async function findGradesFrame(page, checkForContent = true, timeoutMs = 15000) {
    const startTime = Date.now();
    try {
        const frame = await page.waitForFrame(
            f => f.url().includes('zups_piq_st_acad_work_ov') || f.url().includes('sap/bc/webdynpro'),
            { timeout: timeoutMs }
        );

        if (!checkForContent) return frame;

        const remaining = Math.max(timeoutMs - (Date.now() - startTime), 5000);
        await frame.waitForSelector('.urST, .urLinStd, table, tr', { timeout: remaining });
        return frame;
    } catch (error) {
        Logger.warn(`findGradesFrame timed out: ${error.message}`, null, token);
        return null;
    }
}

async function refreshCaptcha(page, captchaFrame, token) {
    Logger.info('Refreshing captcha...', null, token);
    try {
        const activeFrame = getActiveFrame(page, captchaFrame);
        if (!activeFrame) throw new Error('Refresh failed: frame lost');

        const refreshButton = await activeFrame.$('div[title="Ανανέωση"]') || await activeFrame.$('img[src*="TbRefresh.gif"]');
        if (!refreshButton) {
            Logger.warn('Captcha refresh button not found.', null, token);
            return null;
        }

        const oldCaptchaEl = await activeFrame.$(CAPTCHA_IMG_SELECTORS);
        const oldSrc = oldCaptchaEl ? await (await oldCaptchaEl.getProperty('src')).jsonValue() : '';

        await refreshButton.click();

        try {
            await activeFrame.waitForFunction(
                (prevSrc, selectors) => {
                    const img = document.querySelector(selectors);
                    return img && img.src !== prevSrc;
                },
                { timeout: 10000 },
                oldSrc,
                CAPTCHA_IMG_SELECTORS
            );
        } catch {
            Logger.warn('Captcha source change wait timed out. Continuing.', null, token);
        }

        const newCaptchaEl = await activeFrame.$(CAPTCHA_IMG_SELECTORS) || await activeFrame.$('img');
        if (!newCaptchaEl) throw new Error('New captcha element not found');

        await waitForImageLoad(activeFrame, newCaptchaEl);
        return await newCaptchaEl.screenshot();
    } catch (error) {
        Logger.error(`Error refreshing captcha: ${error.message}`, null, token);
        return null;
    }
}

async function submitCaptchaAndVerify(page, captchaFrame, answer) {
    const activeFrame = getActiveFrame(page, captchaFrame);
    if (!activeFrame) throw new Error('Captcha frame lost');

    const inputField = await activeFrame.$('input[type="text"]')
        || await activeFrame.$('input.lsField__input')
        || await activeFrame.$('input.urEdf2TxtL');

    let submitButton = await activeFrame.$('div.lsButton[ct="B"]');
    if (!submitButton) {
        const candidates = await activeFrame.$$('div.lsButton, [ct="B"], a, span, div, button');
        for (const button of candidates) {
            const text = await (await button.getProperty('innerText')).jsonValue();
            const cleanText = (text || '').trim();
            if (['ΕΠΟΜΕΝΟ', 'NEXT', 'Next', 'ΝΕΧΤ'].some(word => cleanText.includes(word))) {
                submitButton = button;
                break;
            }
        }
    }

    if (!inputField || !submitButton) {
        throw new Error('Could not find captcha input or submit button');
    }

    try {
        await inputField.focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
    } catch (error) {
        Logger.warn(`Failed clearing captcha field with shortcut: ${error.message}`, null, token);
    }

    await inputField.type(answer);

    try {
        await submitButton.click();
    } catch {
        await activeFrame.evaluate(() => {
            const button = document.querySelector('input[type="submit"], button, .urBtnStd, img[src*="BTN_OK"]');
            if (button && button.click) button.click();
        });
    }

    const submitStart = Date.now();
    while (Date.now() - submitStart < 25000) {
        for (const frame of page.frames()) {
            try {
                if (frame.isDetached()) continue;

                const status = await frame.evaluate(() => {
                    const text = document.documentElement.innerText || '';
                    const html = document.documentElement.innerHTML || '';

                    // SAP Specific Success Indicators
                    const okIcon = document.querySelector('img[src*="SuccessMessage"], img[src*="WD_M_OK"], .lsMessageArea--success, img[src*="sapIcon_success"]');
                    const hasOkText = text.includes('OK!') || text.includes('ΟΚ!') || text.includes('Επιτυχία') || text.includes('Success');

                    // Fallback for cases where images/text are in attributes (SAP common pattern)
                    const hasOkAttribute = html.includes('SuccessMessage.gif') || html.includes('WD_M_OK.gif');

                    if (okIcon || hasOkText || hasOkAttribute) return 'SUCCESS';

                    const errIcon = document.querySelector('img[src*="ErrorMessage"], img[src*="WD_M_ERROR"], img[src*="sapIcon_error"]');
                    const hasErrText = text.includes('ERROR!') || text.includes('Λάθος') || text.includes('Σφάλμα') || text.includes('Error');

                    if (errIcon || hasErrText) return 'ERROR';
                    if (document.querySelector('table[id*="GRADES"]')) return 'SUCCESS';
                    return null;
                });

                if (status === 'SUCCESS') {
                    Logger.info('Verification Success!', null, token);
                    return true;
                }
                if (status === 'ERROR') {
                    Logger.warn('Verification Error flagged by portal.', null, token);
                    throw new Error('Incorrect captcha code. Please try again.');
                }
            } catch (error) {
                if (isIncorrectCaptchaError(error)) throw error;
            }
        }

        await page.waitForNetworkIdle({ idleTime: 300, timeout: 2000 }).catch(() => { });
    }

    const finalCheck = await page.evaluate(() => !!document.querySelector('table[id*="GRADES"]'));
    if (finalCheck) return true;

    throw new Error('Verification timed out (no success indicator found)');
}

async function authenticatePortalLogin(page, username, password, token) {
    Logger.info('Navigating to login page...', null, token);
    await page.goto('https://progress.upatras.gr', { waitUntil: 'networkidle2' });

    let usernameSelector = '#inputEmail';
    const passwordSelector = '#inputPassword';

    try {
        await page.waitForSelector(usernameSelector, { timeout: 3000 });
    } catch {
        if (!page.url().includes('idp.upnet.gr')) {
            const loginButton = await page.$('a[href*="login"], a[href*="Login"], div[title="Είσοδος"]');
            if (loginButton) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { }),
                    loginButton.click()
                ]);
            }
        }

        const altSelector = '#username, input[name="j_username"], input[name="username"]';
        const found = await page.waitForSelector(`${usernameSelector}, ${altSelector}`, { timeout: 5000 }).catch(() => null);
        if (found) {
            usernameSelector = await page.evaluate(el => {
                if (el.id) return `#${el.id}`;
                if (el.name) return `input[name="${el.name}"]`;
                return 'input[type="text"]';
            }, found);
        }
    }

    Logger.info('Entering credentials...', null, token);
    await page.type(usernameSelector, username);
    await page.type(passwordSelector, password);

    await page.waitForSelector('#loginButton', { visible: true });

    Logger.info('Submitting login form...', null, token);
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
                Logger.warn('Login navigation timed out, checking state...', null, token);
            }),
            page.click('#loginButton')
        ]);
    } catch (error) {
        if (!error.message.includes('context was destroyed')) {
            throw error;
        }
        Logger.info('Handled context destruction during navigation.', null, token);
    }

    // Verify if we are still on the login page by checking for the error element
    // wrapped in a try/catch to handle destroyed context if navigation is still finishing
    let errorText = null;
    try {
        const errorElement = await page.$('.form-element.form-error');
        if (errorElement) {
            errorText = await page.evaluate(el => el.textContent.trim(), errorElement);
        }
    } catch (e) {
        // If context destroyed here, we most likely moved to the next page successfully
        Logger.info('Could not check error element (context transient), proceeding...', null, token);
    }

    if (errorText) {
        if (errorText.includes('Άγνωστο')) {
            throw new PublicHttpError('Unknown username', 401, 'UNKNOWN_USERNAME');
        }
        if (errorText.includes('Λανθασμένος')) {
            throw new PublicHttpError('Wrong password', 401, 'WRONG_PASSWORD');
        }
        throw new PublicHttpError(errorText || 'Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Wait for the cookie as a confirmation of success
    try {
        await page.waitForFunction(
            () => document.cookie.includes('MYSAPSSO2') || document.cookie.includes('saplb'),
            { timeout: 15000 }
        );
    } catch (e) {
        Logger.warn('Post-login cookie wait failed, attempting to read available cookies anyway.', null, token);
    }

    return page.cookies();
}

async function executeAsyncScrape(token, browser, page) {
    const session = SESSIONS.get(token);
    if (!session) return;

    session.status = 'loading';
    try {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
            result = await scrapeGrades(page, token);
            if (result && Array.isArray(result.grades) && result.grades.length > 0) break;
            await page.waitForFunction(() => document.querySelector('table, .urST, iframe'), { timeout: 8000 }).catch(() => { });
        }

        if (!result || !Array.isArray(result.grades)) {
            result = await scrapeGrades(page, token);
        }

        const latestSession = SESSIONS.get(token);
        if (!latestSession) return;

        const newCookies = await page.cookies();
        await browser.close();

        latestSession.status = 'completed';
        Logger.info('Async scraping completed successfully.', null, token);
        latestSession.result = {
            grades: result.grades || [],
            studentInfo: result.studentInfo || {},
            headers: result.headers || [],
            cookies: newCookies
        };
    } catch (error) {
        Logger.error(`Background scrape for session failed: ${error.message}`, null, token);

        const latestSession = SESSIONS.get(token);
        if (latestSession) {
            if (latestSession.browser) {
                await latestSession.browser.close().catch(() => { });
            }
            latestSession.status = 'error';
            latestSession.error = error.message;

            await incrementStatistics(latestSession.username, { failedRefreshCount: 1 }, {
                deviceId: latestSession.deviceId,
                deviceModel: latestSession.deviceModel,
                touchLastSeen: true
            });
        }
    }
}

async function startGradePortalFlow(token, browser, page, {
    skipNavigation = false,
    autoSolveEnabled = true
} = {}) {
    const session = SESSIONS.get(token);
    if (!session) return;

    try {
        if (!skipNavigation) {
            await navigateToIview(page, token);
        }

        const captchaFrame = await findGradesFrame(page, false, 12000);
        if (!captchaFrame) throw new Error('Captcha/Grades frame not found.');

        session.captchaFrame = captchaFrame;

        Logger.info('Capturing captcha element...', null, token);
        const captchaEl = await findCaptchaImage(captchaFrame);
        let currentCaptchaBuffer = await captchaEl.screenshot({ timeout: 60000 });
        let currentFrame = captchaFrame;

        const autoSolveGloballyEnabled = process.env.DISABLE_AUTO_CAPTCHA !== 'true';
        const canAutoSolve = autoSolveGloballyEnabled && parseBoolean(autoSolveEnabled, true);

        if (canAutoSolve) {
            let allowSecondAttempt = false;

            const firstAutoText = await solveCaptcha(currentCaptchaBuffer, token);
            if (firstAutoText) {
                Logger.info(`Auto-solving attempt 1/2: ${firstAutoText}`, null, token);
                try {
                    Logger.info('Waiting for captcha verification result...', null, token);
                    await submitCaptchaAndVerify(page, currentFrame, firstAutoText, token);
                    return executeAsyncScrape(token, browser, page);
                } catch (error) {
                    if (isIncorrectCaptchaError(error)) {
                        allowSecondAttempt = true;
                        await incrementStatistics(session.username, { incorrectCaptchaCountAuto: 1 }, {
                            deviceId: session.deviceId,
                            deviceModel: session.deviceModel,
                            touchLastSeen: true
                        });
                    } else {
                        Logger.warn(`Auto-solve attempt 1 failed with technical error: ${error.message}`, null, token);
                    }
                }
            } else {
                Logger.warn('Auto-solve attempt 1 returned <null>; skipping second attempt.', null, token);
            }

            if (allowSecondAttempt) {
                const refreshedBuffer = await refreshCaptcha(page, currentFrame, token);
                if (refreshedBuffer) {
                    currentCaptchaBuffer = refreshedBuffer;
                    currentFrame = getActiveFrame(page, currentFrame) || currentFrame;
                }

                const secondAutoText = await solveCaptcha(currentCaptchaBuffer, token);
                if (secondAutoText) {
                    Logger.info(`Auto-solving attempt 2/2: ${secondAutoText}`, null, token);
                    try {
                        Logger.info('Waiting for captcha verification result...', null, token);
                        await submitCaptchaAndVerify(page, currentFrame, secondAutoText, token);
                        return executeAsyncScrape(token, browser, page);
                    } catch (error) {
                        if (isIncorrectCaptchaError(error)) {
                            await incrementStatistics(session.username, { incorrectCaptchaCountAuto: 1 }, {
                                deviceId: session.deviceId,
                                deviceModel: session.deviceModel,
                                touchLastSeen: true
                            });
                        }
                        Logger.warn(`Auto-solve attempt 2 failed: ${error.message}`, null, token);
                    }
                }

                const manualRefresh = await refreshCaptcha(page, currentFrame, token);
                if (manualRefresh) {
                    currentCaptchaBuffer = manualRefresh;
                }
            }
        }

        session.status = 'manual_captcha';
        session.captchaImage = `data:image/png;base64,${currentCaptchaBuffer.toString('base64')}`;
        session.message = canAutoSolve
            ? 'Automatic captcha solving failed. Please solve it manually.'
            : 'Captcha auto-solve is disabled. Please solve it manually.';

        if (!session.manualCaptchaCounted) {
            session.manualCaptchaCounted = true;
            await incrementStatistics(session.username, { gradeRefreshCountCaptcha: 1 }, {
                deviceId: session.deviceId,
                deviceModel: session.deviceModel,
                touchLastSeen: true
            });
        }
    } catch (error) {
        Logger.error(`Portal flow error: ${error.message}`, null, token);

        if (session.browser) {
            await session.browser.close().catch(() => { });
        }

        session.status = 'error';
        session.error = error.message;

        await incrementStatistics(session.username, { failedRefreshCount: 1 }, {
            deviceId: session.deviceId,
            deviceModel: session.deviceModel,
            touchLastSeen: true
        });
    }
}

async function fetchGradesForNotifications(username, passwordPlain) {
    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await authenticatePortalLogin(page, username, passwordPlain, 'notifier');

        await page.goto(ACADEMIC_IVIEW_URL, {
            waitUntil: 'networkidle2',
            timeout: 45000
        });

        if (await isBodyEmpty(page)) {
            throw new Error('Session appears invalid after login.');
        }

        const captchaFrame = await findGradesFrame(page, false, 12000);
        if (!captchaFrame) throw new Error('Could not find grades frame.');

        const captchaEl = await findCaptchaImage(captchaFrame);
        let captchaBuffer = await captchaEl.screenshot({ timeout: 60000 });

        const firstAutoText = await solveCaptcha(captchaBuffer);
        if (!firstAutoText) {
            throw new Error('Auto captcha returned null on attempt 1');
        }

        try {
            await submitCaptchaAndVerify(page, captchaFrame, firstAutoText);
        } catch (error) {
            if (!isIncorrectCaptchaError(error)) throw error;

            await incrementStatistics(username, { incorrectCaptchaCountAuto: 1 });

            const refreshed = await refreshCaptcha(page, captchaFrame);
            if (refreshed) captchaBuffer = refreshed;

            const secondAutoText = await solveCaptcha(captchaBuffer);
            if (!secondAutoText) {
                throw new Error('Auto captcha returned null on attempt 2');
            }

            await submitCaptchaAndVerify(page, captchaFrame, secondAutoText).catch(async secondError => {
                if (isIncorrectCaptchaError(secondError)) {
                    await incrementStatistics(username, { incorrectCaptchaCountAuto: 1 });
                }
                throw secondError;
            });
        }

        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
            result = await scrapeGrades(page, 'notifier');
            if (result && Array.isArray(result.grades) && result.grades.length > 0) break;
            await page.waitForFunction(() => document.querySelector('table, .urST, iframe'), { timeout: 8000 }).catch(() => { });
        }

        if (!result || !Array.isArray(result.grades)) {
            result = await scrapeGrades(page, 'notifier');
        }

        await browser.close();

        return {
            grades: Array.isArray(result && result.grades) ? result.grades : [],
            studentInfo: result && result.studentInfo ? result.studentInfo : {}
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => { });
        }
    }
}

async function runBackgroundCheckForUser(userDoc) {
    if (!isMongoEnabled()) return;
    if (!userDoc || !isValidIdentifier(userDoc._id)) return;

    const username = userDoc._id;
    const cols = getMongoCollections();
    if (!cols) return;

    const now = new Date();
    const currentInterval = normalizeInterval(userDoc.checkIntervalMinutes);

    if (currentInterval !== userDoc.checkIntervalMinutes) {
        await cols.subscriptions.updateOne(
            { _id: username },
            {
                $set: {
                    checkIntervalMinutes: currentInterval,
                    updatedAt: now
                }
            }
        );
    }

    if (userDoc.lastCheckedAt) {
        const last = new Date(userDoc.lastCheckedAt).getTime();
        if (Number.isFinite(last)) {
            const elapsed = Date.now() - last;
            if (elapsed < currentInterval * 60 * 1000) {
                return;
            }
        }
    }

    const entries = Array.isArray(userDoc.subscriptions) ? [...userDoc.subscriptions] : [];
    if (entries.length === 0) {
        await cols.subscriptions.deleteOne({ _id: username });
        return;
    }

    const statsDoc = await cols.statistics.findOne(
        { _id: username },
        { projection: { devices: 1 } }
    );

    const deviceStatsMap = new Map();
    if (statsDoc && Array.isArray(statsDoc.devices)) {
        for (const device of statsDoc.devices) {
            if (device && isValidIdentifier(device.deviceId)) {
                deviceStatsMap.set(device.deviceId, device);
            }
        }
    }

    const activeEntries = [];
    for (const entry of entries) {
        if (!entry || !isValidIdentifier(entry.deviceId)) continue;

        const statDevice = deviceStatsMap.get(entry.deviceId);
        const lastSeen = statDevice && statDevice.lastSeen ? new Date(statDevice.lastSeen) : null;

        if (lastSeen && Number.isFinite(lastSeen.getTime()) && (Date.now() - lastSeen.getTime()) > INACTIVE_DEVICE_MS) {
            if (hasVapidConfig && entry.pushSubscription) {
                try {
                    await sendPushSafely(entry.pushSubscription, {
                        title: 'Notifications disabled',
                        body: 'This device was offline for over 14 days. Push notifications were disabled.',
                        icon: '/pwa-192x192.png',
                        badge: '/pwa-192x192.png',
                        tag: `inactive-device-${entry.deviceId}`,
                        data: { url: '/' }
                    });
                } catch (error) {
                    Logger.warn(`Failed sending inactive-device notification to ${username}/${entry.deviceId}: ${error.message}`, null, username);
                }
            }
            continue;
        }

        activeEntries.push(entry);
    }

    if (activeEntries.length === 0) {
        await cols.subscriptions.deleteOne({ _id: username });
        return;
    }

    if (!isValidBase64(userDoc.passwordBase64)) {
        Logger.warn(`Skipping background check for ${username}: invalid stored password base64.`);
        await cols.subscriptions.updateOne(
            { _id: username },
            {
                $set: {
                    subscriptions: activeEntries,
                    lastCheckedAt: now,
                    updatedAt: now
                }
            }
        );
        return;
    }

    const passwordPlain = Buffer.from(userDoc.passwordBase64, 'base64').toString('utf8');
    let fetched;
    try {
        fetched = await fetchGradesForNotifications(username, passwordPlain);
    } catch (error) {
        Logger.error(`Background grade check failed for ${userDoc._id}: ${error.message}`);
        return;
    }

    const currentTrackedGrades = normalizeTrackedGrades(fetched.grades);

    const updatedEntries = [];
    for (const entry of activeEntries) {
        const pushSubscription = entry.pushSubscription;
        const trackedPrevious = normalizeTrackedGrades(entry.lastSeenGrades || []);
        const previousByIdentity = new Map(trackedPrevious.map(g => [buildGradeIdentity(g), g]));

        const sentNotifications = Array.isArray(entry.sentNotifications) ? [...entry.sentNotifications] : [];
        const sentSet = new Set(
            sentNotifications
                .filter(item => item && typeof item.notificationKey === 'string')
                .map(item => item.notificationKey)
        );

        let pushStillValid = true;

        for (const grade of currentTrackedGrades) {
            if (!hasGradeValue(grade.grade)) continue;

            const identity = buildGradeIdentity(grade);
            const previous = previousByIdentity.get(identity);
            if (!previous) continue;
            if (previous.grade === grade.grade) continue;

            const notificationKey = `${identity}::${grade.grade}`;
            if (sentSet.has(notificationKey)) continue;

            if (hasVapidConfig && pushSubscription) {
                try {
                    await sendPushSafely(pushSubscription, {
                        title: 'New Grade Available',
                        body: `${grade.title || grade.code}: ${grade.grade}`,
                        icon: '/pwa-192x192.png',
                        badge: '/pwa-192x192.png',
                        tag: `grade-${grade.code}`,
                        data: { url: '/' }
                    });

                    sentSet.add(notificationKey);
                    sentNotifications.push({
                        notificationKey,
                        sentAt: new Date()
                    });
                } catch (error) {
                    Logger.error(`Push send failed for ${username}/${entry.deviceId}: ${error.message}`, null, username);
                    if (isExpiredPushSubscriptionError(error)) {
                        pushStillValid = false;
                        break;
                    }
                }
            }
        }

        if (!pushStillValid) continue;

        const trimmedSent = sentNotifications.slice(-500);

        updatedEntries.push({
            ...entry,
            lastSeenGrades: currentTrackedGrades,
            sentNotifications: trimmedSent,
            updatedAt: new Date()
        });
    }

    if (updatedEntries.length === 0) {
        await cols.subscriptions.deleteOne({ _id: username });
        return;
    }

    await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                subscriptions: updatedEntries,
                checkIntervalMinutes: currentInterval,
                lastCheckedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
}

async function runBackgroundChecks() {
    if (!isMongoEnabled() || backgroundWorkerBusy) return;

    backgroundWorkerBusy = true;
    try {
        const cols = getMongoCollections();
        if (!cols) return;

        const docs = await cols.subscriptions.find({}).toArray();
        if (docs.length === 0) return;

        Logger.info(`Background check tick: ${docs.length} subscribed user(s).`);

        for (const doc of docs) {
            try {
                await runBackgroundCheckForUser(doc);
            } catch (error) {
                Logger.error(`Background check user-level error: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    } catch (error) {
        Logger.error(`Background worker failed: ${error.message}`);
    } finally {
        backgroundWorkerBusy = false;
    }
}

setInterval(runBackgroundChecks, BACKGROUND_CHECK_TICK_MS);

app.get('/api/features', (req, res) => {
    const mongoEnabled = isMongoEnabled();
    res.json({
        mongoEnabled,
        pushEnabled: mongoEnabled && hasVapidConfig,
        vapidAvailable: hasVapidConfig
    });
});

app.get('/api/push/vapid-key', (req, res) => {
    if (!isMongoEnabled()) {
        return res.json({ publicKey: '' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/login', async (req, res) => {
    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const password = safeString(req.body && req.body.password, { maxLength: 512, trim: false });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });
    const deviceModel = normalizeDeviceModel(req.body && req.body.deviceModel);

    if (!isValidIdentifier(username) || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }

    Logger.info('Login request received', req);

    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await authenticatePortalLogin(page, username, password);

        const currentCookies = await page.cookies();
        await browser.close();

        if (isMongoEnabled()) {
            const passwordBase64 = Buffer.from(password, 'utf8').toString('base64');
            await syncStoredPasswordIfSubscriptionExists(username, passwordBase64);

            if (isValidIdentifier(deviceId)) {
                await incrementStatistics(username, {}, {
                    deviceId,
                    deviceModel,
                    touchLastSeen: true
                });
            }
        }

        Logger.info('Login successful. Returning cookies.', req);
        res.json({ success: true, cookies: currentCookies });
    } catch (error) {
        if (browser) {
            await browser.close().catch(() => { });
        }

        if (error instanceof PublicHttpError && error.statusCode === 401) {
            return res.status(401).json({ error: error.message });
        }

        await incrementStatistics(username, { failedLoginCount: 1 }, {
            deviceId,
            deviceModel,
            touchLastSeen: true
        });

        Logger.error(`Login error: ${error.message || error}`, req);
        return res.status(500).json({ error: error.message || 'Login failed' });
    }
});

app.post('/api/refresh-grades', async (req, res) => {
    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });
    const deviceModel = normalizeDeviceModel(req.body && req.body.deviceModel);
    const autoSolveEnabled = parseBoolean(req.body && req.body.autoSolveEnabled, true);

    if (isValidIdentifier(username)) {
        await incrementStatistics(username, { gradeRefreshCount: 1 }, {
            deviceId,
            deviceModel,
            touchLastSeen: true
        });
    }

    Logger.info('Grade refresh request received', req, username);

    const cookies = sanitizeCookies(req.body && req.body.cookies);
    if (!Array.isArray(cookies) || cookies.length === 0) {
        if (isValidIdentifier(username)) {
            await incrementStatistics(username, { failedRefreshCount: 1 }, {
                deviceId,
                deviceModel,
                touchLastSeen: true
            });
        }
        return res.status(400).json({ error: 'No session cookies provided. Please login first.' });
    }

    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await page.setCookie(...cookies);
        Logger.info('Navigating to iView with session cookies...', req, username);
        await page.goto(ACADEMIC_IVIEW_URL, {
            waitUntil: 'networkidle2',
            timeout: 45000
        });

        if (await isBodyEmpty(page)) {
            await browser.close();

            if (isValidIdentifier(username)) {
                await incrementStatistics(username, { failedRefreshCount: 1 }, {
                    deviceId,
                    deviceModel,
                    touchLastSeen: true
                });
            }

            return res.status(401).json({
                error: 'Session expired. Please login again.',
                expired: true
            });
        }

        Logger.info('Session valid! Starting grade portal flow...', req, username);

        const sessionToken = createSession(browser, page, {
            username,
            deviceId,
            deviceModel,
            autoSolveEnabled
        });

        res.json({
            success: true,
            token: sessionToken,
            status: 'loading',
            message: 'Fetching grades...'
        });

        startGradePortalFlow(sessionToken, browser, page, {
            skipNavigation: true,
            autoSolveEnabled
        });
    } catch (error) {
        if (browser) {
            await browser.close().catch(() => { });
        }

        if (isValidIdentifier(username)) {
            await incrementStatistics(username, { failedRefreshCount: 1 }, {
                deviceId,
                deviceModel,
                touchLastSeen: true
            });
        }

        Logger.error(`Refresh grades error: ${error.message || error}`, req, username);
        return res.status(500).json({ error: error.message || 'Failed to refresh grades' });
    }
});

app.post('/api/solve-captcha', async (req, res) => {
    const token = safeString(req.body && req.body.token, { maxLength: 64 });
    const answer = safeString(req.body && req.body.answer, { maxLength: 64, trim: false });

    const session = SESSIONS.get(token);
    if (!session) {
        return res.status(404).json({ error: 'Session expired' });
    }

    if (!answer) {
        return res.status(400).json({ error: 'Captcha answer is required.' });
    }

    try {
        const { browser, page, captchaFrame } = session;

        await submitCaptchaAndVerify(page, captchaFrame, answer);
        executeAsyncScrape(token, browser, page);

        const currentCookies = await page.cookies();
        return res.json({
            success: true,
            status: 'loading',
            message: 'Refreshing grades...',
            cookies: currentCookies
        });
    } catch (error) {
        Logger.error(`Captcha solve error: ${error.message || error}`, req, token);

        if (session && session.browser && !session.browser.isConnected()) {
            await closeSession(token);
            return res.status(500).json({ error: 'Browser session lost' });
        }

        if (isIncorrectCaptchaError(error)) {
            await incrementStatistics(session.username, { incorrectCaptchaCount: 1 }, {
                deviceId: session.deviceId,
                deviceModel: session.deviceModel,
                touchLastSeen: true
            });
        } else {
            await incrementStatistics(session.username, { failedRefreshCountCaptcha: 1 }, {
                deviceId: session.deviceId,
                deviceModel: session.deviceModel,
                touchLastSeen: true
            });
        }

        return res.status(400).json({ error: error.message || 'Captcha verification failed.' });
    }
});

app.get('/api/status', (req, res) => {
    const token = safeString(req.query && req.query.token, { maxLength: 64 });
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }

    const session = SESSIONS.get(token);
    if (!session) {
        return res.json({ status: 'expired' });
    }

    if (session.status === 'completed') {
        const result = session.result;
        SESSIONS.delete(token);
        return res.json({
            status: 'completed',
            grades: result.grades || [],
            studentInfo: result.studentInfo || {},
            headers: result.headers || [],
            cookies: result.cookies || []
        });
    }

    if (session.status === 'manual_captcha') {
        return res.json({
            status: 'manual_captcha',
            token,
            captchaImage: session.captchaImage,
            message: session.message
        });
    }

    if (session.status === 'error') {
        const error = session.error;
        SESSIONS.delete(token);
        return res.json({ status: 'error', error });
    }

    return res.json({ status: session.status || 'loading' });
});

app.post('/api/refresh-captcha', async (req, res) => {
    const token = safeString(req.body && req.body.token, { maxLength: 64 });
    const session = SESSIONS.get(token);
    if (!session) {
        return res.status(404).json({ error: 'Session expired' });
    }

    await incrementStatistics(session.username, { captchaRefreshCount: 1 }, {
        deviceId: session.deviceId,
        deviceModel: session.deviceModel,
        touchLastSeen: true
    });

    const buffer = await refreshCaptcha(session.page, session.captchaFrame);
    if (!buffer) {
        return res.status(500).json({ error: 'Failed to refresh captcha' });
    }

    return res.json({
        success: true,
        captchaImage: `data:image/png;base64,${buffer.toString('base64')}`
    });
});

app.post('/api/logout', async (req, res) => {
    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });

    for (const [token, session] of SESSIONS.entries()) {
        if (!username || session.username === username) {
            if (session.browser) {
                await session.browser.close().catch(() => { });
            }
            SESSIONS.delete(token);
        }
    }

    let removedSubscription = { removed: false, deletedUserDoc: false, remaining: null };
    if (isValidIdentifier(username) && isValidIdentifier(deviceId)) {
        removedSubscription = await removeDeviceSubscription(username, deviceId);
    }

    return res.json({ success: true, removedSubscription });
});

app.get('/api/notifications/settings', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.json({
            success: false,
            featureDisabled: true,
            mongoEnabled: false
        });
    }

    const username = safeString(req.query && req.query.username, { maxLength: 128 });
    const deviceId = safeString(req.query && req.query.deviceId, { maxLength: 128 });

    if (!isValidIdentifier(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }

    const cols = getMongoCollections();
    if (!cols) {
        return res.status(503).json({ error: 'Database unavailable.' });
    }

    const [subDoc, statsDoc] = await Promise.all([
        cols.subscriptions.findOne({ _id: username }),
        cols.statistics.findOne({ _id: username }, { projection: { devices: 1 } })
    ]);

    const subscriptions = Array.isArray(subDoc && subDoc.subscriptions) ? subDoc.subscriptions : [];
    const statsDevices = Array.isArray(statsDoc && statsDoc.devices) ? statsDoc.devices : [];
    const statsMap = new Map();
    for (const d of statsDevices) {
        if (d && isValidIdentifier(d.deviceId)) statsMap.set(d.deviceId, d);
    }

    const devices = subscriptions
        .filter(entry => entry && isValidIdentifier(entry.deviceId))
        .map(entry => {
            const stat = statsMap.get(entry.deviceId) || {};
            return {
                deviceId: entry.deviceId,
                model: normalizeDeviceModel(stat.model),
                lastSeen: stat.lastSeen || null,
                isCurrent: entry.deviceId === deviceId
            };
        });

    return res.json({
        success: true,
        mongoEnabled: true,
        hasSubscriptionDoc: !!subDoc,
        currentDeviceSubscribed: subscriptions.some(entry => entry && entry.deviceId === deviceId),
        checkIntervalMinutes: normalizeInterval(subDoc && subDoc.checkIntervalMinutes),
        totalSubscriptions: devices.length,
        maxSubscriptions: MAX_SUBSCRIPTIONS_PER_USER,
        devices
    });
});

app.post('/api/notifications/subscribe', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({
            error: 'Notifications are disabled because MongoDB is not configured.',
            featureDisabled: true
        });
    }

    if (!hasVapidConfig) {
        return res.status(503).json({ error: 'Push notifications are not configured on the server.' });
    }

    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const passwordBase64 = safeString(req.body && req.body.passwordBase64, { maxLength: 4096, trim: true });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });
    const deviceModel = normalizeDeviceModel(req.body && req.body.deviceModel);
    const checkIntervalMinutes = normalizeInterval(req.body && req.body.checkIntervalMinutes);
    const consentAccepted = parseBoolean(req.body && req.body.consentAccepted, false);
    const autoSolveEnabled = parseBoolean(req.body && req.body.autoSolveEnabled, false);
    const pushSubscription = req.body && req.body.pushSubscription;

    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return res.status(400).json({ error: 'Invalid username or deviceId.' });
    }

    if (!isValidBase64(passwordBase64)) {
        return res.status(400).json({ error: 'A valid password (base64) is required for notifications.' });
    }

    if (!autoSolveEnabled) {
        return res.status(400).json({ error: 'Auto solve is required to enable push notifications.' });
    }

    if (!validatePushSubscription(pushSubscription)) {
        return res.status(400).json({ error: 'Invalid push subscription payload.' });
    }

    const cols = getMongoCollections();
    if (!cols) {
        return res.status(503).json({ error: 'Database unavailable.' });
    }

    const now = new Date();
    const existing = await cols.subscriptions.findOne({ _id: username });

    let subscriptions = [];
    if (existing && Array.isArray(existing.subscriptions)) {
        subscriptions = [...existing.subscriptions];
    }

    if (!existing && !consentAccepted) {
        return res.status(400).json({
            error: 'Consent is required before storing your password for notification checks.',
            requiresConsent: true
        });
    }

    const existingIndex = subscriptions.findIndex(entry => entry && entry.deviceId === deviceId);
    if (existingIndex === -1 && subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER) {
        return res.status(400).json({
            error: `The maximum of ${MAX_SUBSCRIPTIONS_PER_USER} subscriptions is exceeded. Remove some from settings.`,
            maxExceeded: true,
            maxSubscriptions: MAX_SUBSCRIPTIONS_PER_USER
        });
    }

    const currentEntry = existingIndex >= 0 ? subscriptions[existingIndex] : null;
    const nextEntry = {
        deviceId,
        pushSubscription,
        lastSeenGrades: normalizeTrackedGrades(currentEntry && currentEntry.lastSeenGrades),
        sentNotifications: Array.isArray(currentEntry && currentEntry.sentNotifications)
            ? currentEntry.sentNotifications
            : [],
        createdAt: currentEntry && currentEntry.createdAt ? currentEntry.createdAt : now,
        updatedAt: now
    };

    if (existingIndex >= 0) {
        subscriptions[existingIndex] = nextEntry;
    } else {
        subscriptions.push(nextEntry);
    }

    await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                passwordBase64,
                checkIntervalMinutes,
                subscriptions,
                updatedAt: now
            },
            $setOnInsert: {
                createdAt: now,
                lastCheckedAt: null
            }
        },
        { upsert: true }
    );

    await incrementStatistics(username, {}, {
        deviceId,
        deviceModel,
        touchLastSeen: true
    });

    return res.json({
        success: true,
        checkIntervalMinutes,
        totalSubscriptions: subscriptions.length,
        maxSubscriptions: MAX_SUBSCRIPTIONS_PER_USER
    });
});

app.post('/api/notifications/unsubscribe-device', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({ featureDisabled: true, error: 'Notifications are disabled.' });
    }

    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });

    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return res.status(400).json({ error: 'Invalid username or deviceId.' });
    }

    const result = await removeDeviceSubscription(username, deviceId);
    return res.json({ success: true, ...result });
});

app.post('/api/notifications/unsubscribe-all', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({ featureDisabled: true, error: 'Notifications are disabled.' });
    }

    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    if (!isValidIdentifier(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }

    const result = await removeAllSubscriptions(username);
    return res.json({ success: true, ...result });
});

app.patch('/api/notifications/interval', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({ featureDisabled: true, error: 'Notifications are disabled.' });
    }

    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    if (!isValidIdentifier(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }

    const rawInterval = req.body && req.body.checkIntervalMinutes;
    const normalized = normalizeInterval(rawInterval);

    const cols = getMongoCollections();
    if (!cols) {
        return res.status(503).json({ error: 'Database unavailable.' });
    }

    const updateResult = await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                checkIntervalMinutes: normalized,
                updatedAt: new Date()
            }
        }
    );

    if (!updateResult.matchedCount) {
        return res.status(404).json({ error: 'Subscription document not found for this user.' });
    }

    return res.json({
        success: true,
        checkIntervalMinutes: normalized,
        defaultApplied: normalized === DEFAULT_INTERVAL_MINUTES && !ALLOWED_INTERVALS.has(parseNonNegativeInt(rawInterval, -1))
    });
});

app.post('/api/statistics/app-open', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({
            error: 'Statistics are disabled because MongoDB is not configured.',
            featureDisabled: true
        });
    }

    const username = safeString(req.body && req.body.username, { maxLength: 128 });
    const deviceId = safeString(req.body && req.body.deviceId, { maxLength: 128 });
    const deviceModel = normalizeDeviceModel(req.body && req.body.deviceModel);
    const offlineOpenDelta = Math.min(parseNonNegativeInt(req.body && req.body.offlineOpenDelta, 0), 100000);
    const countOnlineOpen = parseBoolean(req.body && req.body.countOnlineOpen, true);

    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return res.status(400).json({ error: 'Invalid username or deviceId.' });
    }

    await incrementStatistics(username, {}, {
        deviceId,
        deviceModel,
        appOpenOnlineDelta: countOnlineOpen ? 1 : 0,
        appOpenOfflineDelta: offlineOpenDelta,
        touchLastSeen: true
    });

    return res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', async () => {
    await initMongo();
    Logger.info(`Server running on 0.0.0.0:${PORT}`);
});

process.on('SIGINT', async () => {
    if (mongoState.client) {
        await mongoState.client.close().catch(() => { });
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (mongoState.client) {
        await mongoState.client.close().catch(() => { });
    }
    process.exit(0);
});
