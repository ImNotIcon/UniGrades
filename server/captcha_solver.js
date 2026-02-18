const { GoogleGenerativeAI } = require("@google/generative-ai");

async function solveCaptcha(imageBuffer, token) {
    if (!process.env.GEMINI_API_KEY) {
        Logger.info("No GEMINI_API_KEY found, skipping auto-solve.", null, token);
        return null;
    }

    const totalStart = Date.now();
    const models = [
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ];

    const attemptsPerModel = 5;

    for (const modelName of models) {
        Logger.info(`[Captcha] Switching to model: ${modelName}`, null, token);

        for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
            const attemptStart = Date.now();
            Logger.info(`[Captcha] ${modelName} attempt ${attempt}/${attemptsPerModel}...`, null, token);

            try {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const generationConfig = {
                    temperature: 0.1 + ((attempt - 1) * 0.15),
                    maxOutputTokens: 20,
                    thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }
                };

                const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
                const result = await model.generateContent([
                    { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/png" } },
                    "Extract the 6-character alphanumeric captcha text from this image. Return ONLY the 6 characters. No spaces."
                ]);

                const response = await result.response;
                const text = response.text().trim().replace(/[^a-zA-Z0-9]/g, '');

                if (text.length === 6) {
                    Logger.info(`[Captcha] Success with ${modelName} on attempt ${attempt}: '${text}' (Time: ${Date.now() - attemptStart}ms)`, null, token);
                    return text;
                } else {
                    Logger.warn(`[Captcha] ${modelName} attempt ${attempt} failed validation: Got '${text}' (Length: ${text.length}). Retrying...`, null, token);
                }

            } catch (error) {
                if (error.message.includes('429')) {
                    Logger.error(`[Captcha] Error with ${modelName}: 429 Too Many Requests`, null, token);
                } else {
                    Logger.error(`[Captcha] Error with ${modelName} on attempt ${attempt}: ${error.message}`, null, token);
                }
                Logger.warn(`[Captcha] Skipping remaining attempts for ${modelName} due to error.`, null, token);
                break; // Skip to next model on technical error
            }
        }
    }

    Logger.info(`[Captcha] Failed to solve after trying all models.`, null, token);
    return null;
}

module.exports = { solveCaptcha };
