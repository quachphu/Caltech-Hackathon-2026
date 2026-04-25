require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
    console.log("Connecting...");
    try {
        const session = await ai.live.connect({
            model: 'gemini-2.0-flash',
            config: {
                responseModalities: [Modality.AUDIO],
            },
            callbacks: {
                onopen: () => {
                    console.log("🟢 Connection SUCCESS");
                    console.log("Session object keys =>", Object.keys(session));
                    console.log("Session prototype =>", Object.getOwnPropertyNames(Object.getPrototypeOf(session)));

                    if (typeof session.send === 'function') console.log("session.send exists!");
                    if (typeof session.sendRealtimeInput === 'function') console.log("session.sendRealtimeInput exists!");

                    // What happens when we call session.send?
                    try {
                        console.log("Testing session.send({text: 'hi'})");
                        session.send({ text: "hi" });
                        console.log("session.send succeeded");
                    } catch (e) {
                        console.log("session.send error:", e.message);
                    }

                    // What happens when we call session.sendRealtimeInput?
                    try {
                        console.log("Testing session.sendRealtimeInput([ { text: 'hi' } ])");
                        session.sendRealtimeInput([{ text: "hi" }]);
                        console.log("session.sendRealtimeInput succeeded");
                    } catch (e) {
                        console.log("session.sendRealtimeInput error:", e.message);
                    }
                    process.exit(0);
                },
                onerror: (e) => {
                    console.error("❌ socket error:", e.message);
                    process.exit(1);
                }
            }
        });
    } catch (err) {
        console.error("Connection failed:", err);
    }
}
test();
