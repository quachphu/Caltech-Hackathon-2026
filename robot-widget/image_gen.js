require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const IMAGE_MODELS = [
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
];
const MAX_BATCH = 6;

function getDesktopPath() {
    return path.join(os.homedir(), 'Desktop');
}

function sanitizeFilename(name) {
    return name
        .replace(/[\/\\:*?"<>|]/g, '-')
        .replace(/\s+/g, '_')
        .trim()
        .slice(0, 50);
}

const STYLE_DESCRIPTORS = {
    realistic:    'photorealistic, ultra-detailed, high-resolution photograph, DSLR quality',
    cartoon:      'cartoon illustration style, bright colors, clean outlines, animated feel',
    anime:        'anime style, Japanese animation, detailed character art, vibrant colors',
    futuristic:   'futuristic sci-fi aesthetic, neon lights, advanced technology, cybernetic',
    fantasy:      'high fantasy art, magical atmosphere, epic landscape, detailed painterly style',
    oil_painting: 'oil painting style, rich textures, classical art technique, brushstroke detail',
    watercolor:   'watercolor painting, soft edges, translucent washes, artistic and dreamy',
    sketch:       'detailed pencil sketch, fine lines, cross-hatching, monochrome drawing',
    cyberpunk:    'cyberpunk aesthetic, neon-lit dystopia, rain-slicked streets, dark atmosphere',
    abstract:     'abstract art, bold geometric shapes, expressive colors, non-representational',
    '3d_render':  '3D render, physically-based rendering, studio lighting, ultra-realistic CGI',
};

const MOOD_DESCRIPTORS = {
    dark:       'dark, moody, shadowy atmosphere',
    bright:     'bright, vibrant, well-lit, cheerful',
    dramatic:   'dramatic lighting, high contrast, cinematic composition',
    calm:       'calm, serene, peaceful atmosphere, soft lighting',
    mysterious: 'mysterious, foggy, atmospheric depth, enigmatic',
    epic:       'epic scale, grand, awe-inspiring, heroic',
};

const ASPECT_HINTS = {
    square:    'square composition (1:1 aspect ratio)',
    landscape: 'wide landscape composition (16:9 aspect ratio)',
    portrait:  'tall portrait composition (9:16 aspect ratio)',
};

function buildFullPrompt(subjectPrompt, style, mood, extra_details, aspect_ratio) {
    const parts = [subjectPrompt];
    if (style && STYLE_DESCRIPTORS[style]) parts.push(STYLE_DESCRIPTORS[style]);
    if (mood  && MOOD_DESCRIPTORS[mood])   parts.push(MOOD_DESCRIPTORS[mood]);
    if (extra_details)                     parts.push(extra_details);
    if (aspect_ratio && ASPECT_HINTS[aspect_ratio]) parts.push(ASPECT_HINTS[aspect_ratio]);
    return parts.join(', ');
}

// ── Core single-image generator — uses v1alpha REST directly ─────────────────
async function generateSingleImage({ subjectPrompt, style, mood, extra_details, aspect_ratio, filenameSlug }, logFn) {
    const fullPrompt = buildFullPrompt(subjectPrompt, style, mood, extra_details, aspect_ratio);
    logFn(`[ImageGen] subject="${subjectPrompt.slice(0, 70)}"`);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    let lastError;
    for (let attempt = 0; attempt < IMAGE_MODELS.length; attempt++) {
        const model = IMAGE_MODELS[attempt];
        try {
            logFn(`[ImageGen] Attempt ${attempt + 1} model=${model}`);

            const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `Generate an image: ${fullPrompt}` }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
                }),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText);
            }

            const data = await res.json();
            const parts = data.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(p => p.inlineData && p.inlineData.data);

            if (!imagePart) {
                const textPart = parts.find(p => p.text);
                throw new Error(textPart ? `Model text-only: ${textPart.text.slice(0, 100)}` : 'No image part in response');
            }

            const imageBytes = imagePart.inlineData.data;
            const mimeType   = imagePart.inlineData.mimeType || 'image/png';
            const ext        = mimeType.includes('jpeg') ? 'jpg' : 'png';

            const desktopPath = getDesktopPath();
            if (!fs.existsSync(desktopPath)) fs.mkdirSync(desktopPath, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fileName  = `Nova_${filenameSlug}_${timestamp}.${ext}`;
            const filePath  = path.join(desktopPath, fileName);

            fs.writeFileSync(filePath, Buffer.from(imageBytes, 'base64'));
            logFn(`[ImageGen] Saved: ${filePath}`);
            return { status: 'created', filePath, fileName };

        } catch (e) {
            lastError = e;
            logFn(`[ImageGen] Attempt ${attempt + 1} (${model}) failed: ${e.message.slice(0, 200)}`);
            const isOverloaded = e.message.includes('overloaded') || e.message.includes('503') || e.message.includes('429');
            if (isOverloaded && attempt < IMAGE_MODELS.length - 1) {
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
            }
        }
    }
    throw lastError || new Error('All image generation models exhausted');
}

// ── Public handler ────────────────────────────────────────────────────────────
async function handleImageGenerationTool(args, logFn) {
    const {
        prompt        = '',
        style         = 'realistic',
        aspect_ratio  = 'square',
        mood          = '',
        extra_details = '',
        filename_hint = '',
        subjects,
    } = args;

    const hasBatch = Array.isArray(subjects) && subjects.length > 1;

    // ── BATCH MODE ─────────────────────────────────────────────────────────
    if (hasBatch) {
        const batch = subjects.slice(0, MAX_BATCH);
        logFn(`[ImageGen] Batch mode: ${batch.length} subjects, style=${style}`);

        const tasks = batch.map((subject, i) => {
            const subjectPrompt = prompt ? `${subject.trim()}, ${prompt}` : subject.trim();
            const slug = sanitizeFilename((filename_hint || style) + `_${i + 1}_` + subject.replace(/\W+/g, '_').slice(0, 20));
            return generateSingleImage({ subjectPrompt, style, mood, extra_details, aspect_ratio, filenameSlug: slug }, logFn)
                .then(r => ({ ...r, subject }))
                .catch(e => ({ status: 'error', subject, error: e.message }));
        });

        const results   = await Promise.all(tasks);
        const succeeded = results.filter(r => r.status === 'created');
        const failed    = results.filter(r => r.status === 'error');

        if (succeeded.length === 0) {
            return {
                status: 'error',
                speak:  `I could not generate any of the ${batch.length} images. Please try again in a moment.`,
            };
        }

        const fileList = succeeded.map(r => `"${r.fileName}"`).join(', ');
        const failNote = failed.length > 0
            ? ` ${failed.length} image${failed.length > 1 ? 's' : ''} could not be generated.`
            : '';

        return {
            status:   'batch_created',
            count:    succeeded.length,
            files:    succeeded.map(r => r.fileName),
            subjects: succeeded.map(r => r.subject),
            speak:    `Done! I created ${succeeded.length} ${style} image${succeeded.length > 1 ? 's' : ''} and saved them all to your Desktop: ${fileList}.${failNote} Take a look!`,
        };
    }

    // ── SINGLE MODE ────────────────────────────────────────────────────────
    if (!prompt || prompt.trim().length < 3) {
        return { status: 'error', speak: 'I need a description to generate an image. What would you like me to create?' };
    }

    logFn(`[ImageGen] Single mode: prompt="${prompt.slice(0, 60)}" style=${style} aspect=${aspect_ratio}`);

    try {
        const slug   = sanitizeFilename(filename_hint || prompt.slice(0, 40));
        const result = await generateSingleImage({
            subjectPrompt: prompt, style, mood, extra_details, aspect_ratio,
            filenameSlug:  slug,
        }, logFn);

        return {
            ...result,
            style,
            speak: `Done! Your ${style} image has been saved to your Desktop as "${result.fileName}". Take a look — it's ready!`,
        };
    } catch (e) {
        return {
            status: 'error',
            speak:  `I had trouble generating the image: ${e.message.slice(0, 150)}. Please try again in a moment.`,
        };
    }
}

module.exports = { handleImageGenerationTool };
