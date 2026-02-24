const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3-flash-preview"];
const DEFAULT_GEMINI_PROMPT = "Extract the 6-character alphanumeric captcha text from this image. Return ONLY the 6 characters. No spaces.";
const DEFAULT_OLLAMA_PROMPT = "Return exactly the 6 letters. No explanation. No spaces.";

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
        return { text: null, hadError: false };
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
                    return { text, hadError };
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
    return { text: null, hadError };
}

async function solveWithOllama(imageBuffer, token) {
    if (!isOllamaConfigured()) {
        return { text: null, hadError: false };
    }

    if (typeof fetch !== "function") {
        Logger.error("[Captcha] Global fetch is unavailable in this Node runtime. Ollama cannot be used.", null, token);
        return { text: null, hadError: true };
    }

    const url = getOllamaGenerateUrl();
    const model = safeString(process.env.OLLAMA_MODEL);
    const prompt = safeString(process.env.OLLAMA_PROMPT) || DEFAULT_OLLAMA_PROMPT;
    const attempts = parsePositiveInt(process.env.OLLAMA_ATTEMPTS, 3);
    const timeoutMs = parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 30000);
    const extraOptions = parseJsonObject(process.env.OLLAMA_OPTIONS_JSON);
    const numCtx = parsePositiveInt(process.env.OLLAMA_NUM_CTX, null);
    const numPredict = parsePositiveInt(process.env.OLLAMA_NUM_PREDICT, null);
    const temperature = parseNumber(process.env.OLLAMA_TEMPERATURE, 0);

    const baseOptions = { ...extraOptions };
    if (numCtx !== null) baseOptions.num_ctx = numCtx;
    if (numPredict !== null) baseOptions.num_predict = numPredict;
    if (Number.isFinite(temperature)) baseOptions.temperature = temperature;

    let hadError = false;
    const imageBase64 = imageBuffer.toString("base64");

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const attemptStart = Date.now();
        Logger.info(`[Captcha] Ollama ${model} attempt ${attempt}/${attempts}...`, null, token);

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
                Logger.info(`[Captcha] Ollama success with ${model} attempt ${attempt}: '${text}' (${Date.now() - attemptStart}ms)`, null, token);
                return { text, hadError };
            }

            Logger.warn(`[Captcha] Ollama ${model} attempt ${attempt} invalid output '${text}' (len=${text.length}).`, null, token);
        } catch (error) {
            hadError = true;
            const message = getErrorMessage(error);
            if (message.includes("AbortError")) {
                Logger.error(`[Captcha] Ollama request timeout after ${timeoutMs}ms.`, null, token);
            } else {
                Logger.error(`[Captcha] Ollama ${model} attempt ${attempt} error: ${message}`, null, token);
            }
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    Logger.info(`[Captcha] Ollama did not solve captcha.`, null, token);
    return { text: null, hadError };
}

async function solveCaptcha(imageBuffer, token, options = {}) {
    const useSubscriptionFlow = options.channel === "subscription" || options.isBackground === true;
    const hasGemini = isGeminiConfigured();
    const hasOllama = isOllamaConfigured();

    if (!hasGemini && !hasOllama) {
        Logger.info("[Captcha] No Gemini/Ollama solver configured, skipping auto-solve.", null, token);
        return null;
    }

    // Policy:
    // - Both set + subscription: use Ollama only.
    // - Both set + user: use Gemini first, fallback to Ollama only when Gemini has technical errors.
    // - Single provider set: use that provider.
    if (hasGemini && hasOllama) {
        if (useSubscriptionFlow) {
            Logger.info("[Captcha] Both providers configured. Subscription flow uses Ollama only.", null, token);
            const ollamaResult = await solveWithOllama(imageBuffer, token);
            return ollamaResult.text;
        }

        Logger.info("[Captcha] Both providers configured. User flow uses Gemini first.", null, token);
        const geminiResult = await solveWithGemini(imageBuffer, token);
        if (geminiResult.text) return geminiResult.text;

        if (geminiResult.hadError) {
            Logger.warn("[Captcha] Gemini returned errors. Falling back to Ollama for user flow.", null, token);
            const ollamaResult = await solveWithOllama(imageBuffer, token);
            return ollamaResult.text;
        }

        Logger.info("[Captcha] Gemini returned no valid solution but no provider errors. Skipping Ollama fallback.", null, token);
        return null;
    }

    if (hasGemini) {
        Logger.info("[Captcha] Using Gemini (only configured provider).", null, token);
        const geminiResult = await solveWithGemini(imageBuffer, token);
        return geminiResult.text;
    }

    Logger.info("[Captcha] Using Ollama (only configured provider).", null, token);
    const ollamaResult = await solveWithOllama(imageBuffer, token);
    return ollamaResult.text;
}

module.exports = {
    solveCaptcha,
    isGeminiConfigured,
    isOllamaConfigured,
    isAutoSolveConfigured
};
