const { GoogleGenerativeAI } = require("@google/generative-ai");
const { PNG } = require("pngjs");
const fs = require("fs");
const path = require("path");

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3-flash-preview"];
const DEFAULT_GEMINI_PROMPT = "Extract the 6-character alphanumeric captcha text from this image. Return ONLY the 6 characters. No spaces.";
const DEFAULT_OLLAMA_PROMPT = "Return exactly the 6 letters. No explanation. No spaces.";
const OLLAMA_CROP_BORDER_SHAVE = 3;
const OLLAMA_ADAPTIVE_BLOCK_SIZE = 11;
const OLLAMA_ADAPTIVE_C = 2;
const OLLAMA_ROW_DENSITY_THRESHOLD = 6;
const OLLAMA_COL_DENSITY_THRESHOLD = 4;
const OLLAMA_CROP_PADDING = 2;

function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function shouldSaveOllamaDebugCrops() {
    const debugScreenshots = (process.env.DEBUG_SCREENSHOTS || "").trim().toLowerCase() === "true";
    const debugCrops = (process.env.OLLAMA_DEBUG_SAVE_CROPS || "").trim().toLowerCase() === "true";
    return debugScreenshots || debugCrops;
}

function saveOllamaDebugCrop(buffer, stage, token) {
    if (!shouldSaveOllamaDebugCrops()) return;

    try {
        const screenshotsDir = path.join(__dirname, "screenshots");
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const tokenSafe = (token || "no-token").toString().slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `${timestamp}_${tokenSafe}_ollama_${stage}.png`;
        const fullPath = path.join(screenshotsDir, filename);
        fs.writeFileSync(fullPath, buffer);
        Logger.info(`[Captcha] Saved debug crop image: ${fullPath}`, null, token);
    } catch (error) {
        Logger.warn(`[Captcha] Failed to save debug crop image: ${getErrorMessage(error)}`, null, token);
    }
}

function gaussianKernel1D(size) {
    const sigma = 0.3 * (((size - 1) * 0.5) - 1) + 0.8;
    const center = Math.floor(size / 2);
    const kernel = new Float32Array(size);
    let sum = 0;

    for (let i = 0; i < size; i++) {
        const x = i - center;
        const w = Math.exp(-(x * x) / (2 * sigma * sigma));
        kernel[i] = w;
        sum += w;
    }

    for (let i = 0; i < size; i++) {
        kernel[i] /= sum;
    }

    return kernel;
}

function cropCaptchaForOllama(imageBuffer, token) {
    try {
        const png = PNG.sync.read(imageBuffer);
        const { width, height, data } = png;

        if (width <= (OLLAMA_CROP_BORDER_SHAVE * 2) + 2 || height <= (OLLAMA_CROP_BORDER_SHAVE * 2) + 2) {
            return imageBuffer;
        }

        const innerX = OLLAMA_CROP_BORDER_SHAVE;
        const innerY = OLLAMA_CROP_BORDER_SHAVE;
        const innerW = width - (OLLAMA_CROP_BORDER_SHAVE * 2);
        const innerH = height - (OLLAMA_CROP_BORDER_SHAVE * 2);
        const gray = new Uint8Array(innerW * innerH);

        for (let y = 0; y < innerH; y++) {
            const srcY = y + innerY;
            for (let x = 0; x < innerW; x++) {
                const srcX = x + innerX;
                const srcIdx = (srcY * width + srcX) * 4;
                const r = data[srcIdx];
                const g = data[srcIdx + 1];
                const b = data[srcIdx + 2];
                gray[(y * innerW) + x] = Math.round((0.299 * r) + (0.587 * g) + (0.114 * b));
            }
        }

        const kernel = gaussianKernel1D(OLLAMA_ADAPTIVE_BLOCK_SIZE);
        const radius = Math.floor(OLLAMA_ADAPTIVE_BLOCK_SIZE / 2);
        const blurredHorizontal = new Float32Array(innerW * innerH);
        const mask = new Uint8Array(innerW * innerH);

        for (let y = 0; y < innerH; y++) {
            for (let x = 0; x < innerW; x++) {
                let sum = 0;
                for (let k = 0; k < OLLAMA_ADAPTIVE_BLOCK_SIZE; k++) {
                    const sx = clamp(x + k - radius, 0, innerW - 1);
                    sum += gray[(y * innerW) + sx] * kernel[k];
                }
                blurredHorizontal[(y * innerW) + x] = sum;
            }
        }

        for (let y = 0; y < innerH; y++) {
            for (let x = 0; x < innerW; x++) {
                let weighted = 0;
                for (let k = 0; k < OLLAMA_ADAPTIVE_BLOCK_SIZE; k++) {
                    const sy = clamp(y + k - radius, 0, innerH - 1);
                    weighted += blurredHorizontal[(sy * innerW) + x] * kernel[k];
                }

                const idx = (y * innerW) + x;
                const threshold = weighted - OLLAMA_ADAPTIVE_C;
                mask[idx] = gray[idx] <= threshold ? 255 : 0;
            }
        }

        let y1 = 0;
        let y2 = innerH;
        let foundRow = false;
        for (let y = 0; y < innerH; y++) {
            let rowCount = 0;
            for (let x = 0; x < innerW; x++) {
                if (mask[(y * innerW) + x] > 0) rowCount++;
            }
            if (rowCount > OLLAMA_ROW_DENSITY_THRESHOLD) {
                if (!foundRow) {
                    y1 = y;
                    y2 = y;
                    foundRow = true;
                } else {
                    y2 = y;
                }
            }
        }

        const colScanStart = clamp(y1, 0, innerH - 1);
        let colScanEndExclusive = foundRow ? y2 : innerH;
        if (colScanEndExclusive <= colScanStart) {
            colScanEndExclusive = Math.min(innerH, colScanStart + 1);
        }

        let x1 = 0;
        let x2 = innerW;
        let foundCol = false;
        for (let x = 0; x < innerW; x++) {
            let colCount = 0;
            for (let y = colScanStart; y < colScanEndExclusive; y++) {
                if (mask[(y * innerW) + x] > 0) colCount++;
            }
            if (colCount > OLLAMA_COL_DENSITY_THRESHOLD) {
                if (!foundCol) {
                    x1 = x;
                    x2 = x;
                    foundCol = true;
                } else {
                    x2 = x;
                }
            }
        }

        const fy1 = Math.max(0, y1 - OLLAMA_CROP_PADDING);
        const fy2 = Math.min(innerH, y2 + OLLAMA_CROP_PADDING);
        const fx1 = Math.max(0, x1 - OLLAMA_CROP_PADDING);
        const fx2 = Math.min(innerW, x2 + OLLAMA_CROP_PADDING);
        const cropStartY = clamp(fy1, 0, innerH - 1);
        const cropEndY = clamp(fy2 + 1, cropStartY + 1, innerH);
        const cropStartX = clamp(fx1, 0, innerW - 1);
        const cropEndX = clamp(fx2 + 1, cropStartX + 1, innerW);
        const cropW = cropEndX - cropStartX;
        const cropH = cropEndY - cropStartY;

        if (cropW <= 0 || cropH <= 0) {
            return imageBuffer;
        }

        const out = new PNG({ width: cropW, height: cropH });
        for (let y = 0; y < cropH; y++) {
            const srcY = innerY + cropStartY + y;
            for (let x = 0; x < cropW; x++) {
                const srcX = innerX + cropStartX + x;
                const srcIdx = (srcY * width + srcX) * 4;
                const outIdx = (y * cropW + x) * 4;
                out.data[outIdx] = data[srcIdx];
                out.data[outIdx + 1] = data[srcIdx + 1];
                out.data[outIdx + 2] = data[srcIdx + 2];
                out.data[outIdx + 3] = data[srcIdx + 3];
            }
        }

        const cropped = PNG.sync.write(out);
        Logger.info(`[Captcha] Ollama pre-crop applied: ${width}x${height} -> ${cropW}x${cropH}`, null, token);
        saveOllamaDebugCrop(cropped, "cropped", token);
        return cropped;
    } catch (error) {
        Logger.warn(`[Captcha] Ollama pre-crop failed, using original image: ${getErrorMessage(error)}`, null, token);
        return imageBuffer;
    }
}

function safeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function parseCsv(value) {
    return safeString(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(safeString(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(value, fallback) {
    const parsed = Number.parseFloat(safeString(value));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObject(value) {
    const raw = safeString(value);
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function sanitizeCaptchaText(rawText) {
    return (typeof rawText === "string" ? rawText : "").trim().replace(/[^a-zA-Z0-9]/g, "");
}

function getErrorMessage(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (typeof error.message === "string" && error.message.trim()) return error.message;
    return JSON.stringify(error);
}

function isGeminiConfigured() {
    return !!safeString(process.env.GEMINI_API_KEY);
}

function isOllamaConfigured() {
    return !!safeString(process.env.OLLAMA_MODEL);
}

function isAutoSolveConfigured() {
    return isGeminiConfigured() || isOllamaConfigured();
}

function getGeminiModels() {
    const configured = parseCsv(process.env.GEMINI_MODELS);
    return configured.length > 0 ? configured : DEFAULT_GEMINI_MODELS;
}

function getOllamaGenerateUrl() {
    const directUrl = safeString(process.env.OLLAMA_API_URL);
    if (directUrl) return directUrl;

    const baseUrl = safeString(process.env.OLLAMA_BASE_URL) || "http://localhost:11434";
    const generatePath = safeString(process.env.OLLAMA_GENERATE_PATH) || "/api/generate";
    return `${baseUrl.replace(/\/+$/, "")}/${generatePath.replace(/^\/+/, "")}`;
}

async function solveWithGemini(imageBuffer, token) {
    if (!isGeminiConfigured()) {
        return { provider: "gemini", text: null, hadError: false, shouldRefreshCaptcha: false };
    }

    const models = getGeminiModels();
    const attemptsPerModel = parsePositiveInt(process.env.GEMINI_ATTEMPTS_PER_MODEL, 5);
    const baseTemperature = parseNumber(process.env.GEMINI_BASE_TEMPERATURE, 0.1);
    const temperatureStep = parseNumber(process.env.GEMINI_TEMPERATURE_STEP, 0.15);
    const maxOutputTokens = parsePositiveInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 20);
    const prompt = safeString(process.env.GEMINI_PROMPT) || DEFAULT_GEMINI_PROMPT;

    let hadError = false;
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    for (const modelName of models) {
        Logger.info(`[Captcha] Gemini model: ${modelName}`, null, token);

        for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
            const attemptStart = Date.now();
            Logger.info(`[Captcha] Gemini ${modelName} attempt ${attempt}/${attemptsPerModel}...`, null, token);

            try {
                const generationConfig = {
                    temperature: baseTemperature + ((attempt - 1) * temperatureStep),
                    maxOutputTokens,
                    thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }
                };

                const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
                const result = await model.generateContent([
                    { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/png" } },
                    prompt
                ]);

                const response = await result.response;
                const text = sanitizeCaptchaText(response.text());

                if (text.length === 6) {
                    Logger.info(`[Captcha] Gemini success with ${modelName} attempt ${attempt}: '${text}' (${Date.now() - attemptStart}ms)`, null, token);
                    return { provider: "gemini", text, hadError, shouldRefreshCaptcha: false };
                }

                Logger.warn(`[Captcha] Gemini ${modelName} attempt ${attempt} invalid output '${text}' (len=${text.length}).`, null, token);
            } catch (error) {
                hadError = true;
                const message = getErrorMessage(error);
                if (message.includes("429")) {
                    Logger.error(`[Captcha] Gemini ${modelName} hit rate limit (429).`, null, token);
                } else {
                    Logger.error(`[Captcha] Gemini ${modelName} attempt ${attempt} error: ${message}`, null, token);
                }
                Logger.warn(`[Captcha] Gemini skipping remaining attempts for ${modelName} after error.`, null, token);
                break;
            }
        }
    }

    Logger.info(`[Captcha] Gemini did not solve captcha.`, null, token);
    return { provider: "gemini", text: null, hadError, shouldRefreshCaptcha: false };
}

async function solveWithOllama(imageBuffer, token) {
    if (!isOllamaConfigured()) {
        return { provider: "ollama", text: null, hadError: false, shouldRefreshCaptcha: false };
    }

    if (typeof fetch !== "function") {
        Logger.error("[Captcha] Global fetch is unavailable in this Node runtime. Ollama cannot be used.", null, token);
        return { provider: "ollama", text: null, hadError: true, shouldRefreshCaptcha: false };
    }

    const url = getOllamaGenerateUrl();
    const model = safeString(process.env.OLLAMA_MODEL);
    const prompt = safeString(process.env.OLLAMA_PROMPT) || DEFAULT_OLLAMA_PROMPT;
    const timeoutMs = parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 30000);
    const extraOptions = parseJsonObject(process.env.OLLAMA_OPTIONS_JSON);
    const numCtx = parsePositiveInt(process.env.OLLAMA_NUM_CTX, null);
    const numPredict = parsePositiveInt(process.env.OLLAMA_NUM_PREDICT, null);
    const temperature = parseNumber(process.env.OLLAMA_TEMPERATURE, 0);

    const baseOptions = { ...extraOptions };
    if (numCtx !== null) baseOptions.num_ctx = numCtx;
    if (numPredict !== null) baseOptions.num_predict = numPredict;
    if (Number.isFinite(temperature)) baseOptions.temperature = temperature;

    const ollamaImageBuffer = cropCaptchaForOllama(imageBuffer, token);
    const imageBase64 = ollamaImageBuffer.toString("base64");
    const attemptStart = Date.now();
    Logger.info(`[Captcha] Ollama ${model} attempt 1/1...`, null, token);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const payload = {
            model,
            prompt,
            images: [imageBase64],
            stream: false,
            options: baseOptions
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!response.ok) {
            const bodyText = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status}${bodyText ? ` - ${bodyText.slice(0, 300)}` : ""}`);
        }

        const body = await response.json();
        const rawText = typeof body.response === "string"
            ? body.response
            : (typeof body.output_text === "string" ? body.output_text : "");
        const text = sanitizeCaptchaText(rawText);

        if (text.length === 6) {
            Logger.info(`[Captcha] Ollama success with ${model} attempt 1: '${text}' (${Date.now() - attemptStart}ms)`, null, token);
            return { provider: "ollama", text, hadError: false, shouldRefreshCaptcha: false };
        }

        Logger.warn(`[Captcha] Ollama ${model} invalid output '${text}' (len=${text.length}). Will require captcha refresh.`, null, token);
        return { provider: "ollama", text: null, hadError: false, shouldRefreshCaptcha: true };
    } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("AbortError")) {
            Logger.error(`[Captcha] Ollama request timeout after ${timeoutMs}ms.`, null, token);
        } else {
            Logger.error(`[Captcha] Ollama ${model} request error: ${message}`, null, token);
        }
        return { provider: "ollama", text: null, hadError: true, shouldRefreshCaptcha: false };
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function solveCaptcha(imageBuffer, token, options = {}) {
    const useSubscriptionFlow = options.channel === "subscription" || options.isBackground === true;
    const hasGemini = isGeminiConfigured();
    const hasOllama = isOllamaConfigured();

    if (!hasGemini && !hasOllama) {
        Logger.info("[Captcha] No Gemini/Ollama solver configured, skipping auto-solve.", null, token);
        return { provider: null, text: null, hadError: false, shouldRefreshCaptcha: false };
    }

    // Policy:
    // - Both set + subscription: use Ollama only.
    // - Both set + user: use Gemini first, fallback to Ollama only when Gemini has technical errors.
    // - Single provider set: use that provider.
    if (hasGemini && hasOllama) {
        if (useSubscriptionFlow) {
            Logger.info("[Captcha] Both providers configured. Subscription flow uses Ollama only.", null, token);
            return solveWithOllama(imageBuffer, token);
        }

        Logger.info("[Captcha] Both providers configured. User flow uses Gemini first.", null, token);
        const geminiResult = await solveWithGemini(imageBuffer, token);
        if (geminiResult.text) return geminiResult;

        if (geminiResult.hadError) {
            Logger.warn("[Captcha] Gemini returned errors. Falling back to Ollama for user flow.", null, token);
            return solveWithOllama(imageBuffer, token);
        }

        Logger.info("[Captcha] Gemini returned no valid solution but no provider errors. Skipping Ollama fallback.", null, token);
        return geminiResult;
    }

    if (hasGemini) {
        Logger.info("[Captcha] Using Gemini (only configured provider).", null, token);
        return solveWithGemini(imageBuffer, token);
    }

    Logger.info("[Captcha] Using Ollama (only configured provider).", null, token);
    return solveWithOllama(imageBuffer, token);
}

module.exports = {
    solveCaptcha,
    isGeminiConfigured,
    isOllamaConfigured,
    isAutoSolveConfigured
};
