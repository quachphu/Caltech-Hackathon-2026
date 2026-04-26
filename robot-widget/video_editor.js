require('dotenv').config();
const { exec, spawn } = require('child_process');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

let _videoEditorModeActive = false;
let _editorOpening        = false;
let _currentProjectPath   = null;  // tracks the active .osp file for direct editing
let _openShotKilled       = false; // true when we killed OpenShot to edit .osp; relaunch before next GUI action
const _veDebounce = new Map();
const VE_DEBOUNCE_MS = {
    open_editor:     8000,
    create_project:  15000,
    import_file:     12000,
    add_to_timeline: 3000,
    delete_clip:     3000,
    play_preview:    30000,
    stop_preview:    5000,
    close_preview:   5000,
    save_project:    5000,
    export_video:    10000,
    undo:            2000,
    redo:            2000,
    close_editor:    5000,
    guide:           1000,
};

function isVideoEditorModeActive() {
    return _videoEditorModeActive;
}

function getVideosDir() {
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Movies');
    return path.join(os.homedir(), 'Videos'); // Linux + Windows
}

// Human-readable folder name for spoken responses
function getVideosFolderName() {
    return process.platform === 'darwin' ? 'Movies' : 'Videos';
}

// Open a file with the system default application (cross-platform)
function openWithSystemPlayer(filePath) {
    const safe = filePath.replace(/'/g, "'\\''");
    if (process.platform === 'darwin') {
        exec(`open '${safe}'`);
    } else if (process.platform === 'win32') {
        // Windows: use start with an empty title so paths with spaces work
        exec(`start "" "${filePath.replace(/"/g, '\\"')}"`);
    } else {
        exec(`xdg-open '${safe}' 2>/dev/null`);
    }
}

function expandVideoPath(fileName) {
    if (!fileName) return fileName;
    const videosDir = getVideosDir();
    if (!fileName.includes('/') && !fileName.includes('\\')) {
        const exact = path.join(videosDir, fileName);
        if (fs.existsSync(exact)) return exact;
        // Case-insensitive fallback: find the file whose name best matches
        if (fs.existsSync(videosDir)) {
            const lowerFn = fileName.toLowerCase();
            const files = fs.readdirSync(videosDir);
            // Exact case-insensitive match first
            const ciMatch = files.find(f => f.toLowerCase() === lowerFn);
            if (ciMatch) return path.join(videosDir, ciMatch);
            // Fuzzy: strip extension and find closest stem match
            const stem = lowerFn.replace(/\.[^.]+$/, '');
            const fuzzy = files.find(f => f.toLowerCase().replace(/\.[^.]+$/, '') === stem);
            if (fuzzy) return path.join(videosDir, fuzzy);
        }
        return exact; // return original so error message shows what was looked for
    }
    return fileName;
}

function killOpenShot() {
    return new Promise((resolve) => {
        const p = process.platform;
        if (p === 'linux') {
            exec('flatpak kill org.openshot.OpenShot 2>/dev/null; pkill -f openshot-qt 2>/dev/null; sleep 0.5; true', () => resolve());
        } else if (p === 'darwin') {
            exec('osascript -e \'tell application "OpenShot Video Editor" to quit\' 2>/dev/null; sleep 0.5; true', () => resolve());
        } else if (p === 'win32') {
            exec('taskkill /IM openshot-qt.exe /F 2>nul & timeout /t 1 /nobreak > nul', () => resolve());
        } else {
            resolve();
        }
    });
}

// ── Project file helpers ───────────────────────────────────────────────────

function createMinimalOspProject(filePath, title) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Format mirrors OpenShot's own _default.project exactly to avoid libopenshot warnings
    const project = {
        id: crypto.randomUUID(),
        fps:           { num: 24, den: 1 },
        display_ratio: { num: 16, den: 9 },
        pixel_ratio:   { num: 1,  den: 1 },
        width:   1280,
        height:  720,
        sample_rate:   48000,
        channels:      2,
        channel_layout: 3,
        settings:      {},
        clips:         [],
        effects:       [],
        files:         [],
        duration:      300,
        scale:         15.0,
        tick_pixels:   100,
        playhead_position: 0,
        profile:       "HD 720p 30 fps",
        export_settings: null,
        layers: [
            { id: "L1", label: "", number: 1000000, y: 0, lock: false },
            { id: "L2", label: "", number: 2000000, y: 0, lock: false },
            { id: "L3", label: "", number: 3000000, y: 0, lock: false },
            { id: "L4", label: "", number: 4000000, y: 0, lock: false },
            { id: "L5", label: "", number: 5000000, y: 0, lock: false },
        ],
        markers:  [],
        progress: [],
        history:  { undo: [], redo: [] },
        // Use 0.0.0 placeholders — OpenShot overwrites on save (no version-mismatch warning)
        version:  { "openshot-qt": "0.0.0", libopenshot: "0.0.0" },
    };
    fs.writeFileSync(filePath, JSON.stringify(project, null, 2));
}

function findExistingProject(nameOrPath) {
    const videosDir = getVideosDir();
    const stripped  = nameOrPath.replace(/\.osp$/i, '');
    // Exact match
    const exact = path.join(videosDir, `${stripped}.osp`);
    if (fs.existsSync(exact)) return exact;
    // Fuzzy: first file whose name contains the query (case-insensitive)
    if (fs.existsSync(videosDir)) {
        const lower = stripped.toLowerCase();
        const match = fs.readdirSync(videosDir)
            .filter(f => f.endsWith('.osp'))
            .find(f => f.toLowerCase().includes(lower));
        if (match) return path.join(videosDir, match);
    }
    return null;
}

function listOspProjects() {
    const videosDir = getVideosDir();
    if (!fs.existsSync(videosDir)) return [];
    return fs.readdirSync(videosDir)
        .filter(f => f.endsWith('.osp'))
        .map(f => f.replace(/\.osp$/i, ''));
}

// Returns video files from the Videos folder that are NOT currently on the timeline.
// Used to build accurate "remaining files" lists for CLIP_ADDED injections.
function getRemainingVideoFiles(ospPath) {
    const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v'];
    const videosDir = getVideosDir();
    let allVids = [];
    try {
        if (fs.existsSync(videosDir))
            allVids = fs.readdirSync(videosDir).filter(f => videoExts.some(e => f.toLowerCase().endsWith(e)) && !f.toLowerCase().includes('_movie'));
    } catch {}

    if (!ospPath || !fs.existsSync(ospPath)) return allVids;

    try {
        const proj = readOsp(ospPath);
        const clipsOnTimeline = new Set((proj.clips || []).map(c => c.file_id));
        const onTimelineNames = new Set(
            (proj.files || [])
                .filter(f => clipsOnTimeline.has(f.id))
                .map(f => f.name || path.basename(f.path || ''))
        );
        return allVids.filter(f => !onTimelineNames.has(f));
    } catch { return allVids; }
}

// ── .osp direct-editing helpers ───────────────────────────────────────────

function readOsp(ospPath) {
    return JSON.parse(fs.readFileSync(ospPath, 'utf-8'));
}

function writeOsp(ospPath, data) {
    fs.writeFileSync(ospPath, JSON.stringify(data, null, 2));
}

// Use ffprobe to get video metadata for building a proper file entry
function getVideoMetadata(filePath) {
    return new Promise((resolve) => {
        const safe = filePath.replace(/'/g, "'\\''");
        exec(
            `ffprobe -v quiet -print_format json -show_format -show_streams '${safe}' 2>/dev/null`,
            (err, stdout) => {
                const fallback = {
                    has_video: true, has_audio: true,
                    width: 1280, height: 720, duration: 30.0,
                    video_fps_num: 24, video_fps_den: 1,
                };
                if (err || !stdout.trim()) { resolve(fallback); return; }
                try {
                    const info = JSON.parse(stdout);
                    const vStream = (info.streams || []).find(s => s.codec_type === 'video');
                    const aStream = (info.streams || []).find(s => s.codec_type === 'audio');
                    const duration = parseFloat(info.format?.duration || 30);
                    let fps_num = 24, fps_den = 1;
                    if (vStream?.r_frame_rate) {
                        const parts = vStream.r_frame_rate.split('/').map(Number);
                        fps_num = parts[0] || 24; fps_den = parts[1] || 1;
                    }
                    resolve({
                        has_video: !!vStream,
                        has_audio: !!aStream,
                        width: vStream?.width || 1280,
                        height: vStream?.height || 720,
                        duration: isNaN(duration) ? 30 : duration,
                        video_fps_num: fps_num,
                        video_fps_den: fps_den,
                    });
                } catch { resolve(fallback); }
            }
        );
    });
}

function buildFileEntry(filePath, meta) {
    const fileId = crypto.randomUUID();
    const name   = path.basename(filePath);
    const mediaType = meta.has_video ? 'video' : (meta.has_audio ? 'audio' : 'video');
    const frames = Math.ceil(meta.duration * (meta.video_fps_num / meta.video_fps_den));
    return {
        id: fileId,
        path: filePath,
        name,
        media_type: mediaType,
        has_video: meta.has_video,
        has_audio: meta.has_audio,
        duration: meta.duration,
        video_length: frames.toString(),
        frames,
        width: meta.width,
        height: meta.height,
        fps: { num: meta.video_fps_num, den: meta.video_fps_den },
        pixel_ratio: { num: 1, den: 1 },
        display_ratio: { num: meta.width, den: meta.height > 0 ? meta.height : 1 },
        tags: "",  // OpenShot expects string, not list — [] crashes QStandardItem in files_model.py
        file_size: '',
        acodec: meta.has_audio ? 'aac' : '',
        vcodec: meta.has_video ? 'h264' : '',
        audio_sample_rate: 48000,
        channels: meta.has_audio ? 2 : 0,
        channel_layout: meta.has_audio ? 3 : 0,
        video_bit_rate: 0,
        audio_bit_rate: 0,
        reader: { path: filePath },
    };
}

function buildClipEntry(fileEntry, position, layerNumber) {
    const d = fileEntry.duration || 30;
    const kfPoint = (x, y) => ({ co: { X: x, Y: y }, interpolation: 2 });
    return {
        id: crypto.randomUUID(),
        layer: layerNumber || 1000000,
        file_id: fileEntry.id,
        position: position || 0.0,
        start: 0.0,
        end: d,
        duration: d,
        gravity: 4,
        scale: 0,
        has_video: fileEntry.has_video,
        has_audio: fileEntry.has_audio,
        reader: { path: fileEntry.path },
        effects: [],
        alpha:      { Points: [kfPoint(1, 1)] },
        location_x: { Points: [kfPoint(1, 0)] },
        location_y: { Points: [kfPoint(1, 0)] },
        rotation:   { Points: [kfPoint(1, 0)] },
        scale_x:    { Points: [kfPoint(1, 1)] },
        scale_y:    { Points: [kfPoint(1, 1)] },
        shear_x:    { Points: [kfPoint(1, 0)] },
        shear_y:    { Points: [kfPoint(1, 0)] },
        volume:     { Points: [kfPoint(1, 1)] },
        time:       { Points: [kfPoint(1, 1)] },
        wave_color: { red: 0, green: 123, blue: 255, alpha: 255 },
    };
}

// Import a video into the .osp project file directly (no GUI needed)
async function importFileIntoOsp(ospPath, videoPath, logFn) {
    const proj = readOsp(ospPath);

    // REUSE existing entry if file is already in project — preserves file_id so existing clips stay valid
    const existing = (proj.files || []).find(f => f.path === videoPath);
    if (existing) {
        logFn(`🎬 File already in project (reusing id): ${path.basename(videoPath)}`);
        return existing;
    }

    const meta  = await getVideoMetadata(videoPath);
    const entry = buildFileEntry(videoPath, meta);
    proj.files = (proj.files || []);
    proj.files.push(entry);
    writeOsp(ospPath, proj);

    logFn(`🎬 Added to .osp: ${path.basename(videoPath)} (${meta.duration.toFixed(1)}s, ${meta.width}x${meta.height})`);
    return entry;
}

// Add a clip to the timeline in the .osp project file
// Use libopenshot (via flatpak) to generate a 100% compatible clip JSON
function buildClipViaLibopenshot(filePath, position, layer, fileId, duration) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'clip_gen.py');
        const safe = filePath.replace(/'/g, "'\\''");
        exec(
            `flatpak run --command=python3 org.openshot.OpenShot '${scriptPath}' '${safe}' ${position} ${layer} '${fileId}' ${duration} 2>/dev/null`,
            { timeout: 15000 },
            (err, stdout) => {
                if (err || !stdout.trim()) {
                    reject(new Error(`clip_gen failed: ${err ? err.message : 'no output'}`));
                    return;
                }
                try { resolve(JSON.parse(stdout.trim())); }
                catch (e) { reject(new Error('clip_gen output not valid JSON')); }
            }
        );
    });
}

async function addClipToOspTimeline(ospPath, fileId, logFn) {
    const proj = readOsp(ospPath);

    // Find the file entry
    const fileEntry = (proj.files || []).find(f => f.id === fileId);
    if (!fileEntry) throw new Error('File not found in project');

    // Resolve relative paths (OpenShot stores paths like './video.mp4') to absolute.
    // libopenshot resolves from the Node process CWD, not the ${getVideosFolderName()} folder.
    const ospDir = path.dirname(ospPath);
    const videoPath = path.isAbsolute(fileEntry.path)
        ? fileEntry.path
        : path.resolve(ospDir, fileEntry.path);

    // Use layer 5000000 (Track 5 = the top visible track in OpenShot's default view)
    const TARGET_LAYER = 5000000;
    const existingClips = (proj.clips || []).filter(c => c.layer === TARGET_LAYER);
    const lastEnd = existingClips.reduce((max, c) => Math.max(max, (c.position || 0) + (c.end || 0)), 0);
    const position = lastEnd;
    const duration = fileEntry.duration || 30;

    logFn(`🎬 Generating clip via libopenshot at position ${position.toFixed(1)}s (path: ${videoPath})...`);
    const clip = await buildClipViaLibopenshot(videoPath, position, TARGET_LAYER, fileId, duration);

    proj.clips = (proj.clips || []);
    proj.clips.push(clip);
    writeOsp(ospPath, proj);

    logFn(`🎬 Added clip to timeline at position ${position.toFixed(1)}s`);
    return clip;
}

function launchOpenShot(projectPath = null) {
    const p = process.platform;
    // Escape for shell; single-quote the path to handle spaces
    const argStr = projectPath ? ` '${projectPath.replace(/'/g, "'\\''")}'` : '';
    if (p === 'linux') {
        const child = spawn('bash', ['-c',
            `if which openshot-qt &>/dev/null; then exec openshot-qt${argStr}; else exec flatpak run org.openshot.OpenShot${argStr}; fi`
        ], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
        child.unref();
    } else if (p === 'darwin') {
        exec(`open -a "OpenShot Video Editor"${argStr}`);
    } else if (p === 'win32') {
        const exe = '"C:\\Program Files\\OpenShot Video Editor\\openshot-qt.exe"';
        const cmd = projectPath ? `${exe} "${projectPath}"` : exe;
        const child = spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore' });
        child.unref();
    }
}

function isOpenShotRunning() {
    return new Promise((resolve) => {
        const p = process.platform;
        if (p === 'linux') {
            exec('pgrep -f "openshot" 2>/dev/null; flatpak ps 2>/dev/null | grep -i openshot', (err, stdout) => {
                resolve(stdout.trim().length > 0);
            });
        } else if (p === 'darwin') {
            exec('pgrep -f "OpenShot" 2>/dev/null', (err, stdout) => {
                resolve(stdout.trim().length > 0);
            });
        } else if (p === 'win32') {
            exec('tasklist /FI "IMAGENAME eq openshot-qt.exe" 2>nul', (err, stdout) => {
                resolve((stdout || '').toLowerCase().includes('openshot-qt.exe'));
            });
        } else {
            resolve(false);
        }
    });
}

// Wait until the OpenShot window is actually visible and reachable via xdotool.
// Returns the window ID string, or null on timeout.
function waitForOpenShotWindow(maxWaitMs = 25000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
            exec(
                'WID=$(xdotool search --onlyvisible --name "OpenShot" 2>/dev/null | head -1); ' +
                '[ -z "$WID" ] && WID=$(xdotool search --onlyvisible --class "openshot" 2>/dev/null | head -1); ' +
                'echo "$WID"',
                (err, stdout) => {
                    const wid = stdout.trim();
                    if (wid) return resolve(wid);
                    if (Date.now() - start >= maxWaitMs) return resolve(null);
                    setTimeout(poll, 1000);
                }
            );
        };
        poll();
    });
}

// Check if xdotool is available (Linux only)
function checkXdotool() {
    return new Promise((resolve) => {
        exec('which xdotool 2>/dev/null', (err, stdout) => {
            resolve(!err && stdout.trim().length > 0);
        });
    });
}

// Focus the OpenShot window cross-platform
function focusOpenShot() {
    return new Promise((resolve) => {
        const p = process.platform;
        let cmd;
        if (p === 'linux') {
            // Try multiple window title variants (flatpak, direct, with project name)
            cmd = `WID=$(xdotool search --onlyvisible --name "OpenShot" 2>/dev/null | head -1); ` +
                  `[ -z "$WID" ] && WID=$(xdotool search --onlyvisible --class "openshot" 2>/dev/null | head -1); ` +
                  `[ -n "$WID" ] && xdotool windowactivate --sync "$WID" 2>/dev/null; true`;
        } else if (p === 'darwin') {
            cmd = `osascript -e 'tell application "OpenShot Video Editor" to activate' 2>/dev/null; true`;
        } else if (p === 'win32') {
            cmd = `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('OpenShot')" 2>nul & echo done`;
        }
        if (cmd) exec(cmd, () => setTimeout(resolve, 350));
        else resolve();
    });
}

// Send a keystroke to the OpenShot window
async function sendKey(key) {
    await focusOpenShot();
    await new Promise((resolve) => {
        const p = process.platform;
        let cmd;
        if (p === 'linux') {
            // xdotool key format: ctrl+o, ctrl+shift+e, space, Delete, Return
            cmd = `WID=$(xdotool search --onlyvisible --name "OpenShot" 2>/dev/null | head -1); ` +
                  `[ -z "$WID" ] && WID=$(xdotool search --onlyvisible --class "openshot" 2>/dev/null | head -1); ` +
                  `[ -n "$WID" ] && xdotool key --window "$WID" --clearmodifiers "${key}" 2>/dev/null; true`;
        } else if (p === 'darwin') {
            // Build AppleScript keystroke from xdotool key format
            const parts = key.toLowerCase().split('+');
            const mods = [];
            let mk = '';
            for (const part of parts) {
                if (part === 'ctrl')  mods.push('command down');
                else if (part === 'shift') mods.push('shift down');
                else if (part === 'alt')   mods.push('option down');
                else mk = part === 'space' ? ' ' : part === 'return' ? '\r' : part;
            }
            const usingClause = mods.length ? ` using {${mods.join(', ')}}` : '';
            cmd = `osascript -e 'tell application "System Events" to keystroke "${mk}"${usingClause}' 2>/dev/null; true`;
        } else if (p === 'win32') {
            // Convert to WScript.Shell SendKeys format
            const keyMap = { ctrl: '^', shift: '+', alt: '%', return: '{ENTER}', Delete: '{DELETE}', space: ' ', escape: '{ESC}', Tab: '{TAB}' };
            const parts2 = key.split('+');
            let ps = '';
            for (const part of parts2) ps += keyMap[part] || part;
            cmd = `powershell -Command "$wsh=New-Object -ComObject WScript.Shell; $wsh.AppActivate('OpenShot'); Start-Sleep -Milliseconds 300; $wsh.SendKeys('${ps}')" 2>nul & echo done`;
        }
        if (cmd) exec(cmd, () => setTimeout(resolve, 450));
        else resolve();
    });
}

// Type text into the focused window (for file dialog path input)
async function typeText(text) {
    await focusOpenShot();
    await new Promise((resolve) => {
        const p = process.platform;
        const safe = text.replace(/'/g, "'\\''");
        let cmd;
        if (p === 'linux') {
            cmd = `WID=$(xdotool search --onlyvisible --name "OpenShot" 2>/dev/null | head -1); ` +
                  `[ -z "$WID" ] && WID=$(xdotool search --onlyvisible --class "openshot" 2>/dev/null | head -1); ` +
                  `[ -n "$WID" ] && xdotool type --window "$WID" --clearmodifiers '${safe}' 2>/dev/null; true`;
        } else if (p === 'darwin') {
            cmd = `osascript -e 'tell application "System Events" to keystroke "${text}"' 2>/dev/null; true`;
        } else if (p === 'win32') {
            cmd = `powershell -Command "$wsh=New-Object -ComObject WScript.Shell; $wsh.AppActivate('OpenShot'); Start-Sleep -Milliseconds 300; $wsh.SendKeys('${text}')" 2>nul & echo done`;
        }
        if (cmd) exec(cmd, () => setTimeout(resolve, 500));
        else resolve();
    });
}

// Send a keystroke to whatever window currently has focus (e.g., an open file dialog).
// Unlike sendKey(), this does NOT call focusOpenShot() first.
function sendKeyToActive(key) {
    return new Promise((resolve) => {
        if (process.platform !== 'linux') { resolve(); return; }
        exec(`xdotool key --clearmodifiers "${key}" 2>/dev/null; true`, () => setTimeout(resolve, 450));
    });
}

// Type text into whatever window currently has focus (e.g., a file dialog location bar).
function typeTextToActive(text) {
    return new Promise((resolve) => {
        if (process.platform !== 'linux') { resolve(); return; }
        const safe = text.replace(/'/g, "'\\''");
        exec(`xdotool type --clearmodifiers '${safe}' 2>/dev/null; true`, () => setTimeout(resolve, 600));
    });
}

async function handleVideoEditorTool(args, logFn) {
    const { action, file_name, instruction, confirmed } = args;
    logFn(`🎬 [VideoEditor] action="${action}" file="${file_name || ''}" instruction="${instruction || ''}"`);

    const now = Date.now();
    const cooldown = VE_DEBOUNCE_MS[action] || 3000;
    // Per-filename debounce for file actions — allows League1 and League2 to run concurrently
    const _deKey = (action === 'import_file' || action === 'add_to_timeline' || action === 'delete_clip') && file_name
        ? `${action}:${file_name.toLowerCase().replace(/\.[^.]+$/, '').trim()}`
        : action;
    if (now - (_veDebounce.get(_deKey) || 0) < cooldown) {
        return { status: 'debounced', speak: 'Already on it, just a moment.' };
    }
    _veDebounce.set(_deKey, now);

    const hasXdotool = process.platform === 'linux' ? await checkXdotool() : false;
    const canAutomate = hasXdotool || process.platform !== 'linux';

    switch (action) {

        case 'list_projects': {
            const projects = listOspProjects();
            if (projects.length === 0) {
                return {
                    status: 'ok',
                    projects: [],
                    speak: `You don't have any saved projects in your ${getVideosFolderName()} folder yet. Just tell me a name and I'll create a fresh one.`
                };
            }
            const list = projects.slice(0, 10).join(', ');
            return {
                status: 'ok',
                projects,
                speak: `Found ${projects.length} project${projects.length > 1 ? 's' : ''} in your ${getVideosFolderName()} folder: ${list}. Which one would you like to open?`
            };
        }

        case 'open_editor': {
            // Hard block on concurrent launches — kills/relaunches race each other
            if (_editorOpening) {
                return { status: 'debounced', speak: 'OpenShot is already opening, just a moment...' };
            }
            _editorOpening = true;

            const projectMode = args.project_mode || 'new';
            // Auto-name if user didn't give one
            const defaultName = `Nova_Edit_${new Date().toISOString().slice(0, 10)}`;
            const projectName = (file_name || '').replace(/\.osp$/i, '').trim() || defaultName;
            const videosDir   = getVideosDir();

            logFn('🎬 Killing any existing OpenShot instance...');
            await killOpenShot();

            // ── Resolve project path without any dialog ────────────────────
            let projectPath   = null;
            let projectStatus = '';

            if (projectName) {
                if (projectMode === 'existing') {
                    projectPath = findExistingProject(projectName);
                    if (projectPath) {
                        projectStatus = 'opened_existing';
                        logFn(`🎬 Found existing project: ${projectPath}`);
                        // Clear timeline clips and normalize all file paths to absolute.
                        // OpenShot stores relative paths (./video.mp4) which libopenshot
                        // can't resolve from the Node process CWD — must be absolute.
                        try {
                            const ospDir2 = path.dirname(projectPath);
                            const p = readOsp(projectPath);
                            p.clips = [];
                            p.files = (p.files || []).map(f => {
                                if (f.path && !path.isAbsolute(f.path)) {
                                    const abs = path.resolve(ospDir2, f.path);
                                    return { ...f, path: abs, reader: { ...f.reader, path: abs } };
                                }
                                return f;
                            });
                            writeOsp(projectPath, p);
                            logFn('🎬 Cleared timeline clips, normalized file paths — fresh session starts at 0s');
                        } catch (e) {
                            logFn(`🎬 Warning: could not reset project: ${e.message}`);
                        }
                    } else {
                        // Not found — create a new one with this name
                        projectPath   = path.join(videosDir, `${projectName}.osp`);
                        projectStatus = 'created_new';
                        createMinimalOspProject(projectPath, projectName);
                        logFn(`🎬 Project not found; created new: ${projectPath}`);
                    }
                } else {
                    projectPath   = path.join(videosDir, `${projectName}.osp`);
                    projectStatus = 'created_new';
                    createMinimalOspProject(projectPath, projectName);
                    logFn(`🎬 Created project file: ${projectPath}`);
                }
            }

            // ── Launch OpenShot with the project file ──────────────────────
            logFn(`🎬 Launching OpenShot${projectPath ? ` with project: ${projectPath}` : ''}...`);
            launchOpenShot(projectPath);

            // Wait up to 4s for the process to appear — then return fast.
            // Keeping this short prevents the long silence that causes Gemini echo/retry loops.
            // The window detection for actual keystroke actions is handled in import_file/sendKey.
            let confirmed = false;
            for (let i = 0; i < 2; i++) {
                await new Promise(r => setTimeout(r, 2000));
                if (await isOpenShotRunning()) { confirmed = true; break; }
                logFn(`🎬 Waiting for OpenShot... (${(i + 1) * 2}s)`);
            }

            if (!confirmed) {
                _videoEditorModeActive = false;
                _editorOpening = false;
                logFn('❌ OpenShot failed to start');
                return {
                    status: 'error',
                    speak: `OpenShot didn't open. Make sure it's installed: flatpak install flathub org.openshot.OpenShot`
                };
            }

            _videoEditorModeActive = true;
            _editorOpening = false;
            _currentProjectPath = projectPath; // track for direct .osp editing
            logFn(`🎬 OpenShot launched (project: ${projectPath})`);

            // Bring OpenShot to foreground (focus only — no keystrokes, no input stealing)
            if (process.platform === 'linux') {
                setTimeout(() => {
                    exec(
                        'WID=$(xdotool search --onlyvisible --name "OpenShot" 2>/dev/null | head -1); ' +
                        '[ -z "$WID" ] && WID=$(xdotool search --onlyvisible --class "openshot" 2>/dev/null | head -1); ' +
                        '[ -n "$WID" ] && xdotool windowactivate "$WID" 2>/dev/null; true',
                        () => {}
                    );
                }, 4000); // give OpenShot 4s to fully load its window before activating
            }

            // Scan the ${getVideosFolderName()} folder so Nova can immediately tell the user what's available
            const videoExts  = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v'];
            const videoFiles = fs.existsSync(videosDir)
                ? fs.readdirSync(videosDir).filter(f => videoExts.some(e => f.toLowerCase().endsWith(e)))
                : [];

            const speak = projectStatus === 'opened_existing'
                ? `OpenShot is open with your existing project "${projectName}" loaded from your ${getVideosFolderName()} folder.`
                : `OpenShot is open and your project "${projectName}" is saved to your ${getVideosFolderName()} folder.`;

            return {
                status:         'ok',
                project_path:   projectPath,
                project_status: projectStatus,
                video_files:    videoFiles,
                speak,
            };
        }

        case 'create_project': {
            // Legacy path — project creation now happens inside open_editor.
            // Keep this so old Gemini calls don't crash but treat it as a no-op.
            const projectName = (file_name || 'My Project').replace(/\.osp$/i, '');
            const pPath = path.join(getVideosDir(), `${projectName}.osp`);
            if (!fs.existsSync(pPath)) createMinimalOspProject(pPath, projectName);
            logFn(`🎬 create_project (legacy): ${pPath}`);
            return {
                status: 'ok',
                speak: `Your project "${projectName}" is saved to your ${getVideosFolderName()} folder. What video files would you like to import?`
            };
        }

        case 'import_file': {
            if (!_videoEditorModeActive) {
                return { status: 'error', speak: 'OpenShot is not open. Say "help me edit a video" to start.' };
            }
            if (!_currentProjectPath || !fs.existsSync(_currentProjectPath)) {
                return { status: 'error', speak: 'I lost track of the project file. Please restart the video editor.' };
            }

            const fn       = file_name || '';
            const fullPath = expandVideoPath(fn);
            logFn(`🎬 Adding to project and timeline: ${fullPath}`);

            if (!fs.existsSync(fullPath)) {
                return { status: 'error', speak: `I couldn't find "${fn}" in your ${getVideosFolderName()} folder. Please check the filename and try again.` };
            }

            try {
                logFn('🎬 Closing OpenShot to edit project file...');
                await killOpenShot();

                const entry = await importFileIntoOsp(_currentProjectPath, fullPath, logFn);

                // Duplicate guard: if this file is already on the timeline don't add it again.
                const projNow = readOsp(_currentProjectPath);
                if ((projNow.clips || []).some(c => c.file_id === entry.id)) {
                    logFn(`🎬 Duplicate blocked in import_file: ${path.basename(fullPath)} already on timeline`);
                    launchOpenShot(_currentProjectPath);
                    const name = path.basename(fullPath);
                    return {
                        status: 'ok', file_id: entry.id, file_name: name, clip_position: 0,
                        speak: `"${name}" is already on your timeline. Say another filename to add, or say play to preview.`
                    };
                }

                const clip  = await addClipToOspTimeline(_currentProjectPath, entry.id, logFn);

                // Relaunch in background — don't await. Nova speaks the confirmation
                // while OpenShot loads the updated timeline behind the scenes.
                launchOpenShot(_currentProjectPath);

                const name = path.basename(fullPath);
                return {
                    status: 'ok',
                    file_id: entry.id,
                    file_name: name,
                    clip_position: clip.position,
                    remaining_files: getRemainingVideoFiles(_currentProjectPath),
                    speak: `Done! "${name}" is on your timeline at ${clip.position.toFixed(1)} seconds.`
                };
            } catch (e) {
                logFn(`🎬 import_file error: ${e.message}`);
                launchOpenShot(_currentProjectPath);
                return { status: 'error', speak: `I had trouble with that file: ${e.message.slice(0, 100)}` };
            }
        }

        case 'add_to_timeline': {
            // If the editor is still launching (open_editor was called seconds ago), wait up to 8s for it.
            if (!_videoEditorModeActive) {
                for (let i = 0; i < 8; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    if (_videoEditorModeActive) break;
                }
            }
            if (!_videoEditorModeActive) return { status: 'error', speak: 'OpenShot is not open. Say "help me edit a video" to start.' };
            if (!_currentProjectPath || !fs.existsSync(_currentProjectPath)) {
                return { status: 'error', speak: 'I lost track of the project file. Please restart the video editor.' };
            }

            const fn = file_name || '';
            logFn(`🎬 Adding to timeline via .osp edit: ${fn}`);

            try {
                // Kill OpenShot only if currently running — so we can safely write the .osp.
                // After the edit we relaunch it immediately in the background (not awaited),
                // so Nova responds instantly while OpenShot loads the updated timeline.
                if (await isOpenShotRunning()) {
                    await killOpenShot();
                    // No wait — OpenShot exits within ms, proceed immediately.
                }
                _openShotKilled = true;

                const lowerFn = fn.toLowerCase();
                let proj = readOsp(_currentProjectPath);

                // Find the file in the project (by name or path match)
                let fileEntry = (proj.files || []).find(f =>
                    f.name?.toLowerCase() === fn.toLowerCase() ||
                    f.path?.toLowerCase().includes(lowerFn) ||
                    path.basename(f.path || '').toLowerCase().includes(lowerFn)
                );

                // Auto-import the file if it's not already in the project
                if (!fileEntry) {
                    const fullPath = expandVideoPath(fn);
                    if (!fs.existsSync(fullPath)) {
                        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v'];
                        const available = fs.existsSync(getVideosDir())
                            ? fs.readdirSync(getVideosDir()).filter(f => videoExts.some(e => f.toLowerCase().endsWith(e)) && !f.toLowerCase().includes('_movie'))
                            : [];
                        const availStr = available.length ? ` Available: ${available.slice(0, 5).join(', ')}.` : '';
                        return { status: 'error', speak: `I couldn't find "${fn}" in your ${getVideosFolderName()} folder.${availStr} Which file did you mean?` };
                    }
                    logFn(`🎬 File not in project yet — auto-importing: ${fullPath}`);
                    fileEntry = await importFileIntoOsp(_currentProjectPath, fullPath, logFn);
                }

                // Duplicate guard: if this file is already on the timeline, don't add it again.
                // This catches the case where import_file already added it and Gemini retries.
                const alreadyOnTimeline = (readOsp(_currentProjectPath).clips || []).some(c => c.file_id === fileEntry.id);
                if (alreadyOnTimeline) {
                    logFn(`🎬 Duplicate blocked: ${fn} is already on the timeline`);
                    launchOpenShot(_currentProjectPath);
                    _openShotKilled = false;
                    const name = fileEntry.name || fn;
                    return {
                        status: 'ok',
                        file_name: name,
                        speak: `"${name}" is already on your timeline. Say another filename, or say play to preview.`
                    };
                }

                const clip = await addClipToOspTimeline(_currentProjectPath, fileEntry.id, logFn);

                // Relaunch OpenShot in the background — don't await so we return immediately.
                // The project loads while Nova is speaking the confirmation, so the user sees
                // the updated timeline within a few seconds without Nova going silent.
                launchOpenShot(_currentProjectPath);
                _openShotKilled = false;

                const name = fileEntry.name || fn;
                return {
                    status: 'ok',
                    file_name: name,
                    remaining_files: getRemainingVideoFiles(_currentProjectPath),
                    speak: `Done! "${name}" added to the timeline.`
                };
            } catch (e) {
                logFn(`🎬 add_to_timeline error: ${e.message}`);
                launchOpenShot(_currentProjectPath); // restore editor on error
                _openShotKilled = false;
                return { status: 'error', speak: `I had trouble adding the clip: ${e.message.slice(0, 100)}` };
            }
        }

        case 'delete_clip': {
            if (!_videoEditorModeActive) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!_currentProjectPath || !fs.existsSync(_currentProjectPath)) {
                return { status: 'error', speak: 'I lost track of the project file. Please restart the video editor.' };
            }

            const delName = (file_name || instruction || '').trim().toLowerCase().replace(/\.mp4$/i, '');
            if (!delName) {
                return { status: 'error', speak: 'Please tell me which video to remove from the timeline. For example, say "delete pokemon.mp4 from the timeline".' };
            }

            const proj = readOsp(_currentProjectPath);

            // Find the file entry by name match
            const delEntry = (proj.files || []).find(f =>
                f.name?.toLowerCase().includes(delName) ||
                path.basename(f.path || '').toLowerCase().includes(delName)
            );

            if (!delEntry) {
                return { status: 'error', speak: `I couldn't find a file matching "${delName}" in this project.` };
            }

            // Remove all timeline clips for this file
            const before = (proj.clips || []).length;
            proj.clips = (proj.clips || []).filter(c => c.file_id !== delEntry.id);
            const removed = before - proj.clips.length;

            if (removed === 0) {
                return { status: 'error', speak: `"${delEntry.name}" isn't on the timeline right now. It's in your project files but not placed on any track.` };
            }

            // Reload OpenShot with the updated project
            await killOpenShot();
            await new Promise(r => setTimeout(r, 500));
            writeOsp(_currentProjectPath, proj);
            launchOpenShot(_currentProjectPath);
            await new Promise(r => setTimeout(r, 800));

            logFn(`🎬 Deleted ${removed} clip(s) for "${delEntry.name}" from timeline`);
            return {
                status: 'ok',
                speak: `Done! I've removed "${delEntry.name}" from the timeline. The editor has been updated. ` +
                       `Want to add a different clip, or say "play" to preview what's left?`
            };
        }

        case 'play_preview': {
            logFn(`🎬 play_preview: active=${_videoEditorModeActive} path=${_currentProjectPath}`);
            if (!_videoEditorModeActive) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!_currentProjectPath || !fs.existsSync(_currentProjectPath)) {
                return { status: 'error', speak: 'I lost track of the project file. Please restart the video editor.' };
            }

            const proj = readOsp(_currentProjectPath);
            const allClips = proj.clips || [];
            logFn(`🎬 play_preview: ${allClips.length} total clips in .osp, layers: [${[...new Set(allClips.map(c => c.layer))].join(',')}]`);

            const TARGET_LAYER_P = 5000000;
            let timelineClips = allClips
                .filter(c => c.layer === TARGET_LAYER_P)
                .sort((a, b) => (a.position || 0) - (b.position || 0));

            // Fallback: if no clips on the target layer, try any layer (e.g. OpenShot moved them)
            if (timelineClips.length === 0 && allClips.length > 0) {
                logFn(`🎬 play_preview: no clips on layer 5000000 — falling back to all clips`);
                timelineClips = [...allClips].sort((a, b) => (a.position || 0) - (b.position || 0));
            }

            if (timelineClips.length === 0) {
                return { status: 'error', speak: 'No clips on the timeline yet! Add some videos first, then say play.' };
            }

            // has_audio can be boolean (our buildFileEntry) or keyframe object (if OpenShot re-saved the .osp)
            function _hasAudioEnabled(val) {
                if (typeof val === 'boolean') return val;
                if (val && typeof val === 'object' && Array.isArray(val.Points)) {
                    const y = val.Points[0]?.co?.Y;
                    return y === undefined || Number(y) >= 0; // Y=-1 means disabled in OpenShot
                }
                return !!val;
            }

            // Build a map from file_id → { path, hasAudio }
            // Resolve relative paths from the .osp's directory (OpenShot sometimes stores them relative)
            const ospDir = path.dirname(_currentProjectPath);
            const fileMap = {};
            for (const f of (proj.files || [])) {
                const rawPath = f.path || '';
                const fPath = rawPath && !path.isAbsolute(rawPath)
                    ? path.resolve(ospDir, rawPath)
                    : rawPath;
                fileMap[f.id] = { path: fPath, hasAudio: _hasAudioEnabled(f.has_audio) };
            }
            logFn(`🎬 play_preview: fileMap has ${Object.keys(fileMap).length} entries`);

            const clipInfos = timelineClips.map(c => {
                const fm = fileMap[c.file_id] || {};
                const p = fm.path || '';
                const exists = p ? fs.existsSync(p) : false;
                logFn(`🎬   clip file_id=${c.file_id} path="${p}" exists=${exists} hasAudio=${fm.hasAudio} start=${c.start} end=${c.end}`);
                return {
                    path: p,
                    hasAudio: fm.hasAudio !== false,
                    start: c.start || 0,
                    end:   c.end   || 30,
                };
            }).filter(c => c.path && fs.existsSync(c.path));

            logFn(`🎬 play_preview: ${clipInfos.length} clips ready for ffmpeg`);
            if (clipInfos.length === 0) {
                const allPaths = timelineClips.map(c => fileMap[c.file_id]?.path || 'MISSING').join(', ');
                logFn(`🎬 play_preview: missing files — ${allPaths}`);
                return { status: 'error', speak: `Could not find the video files. Make sure the ${getVideosFolderName()} folder is accessible.` };
            }

            const projectName = path.basename(_currentProjectPath, '.osp');
            const outputPath  = path.join(path.dirname(_currentProjectPath), `${projectName}_movie.mp4`);

            logFn(`🎬 Rendering ${clipInfos.length} clip(s) → ${outputPath}`);

            // Build ffmpeg filter_complex concat.
            // - All clips are scaled to 1280x720 with letterbox padding (handles resolution mismatch).
            // - Clips without an audio stream get a silent aevalsrc track so concat always works.
            await new Promise((resolve, reject) => {
                const inputs = clipInfos.map(c => {
                    const safe = c.path.replace(/'/g, "'\\''");
                    return `-i '${safe}'`;
                }).join(' ');
                const n = clipInfos.length;
                const TARGET_W = 1280, TARGET_H = 720;
                const vFilters = clipInfos.map((c, i) =>
                    `[${i}:v]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
                    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,` +
                    `trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS[v${i}]`);
                const aFilters = clipInfos.map((c, i) => {
                    if (c.hasAudio) {
                        return `[${i}:a]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`;
                    }
                    // No audio stream — synthesize silence matching clip duration
                    const dur = (c.end - c.start).toFixed(3);
                    return `aevalsrc=0:channel_layout=stereo:sample_rate=44100[_silent${i}];` +
                           `[_silent${i}]atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`;
                });
                const concatIn  = clipInfos.map((_, i) => `[v${i}][a${i}]`).join('');
                const filterComplex = [
                    ...vFilters, ...aFilters,
                    `${concatIn}concat=n=${n}:v=1:a=1[outv][outa]`
                ].join(';');
                const outSafe = outputPath.replace(/'/g, "'\\''");
                const cmd = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -c:a aac '${outSafe}'`;
                logFn(`🎬 FFmpeg cmd: ${cmd.slice(0, 300)}...`);
                exec(cmd, { timeout: 300000 }, (err, _stdout, stderr) => {
                    if (err) {
                        const detail = (stderr || '').split('\n')
                            .filter(l => l.toLowerCase().includes('error') || l.includes('Invalid') || l.includes('failed'))
                            .slice(-3).join(' ') || err.message;
                        logFn(`🎬 FFmpeg error: ${detail}`);
                        reject(new Error(`FFmpeg render failed: ${detail}`));
                    } else {
                        resolve();
                    }
                });
            });

            logFn(`🎬 Movie saved: ${outputPath}`);
            openWithSystemPlayer(outputPath);

            return {
                status: 'ok',
                speak: `Your movie is ready! I've saved it as "${projectName}_movie.mp4" in your ${getVideosFolderName()} folder and it's now playing. ` +
                       `When you're done watching, say "close preview" to go back to editing. ` +
                       `Say "save" to save the project, or "export" to use OpenShot's full export dialog.`
            };
        }

        case 'close_preview':
        case 'stop_preview': {
            // Close any open video player — no xdotool needed
            exec('pkill -f "_movie.mp4" 2>/dev/null; pkill mpv 2>/dev/null; pkill vlc 2>/dev/null; pkill celluloid 2>/dev/null; pkill totem 2>/dev/null; true');
            return {
                status: 'ok',
                speak: `Preview closed. The editor is still open! ` +
                       `You can add more clips, say "play" again to re-render and preview, say "save" to save, or say "close editor" when you're completely done.`
            };
        }

        case 'save_project': {
            if (!_videoEditorModeActive) return { status: 'error', speak: 'No editor session is active.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool to save for you. Install it: sudo pacman -S xdotool' };
            }
            // If OpenShot was killed during editing, relaunch it so we can send Ctrl+S.
            if (_openShotKilled || !(await isOpenShotRunning())) {
                logFn('🎬 Relaunching OpenShot to save...');
                launchOpenShot(_currentProjectPath);
                _openShotKilled = false;
                const wid = await waitForOpenShotWindow(20000);
                if (!wid) return { status: 'error', speak: 'OpenShot took too long to open. Try saying save again.' };
                await new Promise(r => setTimeout(r, 1000)); // extra settle time before keystroke
            }
            logFn('🎬 Saving project (Ctrl+S)');
            await focusOpenShot();
            await sendKey('ctrl+s');
            await new Promise(r => setTimeout(r, 500));
            return {
                status: 'ok',
                speak: `Project saved! Would you like to keep editing, or shall I close the editor?`
            };
        }

        case 'export_video': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool to open the export dialog for you. Install it: sudo pacman -S xdotool' };
            }
            logFn('🎬 Opening Export dialog (Ctrl+Shift+E)');
            await sendKey('ctrl+shift+e');
            return {
                status: 'ok',
                speak: `I\'ve opened the Export Video dialog. Keep the default MP4 format, choose your output folder, ` +
                       `give it a filename, then click Export File. Rendering may take a few minutes.`
            };
        }

        case 'undo': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool for undo. Install it: sudo pacman -S xdotool' };
            }
            logFn('🎬 Undo (Ctrl+Z)');
            await sendKey('ctrl+z');
            return { status: 'ok', speak: 'Undone! Say undo again to go back further.' };
        }

        case 'redo': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool for redo. Install it: sudo pacman -S xdotool' };
            }
            logFn('🎬 Redo (Ctrl+Y)');
            await sendKey('ctrl+y');
            return { status: 'ok', speak: 'Redone!' };
        }

        case 'guide': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) {
                return { status: 'error', speak: 'OpenShot is not open. Say "help me edit a video" to open it.' };
            }
            const needsInstall = !canAutomate && process.platform === 'linux';
            return {
                status: needsInstall ? 'needs_xdotool' : 'ok',
                speak: needsInstall
                    ? `OpenShot is open but I can\'t control it yet — I need xdotool. Run: sudo pacman -S xdotool — then restart Nova for full control.`
                    : `Editor is open! Say a filename to add it (e.g. "add video1.mp4"), "delete [filename]" to remove, "play" to preview, "save" to save, or "close editor" when done.`
            };
        }

        case 'close_editor': {
            _videoEditorModeActive = false;
            _editorOpening = false;
            _currentProjectPath = null;
            _veDebounce.clear();
            logFn('🎬 Closing video editor session (OpenShot + any preview player)');
            // Kill OpenShot
            const p = process.platform;
            let closeCmd;
            if (p === 'linux')   closeCmd = `flatpak kill org.openshot.OpenShot 2>/dev/null; pkill -f openshot 2>/dev/null; true`;
            else if (p === 'darwin') closeCmd = `osascript -e 'tell application "OpenShot Video Editor" to quit' 2>/dev/null; true`;
            else if (p === 'win32')  closeCmd = `taskkill /IM openshot-qt.exe /F 2>nul & echo done`;
            if (closeCmd) exec(closeCmd);
            // Also close any open video preview player
            exec('pkill -f "_movie.mp4" 2>/dev/null; pkill mpv 2>/dev/null; pkill vlc 2>/dev/null; pkill celluloid 2>/dev/null; pkill totem 2>/dev/null; true');
            return {
                status: 'ok',
                speak: `All done! The video editor and any preview windows are now closed. ` +
                       `Your project is saved in your ${getVideosFolderName()} folder. ` +
                       `Let me know whenever you'd like to start editing again!`
            };
        }

        default:
            return { status: 'error', speak: `I don't know how to handle "${action}" in the video editor. Try saying "add a video", "delete the clip", "save", or "export".` };
    }
}

module.exports = { handleVideoEditorTool, isVideoEditorModeActive };
