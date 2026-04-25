require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Convert raw PCM bytes to a WAV file buffer.
 * Gemini TTS returns raw 16-bit little-endian PCM at 24 kHz, mono.
 */
function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);               // Subchunk1Size
    header.writeUInt16LE(1, 20);                // AudioFormat: PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * numChannels * (bitDepth / 8), 28); // ByteRate
    header.writeUInt16LE(numChannels * (bitDepth / 8), 32);              // BlockAlign
    header.writeUInt16LE(bitDepth, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

/**
 * Generate speech using Gemini TTS API.
 * @param {string} text - The text to speak
 * @param {string} relativeOutputPath - Relative path like 'assets/tts_output.wav'
 * @returns {Promise<string>} - The relative output path used
 */
async function generateSpeech(text, relativeOutputPath) {
    // Always write as .wav
    const wavOutputPath = relativeOutputPath.replace(/\.(mp3|ogg|aac)$/i, '.wav');
    if (!wavOutputPath.endsWith('.wav')) {
        // ensure .wav extension
    }
    const absoluteOutputPath = path.join(__dirname, wavOutputPath);

    // Ensure directory exists
    const dir = path.dirname(absoluteOutputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: 'Orus', // Deep, resonant sci-fi voice
                        },
                    },
                },
            },
        });

        // Extract base64 PCM audio data from the response
        const audioPart = response?.candidates?.[0]?.content?.parts?.[0];
        if (!audioPart?.inlineData?.data) {
            throw new Error('No audio data in Gemini TTS response');
        }

        const pcmBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
        const wavBuffer = pcmToWav(pcmBuffer);

        fs.writeFileSync(absoluteOutputPath, wavBuffer);
        console.log('🔊 Gemini TTS: WAV written to', absoluteOutputPath);

        return wavOutputPath;
    } catch (e) {
        console.error('❌ Gemini TTS Error:', e);
        throw e;
    }
}

module.exports = { generateSpeech };
