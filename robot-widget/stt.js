require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Transcribe audio buffer using Gemini.
 * @param {Buffer} audioBuffer - The raw audio data (WebM/Ogg from MediaRecorder)
 * @returns {Promise<string>} - The transcribed text
 */
async function transcribeAudio(audioBuffer) {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not found in environment.');
    }

    const base64Audio = audioBuffer.toString('base64');

    try {
        console.log('🎙️ Sending audio to Gemini for transcription...');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    parts: [
                        {
                            inlineData: {
                                mimeType: 'audio/webm',
                                data: base64Audio,
                            },
                        },
                        {
                            text: 'Please transcribe this audio accurately. Return only the spoken words with no extra commentary.',
                        },
                    ],
                },
            ],
        });

        const transcription = response.text?.trim() || '';
        console.log('✅ Gemini Transcription:', transcription);
        return transcription;
    } catch (error) {
        if (error.status === 400) {
            console.log('⚠️ Gemini 400 error (likely purely silent audio chunk). Returning empty string.');
            return '';
        }
        console.error('❌ Gemini Transcription Failed:', error);
        throw error;
    }
}

module.exports = { transcribeAudio };
