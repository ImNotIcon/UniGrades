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
const { solveCaptcha, isAutoSolveConfigured } = require('./captcha_solver');

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
const SESSION_POLL_TIMEOUT_MS = 10000;
const PAUSED_SESSION_TTL_MS = 2 * 60 * 1000;
const SESSION_WATCHDOG_TICK_MS = 1000;
const COMPLETED_SESSION_TTL_MS = 2000;
const STATUS_LONG_POLL_TIMEOUT_MS = 8000;
const MONGO_STATS_QUEUE_WINDOW_MS = (() => {
    const value = Number.parseInt(process.env.MONGO_STATS_QUEUE_WINDOW_MS || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : 80;
})();
const MONGO_STATS_QUEUE_RETRY_MAX = (() => {
    const value = Number.parseInt(process.env.MONGO_STATS_QUEUE_RETRY_MAX || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : 2;
})();
const MONGO_STATS_QUEUE_RETRY_BASE_MS = (() => {
    const value = Number.parseInt(process.env.MONGO_STATS_QUEUE_RETRY_BASE_MS || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : 250;
})();
const MONGO_STATS_DRAIN_TIMEOUT_MS = 2000;
const MONGO_STATS_QUEUE_DEPTH_WARN_THRESHOLD = 10;

const SESSIONS = new Map();
const USER_QUEUES = new Map();
const USER_ACTIVE_SESSION = new Map();
const STATS_PENDING_BY_USER = new Map();
const STATS_TIMER_BY_USER = new Map();
const MONGO_WRITE_CHAIN_BY_USER = new Map();
const STATS_QUEUE_METRICS = {
    enqueued: 0,
    flushed: 0,
    failed: 0,
    dropped: 0,
    retried: 0
};
let backgroundWorkerBusy = false;
let sharedBrowser = null;
let sharedBrowserPromise = null;

function nowMs() {
    return Date.now();
}

function initTiming(session) {
    session.timings = {
        startedAt: nowMs(),
        marks: {}
    };
}

function markTiming(session, label) {
    if (!session || !session.timings || !session.timings.marks) return;
    session.timings.marks[label] = nowMs() - session.timings.startedAt;
}

function flushTimingLog(session, token, extra = {}) {
    if (!session || !session.timings) return;
    const marks = session.timings.marks || {};
    const payload = {
        totalMs: nowMs() - session.timings.startedAt,
        ...marks,
        ...extra
    };
    Logger.info(`Flow timings ${JSON.stringify(payload)}`, null, token || session.username);
}

function notifySessionUpdated(token) {
    const session = SESSIONS.get(token);
    if (!session) return;
    session.lastActive = nowMs();
    const waiters = Array.isArray(session.statusWaiters) ? session.statusWaiters : [];
    session.statusWaiters = [];
    for (const resolve of waiters) {
        try {
            resolve();
        } catch {
            // Ignore waiter failures
        }
    }
}

async function waitForSessionUpdate(token, timeoutMs) {
    const session = SESSIONS.get(token);
    if (!session) return false;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return true;

    await new Promise((resolve) => {
        const latest = SESSIONS.get(token);
        if (!latest) return resolve();
        if (!Array.isArray(latest.statusWaiters)) latest.statusWaiters = [];
        const wrappedResolve = () => {
            if (!Array.isArray(latest.statusWaiters)) return resolve();
            latest.statusWaiters = latest.statusWaiters.filter(fn => fn !== wrappedResolve);
            resolve();
        };
        latest.statusWaiters.push(wrappedResolve);
        setTimeout(wrappedResolve, timeoutMs);
    });
    return true;
}

async function getSharedBrowser() {
    if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
        return sharedBrowser;
    }
    if (sharedBrowserPromise) return sharedBrowserPromise;

    sharedBrowserPromise = (async () => {
        const browser = await puppeteer.launch({
            headless: process.env.HEADLESS !== 'false',
            ...BROWSER_LAUNCH_OPTIONS
        });
        browser.on('disconnected', () => {
            sharedBrowser = null;
        });
        sharedBrowser = browser;
        return browser;
    })();

    try {
        return await sharedBrowserPromise;
    } finally {
        sharedBrowserPromise = null;
    }
}

/**
 * Ensures only one active grade refresh per user is running.
 */
async function enqueueUserTask(username, taskFn, { token = '' } = {}) {
    if (!username) return taskFn();

    const previous = USER_QUEUES.get(username) || Promise.resolve();
    const activeToken = USER_ACTIVE_SESSION.get(username);
    const activeSession = activeToken ? SESSIONS.get(activeToken) : null;
    const shouldBypassPaused = !!(activeToken && activeToken !== token && activeSession && activeSession.paused);

    if (shouldBypassPaused) {
        Logger.info(`Bypassing paused session ${activeToken.slice(0, 8)} for newer session ${token.slice(0, 8)}.`, null, username);
    }

    const base = shouldBypassPaused ? Promise.resolve() : previous;
    const current = base.catch(() => { }).then(async () => {
        if (token) {
            USER_ACTIVE_SESSION.set(username, token);
        }
        return await taskFn();
    }).finally(() => {
        if (USER_QUEUES.get(username) === current) {
            USER_QUEUES.delete(username);
        }
        if (token && USER_ACTIVE_SESSION.get(username) === token) {
            USER_ACTIVE_SESSION.delete(username);
        }
    });

    USER_QUEUES.set(username, current);
    return current;
}

function getInFlightSessionTokenForUser(username) {
    if (!username) return null;

    const activeToken = USER_ACTIVE_SESSION.get(username);
    if (activeToken) {
        const activeSession = SESSIONS.get(activeToken);
        if (activeSession && activeSession.status !== 'completed' && activeSession.status !== 'error') {
            return activeToken;
        }
    }

    for (const [token, session] of SESSIONS.entries()) {
        if (!session || session.username !== username) continue;
        if (session.status === 'completed' || session.status === 'error') continue;
        return token;
    }

    return null;
}


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
const isAutoSolveWhitelistEnabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.AUTOSOLVE_USERNAME_WHITELIST_ENABLED || '').trim().toLowerCase()
);
const autoSolveWhitelist = new Set(
    (process.env.AUTOSOLVE_USERNAME_WHITELIST || '')
        .split(',')
        .map(v => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
        .filter(v => !!v)
);
const isAutoSolveWhitelistActive = isAutoSolveWhitelistEnabled && autoSolveWhitelist.size > 0;

function normalizeUsernameForWhitelist(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, 128).toLowerCase();
}

function isUsernameAllowedForAutoSolveAndPush(username) {
    const normalized = normalizeUsernameForWhitelist(username);
    if (!normalized) return false;
    if (!isAutoSolveWhitelistEnabled) return true;
    return autoSolveWhitelist.has(normalized);
}

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
    if (statusCode === 404 || statusCode === 410 || statusCode === 401 || statusCode === 403) return true;
    const msg = error && typeof error.message === 'string' ? error.message : '';
    return msg.includes('Received unexpected response code');
}

function buildGradeIdentity(grade) {
    const code = safeString(grade.code, { maxLength: 64 }).normalize('NFC');
    const year = safeString(grade.year, { maxLength: 32 }).normalize('NFC');
    const semester = safeString(grade.semester, { maxLength: 32 }).normalize('NFC');
    const session = safeString(grade.session || grade.acadSession, { maxLength: 64 }).normalize('NFC');
    return `${code}|${year}|${semester}|${session}`;
}

function normalizeTrackedGrade(grade) {
    return {
        code: safeString(grade.code, { maxLength: 64 }).normalize('NFC'),
        year: safeString(grade.year, { maxLength: 32 }).normalize('NFC'),
        semester: safeString(grade.semester, { maxLength: 32 }).normalize('NFC'),
        session: safeString(grade.session || grade.acadSession, { maxLength: 64 }).normalize('NFC'),
        grade: safeString(grade.grade, { maxLength: 32 }).normalize('NFC'),
        title: safeString(grade.title, { maxLength: 220 }).normalize('NFC')
    };
}

function normalizeTrackedGrades(grades) {
    if (!Array.isArray(grades)) return [];
    return grades
        .map(normalizeTrackedGrade)
        .filter(g => g.code && g.year && g.semester);
}

function hasGradeValue(value) {
    if (value === null || value === undefined) return false;
    const t = value.toString().trim();
    return t !== '' && t !== '-';
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

/**
 * Common request parameter extraction and sanitization.
 */
function getParams(req) {
    const body = req.body || {};
    const query = req.query || {};
    const params = { ...query, ...body };

    const username = safeString(params.username, { maxLength: 128 });
    const password = safeString(params.password, { maxLength: 512, trim: false });
    const passwordBase64 = safeString(params.passwordBase64, { maxLength: 4096, trim: true });
    const deviceId = safeString(params.deviceId, { maxLength: 128 });
    const deviceModel = normalizeDeviceModel(params.deviceModel);
    const token = safeString(params.token, { maxLength: 64 });
    const answer = safeString(params.answer, { maxLength: 64, trim: false });
    const autoSolveEnabled = parseBoolean(params.autoSolveEnabled, true);
    const checkIntervalMinutes = normalizeInterval(params.checkIntervalMinutes);
    const cookies = sanitizeCookies(params.cookies);
    const consentAccepted = parseBoolean(params.consentAccepted, false);
    const countOnlineOpen = parseBoolean(params.countOnlineOpen, true);
    const offlineOpenDelta = Math.min(parseNonNegativeInt(params.offlineOpenDelta, 0), 100000);

    return {
        username,
        password,
        passwordBase64,
        deviceId,
        deviceModel,
        token,
        answer,
        autoSolveEnabled,
        checkIntervalMinutes,
        cookies,
        consentAccepted,
        countOnlineOpen,
        offlineOpenDelta,
        raw: params
    };
}

/**
 * Standard API error handler to reduce duplication in route catch blocks.
 */
async function apiErrorHandler(req, res, error, {
    username = '',
    deviceId = '',
    deviceModel = '',
    token = '',
    context = 'API Error',
    statsIncrements = {},
    browser = null,
    cleanup = null
} = {}) {
    if (typeof cleanup === 'function') {
        await cleanup().catch(() => { });
    } else if (browser) {
        await browser.close().catch(() => { });
    }

    if (error instanceof PublicHttpError && error.statusCode === 401) {
        return res.status(401).json({ error: error.message });
    }

    if (isValidIdentifier(username)) {
        queueStatisticsUpdate(username, statsIncrements, {
            deviceId,
            deviceModel,
            touchLastSeen: true
        });
    }

    const message = error.message || error;
    Logger.error(`${context}: ${message}`, req, token || username);
    return res.status(error.statusCode || 500).json({ error: message || 'Internal Server Error' });
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

function defaultStatsDocument(username, excludedCounterKeys = new Set()) {
    const doc = {
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

    for (const key of excludedCounterKeys) {
        delete doc[key];
    }

    return doc;
}

const STATS_INCREMENT_KEYS = [
    'gradeRefreshCount',
    'gradeRefreshCountCaptcha',
    'failedRefreshCount',
    'failedRefreshCountCaptcha',
    'incorrectCaptchaCount',
    'captchaRefreshCount',
    'incorrectCaptchaCountAuto',
    'failedLoginCount'
];

function sanitizeStatsIncrements(increments) {
    const output = {};
    if (!isPlainObject(increments)) return output;

    for (const key of STATS_INCREMENT_KEYS) {
        const value = parseNonNegativeInt(increments[key], 0);
        if (value > 0) output[key] = value;
    }

    return output;
}

function createEmptyStatsAggregate() {
    return {
        increments: {},
        devices: new Map(),
        eventCount: 0,
        firstEnqueuedAt: Date.now()
    };
}

function mergeStatsAggregate(target, increments = {}, {
    deviceId = '',
    deviceModel = '',
    appOpenOnlineDelta = 0,
    appOpenOfflineDelta = 0,
    touchLastSeen = false
} = {}) {
    const cleanIncrements = sanitizeStatsIncrements(increments);
    for (const [key, value] of Object.entries(cleanIncrements)) {
        target.increments[key] = (target.increments[key] || 0) + value;
    }

    if (isValidIdentifier(deviceId)) {
        const existing = target.devices.get(deviceId) || {
            deviceId,
            deviceModel: '',
            appOpenOnlineDelta: 0,
            appOpenOfflineDelta: 0,
            touchLastSeen: false,
            ensureDeviceRecord: false
        };

        existing.appOpenOnlineDelta += Math.max(0, parseNonNegativeInt(appOpenOnlineDelta, 0));
        existing.appOpenOfflineDelta += Math.max(0, parseNonNegativeInt(appOpenOfflineDelta, 0));
        existing.touchLastSeen = existing.touchLastSeen || parseBoolean(touchLastSeen, false);
        existing.ensureDeviceRecord = true;

        const normalizedModel = safeString(deviceModel, { maxLength: 160 });
        if (normalizedModel) {
            existing.deviceModel = normalizeDeviceModel(normalizedModel);
        }

        target.devices.set(deviceId, existing);
    }

    target.eventCount += 1;
    return target;
}

function scheduleStatsFlush(username, delayMs = MONGO_STATS_QUEUE_WINDOW_MS) {
    if (!isValidIdentifier(username)) return;
    const existingTimer = STATS_TIMER_BY_USER.get(username);
    if (existingTimer) {
        if (delayMs > 0) return;
        clearTimeout(existingTimer);
        STATS_TIMER_BY_USER.delete(username);
    }

    const timeout = setTimeout(() => {
        STATS_TIMER_BY_USER.delete(username);
        flushStatsForUser(username).catch((error) => {
            Logger.error(`Stats queue flush error: ${error.message}`, null, username);
        });
    }, Math.max(0, delayMs));

    STATS_TIMER_BY_USER.set(username, timeout);
}

function queueStatisticsUpdate(username, increments = {}, options = {}) {
    if (!isMongoEnabled() || !isValidIdentifier(username)) return;
    try {
        const aggregate = STATS_PENDING_BY_USER.get(username) || createEmptyStatsAggregate();
        mergeStatsAggregate(aggregate, increments, options);
        STATS_PENDING_BY_USER.set(username, aggregate);
        STATS_QUEUE_METRICS.enqueued += 1;

        if (aggregate.eventCount >= MONGO_STATS_QUEUE_DEPTH_WARN_THRESHOLD
            && aggregate.eventCount % MONGO_STATS_QUEUE_DEPTH_WARN_THRESHOLD === 0) {
            Logger.warn(
                `Stats queue depth for user is ${aggregate.eventCount} event(s).`,
                null,
                username
            );
        }

        scheduleStatsFlush(username, MONGO_STATS_QUEUE_WINDOW_MS);
    } catch (error) {
        Logger.error(`Failed to queue statistics update: ${error.message}`, null, username);
    }
}

function isRepairableStatsWriteError(error) {
    const message = safeString(error && error.message ? error.message : '', { maxLength: 512 }).toLowerCase();
    if (!message) return false;

    return message.includes('non-numeric type')
        || message.includes('must be an array')
        || message.includes('array updates to non-array');
}

async function repairMalformedStatisticsDocument(username) {
    if (!isMongoEnabled() || !isValidIdentifier(username)) return false;
    const cols = getMongoCollections();
    if (!cols) return false;

    const projection = { devices: 1 };
    for (const key of STATS_INCREMENT_KEYS) {
        projection[key] = 1;
    }

    const doc = await cols.statistics.findOne({ _id: username }, { projection });
    if (!doc) return false;

    const fieldsToRepair = [];
    const setPatch = {};

    for (const key of STATS_INCREMENT_KEYS) {
        const currentValue = doc[key];
        if (typeof currentValue !== 'number' || !Number.isFinite(currentValue) || currentValue < 0) {
            setPatch[key] = parseNonNegativeInt(currentValue, 0);
            fieldsToRepair.push(key);
        }
    }

    if (!Array.isArray(doc.devices)) {
        setPatch.devices = [];
        fieldsToRepair.push('devices');
    }

    if (fieldsToRepair.length === 0) return false;

    setPatch.updatedAt = new Date();
    await cols.statistics.updateOne(
        { _id: username },
        { $set: setPatch }
    );

    Logger.warn(
        `Repaired malformed statistics fields: ${fieldsToRepair.join(', ')}.`,
        null,
        username
    );
    return true;
}

async function applyStatsAggregateToMongo(username, aggregate) {
    if (!isMongoEnabled() || !isValidIdentifier(username)) return;
    const cols = getMongoCollections();
    if (!cols) return;

    const now = new Date();
    const cleanIncrements = sanitizeStatsIncrements(aggregate && aggregate.increments);
    const incrementedKeys = new Set(Object.keys(cleanIncrements));
    const baseUpdate = {
        $setOnInsert: defaultStatsDocument(username, incrementedKeys),
        $set: { updatedAt: now }
    };

    if (Object.keys(cleanIncrements).length > 0) {
        baseUpdate.$inc = cleanIncrements;
    }

    await cols.statistics.updateOne(
        { _id: username },
        baseUpdate,
        { upsert: true }
    );

    const deviceEntries = aggregate && aggregate.devices instanceof Map
        ? Array.from(aggregate.devices.values())
        : [];

    for (const entry of deviceEntries) {
        if (!entry || !isValidIdentifier(entry.deviceId)) continue;

        const incExisting = {};
        if (entry.appOpenOnlineDelta > 0) {
            incExisting['devices.$.appOpenCountOnline'] = entry.appOpenOnlineDelta;
        }
        if (entry.appOpenOfflineDelta > 0) {
            incExisting['devices.$.appOpenCountOffline'] = entry.appOpenOfflineDelta;
        }

        const setExisting = {
            updatedAt: now
        };
        if (entry.touchLastSeen) {
            setExisting['devices.$.lastSeen'] = now;
        }
        if (entry.deviceModel) {
            setExisting['devices.$.model'] = normalizeDeviceModel(entry.deviceModel);
        }

        const updateExisting = {
            $set: setExisting
        };
        if (Object.keys(incExisting).length > 0) {
            updateExisting.$inc = incExisting;
        }

        const existingResult = await cols.statistics.updateOne(
            { _id: username, 'devices.deviceId': entry.deviceId },
            updateExisting
        );

        if (!existingResult.matchedCount && entry.ensureDeviceRecord) {
            await cols.statistics.updateOne(
                { _id: username, 'devices.deviceId': { $ne: entry.deviceId } },
                {
                    $set: { updatedAt: now },
                    $push: {
                        devices: {
                            deviceId: entry.deviceId,
                            model: normalizeDeviceModel(entry.deviceModel || 'Unknown device'),
                            lastSeen: now,
                            appOpenCountOnline: Math.max(0, parseNonNegativeInt(entry.appOpenOnlineDelta, 0)),
                            appOpenCountOffline: Math.max(0, parseNonNegativeInt(entry.appOpenOfflineDelta, 0))
                        }
                    }
                }
            );
        }
    }
}

async function flushStatsAggregateWithRetry(username, aggregate) {
    const retryCount = Math.max(0, MONGO_STATS_QUEUE_RETRY_MAX);
    const deviceCount = aggregate && aggregate.devices instanceof Map ? aggregate.devices.size : 0;
    const counterCount = aggregate ? Object.keys(aggregate.increments || {}).length : 0;
    const eventCount = aggregate && Number.isFinite(aggregate.eventCount) ? aggregate.eventCount : 0;
    let repairAttempted = false;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
            await applyStatsAggregateToMongo(username, aggregate);
            STATS_QUEUE_METRICS.flushed += 1;
            Logger.info(
                `Stats queue flushed (events=${eventCount}, counters=${counterCount}, devices=${deviceCount}).`,
                null,
                username
            );
            return;
        } catch (error) {
            STATS_QUEUE_METRICS.failed += 1;

            if (!repairAttempted && isRepairableStatsWriteError(error)) {
                repairAttempted = true;
                try {
                    const repaired = await repairMalformedStatisticsDocument(username);
                    if (repaired) {
                        Logger.warn(
                            `Stats write failed due to malformed document; repaired and retrying immediately: ${error.message}`,
                            null,
                            username
                        );
                        continue;
                    }
                } catch (repairError) {
                    Logger.error(
                        `Failed to repair malformed statistics document: ${repairError.message}`,
                        null,
                        username
                    );
                }
            }

            if (attempt < retryCount) {
                STATS_QUEUE_METRICS.retried += 1;
                const retryDelay = MONGO_STATS_QUEUE_RETRY_BASE_MS * (2 ** attempt);
                Logger.warn(
                    `Stats queue flush attempt ${attempt + 1} failed, retrying in ${retryDelay}ms: ${error.message}`,
                    null,
                    username
                );
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                continue;
            }

            STATS_QUEUE_METRICS.dropped += 1;
            Logger.error(
                `Dropping stats queue payload after ${attempt + 1} attempt(s). events=${eventCount}, counters=${counterCount}, devices=${deviceCount}. Error: ${error.message}`,
                null,
                username
            );
        }
    }
}

async function flushStatsForUser(username) {
    if (!isValidIdentifier(username)) return;

    const aggregate = STATS_PENDING_BY_USER.get(username);
    if (!aggregate) return;
    STATS_PENDING_BY_USER.delete(username);

    const previous = MONGO_WRITE_CHAIN_BY_USER.get(username) || Promise.resolve();
    const current = previous.catch(() => { }).then(async () => {
        await flushStatsAggregateWithRetry(username, aggregate);
    }).finally(() => {
        if (MONGO_WRITE_CHAIN_BY_USER.get(username) === current) {
            if (STATS_PENDING_BY_USER.has(username)) {
                scheduleStatsFlush(username, 0);
            } else {
                MONGO_WRITE_CHAIN_BY_USER.delete(username);
            }
        }
    });

    MONGO_WRITE_CHAIN_BY_USER.set(username, current);
    return current;
}

async function drainStatsQueue(timeoutMs = MONGO_STATS_DRAIN_TIMEOUT_MS) {
    const timeout = Math.max(0, parseNonNegativeInt(timeoutMs, MONGO_STATS_DRAIN_TIMEOUT_MS));
    const deadline = Date.now() + timeout;

    for (const [username, timer] of STATS_TIMER_BY_USER.entries()) {
        clearTimeout(timer);
        STATS_TIMER_BY_USER.delete(username);
    }

    for (const username of STATS_PENDING_BY_USER.keys()) {
        scheduleStatsFlush(username, 0);
    }

    while ((STATS_PENDING_BY_USER.size > 0 || MONGO_WRITE_CHAIN_BY_USER.size > 0) && Date.now() < deadline) {
        for (const username of STATS_PENDING_BY_USER.keys()) {
            if (!MONGO_WRITE_CHAIN_BY_USER.has(username)) {
                scheduleStatsFlush(username, 0);
            }
        }

        const chains = Array.from(MONGO_WRITE_CHAIN_BY_USER.values());
        if (chains.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
        }

        const remaining = Math.max(0, deadline - Date.now());
        await Promise.race([
            Promise.allSettled(chains),
            new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
        ]);
    }

    const pendingUsers = STATS_PENDING_BY_USER.size;
    const activeChains = MONGO_WRITE_CHAIN_BY_USER.size;
    if (pendingUsers > 0 || activeChains > 0) {
        Logger.warn(
            `Stats queue drain timed out with ${pendingUsers} pending user(s) and ${activeChains} active chain(s).`,
            null,
            'stats-q'
        );
        return false;
    }

    Logger.info(
        `Stats queue drained. Metrics: enqueued=${STATS_QUEUE_METRICS.enqueued}, flushed=${STATS_QUEUE_METRICS.flushed}, failed=${STATS_QUEUE_METRICS.failed}, retried=${STATS_QUEUE_METRICS.retried}, dropped=${STATS_QUEUE_METRICS.dropped}.`,
        null,
        'stats-q'
    );
    return true;
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
    autoSolveEnabled = true,
    status = 'loading'
} = {}) {
    const token = Math.random().toString(36).substring(2, 12);
    SESSIONS.set(token, {
        browser,
        page,
        context: null,
        cleanup: null,
        status,
        username,
        deviceId,
        deviceModel,
        autoSolveEnabled,
        manualCaptchaCounted: false,
        lastActive: Date.now(),
        createdAt: Date.now(),
        lastStatusPollAt: Date.now(),
        paused: false,
        pausedAt: null,
        completedAt: null,
        statusWaiters: []
    });
    const session = SESSIONS.get(token);
    initTiming(session);
    return token;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function touchSessionStatusPoll(token) {
    const session = SESSIONS.get(token);
    if (!session) return;
    session.lastStatusPollAt = Date.now();
    session.lastActive = Date.now();
    if (session.paused) {
        session.paused = false;
        session.pausedAt = null;
        Logger.info('Resuming paused session after status poll.', null, token);
    }
}

async function waitIfSessionPaused(token) {
    while (true) {
        const session = SESSIONS.get(token);
        if (!session) return false;
        if (!session.paused) return true;
        await sleep(250);
    }
}

async function runSessionWatchdog() {
    const now = Date.now();
    const tokensToClose = [];

    for (const [token, session] of SESSIONS.entries()) {
        if (!session) continue;
        if (session.status === 'completed') {
            const completedAt = Number.isFinite(session.completedAt) ? session.completedAt : now;
            if ((now - completedAt) > COMPLETED_SESSION_TTL_MS) {
                tokensToClose.push(token);
            }
            continue;
        }
        if (session.status === 'error') continue;

        const lastPoll = Number.isFinite(session.lastStatusPollAt) ? session.lastStatusPollAt : session.createdAt || now;
        const idleMs = now - lastPoll;

        if (!session.paused && idleMs > SESSION_POLL_TIMEOUT_MS) {
            session.paused = true;
            session.pausedAt = now;
            Logger.warn(`Pausing session due to missing /api/status updates for ${idleMs}ms.`, null, token);
        }

        if (session.paused && session.pausedAt && (now - session.pausedAt) > PAUSED_SESSION_TTL_MS) {
            tokensToClose.push(token);
        }
    }

    for (const token of tokensToClose) {
        Logger.warn('Removing paused session after TTL expiration.', null, token);
        await closeSession(token);
    }
}

async function closeSession(token) {
    const session = SESSIONS.get(token);
    if (!session) return;

    try {
        if (typeof session.cleanup === 'function') {
            await session.cleanup().catch(() => { });
        } else if (session.context) {
            await session.context.close().catch(() => { });
        } else if (session.page) {
            await session.page.close().catch(() => { });
        }
    } finally {
        notifySessionUpdated(token);
        SESSIONS.delete(token);
    }
}

function getActiveFrame(page, frame) {
    if (frame && !frame.isDetached()) return frame;
    return page.frames().find(f =>
        f.url().includes('zups_piq_st_acad_work_ov') || f.url().includes('sap/bc/webdynpro')
    ) || null;
}

async function waitForImageLoad(frame, imgElement, token = null) {
    await frame.waitForFunction(
        el => el.complete && el.naturalWidth > 0,
        { timeout: 5000 },
        imgElement
    ).catch(() => {
        Logger.warn('Image load wait timed out, continuing anyway.', null, token);
    });
}

async function findCaptchaImage(frame, token = null) {
    let element = null;

    try {
        await frame.waitForSelector(CAPTCHA_IMG_SELECTORS, { timeout: 10000 });
        element = await frame.$(CAPTCHA_IMG_SELECTORS);
    } catch {
        Logger.warn('Primary captcha selector timed out. Trying fallback image selector.', null, token);
    }

    if (!element) element = await frame.$('img');
    if (!element) throw new Error('Captcha element not found');

    await waitForImageLoad(frame, element, token);
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
    const browser = await getSharedBrowser();
    let context = null;
    if (typeof browser.createIncognitoBrowserContext === 'function') {
        context = await browser.createIncognitoBrowserContext();
    } else if (typeof browser.createBrowserContext === 'function') {
        context = await browser.createBrowserContext();
    }

    const page = context ? await context.newPage() : await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const close = async () => {
        if (context) {
            await context.close().catch(() => { });
            return;
        }
        await page.close().catch(() => { });
    };

    return { browser, context, page, close };
}

async function navigateToIview(page, token) {
    Logger.info('Navigating to Academic Work iView...', null, token);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await page.goto(ACADEMIC_IVIEW_URL, { timeout: 5000 });
            await page.waitForSelector('body', { timeout: 5000 });
            return;
        } catch (error) {
            Logger.warn(`iView navigation attempt ${attempt + 1} failed: ${error.message}`, null, token);
        }
    }

    throw new Error('iView navigation failed');
}

async function findGradesFrame(page, checkForContent = true, timeoutMs = 15000, token = null) {
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

async function submitCaptchaAndVerify(page, captchaFrame, answer, token = null) {
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

    // Remove any pre-existing error/success indicators from the DOM so
    // the post-submit verification loop does not immediately pick up stale
    // markers left over from a previous (auto-solve) attempt.
    try {
        await activeFrame.evaluate(() => {
            const stale = document.querySelectorAll(
                'img[src*="ErrorMessage"], img[src*="WD_M_ERROR"], '
                + 'img[src*="SuccessMessage"], img[src*="WD_M_OK"], img[src*="WD_M_OKAY"]'
            );
            stale.forEach(el => el.remove());
        });
    } catch { /* frame may have navigated; safe to ignore */ }

    try {
        await submitButton.click();
    } catch {
        await activeFrame.evaluate(() => {
            const button = document.querySelector('input[type="submit"], button, .urBtnStd, img[src*="BTN_OK"]');
            if (button && button.click) button.click();
        });
    }

    const readResultInDocument = () => {
        const body = document.body;
        const text = body ? body.innerText : '';
        const textUpper = text.toUpperCase();
        const okIcon = document.querySelector('img[src*="SuccessMessage"], img[src*="WD_M_OK"], img[src*="WD_M_OKAY"]');
        const errIcon = document.querySelector('img[src*="ErrorMessage"], img[src*="WD_M_ERROR"]');
        const gradesTable = document.querySelector('table[id*="GRADES"], table[id*="GRADE"], .urST');
        const hasSuccessText = textUpper.includes('OK!') || textUpper.includes('ΟΚ!') || /\bOK\b/.test(textUpper);
        const hasErrorText = textUpper.includes('ERROR') || textUpper.includes('ΛΑΘ') || textUpper.includes('INCORRECT CAPTCHA');

        if (okIcon || hasSuccessText || gradesTable) return 'SUCCESS';
        if (errIcon || hasErrorText) return 'ERROR';
        return null;
    };

    const waitForVerification = async (frame, timeout) => {
        const handle = await frame.waitForFunction(
            readResultInDocument,
            { timeout, polling: 90 }
        );
        return handle.jsonValue();
    };

    let result = null;
    try {
        try {
            result = await waitForVerification(activeFrame, 7000);
        } catch (error) {
            const message = safeString(error && error.message ? error.message : '', { maxLength: 300 }).toLowerCase();
            if (!message.includes('timeout')) throw error;
        }

        if (!result) {
            result = await page.waitForFunction(() => {
                const checkDoc = (doc) => {
                    const body = doc.body;
                    const text = body ? body.innerText : '';
                    const textUpper = text.toUpperCase();
                    const okIcon = doc.querySelector('img[src*="SuccessMessage"], img[src*="WD_M_OK"], img[src*="WD_M_OKAY"]');
                    const errIcon = doc.querySelector('img[src*="ErrorMessage"], img[src*="WD_M_ERROR"]');
                    const gradesTable = doc.querySelector('table[id*="GRADES"], table[id*="GRADE"], .urST');
                    const hasSuccessText = textUpper.includes('OK!') || textUpper.includes('ΟΚ!') || /\bOK\b/.test(textUpper);
                    const hasErrorText = textUpper.includes('ERROR') || textUpper.includes('ΛΑΘ') || textUpper.includes('INCORRECT CAPTCHA');

                    if (okIcon || hasSuccessText || gradesTable) return 'SUCCESS';
                    if (errIcon || hasErrorText) return 'ERROR';
                    return null;
                };

                const mainStatus = checkDoc(document);
                if (mainStatus) return mainStatus;

                for (let i = 0; i < window.frames.length; i++) {
                    try {
                        const frameStatus = checkDoc(window.frames[i].document);
                        if (frameStatus) return frameStatus;
                    } catch {
                        // cross-origin frame, ignore
                    }
                }
                return null;
            }, { timeout: 5000, polling: 120 }).then(h => h.jsonValue());
        }

        if (result === 'SUCCESS') {
            Logger.info('Verification Success!', null, token);
            return true;
        }
        if (result === 'ERROR') {
            Logger.warn('Verification Error flagged by portal.', null, token);
            throw new Error('Incorrect captcha code. Please try again.');
        }
        throw new Error('Verification timed out (no success indicator found)');
    } catch (error) {
        if (error.message.includes('timeout')) {
            await debugScreenshot(page, 'verification_timeout');
            throw new Error('Verification timed out (no success indicator found)');
        }
        if (isIncorrectCaptchaError(error)) throw error;
        throw error;
    }
}

async function authenticatePortalLogin(page, username, password, token) {
    Logger.info('Navigating to login page...', null, token);
    await page.goto('https://progress.upatras.gr', { waitUntil: 'domcontentloaded', timeout: 5000 });

    let usernameSelector = '#inputEmail';
    const passwordSelector = '#inputPassword';

    await page.waitForSelector(usernameSelector, { timeout: 3000 });

    Logger.info('Entering credentials...', null, token);
    await page.type(usernameSelector, username);
    await page.type(passwordSelector, password);

    await page.waitForSelector('#loginButton', { visible: true });

    Logger.info('Submitting login form...', null, token);
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {
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

/**
 * Encapsulated scraping with retry logic.
 */
async function performPortalScrape(page, token) {
    const hasSession = token && SESSIONS.has(token);
    let result;
    const retryDelays = [900, 1800];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (hasSession && !(await waitIfSessionPaused(token))) return null;
        result = await scrapeGrades(page, token);
        if (result && Array.isArray(result.grades) && result.grades.length > 0) break;
        const waitMs = retryDelays[Math.min(attempt, retryDelays.length - 1)];
        await page.waitForFunction(() => document.querySelector('table, .urST, iframe'), { timeout: waitMs }).catch(() => { });
    }

    if (hasSession && !(await waitIfSessionPaused(token))) return null;
    if (!result || !Array.isArray(result.grades)) {
        result = await scrapeGrades(page, token);
    }
    return result;
}

async function executeAsyncScrape(token, page) {
    const session = SESSIONS.get(token);
    if (!session) return;

    session.status = 'loading';
    notifySessionUpdated(token);
    try {
        const result = await performPortalScrape(page, token);
        if (!result) return; // Session closed/paused during scrape

        const latestSession = SESSIONS.get(token);
        if (!latestSession) return;

        const newCookies = await page.cookies();
        markTiming(latestSession, 'scrapeDoneMs');
        if (typeof latestSession.cleanup === 'function') {
            await latestSession.cleanup().catch(() => { });
            latestSession.cleanup = null;
        }

        latestSession.status = 'completed';
        latestSession.completedAt = Date.now();
        Logger.info('Async scraping completed successfully.', null, token);
        latestSession.result = {
            grades: result.grades || [],
            studentInfo: result.studentInfo || {},
            headers: result.headers || [],
            cookies: newCookies
        };
        flushTimingLog(latestSession, token, { status: 'completed' });
        notifySessionUpdated(token);
    } catch (error) {
        Logger.error(`Background scrape for session failed: ${error.message}`, null, token);

        const latestSession = SESSIONS.get(token);
        if (latestSession) {
            if (typeof latestSession.cleanup === 'function') {
                await latestSession.cleanup().catch(() => { });
                latestSession.cleanup = null;
            }
            latestSession.status = 'error';
            latestSession.error = error.message;
            flushTimingLog(latestSession, token, { status: 'error' });
            notifySessionUpdated(token);

            queueStatisticsUpdate(latestSession.username, { failedRefreshCount: 1 }, latestSession);
        }
    }
}

/**
 * Unified logic for navigating to iView, handling captcha (auto/manual), and scraping.
 */
async function unifiedIviewFlow(token, browser, page, {
    skipNavigation = false,
    forceLogin = false,
    autoSolveEnabled = true,
    isBackground = false,
    username = '',
    passwordPlain = '',
    passwordBase64 = '',
    cookies = []
} = {}) {
    const session = SESSIONS.get(token);
    if (!session && !isBackground) return;

    const effectiveUsername = session ? session.username : username;
    const contextToken = isBackground ? 'notifier' : token;
    let autoSolveFallbackMessage = '';

    try {
        if (session) markTiming(session, 'flowStartMs');
        if (!isBackground && !(await waitIfSessionPaused(token))) return;

        let plain = passwordPlain;
        if (!plain && isValidBase64(passwordBase64)) {
            plain = Buffer.from(passwordBase64, 'base64').toString('utf8');
        }

        if (forceLogin && plain && isValidIdentifier(effectiveUsername)) {
            await authenticatePortalLogin(page, effectiveUsername, plain, contextToken);
            if (session) markTiming(session, 'authMs');
        } else if (Array.isArray(cookies) && cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        if (!skipNavigation) {
            await navigateToIview(page, contextToken);
            if (session) markTiming(session, 'navigateMs');
        }


        if (!isBackground && !(await waitIfSessionPaused(token))) return;

        // Auto Re-login logic if body is empty
        if (await isBodyEmpty(page)) {
            if (!plain && isMongoEnabled() && isValidIdentifier(effectiveUsername)) {
                const cols = getMongoCollections();
                const userDoc = await cols.subscriptions.findOne({ _id: effectiveUsername });
                if (userDoc && userDoc.passwordBase64) {
                    plain = Buffer.from(userDoc.passwordBase64, 'base64').toString('utf8');
                }
            }

            if (plain && isValidIdentifier(effectiveUsername)) {
                Logger.info('Session empty. Attempting re-authentication...', null, contextToken);
                if (session) session.message = 'Session expired. Re-authenticating...';
                await authenticatePortalLogin(page, effectiveUsername, plain, contextToken);
                await navigateToIview(page, contextToken);
                if (session) markTiming(session, 'reauthMs');
                if (await isBodyEmpty(page)) throw new Error('Session still empty after re-authentication.');
            } else {
                throw new Error('Session expired or empty.');
            }
        }

        const captchaFrame = await findGradesFrame(page, false, 12000, contextToken);
        if (!captchaFrame) throw new Error('Captcha/Grades frame not found.');
        if (session) markTiming(session, 'frameFoundMs');

        if (session) session.captchaFrame = captchaFrame;

        const captchaEl = await findCaptchaImage(captchaFrame, contextToken);
        let currentCaptchaBuffer = await captchaEl.screenshot({ timeout: 60000 });
        let currentFrame = captchaFrame;

        const autoSolveGloballyEnabled = process.env.DISABLE_AUTO_CAPTCHA !== 'true';
        const autoSolveProviderConfigured = isAutoSolveConfigured();
        const canAutoSolve = autoSolveGloballyEnabled
            && autoSolveProviderConfigured
            && parseBoolean(autoSolveEnabled, true)
            && isUsernameAllowedForAutoSolveAndPush(effectiveUsername);

        if (canAutoSolve) {
            try {
                let allowSecondAttempt = false;

                if (!isBackground && !(await waitIfSessionPaused(token))) return;
                const firstAutoResult = await solveCaptcha(currentCaptchaBuffer, contextToken, { isBackground });
                const firstAutoText = firstAutoResult && typeof firstAutoResult === 'object'
                    ? firstAutoResult.text
                    : firstAutoResult;
                if (firstAutoText) {
                    Logger.info(`Auto-solving attempt 1/2: ${firstAutoText}`, null, contextToken);
                    try {
                        if (!isBackground && !(await waitIfSessionPaused(token))) return;
                        await submitCaptchaAndVerify(page, currentFrame, firstAutoText, contextToken);
                        if (isBackground) return await performPortalScrape(page, contextToken);
                        if (session) markTiming(session, 'captchaSolvedMs');
                        return executeAsyncScrape(token, page);
                    } catch (error) {
                        if (isIncorrectCaptchaError(error)) {
                            allowSecondAttempt = true;
                            queueStatisticsUpdate(effectiveUsername, { incorrectCaptchaCountAuto: 1 }, session || { deviceId: '', deviceModel: '' });
                        } else {
                            throw error;
                        }
                    }
                } else if (
                    firstAutoResult
                    && typeof firstAutoResult === 'object'
                    && firstAutoResult.provider === 'ollama'
                    && firstAutoResult.shouldRefreshCaptcha
                ) {
                    allowSecondAttempt = true;
                    Logger.info('Ollama produced non-6-char output. Refreshing captcha for a new image instead of retrying same one.', null, contextToken);
                }

                if (allowSecondAttempt) {
                    if (!isBackground && !(await waitIfSessionPaused(token))) return;
                    const refreshedBuffer = await refreshCaptcha(page, currentFrame, contextToken);
                    if (refreshedBuffer) {
                        currentCaptchaBuffer = refreshedBuffer;
                        currentFrame = getActiveFrame(page, currentFrame) || currentFrame;
                        const secondAutoResult = await solveCaptcha(currentCaptchaBuffer, contextToken, { isBackground });
                        const secondAutoText = secondAutoResult && typeof secondAutoResult === 'object'
                            ? secondAutoResult.text
                            : secondAutoResult;
                        if (secondAutoText) {
                            Logger.info(`Auto-solving attempt 2/2: ${secondAutoText}`, null, contextToken);
                            try {
                                if (!isBackground && !(await waitIfSessionPaused(token))) return;
                                await submitCaptchaAndVerify(page, currentFrame, secondAutoText, contextToken);
                                if (isBackground) return await performPortalScrape(page, contextToken);
                                if (session) markTiming(session, 'captchaSolvedMs');
                                return executeAsyncScrape(token, page);
                            } catch (innerError) {
                                if (isIncorrectCaptchaError(innerError)) {
                                    queueStatisticsUpdate(effectiveUsername, { incorrectCaptchaCountAuto: 1 }, session || { deviceId: '', deviceModel: '' });
                                }
                                throw innerError;
                            }
                        }
                    }
                }
            } catch (autoError) {
                if (isBackground) throw autoError;
                const message = safeString(autoError && autoError.message ? autoError.message : '', { maxLength: 220 });
                Logger.warn(`Auto-captcha failed; switching to manual entry. Cause: ${message || 'unknown'}`, null, contextToken);
                autoSolveFallbackMessage = message
                    ? `Auto-solve failed (${message}). Please solve the captcha manually.`
                    : 'Auto-solve failed. Please solve the captcha manually.';

                // After failed auto-solve, the portal may have rotated the captcha
                // and/or left error overlays in the frame.  Refresh to get a known-
                // good image that matches the server-side challenge.
                try {
                    const postFailFrame = getActiveFrame(page, currentFrame) || currentFrame;
                    const freshBuffer = await refreshCaptcha(page, postFailFrame, contextToken);
                    if (freshBuffer) {
                        currentCaptchaBuffer = freshBuffer;
                        currentFrame = getActiveFrame(page, postFailFrame) || postFailFrame;
                    }
                } catch (refreshErr) {
                    Logger.warn(`Post-auto-solve captcha refresh failed: ${refreshErr.message}`, null, contextToken);
                }
            }
        }

        if (isBackground) throw new Error('Auto-captcha failed in background mode.');

        // Keep session frame reference in sync with the potentially-navigated frame.
        session.captchaFrame = getActiveFrame(page, currentFrame) || currentFrame;

        session.status = 'manual_captcha';
        session.captchaImage = `data:image/png;base64,${currentCaptchaBuffer.toString('base64')}`;
        session.message = canAutoSolve
            ? (autoSolveFallbackMessage || 'Auto-solve failed. Please solve the captcha manually.')
            : 'Please solve the captcha manually.';
        notifySessionUpdated(token);

        if (!session.manualCaptchaCounted) {
            session.manualCaptchaCounted = true;
            queueStatisticsUpdate(effectiveUsername, { gradeRefreshCountCaptcha: 1 }, session);
        }
    } catch (error) {
        if (isBackground) throw error;

        Logger.error(`Portal flow error: ${error.message}`, null, token);
        if (session && typeof session.cleanup === 'function') {
            await session.cleanup().catch(() => { });
            session.cleanup = null;
        }
        session.status = 'error';
        session.error = error.message;
        flushTimingLog(session, token, { status: 'error' });
        notifySessionUpdated(token);
        queueStatisticsUpdate(effectiveUsername, { failedRefreshCount: 1 }, session);
    }
}

async function startGradePortalFlow(token, browser, page, options = {}) {
    return unifiedIviewFlow(token, browser, page, options);
}

async function fetchGradesForNotifications(username, passwordPlain) {
    return enqueueUserTask(username, async () => {
        let cleanup = null;
        try {
            const launched = await launchBrowser();
            cleanup = launched.close;
            const page = launched.page;

            await authenticatePortalLogin(page, username, passwordPlain, 'notifier');

            const result = await unifiedIviewFlow('notifier', launched.browser, page, {
                isBackground: true,
                username,
                passwordPlain
            });

            return {
                grades: (result && Array.isArray(result.grades)) ? result.grades : [],
                studentInfo: (result && result.studentInfo) ? result.studentInfo : {}
            };
        } finally {
            if (cleanup) await cleanup().catch(() => { });
        }
    });
}


async function runBackgroundCheckForUser(userDoc) {
    if (!isMongoEnabled()) return;
    if (!userDoc || !isValidIdentifier(userDoc._id)) return;

    const username = userDoc._id;
    if (!isUsernameAllowedForAutoSolveAndPush(username)) {
        Logger.info(`Skipping notifications for non-whitelisted user ${username}.`);
        await removeAllSubscriptions(username);
        return;
    }

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
        const lastSeenGradesRaw = entry.lastSeenGrades;
        const pushSubscription = entry.pushSubscription;
        const hasPreviousData = Array.isArray(lastSeenGradesRaw) && lastSeenGradesRaw.length > 0;
        const trackedPrevious = normalizeTrackedGrades(lastSeenGradesRaw || []);
        const previousByIdentity = new Map(trackedPrevious.map(g => [buildGradeIdentity(g), g]));

        const sentNotifications = Array.isArray(entry.sentNotifications) ? [...entry.sentNotifications] : [];
        const sentSet = new Set(
            sentNotifications
                .filter(item => item && typeof item.notificationKey === 'string')
                .map(item => item.notificationKey)
        );

        let pushStillValid = true;

        for (const grade of currentTrackedGrades) {
            const gradeVal = grade.grade;
            if (!hasGradeValue(gradeVal)) continue;

            const identity = buildGradeIdentity(grade);
            const previous = previousByIdentity.get(identity);

            const isNewSubject = !previous;
            const isChangedGrade = previous && previous.grade !== gradeVal;

            if (hasPreviousData && (isNewSubject || isChangedGrade)) {
                const notificationKey = `${identity}::${gradeVal}`;
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
setInterval(() => {
    runSessionWatchdog().catch((error) => {
        Logger.error(`Session watchdog failed: ${error.message}`);
    });
}, SESSION_WATCHDOG_TICK_MS);

app.get('/api/features', (req, res) => {
    const mongoEnabled = isMongoEnabled();
    const autoSolveGloballyEnabled = process.env.DISABLE_AUTO_CAPTCHA !== 'true';
    const params = getParams(req);
    const usernameAllowed = params.username
        ? isUsernameAllowedForAutoSolveAndPush(params.username)
        : !isAutoSolveWhitelistEnabled;
    res.json({
        mongoEnabled,
        pushEnabled: mongoEnabled && hasVapidConfig,
        vapidAvailable: hasVapidConfig,
        autoSolveAvailable: autoSolveGloballyEnabled && isAutoSolveConfigured() && usernameAllowed,
        usernameAllowedForAutoSolveAndPush: usernameAllowed,
        autoSolveWhitelistEnabled: isAutoSolveWhitelistEnabled,
        autoSolveWhitelistActive: isAutoSolveWhitelistActive
    });
});

app.get('/api/push/vapid-key', (req, res) => {
    if (!isMongoEnabled()) {
        return res.json({ publicKey: '' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/login', async (req, res) => {
    const params = getParams(req);
    const { username, password, deviceId, deviceModel } = params;

    if (!isValidIdentifier(username) || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }

    Logger.info('Login request received', req);

    let cleanup = null;
    try {
        const launched = await launchBrowser();
        cleanup = launched.close;
        const page = launched.page;

        await authenticatePortalLogin(page, username, password);

        const currentCookies = await page.cookies();
        await launched.close();

        if (isMongoEnabled()) {
            const passwordBase64 = Buffer.from(password, 'utf8').toString('base64');
            await syncStoredPasswordIfSubscriptionExists(username, passwordBase64);
            queueStatisticsUpdate(username, {}, params);
        }

        Logger.info('Login successful. Returning cookies.', req);
        res.json({ success: true, cookies: currentCookies });
    } catch (error) {
        return apiErrorHandler(req, res, error, {
            ...params,
            context: 'Login error',
            statsIncrements: { failedLoginCount: 1 },
            cleanup
        });
    }
});


app.post('/api/refresh-grades', async (req, res) => {
    const params = getParams(req);
    const { username, deviceId, deviceModel, autoSolveEnabled, passwordBase64, cookies } = params;
    const usernameAllowed = isUsernameAllowedForAutoSolveAndPush(username);
    const canAutoSolve = process.env.DISABLE_AUTO_CAPTCHA !== 'true' && autoSolveEnabled && usernameAllowed;
    const hasCookies = Array.isArray(cookies) && cookies.length > 0;
    const canForceLogin = isValidIdentifier(username) && isValidBase64(passwordBase64);
    const forceLogin = !hasCookies && canForceLogin;

    try {
        if (isValidIdentifier(username)) {
            queueStatisticsUpdate(username, { gradeRefreshCount: 1 }, params);
        }

        Logger.info('Grade refresh request received', req, username);

        if (!hasCookies && !forceLogin) {
            if (isValidIdentifier(username)) {
                queueStatisticsUpdate(username, { failedRefreshCount: 1 }, params);
            }
            return res.status(400).json({ error: 'No session cookies and no valid password available. Please login first.' });
        }

        Logger.info('Starting refresh session...', req, username);

        const existingToken = canAutoSolve ? getInFlightSessionTokenForUser(username) : null;
        if (existingToken) {
            const existingSession = SESSIONS.get(existingToken);
            Logger.info(`Reusing in-flight session token ${existingToken} for ${username}.`, req, username);
            return res.json({
                success: true,
                token: existingToken,
                status: (existingSession && existingSession.status) || 'loading',
                message: 'Refresh already in progress.'
            });
        } else if (!canAutoSolve) {
            Logger.info('Auto-captcha disabled (client/server); creating a fresh session without token reuse.', req, username);
        }

        const sessionToken = createSession(null, null, params);

        res.json({
            success: true,
            token: sessionToken,
            status: 'queued',
            message: 'Waiting for other requests to finish...'
        });

        enqueueUserTask(username, async () => {
            const session = SESSIONS.get(sessionToken);
            if (!session) return;

            let launched;
            try {
                launched = await launchBrowser();
                const page = launched.page;

                session.browser = launched.browser;
                session.context = launched.context || null;
                session.page = page;
                session.cleanup = launched.close;
                session.status = 'loading';
                markTiming(session, 'browserReadyMs');
                notifySessionUpdated(sessionToken);

                await unifiedIviewFlow(sessionToken, launched.browser, page, {
                    cookies,
                    passwordBase64,
                    username,
                    autoSolveEnabled,
                    forceLogin
                });
            } catch (error) {
                Logger.error(`Queued refresh error for ${username}: ${error.message}`, null, sessionToken);
                if (launched && typeof launched.close === 'function') {
                    await launched.close().catch(() => { });
                }
                session.status = 'error';
                session.error = error.message;
                flushTimingLog(session, sessionToken, { status: 'error' });
                notifySessionUpdated(sessionToken);

                queueStatisticsUpdate(username, { failedRefreshCount: 1 }, params);
            }
        }, { token: sessionToken });
    } catch (error) {
        return apiErrorHandler(req, res, error, {
            ...params,
            context: 'Refresh grades error',
            statsIncrements: { failedRefreshCount: 1 }
        });
    }
});


app.post('/api/solve-captcha', async (req, res) => {
    const params = getParams(req);
    const { token, answer } = params;

    const session = SESSIONS.get(token);
    if (!session) {
        return res.status(404).json({ error: 'Session expired' });
    }

    if (!answer) {
        return res.status(400).json({ error: 'Captcha answer is required.' });
    }

    try {
        const { page, captchaFrame } = session;

        await submitCaptchaAndVerify(page, captchaFrame, answer, token);
        markTiming(session, 'captchaSolvedMs');
        executeAsyncScrape(token, page);

        const currentCookies = await page.cookies();
        return res.json({
            success: true,
            status: 'loading',
            message: 'Refreshing grades...',
            cookies: currentCookies
        });
    } catch (error) {
        if (session && session.page && session.page.isClosed && session.page.isClosed()) {
            await closeSession(token);
            return res.status(500).json({ error: 'Browser session lost' });
        }

        const isWrong = isIncorrectCaptchaError(error);
        if (isWrong) {
            queueStatisticsUpdate(session.username, { incorrectCaptchaCount: 1 }, session);

            const refreshedBuffer = await refreshCaptcha(session.page, session.captchaFrame, token);
            if (refreshedBuffer) {
                return res.status(400).json({
                    error: error.message || 'Incorrect captcha code. Please try again.',
                    captchaImage: `data:image/png;base64,${refreshedBuffer.toString('base64')}`
                });
            }
        }

        return apiErrorHandler(req, res, error, {
            ...session,
            token,
            context: 'Captcha solve error',
            statsIncrements: isWrong ? {} : { failedRefreshCountCaptcha: 1 }
        });
    }
});


app.get('/api/status', (req, res) => {
    const { token } = getParams(req);
    const waitMsRaw = parseNonNegativeInt(req.query && req.query.waitMs, 0);
    const waitMs = Math.min(waitMsRaw, STATUS_LONG_POLL_TIMEOUT_MS);
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }

    const respondWithSession = (session) => {
        if (!session) {
            return res.json({ status: 'expired' });
        }

        touchSessionStatusPoll(token);

        if (session.status === 'completed') {
            const result = session.result;
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
            if (typeof session.cleanup === 'function') {
                session.cleanup().catch(() => { });
                session.cleanup = null;
            }
            SESSIONS.delete(token);
            return res.json({ status: 'error', error });
        }

        return res.json({ status: session.status || 'loading' });
    };

    const session = SESSIONS.get(token);
    if (!session) return respondWithSession(null);
    touchSessionStatusPoll(token);

    const shouldWait = waitMs > 0 && (session.status === 'loading' || session.status === 'queued');
    if (!shouldWait) return respondWithSession(session);

    return waitForSessionUpdate(token, waitMs).then(() => {
        const latest = SESSIONS.get(token);
        return respondWithSession(latest || null);
    }).catch(() => {
        const latest = SESSIONS.get(token);
        return respondWithSession(latest || null);
    });
});

app.post('/api/refresh-captcha', async (req, res) => {
    const { token } = getParams(req);
    const session = SESSIONS.get(token);
    if (!session) {
        return res.status(404).json({ error: 'Session expired' });
    }

    queueStatisticsUpdate(session.username, { captchaRefreshCount: 1 }, session);

    const buffer = await refreshCaptcha(session.page, session.captchaFrame, token);
    if (!buffer) {
        return res.status(500).json({ error: 'Failed to refresh captcha' });
    }

    return res.json({
        success: true,
        captchaImage: `data:image/png;base64,${buffer.toString('base64')}`
    });
});


app.post('/api/logout', async (req, res) => {
    const { username, deviceId } = getParams(req);

    for (const [token, session] of SESSIONS.entries()) {
        if (!username || session.username === username) {
            await closeSession(token);
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

    const { username, deviceId } = getParams(req);

    if (!isValidIdentifier(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }
    const usernameAllowed = isUsernameAllowedForAutoSolveAndPush(username);


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
        usernameAllowedForAutoSolveAndPush: usernameAllowed,
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

    const params = getParams(req);
    const {
        username,
        passwordBase64,
        deviceId,
        deviceModel,
        checkIntervalMinutes,
        consentAccepted,
        autoSolveEnabled,
        raw
    } = params;
    const pushSubscription = raw.pushSubscription;


    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return res.status(400).json({ error: 'Invalid username or deviceId.' });
    }

    if (!isUsernameAllowedForAutoSolveAndPush(username)) {
        return res.status(403).json({
            error: 'This username is not allowed to use auto solve or push notifications.',
            usernameNotAllowed: true
        });
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

    queueStatisticsUpdate(username, {}, params);


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

    const { username, deviceId } = getParams(req);

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

    const { username } = getParams(req);
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

    const { username, checkIntervalMinutes } = getParams(req);
    if (!isValidIdentifier(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }


    const cols = getMongoCollections();
    if (!cols) {
        return res.status(503).json({ error: 'Database unavailable.' });
    }

    const updateResult = await cols.subscriptions.updateOne(
        { _id: username },
        {
            $set: {
                checkIntervalMinutes,
                updatedAt: new Date()
            }

        }
    );

    if (!updateResult.matchedCount) {
        return res.status(404).json({ error: 'Subscription document not found for this user.' });
    }

    return res.json({
        success: true,
        checkIntervalMinutes,
        defaultApplied: checkIntervalMinutes === DEFAULT_INTERVAL_MINUTES && !ALLOWED_INTERVALS.has(parseNonNegativeInt(req.body && req.body.checkIntervalMinutes, -1))
    });

});

app.post('/api/statistics/app-open', async (req, res) => {
    if (!isMongoEnabled()) {
        return res.status(503).json({
            error: 'Statistics are disabled because MongoDB is not configured.',
            featureDisabled: true
        });
    }

    const params = getParams(req);
    const { username, deviceId, countOnlineOpen, offlineOpenDelta } = params;

    if (!isValidIdentifier(username) || !isValidIdentifier(deviceId)) {
        return res.status(400).json({ error: 'Invalid username or deviceId.' });
    }

    queueStatisticsUpdate(username, {}, {
        ...params,
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

let shuttingDown = false;

async function shutdownGracefully(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    Logger.info(`Received ${signal}. Draining Mongo stats queue...`);
    await drainStatsQueue(MONGO_STATS_DRAIN_TIMEOUT_MS).catch((error) => {
        Logger.error(`Stats queue drain failed during ${signal}: ${error.message}`);
    });

    if (mongoState.client) {
        await mongoState.client.close().catch(() => { });
    }
    if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
        await sharedBrowser.close().catch(() => { });
    }

    process.exit(0);
}

process.on('SIGINT', () => {
    shutdownGracefully('SIGINT').catch((error) => {
        Logger.error(`Shutdown error on SIGINT: ${error.message}`);
        process.exit(1);
    });
});

process.on('SIGTERM', () => {
    shutdownGracefully('SIGTERM').catch((error) => {
        Logger.error(`Shutdown error on SIGTERM: ${error.message}`);
        process.exit(1);
    });
});
