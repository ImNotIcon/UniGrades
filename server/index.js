const express = require('express');
require('dotenv').config();
const puppeteer = require('puppeteer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const { scrapeGrades } = require('./scraper');
const { solveCaptcha } = require('./captcha_solver');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SESSIONS = new Map();

// --- Push Notification Setup ---
const PUSH_SUBSCRIPTIONS = new Map(); // username -> { subscription, cookies, lastGrades }

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('Web Push configured with VAPID keys.');
}

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

// --- Utility Helpers ---

async function debugScreenshot(page, name) {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
        const screenshotsDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.join(screenshotsDir, `${timestamp}_${name}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`Debug screenshot saved: ${filename}`);
    } catch (e) {
        console.error('Failed to take debug screenshot:', e.message);
    }
}

function createSession(browser, page, status = 'loading') {
    const token = Math.random().toString(36).substring(7);
    SESSIONS.set(token, { browser, page, status, lastActive: Date.now() });
    return token;
}

function getActiveFrame(page, frame) {
    if (frame && !frame.isDetached()) return frame;
    return page.frames().find(f =>
        f.url().includes('zups_piq_st_acad_work_ov') || f.url().includes('sap/bc/webdynpro')
    ) || null;
}

function sanitizeCookies(cookies) {
    return cookies.map(c => {
        let domain = c.domain || '';
        if (domain.includes('localhost') || !domain) domain = 'progress.upatras.gr';
        domain = domain.replace(/https?:\/\//, '').split(':')[0];
        return {
            name: c.name, value: c.value, domain,
            path: c.path || '/',
            secure: c.secure !== undefined ? c.secure : true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
            sameSite: c.sameSite || 'Lax'
        };
    });
}

async function findCaptchaImage(frame) {
    let el = null;
    try {
        await frame.waitForSelector(CAPTCHA_IMG_SELECTORS, { timeout: 10000 });
        el = await frame.$(CAPTCHA_IMG_SELECTORS);
    } catch (e) {
        console.warn('Captcha selector wait timed out, trying fallback...');
    }
    if (!el) el = await frame.$('img');
    if (!el) throw new Error('Captcha element not found');
    await waitForImageLoad(frame, el);
    return el;
}

async function waitForImageLoad(frame, imgElement) {
    await frame.waitForFunction(
        el => el.complete && el.naturalWidth > 0,
        { timeout: 5000 },
        imgElement
    ).catch(() => console.warn('Image load wait timed out, proceeding anyway.'));
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    return { browser, page };
}

// --- Core Navigation & Scraping ---

async function navigateToIview(page) {
    console.log('Navigating to Academic Work iView...');
    for (let i = 0; i < 2; i++) {
        try {
            const response = await page.goto(ACADEMIC_IVIEW_URL, { waitUntil: 'networkidle2', timeout: 45000 });
            if (response && response.status() !== 404) return;
        } catch (err) {
            console.warn(`Navigation attempt ${i + 1} failed:`, err.message);
        }
    }
    console.warn('Direct navigation failed, attempting portal home fallback.');
    await page.goto('https://progress.upatras.gr/irj/portal', { waitUntil: 'networkidle2', timeout: 45000 });
}

async function findGradesFrame(page, checkForContent = true, timeoutMs = 15000) {
    const startTime = Date.now();
    try {
        const frame = await page.waitForFrame(
            f => f.url().includes('zups_piq_st_acad_work_ov') || f.url().includes('sap/bc/webdynpro'),
            { timeout: timeoutMs }
        );
        if (!checkForContent) return frame;

        const remainingTime = Math.max(timeoutMs - (Date.now() - startTime), 5000);
        await frame.waitForSelector('.urST, .urLinStd, table, tr', { timeout: remainingTime });
        return frame;
    } catch (e) {
        console.warn('findGradesFrame timed out:', e.message);
        return null;
    }
}

async function executeAsyncScrape(token, browser, page) {
    const session = SESSIONS.get(token);
    if (!session) return;

    session.status = 'loading';
    try {
        let result;
        for (let i = 0; i < 3; i++) {
            result = await scrapeGrades(page);
            if (result.grades && result.grades.length > 0) break;
            await page.waitForFunction(
                () => document.querySelector('table, .urST, iframe'),
                { timeout: 8000 }
            ).catch(() => { });
        }
        if (!result || !result.grades || result.grades.length === 0) {
            result = await scrapeGrades(page);
        }

        const sess = SESSIONS.get(token);
        if (!sess) return;

        const newCookies = await page.cookies();
        await browser.close();

        sess.status = 'completed';
        sess.result = { grades: result.grades, studentInfo: result.studentInfo, cookies: newCookies };
        console.log('Async scraping completed successfully.');
    } catch (err) {
        console.error('Final background scrape failed:', err.message);
        const sess = SESSIONS.get(token);
        if (sess) {
            if (sess.browser) await sess.browser.close().catch(() => { });
            sess.status = 'error';
            sess.error = err.message;
        }
    }
}

// --- Captcha Handling ---

async function refreshCaptcha(page, captchaFrame) {
    console.log('Refreshing captcha...');
    try {
        const activeFrame = getActiveFrame(page, captchaFrame);
        if (!activeFrame) throw new Error('Refresh failed: Frame lost');

        const refreshBtn = await activeFrame.$('div[title="Ανανέωση"]') || await activeFrame.$('img[src*="TbRefresh.gif"]');
        if (!refreshBtn) {
            console.log('Refresh button not found.');
            return null;
        }

        const oldCaptchaEl = await activeFrame.$(CAPTCHA_IMG_SELECTORS);
        const oldSrc = oldCaptchaEl ? await (await oldCaptchaEl.getProperty('src')).jsonValue() : '';

        await refreshBtn.click();

        try {
            await activeFrame.waitForFunction(
                (prevSrc, selectors) => {
                    const img = document.querySelector(selectors);
                    return img && img.src !== prevSrc;
                },
                { timeout: 10000 },
                oldSrc, CAPTCHA_IMG_SELECTORS
            );
        } catch (e) {
            console.warn('Timed out waiting for captcha src change, proceeding anyway.');
        }

        let newCaptchaEl = await activeFrame.$(CAPTCHA_IMG_SELECTORS) || await activeFrame.$('img');
        if (!newCaptchaEl) throw new Error('New captcha element not found');

        await waitForImageLoad(activeFrame, newCaptchaEl);
        return await newCaptchaEl.screenshot();
    } catch (e) {
        console.error('Error refreshing captcha:', e);
        return null;
    }
}

async function submitCaptchaAndVerify(page, captchaFrame, answer) {
    const activeFrame = getActiveFrame(page, captchaFrame);
    if (!activeFrame) throw new Error('Captcha frame lost');

    const inputField = await activeFrame.$('input[type="text"]')
        || await activeFrame.$('input.lsField__input')
        || await activeFrame.$('input.urEdf2TxtL');

    let submitBtn = await activeFrame.$('div.lsButton[ct="B"]');
    if (!submitBtn) {
        const candidates = await activeFrame.$$('div.lsButton, [ct="B"], a, span, div, button');
        for (const b of candidates) {
            const text = await (await b.getProperty('innerText')).jsonValue();
            const cleanText = (text || '').trim();
            if (['ΕΠΟΜΕΝΟ', 'ΝΕΧΤ', 'NEXT', 'Next'].some(t => cleanText.includes(t))) {
                submitBtn = b;
                break;
            }
        }
    }

    if (!inputField || !submitBtn) throw new Error('Could not find captcha input or submit button');

    try {
        await inputField.focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
    } catch (e) {
        console.warn('Focus/Select error:', e.message);
    }
    await inputField.type(answer);

    try {
        await submitBtn.click();
    } catch (e) {
        await activeFrame.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (btn && btn.click) btn.click();
        }, 'input[type="submit"], button, .urBtnStd, img[src*="BTN_OK"]');
    }

    console.log('Waiting for captcha verification result...');
    const submitStart = Date.now();

    while (Date.now() - submitStart < 25000) {
        for (const f of page.frames()) {
            try {
                if (f.isDetached()) continue;
                const status = await f.evaluate(() => {
                    const text = document.body.innerText;
                    const okIcon = document.querySelector('img[src*="SuccessMessage"], img[src*="WD_M_OK"]');
                    const errIcon = document.querySelector('img[src*="ErrorMessage"], img[src*="WD_M_ERROR"]');

                    if (okIcon || text.includes('OK!') || text.includes('ΟΚ!')) return 'SUCCESS';
                    if (errIcon || text.includes('ERROR!') || text.includes('Λάθος')) return 'ERROR';
                    if (document.querySelector('table[id*="GRADES"]')) return 'SUCCESS';
                    return null;
                });

                if (status === 'SUCCESS') {
                    console.log('Verification Success!');
                    return true;
                }
                if (status === 'ERROR') {
                    console.log('Verification Error flagged by portal.');
                    throw new Error('Incorrect captcha code. Please try again.');
                }
            } catch (e) {
                if (e.message.includes('Incorrect captcha')) throw e;
            }
        }
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 2000 }).catch(() => { });
    }

    const finalCheck = await page.evaluate(() => !!document.querySelector('table[id*="GRADES"]'));
    if (finalCheck) return true;

    throw new Error('Verification timed out (No success indicator found)');
}

// --- Grade Portal Flow (captcha + scrape) ---

async function startGradePortalFlow(token, browser, page, { skipNavigation = false } = {}) {
    const session = SESSIONS.get(token);
    if (!session) return;

    try {
        if (!skipNavigation) await navigateToIview(page);

        const captchaFrame = await findGradesFrame(page, false, 12000);
        if (!captchaFrame) throw new Error('Captcha/Grades frame not found.');

        session.captchaFrame = captchaFrame;
        console.log('Capturing captcha element...');

        const captchaEl = await findCaptchaImage(captchaFrame);
        const captchaBuffer = await captchaEl.screenshot({ timeout: 60000 });
        let currentCaptchaBuffer = captchaBuffer;

        if (process.env.DISABLE_AUTO_CAPTCHA !== 'true') {
            const MAX_AUTO_ATTEMPTS = 2;
            let currentFrame = captchaFrame;

            for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
                const autoText = await solveCaptcha(currentCaptchaBuffer);
                if (autoText) {
                    console.log(`Auto-solving attempt ${attempt}/${MAX_AUTO_ATTEMPTS}: ${autoText}`);
                    try {
                        if (await submitCaptchaAndVerify(page, currentFrame, autoText)) {
                            return executeAsyncScrape(token, browser, page);
                        }
                    } catch (err) {
                        console.warn(`Auto-solve attempt ${attempt} failed: ${err.message}`);
                    }
                } else {
                    console.warn(`Auto-solve attempt ${attempt}: <null>`);
                }

                // Refresh captcha for next attempt (unless it's the last one)
                // If it IS the last attempt, we still need a fresh captcha for manual solving!
                if (attempt < MAX_AUTO_ATTEMPTS) {
                    console.log('Refreshing captcha for next auto-solve attempt...');
                    const refreshedBuffer = await refreshCaptcha(page, currentFrame);
                    if (refreshedBuffer) {
                        currentCaptchaBuffer = refreshedBuffer;
                        currentFrame = getActiveFrame(page, currentFrame) || currentFrame;
                    } else {
                        console.warn('Could not refresh captcha, breaking auto-solve loop.');
                        break;
                    }
                } else {
                    // Last attempt failed. Refresh one last time for the user to solve manually.
                    console.log('Last auto-solve attempt failed. Refreshing for manual solve...');
                    const refreshedBuffer = await refreshCaptcha(page, currentFrame);
                    if (refreshedBuffer) {
                        currentCaptchaBuffer = refreshedBuffer;
                    }
                }
            }
            console.log('All auto-solve attempts exhausted. Falling back to manual captcha.');
        }

        const autoSolveDisabled = process.env.DISABLE_AUTO_CAPTCHA === 'true';
        session.status = 'manual_captcha';
        session.captchaImage = `data:image/png;base64,${currentCaptchaBuffer.toString('base64')}`;
        session.message = autoSolveDisabled
            ? "Captcha auto-solve is disabled. Please solve it manually."
            : "Automatic captcha solving failed. Please solve it manually.";

    } catch (error) {
        console.error('Portal flow error:', error);
        if (session.browser) await session.browser.close().catch(() => { });
        session.status = 'error';
        session.error = error.message;
    }
}

// --- API Routes ---

// Login: authenticates only, returns cookies. Does NOT fetch grades.
app.post('/api/login', async (req, res) => {
    console.log('Login request received');
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Missing credentials' });
    }

    let browser;
    try {
        ({ browser } = { browser: null });
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        // Navigate to login page
        console.log('Navigating to login page...');
        await page.goto('https://progress.upatras.gr', { waitUntil: 'networkidle2' });

        let usernameSelector = '#inputEmail';
        const passwordSelector = '#inputPassword';

        try { await page.waitForSelector(usernameSelector, { timeout: 3000 }); }
        catch (e) {
            if (!page.url().includes('idp.upnet.gr')) {
                const loginBtn = await page.$('a[href*="login"], a[href*="Login"], div[title="Είσοδος"]');
                if (loginBtn) { await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), loginBtn.click()]); }
            }
            const altSelector = '#username, input[name="j_username"], input[name="username"]';
            const found = await page.waitForSelector(`${usernameSelector}, ${altSelector}`, { timeout: 5000 }).catch(() => null);
            if (found) {
                usernameSelector = await page.evaluate(el => el.id ? '#' + el.id : (el.name ? `input[name="${el.name}"]` : 'input[type="text"]'), found);
            }
        }

        console.log('Entering credentials...');
        await page.type(usernameSelector, username);
        await page.type(passwordSelector, password);
        console.log('Submitting login form...');
        await page.waitForSelector('#loginButton', { visible: true });

        // Use evaluate for a more reliable click
        const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => console.log('Navigation timeout (might be checking for errors)'));
        await page.evaluate(() => document.querySelector('#loginButton').click());
        await navigationPromise;

        // Error check
        try {
            const errorElement = await page.$('.form-element.form-error');
            if (errorElement) {
                const errorText = await page.evaluate(el => el.innerText.trim(), errorElement);
                console.log(`Login error detected: ${errorText}`);
                await browser.close();
                return res.status(401).json({
                    error: errorText.includes('Άγνωστο') ? 'Unknown username'
                        : errorText.includes('Λανθασμένος') ? 'Wrong password'
                            : errorText
                });
            }
        } catch (e) {
            console.log('Safe check: error element detection skipped (likely navigated):', e.message);
        }

        // Wait for session cookies to confirm login success
        await page.waitForFunction(() => document.cookie.includes('MYSAPSSO2') || document.cookie.includes('saplb'), { timeout: 15000 });

        const currentCookies = await page.cookies();
        await browser.close();

        console.log('Login successful. Returning cookies.');
        res.json({ success: true, cookies: currentCookies });

    } catch (error) {
        console.error('Login error:', error);
        if (browser) await browser.close().catch(() => { });
        res.status(500).json({ error: error.message });
    }
});

// Refresh Grades: uses cookies to open the portal, handle captcha, and scrape grades.
// This is the main grade-fetching endpoint.
app.post('/api/refresh-grades', async (req, res) => {
    console.log('Grade refresh request received');
    const { cookies } = req.body;

    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        return res.status(400).json({ error: 'No session cookies provided. Please login first.' });
    }

    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await page.setCookie(...sanitizeCookies(cookies));

        // Navigate directly to the iView to check cookie validity
        console.log('Navigating to iView with session cookies...');
        await page.goto(ACADEMIC_IVIEW_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        if (await isBodyEmpty(page)) {
            console.log('Cookies expired (empty body). Login required.');
            await browser.close();
            return res.status(401).json({ error: 'Session expired. Please login again.', expired: true });
        }

        console.log('Session valid! Starting grade portal flow...');
        const sessionToken = createSession(browser, page);

        res.json({ success: true, token: sessionToken, status: 'loading', message: 'Fetching grades...' });

        // Already on the iView, skip navigation
        startGradePortalFlow(sessionToken, browser, page, { skipNavigation: true });

    } catch (error) {
        console.error('Grade refresh error:', error);
        if (browser) await browser.close().catch(() => { });
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/solve-captcha', async (req, res) => {
    const { token: solveToken, answer } = req.body;
    const session = SESSIONS.get(solveToken);
    if (!session) return res.status(404).json({ error: 'Session expired' });

    try {
        const { browser, page, captchaFrame } = session;
        await submitCaptchaAndVerify(page, captchaFrame, answer);
        executeAsyncScrape(solveToken, browser, page);

        const currentCookies = await page.cookies();
        res.json({ success: true, status: 'loading', message: 'Refreshing grades...', cookies: currentCookies });
    } catch (error) {
        console.error('Captcha solve error:', error.message);

        // Only close session if browser is actually disconnected or crashed
        if (session && session.browser && !session.browser.isConnected()) {
            SESSIONS.delete(solveToken);
            return res.status(500).json({ error: 'Browser session lost' });
        }

        // Otherwise keep session alive and let client retry/refresh
        return res.status(400).json({ error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const session = SESSIONS.get(token);
    if (!session) return res.json({ status: 'expired' });

    if (session.status === 'completed') {
        const r = session.result;
        SESSIONS.delete(token);
        return res.json({ status: 'completed', ...r });
    }
    if (session.status === 'manual_captcha') {
        return res.json({ status: 'manual_captcha', token, captchaImage: session.captchaImage, message: session.message });
    }
    if (session.status === 'error') {
        const err = session.error;
        SESSIONS.delete(token);
        return res.json({ status: 'error', error: err });
    }
    return res.json({ status: session.status || 'loading' });
});

app.post('/api/refresh-captcha', async (req, res) => {
    const { token } = req.body;
    const session = SESSIONS.get(token);
    if (!session) return res.status(404).json({ error: 'Session expired' });

    const buffer = await refreshCaptcha(session.page, session.captchaFrame);
    if (buffer) {
        res.json({ success: true, captchaImage: `data:image/png;base64,${buffer.toString('base64')}` });
    } else {
        res.status(500).json({ error: 'Failed to refresh captcha' });
    }
});

app.post('/api/logout', (req, res) => { SESSIONS.clear(); res.json({ success: true }); });

// --- Push Notification Routes ---

app.get('/api/push/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', (req, res) => {
    const { subscription, username, cookies } = req.body;
    if (!subscription || !username) {
        return res.status(400).json({ error: 'Missing subscription or username' });
    }

    PUSH_SUBSCRIPTIONS.set(username, {
        subscription,
        cookies: cookies || null,
        lastGrades: [],
        lastChecked: null
    });

    console.log(`Push subscription saved for user: ${username}`);
    res.json({ success: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
    const { username } = req.body;
    if (username) {
        PUSH_SUBSCRIPTIONS.delete(username);
        console.log(`Push subscription removed for user: ${username}`);
    }
    res.json({ success: true });
});

// --- Background Grade Checker ---

async function checkGradesForUser(username, subData) {
    if (!subData.cookies) {
        console.log(`No cookies for ${username}, skipping background check.`);
        return;
    }

    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await page.setCookie(...sanitizeCookies(subData.cookies));
        await page.goto(ACADEMIC_IVIEW_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        if (await isBodyEmpty(page)) {
            console.log(`Session expired for ${username}, skipping.`);
            await browser.close();
            return;
        }

        // Find the grades frame
        const captchaFrame = await findGradesFrame(page, false, 12000);
        if (!captchaFrame) {
            console.log(`Could not find grades frame for ${username}.`);
            await browser.close();
            return;
        }

        // Try auto-solving captcha
        const captchaEl = await findCaptchaImage(captchaFrame).catch(() => null);
        if (captchaEl) {
            const captchaBuffer = await captchaEl.screenshot({ timeout: 60000 });
            const autoText = await solveCaptcha(captchaBuffer);
            if (autoText) {
                try {
                    await submitCaptchaAndVerify(page, captchaFrame, autoText);
                } catch (e) {
                    console.log(`Background captcha solve failed for ${username}: ${e.message}`);
                    await browser.close();
                    return;
                }
            } else {
                console.log(`Could not auto-solve captcha for ${username}.`);
                await browser.close();
                return;
            }
        }

        // Scrape grades
        let result;
        for (let i = 0; i < 3; i++) {
            result = await scrapeGrades(page);
            if (result.grades && result.grades.length > 0) break;
            await page.waitForFunction(() => document.querySelector('table, .urST, iframe'), { timeout: 8000 }).catch(() => { });
        }

        // Update cookies
        const newCookies = await page.cookies();
        subData.cookies = newCookies;

        await browser.close();

        if (!result || !result.grades || result.grades.length === 0) return;

        // Compare with last known grades
        const currentGradeKeys = new Set(result.grades.map(g => `${g.code}-${g.grade}`));
        const lastGradeKeys = new Set(subData.lastGrades.map(g => `${g.code}-${g.grade}`));

        const newGrades = result.grades.filter(g => {
            const key = `${g.code}-${g.grade}`;
            return !lastGradeKeys.has(key) && g.grade && g.grade.trim() !== '';
        });

        subData.lastGrades = result.grades;
        subData.lastChecked = new Date();

        if (newGrades.length > 0 && subData.lastGrades.length > 0) {
            // Only notify if we had previous grades (not first check)
            if (lastGradeKeys.size > 0) {
                const gradeList = newGrades.map(g => `${g.title}: ${g.grade}`).join(', ');
                const notifBody = newGrades.length === 1
                    ? `New grade: ${newGrades[0].title} — ${newGrades[0].grade}`
                    : `${newGrades.length} new grades: ${gradeList}`;

                try {
                    await webpush.sendNotification(
                        subData.subscription,
                        JSON.stringify({
                            title: '📊 New Grade Available!',
                            body: notifBody,
                            icon: '/pwa-192x192.png',
                            badge: '/pwa-192x192.png',
                            tag: 'new-grade',
                            data: { url: '/' }
                        })
                    );
                    console.log(`Push notification sent to ${username}: ${notifBody}`);
                } catch (pushErr) {
                    console.error(`Failed to send push to ${username}:`, pushErr.message);
                    if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
                        PUSH_SUBSCRIPTIONS.delete(username);
                        console.log(`Removed expired subscription for ${username}`);
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Background check error for ${username}:`, err.message);
        if (browser) await browser.close().catch(() => { });
    }
}

// Check grades every 30 minutes for subscribed users
const BACKGROUND_CHECK_INTERVAL = 30 * 60 * 1000;
setInterval(async () => {
    if (PUSH_SUBSCRIPTIONS.size === 0) return;
    console.log(`Background grade check starting for ${PUSH_SUBSCRIPTIONS.size} user(s)...`);

    for (const [username, subData] of PUSH_SUBSCRIPTIONS) {
        await checkGradesForUser(username, subData);
        // Small delay between users to avoid overwhelming the server
        await new Promise(r => setTimeout(r, 5000));
    }

    console.log('Background grade check complete.');
}, BACKGROUND_CHECK_INTERVAL);

app.listen(3001, '0.0.0.0', () => console.log('Server running on 0.0.0.0:3001'));
