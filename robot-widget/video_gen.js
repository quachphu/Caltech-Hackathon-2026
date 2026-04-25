require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { exec } = require('child_process');

const GEMINI_API_BASE   = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL         = 'veo-2.0-generate-001';
const POLL_INTERVAL_MS  = 8000;   // 8 s between polls
const MAX_POLL_ATTEMPTS = 45;     // ~6 min max before timeout

// ── Paths ─────────────────────────────────────────────────────────────────────

function getNovaCacheDir() {
    return path.join(os.homedir(), 'Nova', 'video_prompts');
}

function getVideosDir() {
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Movies');
    return path.join(os.homedir(), 'Videos'); // Linux + Windows
}

function sanitizeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, '_').trim().slice(0, 50);
}

// ── Prompt Building ───────────────────────────────────────────────────────────

const STYLE_PREFIXES = {
    cinematic:   'Hollywood cinematic quality, dramatic depth of field, professional color grading, movie-grade cinematography.',
    animated:    'High-quality 3D animation, fluid character motion, vivid colors, studio-quality rendering.',
    documentary: 'Documentary-style realism, naturalistic handheld camera, authentic soft lighting, observational framing.',
    nature:      'Nature documentary quality, macro detail, David Attenborough aesthetic, pristine natural lighting.',
    'sci-fi':    'Epic sci-fi aesthetic, futuristic neon lighting, advanced technology visuals, otherworldly atmosphere.',
    commercial:  'High-end commercial production, polished clean look, aspirational lifestyle feel, sharp focus.',
};

function buildVideoPrompt({ subject, style, setting, characters, dialogue_script, camera_style, mood_color }) {
    const parts = [];

    const stylePrefix = STYLE_PREFIXES[style] || 'Professional quality video.';
    parts.push(stylePrefix);
    parts.push(subject);

    if (setting)          parts.push(`Setting: ${setting}.`);
    if (characters)       parts.push(`Characters: ${characters}.`);
    if (dialogue_script)  parts.push(`Scene and dialogue: ${dialogue_script}.`);
    if (camera_style)     parts.push(`Camera: ${camera_style}.`);
    if (mood_color)       parts.push(`Color and mood: ${mood_color}.`);

    // Quality boosters that consistently improve Veo output
    parts.push(
        '8-second continuous shot, smooth motion throughout, coherent narrative arc, ' +
        '4K ultra-high definition, professional audio if speech is present, ' +
        'cinematic composition, no jump cuts, visually compelling framing.'
    );

    return parts.join(' ');
}

// ── Nova Prompt Cache ─────────────────────────────────────────────────────────

function ensureNovaCacheDir() {
    const dir = getNovaCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function savePromptToCache({ title, promptText, fullPrompt }) {
    const dir = ensureNovaCacheDir();
    const id  = `vp_${Date.now()}`;
    const record = {
        id, title,
        prompt_text: promptText,
        full_prompt: fullPrompt,
        created: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
    return id;
}

function listCachedPrompts() {
    const dir = getNovaCacheDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
            catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function deletePromptFromCache(id) {
    const dir  = getNovaCacheDir();
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
}

// ── Platform Open ─────────────────────────────────────────────────────────────

async function openFolderThenVideo(videoPath, logFn) {
    const folder = path.dirname(videoPath);
    const p = process.platform;

    // Open the Videos folder first
    const folderCmds = {
        linux:  `xdg-open "${folder}" 2>/dev/null &`,
        darwin: `open "${folder}"`,
        win32:  `explorer "${folder}"`,
    };
    if (folderCmds[p]) exec(folderCmds[p], (e) => { if (e) logFn(`[VideoGen] Folder open: ${e.message}`); });

    await new Promise(r => setTimeout(r, 1500));

    // Open the video — mpv preferred on Linux (user's player), then vlc, then xdg-open
    let videoCmd;
    if (p === 'linux') {
        videoCmd =
            `(which mpv &>/dev/null && mpv "${videoPath}" &) || ` +
            `(which vlc &>/dev/null && vlc "${videoPath}" &) || ` +
            `xdg-open "${videoPath}" &`;
    } else if (p === 'darwin') {
        videoCmd = `open "${videoPath}"`;
    } else if (p === 'win32') {
        videoCmd = `start "" "${videoPath}"`;
    }
    if (videoCmd) exec(videoCmd, (e) => { if (e) logFn(`[VideoGen] Video open: ${e.message}`); });
}

// ── Veo API (long-running operation) ─────────────────────────────────────────

async function callVeoAPI({ fullPrompt, aspectRatio }, apiKey, logFn) {
    const aspectMap = { landscape: '16:9', portrait: '9:16', square: '1:1' };
    const veoAspect = aspectMap[aspectRatio] || '16:9';

    const submitUrl = `${GEMINI_API_BASE}/models/${VEO_MODEL}:predictLongRunning?key=${apiKey}`;
    logFn(`[VideoGen] Submitting to Veo (aspect=${veoAspect})...`);

    const submitRes = await fetch(submitUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            instances: [{
                prompt: fullPrompt,
            }],
            parameters: {
                aspectRatio:      veoAspect,
                durationSeconds:  8,
                enhancePrompt:    true,
                personGeneration: 'allow_adult',
            }
        })
    });

    if (!submitRes.ok) {
        const errText = await submitRes.text();
        throw new Error(`Veo submit failed (${submitRes.status}): ${errText.slice(0, 300)}`);
    }

    const opData = await submitRes.json();
    const opName = opData.name;
    if (!opName) throw new Error('No operation name returned from Veo — the API may not support this model yet for your key.');
    logFn(`[VideoGen] Operation started: ${opName}`);

    // Poll until done
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        logFn(`[VideoGen] Polling ${attempt}/${MAX_POLL_ATTEMPTS}...`);

        let pollData;
        try {
            const pollUrl = `${GEMINI_API_BASE}/${opName}?key=${apiKey}`;
            const pollRes = await fetch(pollUrl);
            if (!pollRes.ok) { logFn(`[VideoGen] Poll HTTP ${pollRes.status}`); continue; }
            pollData = await pollRes.json();
        } catch (e) {
            logFn(`[VideoGen] Poll error: ${e.message}`); continue;
        }

        if (!pollData.done) continue;
        if (pollData.error) throw new Error(`Veo generation error: ${JSON.stringify(pollData.error).slice(0, 200)}`);

        const samples = pollData.response?.generateVideoResponse?.generatedSamples;
        if (!samples?.length) throw new Error('No video samples in Veo response');

        const videoData = samples[0].video;
        if (!videoData) throw new Error('No video data in sample');

        // Download video bytes
        if (videoData.bytesBase64Encoded) {
            return Buffer.from(videoData.bytesBase64Encoded, 'base64');
        }
        if (videoData.uri) {
            logFn(`[VideoGen] Downloading from URI...`);
            const dlUrl = videoData.uri.includes('?')
                ? `${videoData.uri}&key=${apiKey}`
                : `${videoData.uri}?key=${apiKey}`;
            const dlRes = await fetch(dlUrl);
            if (!dlRes.ok) throw new Error(`Failed to download video: HTTP ${dlRes.status}`);
            return Buffer.from(await dlRes.arrayBuffer());
        }
        throw new Error('No video bytes or URI found in Veo response');
    }

    throw new Error(`Video generation timed out after ~${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000)} minutes. Veo servers may be busy — please try again.`);
}

// ── Public Handler ────────────────────────────────────────────────────────────

async function handleVideoGenerationTool(args, logFn) {
    const {
        action              = 'generate',
        subject             = '',
        style               = 'cinematic',
        setting             = '',
        characters          = '',
        dialogue_script     = '',
        camera_style        = '',
        mood_color          = '',
        aspect_ratio        = 'landscape',
        filename_hint       = '',
        prompt_id_to_delete = '',
    } = args;

    // ── List saved prompts ──────────────────────────────────────────────────
    if (action === 'list_prompts') {
        const prompts = listCachedPrompts();
        if (prompts.length === 0) {
            return {
                status:  'ok',
                prompts: [],
                speak:   "You don't have any saved video prompts yet — I'll save them automatically once we create your first video.",
            };
        }
        const list = prompts.slice(0, 8).map((p, i) =>
            `${i + 1}. ${p.title} — ID: ${p.id} — created ${p.created.slice(0, 10)}`
        ).join('; ');
        return {
            status:  'ok',
            prompts,
            speak:   `You have ${prompts.length} saved video prompt${prompts.length > 1 ? 's' : ''}: ${list}. ` +
                     `Which would you like to reuse, improve, or delete?`,
        };
    }

    // ── Delete a saved prompt ───────────────────────────────────────────────
    if (action === 'delete_prompt') {
        if (!prompt_id_to_delete) {
            return { status: 'error', speak: "I need the prompt ID to delete it. Which prompt would you like to remove?" };
        }
        const deleted = deletePromptFromCache(prompt_id_to_delete);
        return {
            status: deleted ? 'ok' : 'not_found',
            speak:  deleted
                ? "Done — I've deleted that prompt from my memory. Would you like to create a new video?"
                : "I couldn't find that prompt — it may have already been deleted.",
        };
    }

    // ── Generate video ──────────────────────────────────────────────────────
    if (!subject || subject.trim().length < 5) {
        return { status: 'error', speak: "I need more detail about what the video should show. What's the main story or subject?" };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { status: 'error', speak: 'The Gemini API key is not configured.' };

    const fullPrompt  = buildVideoPrompt({ subject, style, setting, characters, dialogue_script, camera_style, mood_color });
    const promptText  = [subject, style, setting, characters, dialogue_script].filter(Boolean).join(' | ');

    logFn(`[VideoGen] Starting: style=${style} aspect=${aspect_ratio}`);
    logFn(`[VideoGen] Prompt preview: "${fullPrompt.slice(0, 130)}..."`);

    try {
        const videoBytes = await callVeoAPI({ fullPrompt, aspectRatio: aspect_ratio }, apiKey, logFn);

        const videosDir = getVideosDir();
        if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const slug      = sanitizeFilename(filename_hint || subject.slice(0, 30));
        const fileName  = `Nova_${slug}_${timestamp}.mp4`;
        const filePath  = path.join(videosDir, fileName);

        fs.writeFileSync(filePath, videoBytes);
        logFn(`[VideoGen] Saved: ${filePath}`);

        const title    = (filename_hint || subject).slice(0, 60);
        const promptId = savePromptToCache({ title, promptText, fullPrompt });
        logFn(`[VideoGen] Prompt cached: ${promptId}`);

        openFolderThenVideo(filePath, logFn).catch(e => logFn(`[VideoGen] Open warning: ${e.message}`));

        return {
            status:   'created',
            filePath,
            fileName,
            promptId,
            speak:
                `Your video is ready! I've saved "${fileName}" to your Videos folder and it's opening now. ` +
                `I've also stored the prompt in my Nova memory so we can improve it later. ` +
                `How does it look? If anything needs adjusting — the scene, the dialogue, the style — ` +
                `just tell me what to change and I'll build an improved prompt and regenerate it.`,
        };

    } catch (e) {
        logFn(`[VideoGen] Error: ${e.message}`);
        return {
            status: 'error',
            speak:  `I had trouble generating the video: ${e.message.slice(0, 180)}. ` +
                    `Would you like me to try again, or would you like to adjust the details first?`,
        };
    }
}

module.exports = { handleVideoGenerationTool };
