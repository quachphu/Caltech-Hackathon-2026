require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
    console.log("Connecting...");
    try {
        let session;
        let isReady = false;

        session = await ai.live.connect({
            model: 'gemini-3.1-flash-live-preview',
            config: {
                // Requesting both text and audio back
                responseModalities: [Modality.AUDIO],
            },
            callbacks: {
                onopen: () => {
                    console.log("🟢 Connection SUCCESS (socket opened)");
                    isReady = true;
                },
                onmessage: (msg) => {
                    if (msg.serverContent && msg.serverContent.modelTurn) {
                        for (const part of msg.serverContent.modelTurn.parts) {
                            if (part.text) console.log("TEXT RESPONSE:", part.text);
                            if (part.inlineData) console.log("AUDIO RESPONSE: (length=" + part.inlineData.data.length + ")");
                        }
                    }
                },
                onerror: (e) => {
                    console.error("❌ socket error:", e.message);
                },
                onclose: (e) => {
                    console.log("🏁 socket closed", e.reason, e.code);
                    process.exit(0);
                }
            }
        });

        // wait for socket ready
        await new Promise(r => setTimeout(r, 1000));

        console.log("Session assigned. Testing object keys...");
        console.log(Object.keys(session));

        try {
            console.log("Transmission test 1: session.send({text: 'hi'})");
            session.send({ text: "Hi Nova, say something back to me right now." });
            console.log("Sent successfully.");
        } catch (e) {
            console.log("Send failed:", e.message);
            try {
                console.log("Transmission test 2: session.send({ parts: [{text: 'hi'}]})");
                session.send({ parts: [{ text: "Hi Nova, say something back to me right now." }] });
                console.log("Sent successfully.");
            } catch (e2) {
                console.log("Send failed:", e2.message);
            }
        }

        // wait for response
        await new Promise(r => setTimeout(r, 5000));
        console.log("Closing...");
        process.exit(0);

    } catch (err) {
        console.error("Connection failed:", err.message);
    }
}
test();
