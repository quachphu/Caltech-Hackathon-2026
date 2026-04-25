'use strict';
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { exec, spawn }  = require('child_process');
const os               = require('os');
const fs               = require('fs');
const path             = require('path');
const http             = require('http');
const net              = require('net');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Session State ──────────────────────────────────────────────────────────
let _active         = false;
let _projectPath    = null;
let _projectName    = null;
let _projectType    = null;   // 'static_website'|'react'|'api_only'|'fullstack'|'cli'|'extension'|'python'
let _vscodeProc     = null;
let _serverProc     = null;   // frontend / main dev server
let _apiProc        = null;   // backend for fullstack
let _serverPort     = null;
let _apiPort        = null;
let _staticServer   = null;   // built-in Node http.Server (static sites)
let _endpoints      = [];     // API endpoints cache
let _projectFiles   = {};     // relative path → content (hot cache after generate)

// ── Cross-platform Desktop path ────────────────────────────────────────────
function getDesktopPath() {
    if (process.platform === 'linux') {
        const xdg = process.env.XDG_DESKTOP_DIR;
        if (xdg && fs.existsSync(xdg)) return xdg;
    }
    return path.join(os.homedir(), 'Desktop');
}

// ── List project folders on Desktop ───────────────────────────────────────
function listDesktopProjects() {
    const desktop = getDesktopPath();
    try {
        return fs.readdirSync(desktop, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name);
    } catch (e) {
        console.error('[CodeAgent] Cannot read Desktop:', e.message);
        return [];
    }
}

// ── Fuzzy-match a project name against existing folders ───────────────────
// Returns { name, score } (score 0-100) or null if no reasonable match.
function fuzzyMatchProject(query, projects) {
    if (!query || !projects.length) return null;
    const q = query.toLowerCase().replace(/[\s_-]+/g, '');
    let best = null, bestScore = 0;

    for (const p of projects) {
        const n = p.toLowerCase().replace(/[\s_-]+/g, '');
        let score = 0;
        if (n === q)                          score = 100;
        else if (n.startsWith(q) || q.startsWith(n)) score = 82;
        else if (n.includes(q) || q.includes(n))     score = 64;
        else {
            const qt = q.split('');
            const matched = qt.filter(c => n.includes(c)).length;
            score = Math.round((matched / Math.max(qt.length, n.length)) * 45);
        }
        if (score > bestScore) { bestScore = score; best = p; }
    }
    return bestScore >= 50 ? { name: best, score: bestScore } : null;
}

// ── Create project folder on Desktop ──────────────────────────────────────
function createProjectFolder(projectName) {
    const safeName = projectName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
    const projectPath = path.join(getDesktopPath(), safeName);
    fs.mkdirSync(projectPath, { recursive: true });
    _projectPath = projectPath;
    _projectName = safeName;
    return projectPath;
}

// ── Open folder in VS Code ─────────────────────────────────────────────────
function openInVSCode(folderPath, logFn) {
    const log = logFn || console.log;
    return new Promise((resolve) => {
        log(`💻 Opening VS Code → ${folderPath}`);
        try {
            _vscodeProc = spawn('code', ['--new-window', folderPath], {
                detached: true,
                stdio: 'ignore',
                shell: process.platform === 'win32',
            });
            _vscodeProc.unref();
            log(`💻 VS Code launched`);
            resolve({ success: true });
        } catch (e) {
            console.error('[CodeAgent] VS Code launch failed:', e.message);
            // Fallback: try platform-specific open
            const fallback = process.platform === 'darwin'
                ? `open -a "Visual Studio Code" "${folderPath}"`
                : process.platform === 'win32'
                ? `start "" code "${folderPath}"`
                : `xdg-open "${folderPath}"`;
            exec(fallback, (err2) => {
                if (err2) { console.error('[CodeAgent] Fallback open failed:', err2.message); }
            });
            resolve({ success: false, error: e.message });
        }
    });
}

// ── Wait until a local port accepts connections ────────────────────────────
function waitForPort(port, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const sock = new net.Socket();
            sock.setTimeout(300);
            sock.connect(port, 'localhost', () => { sock.destroy(); resolve(true); });
            sock.on('error', () => {
                sock.destroy();
                if (Date.now() < deadline) setTimeout(attempt, 400);
                else resolve(false);
            });
            sock.on('timeout', () => {
                sock.destroy();
                if (Date.now() < deadline) setTimeout(attempt, 400);
                else resolve(false);
            });
        };
        attempt();
    });
}

// ── Read all source files of a project into a flat map ────────────────────
function readProjectFiles(projectPath) {
    const files = {};
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
    const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py',
                               '.md', '.txt', '.sh', '.yaml', '.yml', '.env.example', '.toml']);

    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') && e.name !== '.env.example') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) walk(full);
            } else {
                const ext = path.extname(e.name);
                if (CODE_EXTS.has(ext) || CODE_EXTS.has(e.name)) {
                    try {
                        const content = fs.readFileSync(full, 'utf8');
                        if (content.length < 80000) {
                            files[path.relative(projectPath, full)] = content;
                        }
                    } catch (_) {}
                }
            }
        }
    };
    walk(projectPath);
    return files;
}

// ── Parse JSON from Gemini response (handles markdown fences) ─────────────
function parseJsonResponse(raw) {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last  = s.lastIndexOf('}');
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
    return JSON.parse(s);
}

// ── Code-generation prompt ─────────────────────────────────────────────────
function buildGenerationPrompt(name, type, description) {
    const structs = {
        static_website: `Structure: index.html, style.css, script.js (add more pages if description needs it).
devCommand: "echo Static site ready — open index.html or use live-server"
installCommand: ""
port: 8080`,

        react: `Structure:
  package.json (Vite + React 18 + TypeScript strict)
  vite.config.ts  tsconfig.json  index.html
  src/main.tsx  src/App.tsx  src/index.css
  src/components/<name>.tsx   (one per logical section)
  src/hooks/use<Name>.ts      (custom hooks as needed)
  src/types/index.ts
devCommand: "npm run dev"
installCommand: "npm install"
port: 5173

package.json → exact versions:
  "react": "^18.3.1",  "react-dom": "^18.3.1"
  "@vitejs/plugin-react": "^4.3.1", "vite": "^5.4.2"
  "typescript": "^5.5.3", "@types/react": "^18.3.5", "@types/react-dom": "^18.3.0"
  scripts: { "dev": "vite", "build": "tsc && vite build" }`,

        api_only: `Structure:
  package.json (Express 4, CORS, dotenv)
  src/index.js           (server entry — CORS, JSON body parser, routes mount, /health)
  src/routes/<resource>.js   (one file per resource)
  src/controllers/<resource>Controller.js
  src/middleware/errorHandler.js
  .env.example (PORT=3001)
devCommand: "node src/index.js"
installCommand: "npm install"
port: 3001

package.json deps: { "express":"^4.19.2","cors":"^2.8.5","dotenv":"^16.4.5" }
devDeps: { "nodemon":"^3.1.4" }
scripts: { "start":"node src/index.js","dev":"nodemon src/index.js" }

Every endpoint returns: { "success": true, "data": ..., "message": "..." }
Errors: { "success": false, "error": "...", "code": 404 }
Include /health GET that returns { "status": "ok", "version": "1.0.0", "timestamp": Date.now() }`,

        fullstack: `TWO sub-directories — frontend/ AND backend/:

frontend/ (Vite + React 18 + TypeScript):
  package.json  vite.config.ts  tsconfig.json  index.html
  src/main.tsx  src/App.tsx  src/index.css
  src/pages/  src/components/  src/hooks/  src/api/client.ts  src/types/
  .env (VITE_API_URL=http://localhost:3001)

backend/ (Express API):
  package.json  src/index.js  src/routes/  src/controllers/  src/middleware/  .env (PORT=3001)

Root package.json:
{
  "scripts": {
    "dev": "concurrently \\"cd frontend && npm run dev\\" \\"cd backend && npm run dev\\"",
    "install:all": "cd frontend && npm install && cd ../backend && npm install"
  },
  "devDependencies": { "concurrently": "^8.2.2" }
}
devCommand: "npm run dev" (from root)
installCommand: "install:all"
port: 5173   (frontend), apiPort: 3001 (backend)`,

        cli: `Structure:
  package.json ("bin": { "<name>": "./bin/index.js" })
  bin/index.js (#!/usr/bin/env node  — uses commander)
  src/commands/<cmd>.js  src/utils/  README.md
deps: { "commander":"^12.1.0","chalk":"^5.3.0","ora":"^8.0.1" }
devCommand: "node bin/index.js --help"
installCommand: "npm install"
port: null`,

        extension: `Chrome Extension Manifest V3:
  manifest.json  popup.html  popup.js  popup.css  background.js  content.js  icons/icon.svg
manifest.json: manifest_version 3, action+popup, background service_worker, content_scripts
devCommand: "echo Load unpacked in chrome://extensions"
installCommand: ""
port: null`,

        python: `Structure:
  main.py  requirements.txt  src/__init__.py  src/core.py  src/utils.py  tests/test_main.py  README.md
Use Python 3.11+, type hints, dataclasses, pathlib, async where natural.
devCommand: "python main.py"
installCommand: "pip install -r requirements.txt"
port: ${description.toLowerCase().includes('web') || description.toLowerCase().includes('api') || description.toLowerCase().includes('flask') || description.toLowerCase().includes('fastapi') ? '8000' : 'null'}`,
    };

    return `You are Nova Code Engine — a world-class senior software engineer and UI/UX designer. Generate a complete, production-ready "${name}" project that looks visually stunning and professional.

USER DESCRIPTION: "${description}"
PROJECT TYPE: ${type}

${structs[type] || structs.static_website}

═══════════════════════ QUALITY CONTRACT ═══════════════════════
CODE QUALITY:
• TypeScript strict everywhere (JS projects)
• ES2022+ async/await, no callbacks
• Named constants for magic values
• Descriptive verb-noun function names
• Full error handling — never swallow errors silently

════════════════════ DESIGN SYSTEM — MANDATORY ════════════════════
You MUST produce a visually stunning, modern, professional UI. Think Vercel, Linear, Stripe, Apple.com quality.

CSS VARIABLES (define in :root and use EVERYWHERE — never hard-code values):
  --bg:           #080810    /* page background */
  --surface:      #0f0f1c    /* card / panel background */
  --surface-2:    #161625    /* elevated surface */
  --border:       rgba(255,255,255,0.07)
  --border-hover: rgba(255,255,255,0.14)
  --accent:       #6366f1    /* indigo — primary interactive */
  --accent-2:     #8b5cf6    /* violet — secondary / gradient end */
  --gold:         #c9a227    /* warm highlight */
  --cyan:         #06b6d4    /* info / links */
  --green:        #10b981    /* success */
  --red:          #ef4444    /* error */
  --text:         #f1f5f9    /* primary text */
  --text-2:       #94a3b8    /* secondary text */
  --text-3:       #475569    /* muted / placeholder */
  --radius:       12px
  --radius-sm:    8px
  --radius-lg:    20px
  --shadow:       0 4px 24px rgba(0,0,0,0.5)
  --shadow-lg:    0 8px 48px rgba(0,0,0,0.65)
  --transition:   0.18s ease

TYPOGRAPHY — use a proper scale, never flat same-size text:
  h1: clamp(2.2rem,5vw,3.8rem), font-weight:800, letter-spacing:-0.03em, line-height:1.1
  h2: clamp(1.6rem,3vw,2.6rem), font-weight:700, letter-spacing:-0.02em
  h3: 1.25rem, font-weight:600
  body: 1rem/1.7, font-weight:400
  small/label: 0.8125rem, font-weight:500, letter-spacing:0.06em, text-transform:uppercase
  Font stack: 'Inter',system-ui,-apple-system,sans-serif

NAVIGATION (every multi-page site needs this):
  • Sticky top bar: backdrop-filter:blur(20px), background:rgba(8,8,16,0.85), border-bottom:1px solid var(--border)
  • Logo left, nav links center/right
  • Nav links: color:var(--text-2), hover:color:var(--text), transition
  • Active/current page link highlighted with accent color
  • Mobile hamburger menu that actually works

HERO SECTION (for landing/marketing pages):
  • Full viewport height or min 80vh
  • Gradient text headline: background:linear-gradient(135deg,var(--text) 0%,var(--accent) 60%,var(--accent-2) 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent
  • Subtle radial glow behind: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.25), transparent)
  • Clear CTA button with hover glow
  • Subheadline in var(--text-2) with generous line-height

BUTTONS — always define all states:
  Primary:   background:var(--accent); color:#fff; padding:12px 28px; border-radius:var(--radius-sm); font-weight:600; border:none; cursor:pointer; transition:all var(--transition)
             hover: background:#4f52e0; transform:translateY(-1px); box-shadow:0 4px 20px rgba(99,102,241,0.45)
             active: transform:translateY(0); box-shadow:none
  Ghost:     background:transparent; border:1px solid var(--border-hover); color:var(--text-2); padding:11px 26px
             hover: border-color:var(--accent); color:var(--text); background:rgba(99,102,241,0.08)
  Danger:    background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); color:var(--red)

CARDS — make them feel premium:
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:24px;
  transition:border-color var(--transition), transform var(--transition), box-shadow var(--transition)
  hover: border-color:var(--border-hover); transform:translateY(-2px); box-shadow:var(--shadow-lg)
  Optional glow: box-shadow: 0 0 0 1px rgba(99,102,241,0.1), 0 8px 40px rgba(0,0,0,0.4)

FORMS & INPUTS:
  input/textarea: background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px 16px; color:var(--text); font-size:0.9375rem; outline:none; width:100%
  focus: border-color:var(--accent); box-shadow:0 0 0 3px rgba(99,102,241,0.18)
  label: color:var(--text-2); font-size:0.875rem; font-weight:500; margin-bottom:6px; display:block

LAYOUT GRID — use CSS Grid, not floats:
  Sections: max-width:1200px; margin:0 auto; padding:0 24px
  Feature grid: grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:24px
  Two-col: grid-template-columns:1fr 1fr; gap:48px; align-items:center

ANIMATIONS — every element should feel alive:
  Page load: @keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
             Apply with: animation:fadeUp 0.5s ease both; stagger with animation-delay:0.1s increments
  Scroll reveal: Use Intersection Observer to add class 'visible' that triggers transition
  Hover lifts: transition: transform 0.18s ease, box-shadow 0.18s ease  →  hover: translateY(-2px)
  Gradient shimmer on loading skeletons if applicable

SECTION PATTERNS (use varied sections — not just a dump of text):
  • Stats/numbers row: large bold number + label, separated by subtle dividers
  • Feature grid: icon + title + description cards in 3-col grid
  • Testimonials/quotes: card with quote, avatar, name, title
  • CTA band: full-width gradient strip with headline + button
  • Footer: multi-column links, logo, copyright, social icons

REQUIRED DETAILS:
  • Every interactive element has :hover and :focus-visible states
  • Scrollbar styling: ::-webkit-scrollbar{width:6px} thumb:var(--border-hover) rounded
  • ::selection { background:rgba(99,102,241,0.35); color:var(--text) }
  • Smooth scroll: html { scroll-behavior: smooth }
  • No layout shift — reserve space for images with aspect-ratio or min-height
  • Dark mode is the default — this IS the design, not an afterthought
  • Mobile responsive: stack grids below 768px, font sizes clamp(), touch targets ≥44px
  • Use rem/em units, never px for layout (px ok for borders, shadows, outlines)
═══════════════════════════════════════════════════════════════

BACKEND:
• CORS configured for localhost dev
• JSON body parser
• Centralized error handler middleware
• Structured response envelope on every route
• /health endpoint mandatory

PROJECT MUST work immediately after running installCommand then devCommand.
Every file must be complete — no "// TODO" or placeholder comments.
Generate a project so visually polished that a designer would be proud of it.
═══════════════════════════════════════════════════════════════

Return ONLY a valid JSON object — no markdown, no extra text:
{
  "files": [
    { "path": "path/relative/to/project/root", "content": "complete file content" }
  ],
  "installCommand": "...",
  "devCommand": "...",
  "port": 3000,
  "apiPort": null,
  "endpoints": [
    { "method": "GET", "path": "/api/health", "description": "Health check" }
  ]
}`;
}

// ── Modification prompt ────────────────────────────────────────────────────
function buildModificationPrompt(instruction, currentFiles) {
    const fileDump = Object.entries(currentFiles)
        .map(([p, c]) => `// ═══ ${p} ═══\n${c}`)
        .join('\n\n');

    return `You are Nova Code Engine — modify this existing project precisely.

PROJECT: "${_projectName}" (${_projectType})
INSTRUCTION: "${instruction}"

CURRENT FILES:
${fileDump}

Rules:
1. Make exactly the change described — nothing more, nothing less.
2. Maintain the same code style, design language, and architecture.
3. If the existing CSS uses the design variables (--bg, --accent, --surface, etc.), preserve and extend them.
4. Only include files that actually changed.
5. Complete file content — never partial snippets.
6. If instruction needs a new file, include it.
7. If the existing design looks plain/generic, you may upgrade it to be more polished while implementing the change.

Return ONLY valid JSON:
{
  "changes": [ { "path": "relative/path", "content": "complete new content" } ],
  "summary": "one-sentence description of what changed"
}`;
}

// ── Generate initial project code ──────────────────────────────────────────
async function generateCode(projectName, projectType, description, logFn) {
    const log = logFn || console.log;
    log(`🤖 [CodeAgent] Generating ${projectType} project: "${projectName}"`);

    const prompt = buildGenerationPrompt(projectName, projectType, description);

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ parts: [{ text: prompt }] }],
        config: { temperature: 0.15, maxOutputTokens: 65536 },
    });

    const result = parseJsonResponse(response.text || '');
    log(`✅ [CodeAgent] Generated ${(result.files || []).length} files`);
    return result;
}

// ── Modify existing project code ───────────────────────────────────────────
async function modifyCode(instruction, logFn) {
    const log = logFn || console.log;
    if (!_projectPath) throw new Error('No active project');

    log(`🔧 [CodeAgent] Modifying: "${instruction}"`);
    const currentFiles = readProjectFiles(_projectPath);
    _projectFiles = { ...currentFiles };

    const prompt = buildModificationPrompt(instruction, currentFiles);
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ parts: [{ text: prompt }] }],
        config: { temperature: 0.1, maxOutputTokens: 32768 },
    });

    const result = parseJsonResponse(response.text || '');
    const changes = [...(result.changes || [])];

    for (const f of changes) {
        const full = path.join(_projectPath, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content, 'utf8');
        _projectFiles[f.path] = f.content;
    }

    log(`✅ [CodeAgent] Modified ${changes.length} file(s)`);
    return result;
}

// ── Write generated files to disk ─────────────────────────────────────────
function writeProjectFiles(files, logFn) {
    const log = logFn || console.log;
    if (!_projectPath) throw new Error('No active project');

    for (const f of files || []) {
        const full = path.join(_projectPath, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content, 'utf8');
        _projectFiles[f.path] = f.content;
    }
    log(`📁 [CodeAgent] Wrote ${(files || []).length} files → ${_projectPath}`);
}

// ── npm / pip install ──────────────────────────────────────────────────────
function installDependencies(installDir, logFn) {
    const log = logFn || console.log;
    return new Promise((resolve) => {
        log(`📦 [CodeAgent] npm install in ${path.basename(installDir)}...`);
        const proc = exec('npm install', { cwd: installDir, timeout: 300000 }, (err) => {
            if (err) { console.error('[CodeAgent] npm install error:', err.message); resolve(false); }
            else      { log(`✅ [CodeAgent] Dependencies installed`); resolve(true); }
        });
        proc.stdout?.on('data', d => process.stdout.write(d));
    });
}

// ── Built-in static HTTP server ────────────────────────────────────────────
function startStaticServer(folderPath, port) {
    return new Promise((resolve) => {
        if (_staticServer) { try { _staticServer.close(); } catch (_) {} _staticServer = null; }

        const MIME = {
            '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
            '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
            '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2',
            '.webp':'image/webp', '.mp4':'video/mp4',
        };

        _staticServer = http.createServer((req, res) => {
            let p = req.url.split('?')[0];
            if (p === '/') p = '/index.html';
            const filePath = path.join(folderPath, p);

            const serve = (fp) => {
                try {
                    const stat = fs.statSync(fp);
                    if (stat.isDirectory()) return serve(path.join(fp, 'index.html'));
                    const mime = MIME[path.extname(fp)] || 'application/octet-stream';
                    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
                    fs.createReadStream(fp).pipe(res);
                } catch (_) {
                    // SPA fallback
                    const idx = path.join(folderPath, 'index.html');
                    if (fs.existsSync(idx)) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        fs.createReadStream(idx).pipe(res);
                    } else {
                        res.writeHead(404); res.end('Not found');
                    }
                }
            };
            serve(filePath);
        });

        _staticServer.listen(port, '127.0.0.1', () => {
            _serverPort = port;
            console.log(`[CodeAgent] Static server → http://localhost:${port}`);
            resolve({ success: true, port });
        });
        _staticServer.on('error', (e) => {
            console.error('[CodeAgent] Static server error:', e.message);
            resolve({ success: false, error: e.message });
        });
    });
}

// ── Start dev server (non-static) ─────────────────────────────────────────
async function startProcessServer(cmd, cwd, port, label, logFn) {
    const log = logFn || console.log;
    const parts = cmd.split(/\s+/);
    const proc = spawn(parts[0], parts.slice(1), {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    proc.stdout.on('data', d => log(`[${label}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) log(`[${label}] ${msg}`);
    });
    proc.on('close', code => { if (code !== 0 && code !== null) log(`⚠️ [${label}] exited ${code}`); });
    return proc;
}

// ── Main startDevServer dispatcher ────────────────────────────────────────
async function startDevServer(projectType, devCommand, port, logFn) {
    const log = logFn || console.log;
    if (!_projectPath) return { success: false, error: 'No project' };

    stopDevServer();

    log(`🚀 [CodeAgent] Starting ${projectType} dev server...`);

    if (projectType === 'static_website') {
        return await startStaticServer(_projectPath, port || 8080);
    }

    if (projectType === 'fullstack') {
        const backendPath  = path.join(_projectPath, 'backend');
        const frontendPath = path.join(_projectPath, 'frontend');
        _apiPort = 3001;

        if (fs.existsSync(backendPath)) {
            _apiProc = await startProcessServer('npm run dev', backendPath, _apiPort, 'API', log);
        }
        await new Promise(r => setTimeout(r, 2000));

        if (fs.existsSync(frontendPath)) {
            _serverPort = port || 5173;
            _serverProc = await startProcessServer(
                `npm run dev -- --port ${_serverPort}`,
                frontendPath, _serverPort, 'Frontend', log
            );
        }

        await waitForPort(_serverPort, 20000);
        return { success: true, port: _serverPort, apiPort: _apiPort };
    }

    // Single-server project (react, api_only, cli, python)
    _serverPort = port || 5173;
    const cmd = devCommand || 'npm run dev';
    _serverProc = await startProcessServer(cmd, _projectPath, _serverPort, 'Server', log);
    const ready = await waitForPort(_serverPort, 30000);
    return { success: ready, port: _serverPort };
}

// ── Stop all running dev servers ───────────────────────────────────────────
function stopDevServer() {
    const kill = (proc) => {
        if (!proc) return;
        try {
            if (process.platform === 'win32') exec(`taskkill /pid ${proc.pid} /T /F`);
            else                               process.kill(-proc.pid, 'SIGTERM');
        } catch (_) {}
    };
    kill(_serverProc);  _serverProc = null;
    kill(_apiProc);     _apiProc    = null;
    if (_staticServer)  { try { _staticServer.close(); } catch (_) {} _staticServer = null; }
    _serverPort = null;
    _apiPort    = null;
}

// ── Close VS Code ──────────────────────────────────────────────────────────
function closeVSCode() {
    if (!_projectName) return;
    try {
        if (process.platform === 'win32') {
            exec(`taskkill /f /im Code.exe 2>nul`);
        } else {
            // Kill VS Code windows associated with this project folder
            exec(`pkill -f "code.*${_projectName}" 2>/dev/null || true`);
        }
    } catch (_) {}
    _vscodeProc = null;
}

// ── API Explorer HTML page ─────────────────────────────────────────────────
function buildApiPreviewHtml(endpoints, apiPort) {
    const port = apiPort || _apiPort || 3001;
    const cards = (endpoints || []).map(ep => {
        const bodyField = ['POST', 'PUT', 'PATCH'].includes(ep.method)
            ? `<textarea class="req-body" placeholder='{ "key": "value" }' rows="3"></textarea>`
            : '';
        return `
<div class="ep-card">
  <div class="ep-row">
    <span class="badge badge-${ep.method.toLowerCase()}">${ep.method}</span>
    <code class="ep-path">${ep.path}</code>
    <span class="ep-desc">${ep.description || ''}</span>
    <button class="btn-test" onclick="testEp(this,'${ep.method}','${ep.path}')">▶ Run</button>
  </div>
  ${bodyField}
  <div class="ep-result" style="display:none">
    <div class="res-meta"></div>
    <pre class="res-body"></pre>
  </div>
</div>`;
    }).join('');

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova API Explorer — ${_projectName || 'Project'}</title>
<style>
:root{--bg:#08080f;--surface:#0e0e1a;--border:rgba(0,200,200,.12);--accent:#00c8c8;--gold:#c9a227;
  --text:#e4e4f0;--muted:#5a6070;--get:#00d9a0;--post:#7c6aff;--put:#f59e0b;--del:#ef4444;--patch:#06b6d4}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,sans-serif;min-height:100vh}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 28px;display:flex;align-items:center;gap:14px}
.dot{width:9px;height:9px;background:var(--accent);border-radius:50%;box-shadow:0 0 10px var(--accent);animation:p 2s infinite}
@keyframes p{0%,100%{opacity:.5}50%{opacity:1;transform:scale(1.2)}}
.header h1{font-size:15px;font-weight:600;letter-spacing:.5px}
.badge-status{margin-left:auto;font-size:11px;padding:3px 10px;border-radius:20px;border:1px solid rgba(0,200,200,.3);color:var(--accent);background:rgba(0,200,200,.07)}
.body{max-width:860px;margin:0 auto;padding:28px}
.base-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;align-items:center;gap:10px;font-family:monospace;font-size:13px}
.base-box .label{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.base-box .url{color:var(--accent)}
.section-label{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.ep-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden;transition:border-color .18s}
.ep-card:hover{border-color:rgba(0,200,200,.35)}
.ep-row{padding:13px 18px;display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.badge{font-size:10px;font-weight:700;font-family:monospace;padding:3px 9px;border-radius:4px;min-width:56px;text-align:center}
.badge-get   {background:rgba(0,217,160,.12);color:var(--get);border:1px solid rgba(0,217,160,.3)}
.badge-post  {background:rgba(124,106,255,.12);color:var(--post);border:1px solid rgba(124,106,255,.3)}
.badge-put   {background:rgba(245,158,11,.12);color:var(--put);border:1px solid rgba(245,158,11,.3)}
.badge-delete{background:rgba(239,68,68,.12);color:var(--del);border:1px solid rgba(239,68,68,.3)}
.badge-patch {background:rgba(6,182,212,.12);color:var(--patch);border:1px solid rgba(6,182,212,.3)}
.ep-path{font-family:monospace;font-size:13px;color:var(--text)}
.ep-desc{flex:1;color:var(--muted);font-size:12px}
.btn-test{background:rgba(0,200,200,.08);border:1px solid rgba(0,200,200,.25);color:var(--accent);padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s;white-space:nowrap}
.btn-test:hover{background:rgba(0,200,200,.18);border-color:rgba(0,200,200,.5)}
.req-body{width:100%;background:rgba(0,0,0,.3);border:none;border-top:1px solid var(--border);color:#a0e0c8;font-family:monospace;font-size:12px;padding:10px 18px;resize:vertical;outline:none}
.ep-result{border-top:1px solid var(--border);background:rgba(0,0,0,.25);padding:14px 18px}
.res-meta{font-size:11px;color:var(--muted);margin-bottom:8px;display:flex;gap:14px}
.ok{color:var(--get)}.err{color:var(--del)}
.res-body{font-family:monospace;font-size:12px;color:#a0dfc8;white-space:pre;overflow-x:auto;line-height:1.55;max-height:320px;overflow-y:auto}
</style></head><body>
<div class="header">
  <div class="dot"></div>
  <h1>Nova API Explorer</h1>
  <span style="color:var(--muted);font-size:13px">${_projectName || 'Project'}</span>
  <span class="badge-status" id="status">● Checking…</span>
</div>
<div class="body">
  <div class="base-box">
    <span class="label">Base URL</span>
    <span class="url">http://localhost:${port}</span>
  </div>
  <div class="section-label">Endpoints (${(endpoints || []).length})</div>
  ${cards || '<p style="color:var(--muted);text-align:center;padding:40px">No endpoints found</p>'}
</div>
<script>
const BASE='http://localhost:${port}';
const ping=async()=>{try{const r=await fetch(BASE+'/health',{mode:'cors'});const s=document.getElementById('status');if(r.ok){s.textContent='● Online';s.style.color='#00d9a0'}else{s.textContent='● Error '+r.status;s.style.color='#ef4444'}}catch(e){const s=document.getElementById('status');s.textContent='● Offline';s.style.color='#ef4444'}};
ping();setInterval(ping,5000);
async function testEp(btn,method,p){
  const card=btn.closest('.ep-card');
  const res=card.querySelector('.ep-result');
  const meta=card.querySelector('.res-meta');
  const body=card.querySelector('.res-body');
  const textarea=card.querySelector('.req-body');
  res.style.display='block';body.textContent='Fetching…';btn.disabled=true;btn.textContent='⟳';
  try{
    const opts={method,mode:'cors',headers:{'Content-Type':'application/json'}};
    if(textarea&&textarea.value.trim())opts.body=textarea.value.trim();
    const t=Date.now();const r=await fetch(BASE+p,opts);const ms=Date.now()-t;
    const d=await r.json().catch(()=>r.text());
    const cls=r.ok?'ok':'err';
    meta.innerHTML='<span class="'+cls+'">'+r.status+' '+r.statusText+'</span><span>'+ms+'ms</span>';
    body.textContent=typeof d==='object'?JSON.stringify(d,null,2):String(d);
  }catch(e){body.textContent='Error: '+e.message;}
  btn.disabled=false;btn.textContent='▶ Run';
}
</script></body></html>`;
}

// ── End the entire coding session ──────────────────────────────────────────
function endSession() {
    stopDevServer();
    closeVSCode();
    _active       = false;
    _projectPath  = null;
    _projectName  = null;
    _projectType  = null;
    _vscodeProc   = null;
    _endpoints    = [];
    _projectFiles = {};
    _serverPort   = null;
    _apiPort      = null;
}

// ── State helpers ──────────────────────────────────────────────────────────
function getState() {
    return { active: _active, projectPath: _projectPath, projectName: _projectName,
             projectType: _projectType, serverPort: _serverPort, apiPort: _apiPort };
}
function setActive(val)                     { _active = val; }
function setProject(name, type, projPath)   { _projectName = name; _projectType = type; _projectPath = projPath; _active = true; }
function setEndpoints(eps)                  { _endpoints = eps || []; }
function getEndpoints()                     { return _endpoints; }

module.exports = {
    getDesktopPath, listDesktopProjects, fuzzyMatchProject,
    createProjectFolder, openInVSCode,
    generateCode, writeProjectFiles, installDependencies,
    startDevServer, stopDevServer, closeVSCode,
    modifyCode, buildApiPreviewHtml,
    endSession, getState, setActive, setProject, setEndpoints, getEndpoints,
};
