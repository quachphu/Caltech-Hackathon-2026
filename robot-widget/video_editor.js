require('dotenv').config();
const { exec, spawn } = require('child_process');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

let _videoEditorModeActive = false;
let _editorOpening        = false;
let _currentProjectPath   = null;  // tracks the active .osp file for direct editing
const _veDebounce = new Map();
const VE_DEBOUNCE_MS = {
    open_editor:     8000,
    create_project:  15000,
    import_file:     12000,
    add_to_timeline: 3000,
    delete_clip:     3000,
    play_preview:    2000,
    stop_preview:    2000,
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

function expandVideoPath(fileName) {
    if (!fileName) return fileName;
    // If the user gave a bare filename (no dir), default to the Videos folder
    if (!fileName.includes('/') && !fileName.includes('\\')) {
        return path.join(getVideosDir(), fileName);
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
        tags: [],
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
    const meta  = await getVideoMetadata(videoPath);
    const entry = buildFileEntry(videoPath, meta);
    const proj  = readOsp(ospPath);

    // Remove any existing entry for the same path
    proj.files = (proj.files || []).filter(f => f.path !== videoPath);
    proj.files.push(entry);
    writeOsp(ospPath, proj);

    logFn(`🎬 Added to .osp: ${path.basename(videoPath)} (${meta.duration.toFixed(1)}s, ${meta.width}x${meta.height})`);
    return entry;
}

// Add a clip to the timeline in the .osp project file
function addClipToOspTimeline(ospPath, fileId, logFn) {
    const proj = readOsp(ospPath);

    // Find the file entry
    const fileEntry = (proj.files || []).find(f => f.id === fileId);
    if (!fileEntry) throw new Error('File not found in project');

    // Calculate position: end of last clip on layer 1000000
    const existingClips = (proj.clips || []).filter(c => c.layer === 1000000);
    const lastEnd = existingClips.reduce((max, c) => Math.max(max, (c.position || 0) + (c.end || 0)), 0);
    const position = lastEnd;

    const clip = buildClipEntry(fileEntry, position, 1000000);
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
    const { action, file_name, instruction } = args;
    logFn(`🎬 [VideoEditor] action="${action}" file="${file_name || ''}" instruction="${instruction || ''}"`);

    const now = Date.now();
    const cooldown = VE_DEBOUNCE_MS[action] || 3000;
    if (now - (_veDebounce.get(action) || 0) < cooldown) {
        return { status: 'debounced', speak: 'Already on it, just a moment.' };
    }
    _veDebounce.set(action, now);

    const hasXdotool = process.platform === 'linux' ? await checkXdotool() : false;
    const canAutomate = hasXdotool || process.platform !== 'linux';

    switch (action) {

        case 'list_projects': {
            const projects = listOspProjects();
            if (projects.length === 0) {
                return {
                    status: 'ok',
                    projects: [],
                    speak: "You don't have any saved projects in your Videos folder yet. Just tell me a name and I'll create a fresh one."
                };
            }
            const list = projects.slice(0, 10).join(', ');
            return {
                status: 'ok',
                projects,
                speak: `Found ${projects.length} project${projects.length > 1 ? 's' : ''} in your Videos folder: ${list}. Which one would you like to open?`
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

            // Scan the Videos folder so Nova can immediately tell the user what's available
            const videoExts  = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v'];
            const videoFiles = fs.existsSync(videosDir)
                ? fs.readdirSync(videosDir).filter(f => videoExts.some(e => f.toLowerCase().endsWith(e)))
                : [];

            const speak = projectStatus === 'opened_existing'
                ? `OpenShot is open with your existing project "${projectName}" loaded from your Videos folder.`
                : `OpenShot is open and your project "${projectName}" is saved to your Videos folder.`;

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
                speak: `Your project "${projectName}" is saved to your Videos folder. What video files would you like to import?`
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
            logFn(`🎬 Importing into .osp directly: ${fullPath}`);

            if (!fs.existsSync(fullPath)) {
                return { status: 'error', speak: `I couldn't find "${fn}" in your Videos folder. Please check the filename and try again.` };
            }

            try {
                // Close OpenShot first so it doesn't overwrite our changes on exit
                logFn('🎬 Closing OpenShot to edit project file...');
                await killOpenShot();
                await new Promise(r => setTimeout(r, 500));

                // Edit the .osp file directly — no dialogs, no focus stealing
                const entry = await importFileIntoOsp(_currentProjectPath, fullPath, logFn);

                // Reopen OpenShot with the updated project
                logFn('🎬 Reopening OpenShot with updated project...');
                launchOpenShot(_currentProjectPath);
                await new Promise(r => setTimeout(r, 800));

                const name = path.basename(fullPath);
                return {
                    status: 'ok',
                    file_id: entry.id,
                    speak: `Done! I've added "${name}" to your project and reopened the editor. ` +
                           `It should appear in the Project Files panel on the left. ` +
                           `Would you like to import another video, or shall I add this one to the timeline?`
                };
            } catch (e) {
                logFn(`🎬 import_file error: ${e.message}`);
                return { status: 'error', speak: `I had trouble importing the file: ${e.message.slice(0, 100)}` };
            }
        }

        case 'add_to_timeline': {
            if (!_videoEditorModeActive) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!_currentProjectPath || !fs.existsSync(_currentProjectPath)) {
                return { status: 'error', speak: 'I lost track of the project file. Please restart the video editor.' };
            }

            const fn = file_name || '';
            logFn(`🎬 Adding to timeline via .osp edit: ${fn}`);

            try {
                const proj = readOsp(_currentProjectPath);

                // Find the file in the project (by name or path match)
                const lowerFn = fn.toLowerCase().replace(/\.osp$/i, '');
                const fileEntry = (proj.files || []).find(f =>
                    f.name?.toLowerCase() === fn.toLowerCase() ||
                    f.path?.toLowerCase().includes(lowerFn) ||
                    path.basename(f.path || '').toLowerCase().includes(lowerFn)
                );

                if (!fileEntry) {
                    return {
                        status: 'error',
                        speak: `I couldn't find "${fn}" in the project. Please import it first, then ask me to add it to the timeline.`
                    };
                }

                // Close OpenShot, edit the .osp, reopen
                await killOpenShot();
                await new Promise(r => setTimeout(r, 500));

                const clip = addClipToOspTimeline(_currentProjectPath, fileEntry.id, logFn);
                launchOpenShot(_currentProjectPath);
                await new Promise(r => setTimeout(r, 800));

                const name = fileEntry.name || fn;
                return {
                    status: 'ok',
                    speak: `Added "${name}" to the timeline at position ${clip.position.toFixed(1)} seconds. ` +
                           `I've reopened the editor with it on the timeline. ` +
                           `Would you like to add another clip, play the preview, or export the video?`
                };
            } catch (e) {
                logFn(`🎬 add_to_timeline error: ${e.message}`);
                return { status: 'error', speak: `I had trouble adding the clip: ${e.message.slice(0, 100)}` };
            }
        }

        case 'delete_clip': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return {
                    status: 'needs_xdotool',
                    speak: `I need xdotool to delete clips for you. Install it with: sudo pacman -S xdotool — then restart Nova.`
                };
            }
            logFn('🎬 Sending Delete key to OpenShot');
            await sendKey('Delete');
            return {
                status: 'ok',
                speak: `I\'ve pressed Delete. If a clip was selected in the timeline it\'s now removed. ` +
                       `If nothing happened, click the clip first to select it, then ask me to delete again.`
            };
        }

        case 'play_preview': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return {
                    status: 'needs_xdotool',
                    speak: `I need xdotool to press play for you. Install it with: sudo pacman -S xdotool — then restart Nova.`
                };
            }
            logFn('🎬 Toggling playback (Space)');
            await sendKey('space');
            return {
                status: 'ok',
                speak: `I\'ve pressed Space to play your video. Watch the preview window at the top right. Tell me to stop when done.`
            };
        }

        case 'stop_preview': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool to control playback. Install it: sudo pacman -S xdotool' };
            }
            await sendKey('space');
            return { status: 'ok', speak: 'Stopped playback.' };
        }

        case 'save_project': {
            const isOpen = _videoEditorModeActive && await isOpenShotRunning();
            if (!isOpen) return { status: 'error', speak: 'OpenShot is not open.' };
            if (!canAutomate) {
                return { status: 'needs_xdotool', speak: 'I need xdotool to save for you. Install it: sudo pacman -S xdotool' };
            }
            logFn('🎬 Saving project (Ctrl+S)');
            await sendKey('ctrl+s');
            return {
                status: 'ok',
                speak: `I\'ve pressed Control S to save. If this is a new project OpenShot will ask you to pick a location — ` +
                       `choose your Desktop or Videos folder and click Save.`
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
                    : `OpenShot is open and I have full control. What would you like to do? I can import a video, add it to the timeline, delete clips, preview, save, or export.`
            };
        }

        case 'close_editor': {
            _videoEditorModeActive = false;
            _editorOpening = false;
            _currentProjectPath = null;
            _veDebounce.clear();
            logFn('🎬 Closing video editor session');
            const p = process.platform;
            let closeCmd;
            if (p === 'linux')   closeCmd = `flatpak kill org.openshot.OpenShot 2>/dev/null; pkill -f openshot 2>/dev/null; true`;
            else if (p === 'darwin') closeCmd = `osascript -e 'tell application "OpenShot Video Editor" to quit' 2>/dev/null; true`;
            else if (p === 'win32')  closeCmd = `taskkill /IM openshot-qt.exe /F 2>nul & echo done`;
            if (closeCmd) exec(closeCmd);
            return {
                status: 'ok',
                speak: `Video editing session closed. OpenShot is shutting down. ` +
                       `Your project was saved if you saved it during the session. ` +
                       `Let me know whenever you want to start editing again!`
            };
        }

        default:
            return { status: 'error', speak: `I don't know how to handle "${action}" in the video editor. Try saying "add a video", "delete the clip", "save", or "export".` };
    }
}

module.exports = { handleVideoEditorTool, isVideoEditorModeActive };
