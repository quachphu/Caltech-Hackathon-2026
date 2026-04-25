require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
    console.log("Attempting to connect with gemini-2.0-flash...");
    try {
        const session = await ai.live.connect({
            model: 'gemini-2.0-flash',
            config: {
                responseModalities: [Modality.AUDIO],
            },
            callbacks: {
                onopen: () => {
                    console.log("🟢 Connection SUCCESS with gemini-2.0-flash");
                    process.exit(0);
                },
                onerror: (e) => {
                    console.error("error:", e);
                }
            }
        });
    } catch (e) {
        console.log("❌ Error with gemini-2.0-flash:", e.message);
    }

    try {
        console.log("\nAttempting to connect with gemini-2.0-flash-exp...");
        const session2 = await ai.live.connect({
            model: 'gemini-2.0-flash-exp',
            config: {
                responseModalities: [Modality.AUDIO],
            },
            callbacks: {
                onopen: () => {
                    console.log("🟢 Connection SUCCESS with gemini-2.0-flash-exp");
                    process.exit(0);
                },
                onerror: (e) => {
                    console.error("error:", e);
                }
            }
        });
    } catch (e) {
        console.log("❌ Error with gemini-2.0-flash-exp:", e.message);
    }
}
test();
