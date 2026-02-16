const { GoogleGenerativeAI } = require("@google/generative-ai");

async function solveCaptcha(imageBuffer) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("No GEMINI_API_KEY found, skipping auto-solve.");
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
        console.log(`[Captcha] Switching to model: ${modelName}`);

        for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
            const attemptStart = Date.now();
            console.log(`[Captcha] ${modelName} attempt ${attempt}/${attemptsPerModel}...`);

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
                    console.log(`[Captcha] Success with ${modelName} on attempt ${attempt}: '${text}' (Time: ${Date.now() - attemptStart}ms)`);
                    return text;
                } else {
                    console.warn(`[Captcha] ${modelName} attempt ${attempt} failed validation: Got '${text}' (Length: ${text.length}). Retrying...`);
                }

            } catch (error) {
                if (error.message.includes('429')) {
                    console.error(`[Captcha] Error with ${modelName}: 429 Too Many Requests`);
                } else {
                    console.error(`[Captcha] Error with ${modelName} on attempt ${attempt}: ${error.message}`);
                }
                console.warn(`[Captcha] Skipping remaining attempts for ${modelName} due to error.`);
                break; // Skip to next model on technical error
            }
        }
    }

    console.log(`[Captcha] Failed to solve after trying all models.`);
    return null;
}

module.exports = { solveCaptcha };
