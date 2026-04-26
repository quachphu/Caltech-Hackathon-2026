// Force X11 backend on Linux so alwaysOnTop, window-type hints, and
// transparent overlays work correctly (Wayland breaks all three).
if (process.platform === 'linux') {
    process.env.ELECTRON_OZONE_PLATFORM_HINT = process.env.ELECTRON_OZONE_PLATFORM_HINT || 'x11';
}

const { app, BrowserWindow, screen, protocol, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn, exec } = require('child_process');
const { generateSpeech } = require('./tts.js');
const { askGemini } = require('./gemini.js');
const { transcribeAudio } = require('./stt.js');
const { startLiveSession, sendAudioChunk, sendTextChunk, endLiveSession, setBrowserOpen, setStoreAssistantActive } = require('./live.js');
const googleAuth                 = require('./google_auth');
const { handleSendEmailTool, handleListContactsTool } = require('./gmail');
const { handleCalendarActionTool } = require('./calendar');
const codeAgent                  = require('./code_agent');
const { handleNotesActionTool }  = require('./notes');
const { handleImageGenerationTool } = require('./image_gen');
const { handleVideoEditorTool, isVideoEditorModeActive } = require('./video_editor');
const { handleVideoGenerationTool } = require('./video_gen');

// Terminate Chromium's Autoplay sandbox. We are a desktop app, not a website!
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
    { scheme: 'appassets', privileges: { standard: true, supportFetchAPI: true, secure: true, bypassCSP: true } }
]);

const WINDOW_WIDTH = 130;
const WINDOW_HEIGHT = 130;

let mainWindow = null;

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        x: width - WINDOW_WIDTH,
        y: height - WINDOW_HEIGHT,
        show: false,

        // Appearance
        transparent: true,
        frame: false,
        hasShadow: false,
        backgroundColor: '#00000000',

        // Behaviour
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,

        // On Linux (KDE/X11/Wayland) we set type to 'toolbar' so the compositor
        // renders it above the desktop without stealing focus.
        ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false   // needed to load local file:// model assets
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Keep it on top even when other windows are fullscreen (macOS / Windows)
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    // Allow click-through on the transparent parts
    // We enable mouse events initially so Three.js can receive them if needed
    mainWindow.setIgnoreMouseEvents(false);

    // On Linux with Wayland transparency sometimes needs a compositor hint
    if (process.platform === 'linux') {
        mainWindow.setBackgroundColor('#00000000');
    }
}

let dragOffset = null;

// ── Macro Recording State ──────────────────────────────────────────────────
let _macroRecording = false;
let _macroSteps = [];
let _macroAwaitingName = false;

ipcMain.on('drag-start', (event, { x, y }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const bounds = win.getBounds();
    dragOffset = { x: x - bounds.x, y: y - bounds.y };
    // Pause bounce while user manually drags Nova
    _bouncePaused = true;
    if (bounceInterval) { clearInterval(bounceInterval); bounceInterval = null; }
});

ipcMain.on('drag-move', (event, { x, y }) => {
    if (!dragOffset) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setBounds({
        x: Math.round(x - dragOffset.x),
        y: Math.round(y - dragOffset.y),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
    });
});

ipcMain.on('drag-end', () => {
    dragOffset = null;
    // Resume bounce from new position if bounce was active before drag
    if (_bounceActive && _bouncePaused) {
        _bouncePaused = false;
        _startWanderInterval();
    }
});

// ── Expressive Movement Engine ────────────────────────────────────────────
// Nova wanders organically while in conversation, with movement character
// that reflects emotional state (listening vs speaking vs thinking).
// When a task starts it eases back to the bottom-right "serious mode" corner.

let bounceInterval = null;
let _bounceActive = false;
let _bouncePaused = false;
let _bouncePos    = { x: 0, y: 0 };
let _wanderTarget = { x: 0, y: 0 };
let _wanderTargetTime = 0;
let _motionMode   = 'listening'; // 'listening' | 'speaking' | 'thinking'
let _snapInterval = null;

// Per-mode parameters
// speed    : lerp factor per 30ms tick — keep this low for smooth, organic motion
// changeMs : how often a new wander target is chosen (longer = lazier movement)
// Speaking : calmest — Nova barely drifts so it doesn't distract while talking
// Listening: gentle unhurried float — present but relaxed
// Thinking : slightly more active than listening — a subtle restlessness
const MOTION_PARAMS = {
    speaking:  { speed: 0.012, changeMs: 5000 },
    listening: { speed: 0.018, changeMs: 3500 },
    thinking:  { speed: 0.022, changeMs: 2200 },
};

function _getHomePosition() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { x: width - WINDOW_WIDTH, y: height - WINDOW_HEIGHT };
}

// Pick a random wander target in the "conversation zone" (upper-center area).
// Nova drifts away from its home corner while chatting, but stays calm.
function _pickWanderTarget(screenW, screenH, mode) {
    const margin = 20;
    let maxX, maxY;
    if (mode === 'speaking') {
        // Speaking: smallest range — Nova holds its position while talking
        maxX = screenW * 0.42;
        maxY = screenH * 0.38;
    } else if (mode === 'thinking') {
        // Thinking: moderate range — a little restless
        maxX = screenW * 0.55;
        maxY = screenH * 0.50;
    } else {
        // Listening: gentle drift in the upper-center area
        maxX = screenW * 0.65;
        maxY = screenH * 0.58;
    }
    return {
        x: margin + Math.random() * (maxX - margin),
        y: margin + Math.random() * (maxY - margin)
    };
}

function _startWanderInterval() {
    if (bounceInterval) { clearInterval(bounceInterval); bounceInterval = null; }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    // Seed first target right away
    _wanderTarget = _pickWanderTarget(width, height, _motionMode);
    _wanderTargetTime = Date.now();

    bounceInterval = setInterval(() => {
        if (!mainWindow || !_bounceActive || _bouncePaused) return;

        const params = MOTION_PARAMS[_motionMode] || MOTION_PARAMS.listening;
        const now = Date.now();

        // Pick a new target once the timer expires
        if (now - _wanderTargetTime > params.changeMs) {
            _wanderTarget = _pickWanderTarget(width, height, _motionMode);
            _wanderTargetTime = now;
        }

        // Smooth lerp toward target
        _bouncePos.x += (_wanderTarget.x - _bouncePos.x) * params.speed;
        _bouncePos.y += (_wanderTarget.y - _bouncePos.y) * params.speed;

        // Clamp to screen
        _bouncePos.x = Math.max(0, Math.min(width  - WINDOW_WIDTH,  _bouncePos.x));
        _bouncePos.y = Math.max(0, Math.min(height - WINDOW_HEIGHT, _bouncePos.y));

        mainWindow.setBounds({
            x: Math.round(_bouncePos.x),
            y: Math.round(_bouncePos.y),
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT
        });
    }, 30); // ~33 fps
}

ipcMain.on('nova-bounce-start', () => {
    if (_bounceActive) return;
    _bounceActive = true;
    _bouncePaused = false;
    _motionMode = 'listening';

    if (_snapInterval) { clearInterval(_snapInterval); _snapInterval = null; }
    if (!mainWindow) return;

    const bounds = mainWindow.getBounds();
    _bouncePos = { x: bounds.x, y: bounds.y };
    _startWanderInterval();
});

// Renderer sends this while conversation is active to update movement character
ipcMain.on('nova-move-state', (event, mode) => {
    if (!_bounceActive) return;
    if (mode === _motionMode) return; // no change

    _motionMode = mode;

    // When switching to speaking: immediately pick a fresh target so the
    // movement change is felt right away rather than waiting for the old timer
    if (mode === 'speaking' || mode === 'thinking') {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        _wanderTarget = _pickWanderTarget(width, height, mode);
        _wanderTargetTime = Date.now();
    }
});

function _snapHome() {
    _bounceActive = false;
    _bouncePaused = false;
    if (bounceInterval) { clearInterval(bounceInterval); bounceInterval = null; }
    if (!mainWindow) return;

    const home = _getHomePosition();
    const startBounds = mainWindow.getBounds();
    const startX = startBounds.x;
    const startY = startBounds.y;
    let t = 0;

    if (_snapInterval) { clearInterval(_snapInterval); _snapInterval = null; }

    _snapInterval = setInterval(() => {
        if (!mainWindow) { clearInterval(_snapInterval); _snapInterval = null; return; }
        t += 0.06;
        if (t >= 1) {
            t = 1;
            clearInterval(_snapInterval);
            _snapInterval = null;
        }
        // Ease-out cubic — purposeful, decisive snap to the corner
        const ease = 1 - Math.pow(1 - t, 3);
        mainWindow.setBounds({
            x: Math.round(startX + (home.x - startX) * ease),
            y: Math.round(startY + (home.y - startY) * ease),
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT
        });
    }, 16); // ~60 fps
}

ipcMain.on('nova-bounce-stop', () => _snapHome());

// ── Stock Mode Position ────────────────────────────────────────────────────
// When the stock chart is open, Nova moves to the top-right corner so the
// floating card (top-left) and Nova sit on opposite ends of the screen.
// When the chart closes, Nova resumes whatever it was doing before.

let _stockModeActive = false;
let _preBounceActive = false; // was _bounceActive true before stock mode?

function _getTopRightPosition() {
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    return { x: width - WINDOW_WIDTH, y: 10 };
}

function _snapToTopRight() {
    _stockModeActive = true;
    _preBounceActive = _bounceActive;

    // Pause wander without clearing _bounceActive flag — we restore it on exit
    _bouncePaused = true;
    if (bounceInterval) { clearInterval(bounceInterval); bounceInterval = null; }
    if (_snapInterval)  { clearInterval(_snapInterval);  _snapInterval  = null; }

    if (!mainWindow) return;
    const target = _getTopRightPosition();
    const start  = mainWindow.getBounds();
    let t = 0;

    _snapInterval = setInterval(() => {
        if (!mainWindow) { clearInterval(_snapInterval); _snapInterval = null; return; }
        t += 0.055;
        if (t >= 1) { t = 1; clearInterval(_snapInterval); _snapInterval = null; }
        const ease = 1 - Math.pow(1 - t, 3);
        mainWindow.setBounds({
            x: Math.round(start.x + (target.x - start.x) * ease),
            y: Math.round(start.y + (target.y - start.y) * ease),
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT
        });
    }, 16);
}

function _restoreFromStockMode() {
    if (!_stockModeActive) return;
    _stockModeActive = false;

    if (_preBounceActive) {
        // Nova was in conversation → resume wandering from top-right position
        _bouncePaused = false;
        if (mainWindow) {
            const bounds = mainWindow.getBounds();
            _bouncePos = { x: bounds.x, y: bounds.y };
        }
        _startWanderInterval();
    } else {
        // Nova was idle → snap back to bottom-right home
        _snapHome();
    }
}

let chatWin = null;
function createChatWindow() {
    if (chatWin) {
        if (chatWin.isMinimized()) chatWin.restore();
        chatWin.focus();
        return;
    }

    chatWin = new BrowserWindow({
        width: 400,
        height: 500,
        title: 'Comms Channel',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    chatWin.loadFile(path.join(__dirname, 'chat.html'));

    chatWin.on('closed', () => {
        chatWin = null;
    });
}

let browserWin = null;
let isBrowserReady = false;
let pendingBrowserUrl = null;
let calendarWin      = null;
let notesWin         = null;
let contactsWin      = null;
let attachmentsWin   = null;
let videoEditorWin   = null;

ipcMain.on('browser-ready', () => {
    console.log('📡 Bridge: Browser Agent is ready.');
    isBrowserReady = true;
    if (pendingBrowserUrl && browserWin) {
        console.log('📡 Bridge: Sending pending navigation:', pendingBrowserUrl);
        browserWin.webContents.send('navigate', pendingBrowserUrl);
        pendingBrowserUrl = null;
    }
});

// ── Store Detection ───────────────────────────────────────────────────────
// Ordered list of known shopping destinations. First match wins.
const STORE_PATTERNS = [
    { re: /apple\.com/i,                        name: 'Apple' },
    { re: /amazon\.(com|co\.uk|de|fr|ca|es|it|co\.jp)/i, name: 'Amazon' },
    { re: /ebay\.(com|co\.uk|de|fr|ca)/i,       name: 'eBay' },
    { re: /bestbuy\.com/i,                       name: 'Best Buy' },
    { re: /pokemoncenter\.com/i,                 name: 'Pokémon Center' },
    { re: /shop\.pokemon\.com/i,                 name: 'Pokémon Center' },
    { re: /shop\.leagueoflegends\.com/i,         name: 'League of Legends' },
    { re: /merch\.riotgames\.com/i,              name: 'Riot Games' },
    { re: /shop\.riotgames\.com/i,               name: 'Riot Games' },
    { re: /target\.com/i,                        name: 'Target' },
    { re: /walmart\.com/i,                       name: 'Walmart' },
    { re: /newegg\.com/i,                        name: 'Newegg' },
    { re: /etsy\.com/i,                          name: 'Etsy' },
    { re: /nike\.com/i,                          name: 'Nike' },
    { re: /adidas\.com/i,                        name: 'Adidas' },
    { re: /samsung\.com/i,                       name: 'Samsung' },
    { re: /store\.google\.com/i,                 name: 'Google Store' },
    { re: /microsoft\.com\/(en-us\/)?store/i,    name: 'Microsoft Store' },
    { re: /gamestop\.com/i,                      name: 'GameStop' },
    { re: /homedepot\.com/i,                     name: 'Home Depot' },
    { re: /costco\.com/i,                        name: 'Costco' },
    { re: /wayfair\.com/i,                       name: 'Wayfair' },
    { re: /ikea\.com/i,                          name: 'IKEA' },
    { re: /lego\.com/i,                          name: 'LEGO' },
    { re: /thinkgeek\.com/i,                     name: 'ThinkGeek' },
    { re: /funko\.com/i,                         name: 'Funko' },
    { re: /hot-topic\.com/i,                     name: 'Hot Topic' },
    { re: /zavvi\.com/i,                         name: 'Zavvi' },
    { re: /sephora\.com/i,                       name: 'Sephora' },
    { re: /ulta\.com/i,                          name: 'Ulta Beauty' },
];

// Fallback: if the URL or title strongly suggests a store but doesn't match above
const STORE_HEURISTIC = /\/shop\b|\/store\b|\/buy\b|\/products?\b|\/collections?\b|shopping\.|storefront/i;

function detectStore(url, title) {
    for (const { re, name } of STORE_PATTERNS) {
        if (re.test(url)) return name;
    }
    // Heuristic: URL or title looks like a store
    if (STORE_HEURISTIC.test(url)) {
        // Try to derive store name from hostname
        try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            const domain = host.split('.')[0];
            const storeName = domain.charAt(0).toUpperCase() + domain.slice(1);
            return storeName;
        } catch (_) {}
    }
    return null;
}

// Deduplicate by store NAME, not URL.
// apple.com, apple.com/watch, apple.com/shop/buy-watch are all the same store.
// Only re-announce when the user leaves Apple and lands on Amazon, etc.
let _lastStoreDetectedName = '';
ipcMain.on('browser-page-loaded', (event, { url, title }) => {
    if (!url) return;

    const storeName = detectStore(url, title);
    if (!storeName) {
        // User navigated away from a known store — reset so re-entry fires again
        _lastStoreDetectedName = '';
        setStoreAssistantActive(false);
        return;
    }

    // Always keep live.js informed that we're on a store (for smart_click follow-up)
    setStoreAssistantActive(true);

    // Same store as before (any sub-page) — do not re-announce greeting
    if (storeName === _lastStoreDetectedName) return;

    _lastStoreDetectedName = storeName;
    console.log(`🛍️ Store detected: ${storeName} — ${url}`);
    if (mainWindow) {
        mainWindow.webContents.send('store-detected', { storeName, url });
    }
});

function openBrowser(data) {
    if (!data) return;
    console.log('🌍 Opening Browser Agent with:', data);
    _snapHome(); // Browser opening = serious mode, snap back to corner

    if (!browserWin) {
        createBrowserWindow();
    }

    const navigate = async () => {
        let url = '';
        if (typeof data === 'string') {
            const isUrl = data.includes('.') && !data.includes(' ');
            if (isUrl) {
                url = data.startsWith('http') ? data : `https://${data}`;
            } else {
                url = `https://www.google.com/search?q=${encodeURIComponent(data)}`;
            }
        } else {
            const { platform, query } = data;
            if (platform === 'youtube' && query) {
                try {
                    console.log(`🔍 Super-Lucky Search: ${query}`);
                    const { exec } = require('child_process');
                    const videoId = await new Promise((resolve) => {
                        exec(`yt-dlp --get-id "ytsearch1:${query}"`, (err, stdout) => {
                            resolve(err ? null : stdout.trim());
                        });
                    });
                    if (videoId && videoId.length < 20) {
                        url = `https://www.youtube.com/watch?v=${videoId}`;
                    }
                } catch (e) {
                    console.error('Super-Lucky failed:', e);
                }
            }

            if (!url) {
                url = platform === 'youtube'
                    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`
                    : `https://www.google.com/search?q=${encodeURIComponent(query || '')}`;
            }
        }

        if (url && browserWin) {
            if (isBrowserReady) {
                console.log('📡 Browser: Navigating to', url);
                browserWin.webContents.send('navigate', url);
            } else {
                console.log('📡 Browser: Pending navigation for', url);
                pendingBrowserUrl = url;
            }
        }
    };

    if (browserWin && browserWin.isVisible && browserWin.isVisible()) {
        navigate();
    } else if (browserWin) {
        browserWin.show();
        // The browser-ready IPC will trigger the navigation
    }
}

function scrollBrowser(direction) {
    if (browserWin) browserWin.webContents.send('scroll', direction);
}

function closeBrowser() {
    if (browserWin) {
        browserWin.close();
        browserWin = null;
    }
    setBrowserOpen(false);
    _lastStoreDetectedName = ''; // reset so re-entering same store fires greeting again
}

function getDomMap() {
    if (browserWin) {
        browserWin.webContents.send('get-dom-map');
    } else {
        // Emit the same shape live.js expects so the Promise resolves cleanly
        ipcMain.emit('dom-map-available', { map: [], url: 'No browser open' });
    }
}

function clickBrowserId(id) {
    if (browserWin) browserWin.webContents.send('click-by-id', id);
}

function smartClickBrowser(text) {
    if (browserWin) browserWin.webContents.send('smart-click', text);
}

// ── Stock Chart Feature ────────────────────────────────────────────────────

let stockWin = null;

function httpsGetJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

function computeStockOutlook(prices, company) {
    const valid = prices.filter(p => p !== null && !isNaN(p));
    if (valid.length < 10) return 'Insufficient historical data for analysis.';

    const first = valid[0];
    const last  = valid[valid.length - 1];
    const pctChange = ((last - first) / first) * 100;
    const absChange = Math.abs(pctChange).toFixed(1);

    // Recent vs prior momentum (last 10 days vs prev 10)
    const recent = valid.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const prior  = valid.slice(-20, -10).reduce((a, b) => a + b, 0) / (valid.slice(-20, -10).length || 1);
    const momentum = prior ? ((recent - prior) / prior) * 100 : 0;

    const trend = pctChange >= 0 ? `gained ${absChange}%` : `declined ${absChange}%`;
    const mWord = momentum >= 1.5 ? 'building upward momentum' :
                  momentum <= -1.5 ? 'showing renewed selling pressure' :
                  'trading sideways in consolidation';

    let hint = '';
    if (pctChange < -15) hint = 'The pullback may attract value investors near current levels.';
    else if (pctChange > 20) hint = 'Strong rally underway — watch for resistance near recent highs.';
    else hint = 'Price is stabilizing within a moderate range.';

    return `${company} has ${trend} over the past 3 months and is ${mWord}. ${hint}`;
}

function createStockWindow() {
    if (stockWin) {
        stockWin.focus();
        return;
    }
    stockWin = new BrowserWindow({
        width: 340,
        height: 340,
        x: 20,
        y: 20,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });
    stockWin.loadFile(path.join(__dirname, 'stock.html'));
    stockWin.setAlwaysOnTop(true, 'screen-saver');
    stockWin.once('ready-to-show', () => stockWin && stockWin.show());
    stockWin.on('closed', () => {
        stockWin = null;
        _restoreFromStockMode();
    });
}

async function showStockChartInternal(company, symbol) {
    try {
        let resolvedSymbol = (symbol || '').toUpperCase().trim();
        let resolvedCompany = company || '';
        let exchange = '';

        // Symbol lookup when not provided or explicitly unknown
        if (!resolvedSymbol || resolvedSymbol === 'UNKNOWN') {
            console.log(`📈 [Stock] Searching symbol for: "${company}"`);
            const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(company)}&quotesCount=1&newsCount=0&enableEnhancedTrivialQuery=true`;
            const searchData = await httpsGetJSON(searchUrl);
            const quote = searchData?.quotes?.[0];
            if (quote && quote.symbol) {
                resolvedSymbol = quote.symbol;
                resolvedCompany = quote.shortname || quote.longname || company;
                exchange = quote.exchDisp || '';
            } else {
                throw new Error(`No symbol found for "${company}"`);
            }
        }

        console.log(`📈 [Stock] Fetching chart data for: ${resolvedSymbol}`);
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(resolvedSymbol)}?interval=1d&range=3mo&includePrePost=false`;
        const chartData = await httpsGetJSON(chartUrl);

        const result = chartData?.chart?.result?.[0];
        if (!result) throw new Error('No chart data in response');

        const meta       = result.meta || {};
        const prices     = result.indicators?.quote?.[0]?.close || [];
        const timestamps = result.timestamp || [];

        const price     = meta.regularMarketPrice || meta.chartPreviousClose || 0;
        const prevClose = meta.previousClose      || meta.chartPreviousClose  || price;
        const change    = price - prevClose;
        const changePct = prevClose ? (change / prevClose) * 100 : 0;

        const firstDate = timestamps[0]
            ? new Date(timestamps[0] * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '3 months ago';

        const stockInfo = {
            company:   meta.shortName || resolvedCompany,
            symbol:    resolvedSymbol,
            exchange:  meta.exchangeName || exchange,
            currency:  meta.currency || 'USD',
            price,
            change,
            changePct,
            high52:    meta.fiftyTwoWeekHigh,
            low52:     meta.fiftyTwoWeekLow,
            volume:    meta.regularMarketVolume,
            prices,
            firstDate,
            outlook:   computeStockOutlook(prices, meta.shortName || resolvedCompany)
        };

        // Move Nova to top-right while chart is visible
        _snapToTopRight();

        // Open / refresh stock window
        createStockWindow();
        const sendData = () => {
            if (stockWin) stockWin.webContents.send('stock-data', stockInfo);
        };
        if (stockWin) {
            if (stockWin.webContents.isLoading()) {
                stockWin.webContents.once('did-finish-load', sendData);
            } else {
                sendData();
            }
        }

        // Return rich summary so Gemini Live can narrate
        const dir  = change >= 0 ? 'up' : 'down';
        const sign = change >= 0 ? '+' : '';
        const summary =
            `Chart for ${stockInfo.company} (${resolvedSymbol}) is now displayed. ` +
            `Current price: $${price.toFixed(2)}, ${dir} ${sign}${changePct.toFixed(2)}% today. ` +
            `52-week range: $${(meta.fiftyTwoWeekLow || 0).toFixed(2)} – $${(meta.fiftyTwoWeekHigh || 0).toFixed(2)}. ` +
            `Outlook: ${stockInfo.outlook}`;

        console.log(`📈 [Stock] Success: ${resolvedSymbol} @ $${price.toFixed(2)}`);
        return { success: true, summary, company: stockInfo.company, symbol: resolvedSymbol, price, changePct };

    } catch (err) {
        console.error(`📈 [Stock] Error: ${err.message}`);
        // Show error in window if already created
        if (stockWin) stockWin.webContents.send('stock-data', { error: true });
        return {
            success: false,
            summary: `Could not fetch live stock data for "${company}". The data provider may be temporarily unavailable. Describe what you know about this company's recent market performance from your training knowledge instead.`
        };
    }
}

// IPC: close stock window from renderer (X button or auto-close timer)
ipcMain.on('close-stock-window', () => {
    if (stockWin) {
        stockWin.close();
        stockWin = null;
    }
    _restoreFromStockMode();
});

// ── End Stock Chart Feature ────────────────────────────────────────────────

const Automation = {
    openBrowser,
    scrollBrowser,
    closeBrowser,
    toggleIncognito,
    getDomMap,
    clickBrowserId,
    smartClickBrowser,
    executeCommand: async (cmd) => {
        return await executeAutomationInternal(cmd);
    },
    focusApp: async (appName) => {
        return await focusAppInternal(appName);
    },
    speak: (text) => {
        if (mainWindow) mainWindow.webContents.send('speak', text);
    },
    generatePaper: (topic) => {
        generateResearchPaper(topic, mainWindow);
    },
    showStockChart: async (company, symbol) => {
        return await showStockChartInternal(company, symbol);
    },

    // ── Gmail tool handler ────────────────────────────────────────────────
    sendEmailTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[Gmail Tool]', msg);
        };
        const statusLabel = args.confirmed
            ? '📧 Sending email...'
            : '✉️ Composing email...';
        if (mainWindow) mainWindow.webContents.send('show-status-message', statusLabel);
        try {
            const result = await handleSendEmailTool(args, null, logFn);
            if (mainWindow) mainWindow.webContents.send('show-status-message', '');
            return result;
        } catch (e) {
            if (mainWindow) mainWindow.webContents.send('show-status-message', '');
            throw e;
        }
    },

    listContactsTool: async (args) => {
        const limit = Math.min(Math.max(args?.limit || 10, 1), 30);
        console.log(`[Contacts Tool] Listing up to ${limit} contacts...`);
        if (mainWindow) mainWindow.webContents.send('show-status-message', '📋 Loading contacts...');
        const result = await handleListContactsTool({ limit });
        if (mainWindow) mainWindow.webContents.send('show-status-message', '');
        if (mainWindow) mainWindow.webContents.send('automation-log', `📋 Listed ${result.contacts?.length || 0} contacts`);
        if (result.contacts && result.contacts.length > 0) {
            Automation.showContactsPanel(result.contacts);
        }
        return result;
    },

    // ── Contacts panel (floating window) ─────────────────────────────────
    showContactsPanel: (contacts) => {
        if (calendarWin && !calendarWin.isDestroyed()) calendarWin.close();
        if (notesWin && !notesWin.isDestroyed()) notesWin.close();

        const W = 340, H = 480;
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        const novaW  = 130;
        const gap    = 12;
        const panelX = Math.max(8, sw - novaW - gap - W);
        const panelY = Math.max(8, sh - H - 8);

        if (contactsWin && !contactsWin.isDestroyed()) {
            contactsWin.webContents.send('contacts-data', contacts);
            return;
        }

        contactsWin = new BrowserWindow({
            width: W, height: H,
            x: panelX, y: panelY,
            transparent: true, frame: false, hasShadow: false,
            alwaysOnTop: true, skipTaskbar: true, resizable: false,
            ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        contactsWin.setAlwaysOnTop(true, 'screen-saver');
        contactsWin.loadFile(path.join(__dirname, 'contacts_panel.html'));
        contactsWin.once('ready-to-show', () => {
            contactsWin.show();
            setTimeout(() => {
                if (contactsWin && !contactsWin.isDestroyed()) {
                    contactsWin.webContents.send('contacts-data', contacts);
                }
            }, 150);
        });
        contactsWin.on('closed', () => { contactsWin = null; });
    },

    hideContactsPanel: () => {
        if (contactsWin && !contactsWin.isDestroyed()) contactsWin.close();
    },

    isContactsPanelOpen: () => {
        return !!(contactsWin && !contactsWin.isDestroyed());
    },

    scrollContactsPanel: (direction) => {
        if (contactsWin && !contactsWin.isDestroyed()) {
            contactsWin.webContents.send('scroll-contacts', direction);
        }
    },

    showAttachmentsPanel: (files, fileType) => {
        const W = 320, H = 420;
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        const novaW = 130, gap = 12;
        const panelX = Math.max(8, sw - novaW - gap - W);
        const panelY = Math.max(8, sh - H - 8);

        if (attachmentsWin && !attachmentsWin.isDestroyed()) {
            attachmentsWin.webContents.send('attachments-data', { files, fileType });
            return;
        }
        attachmentsWin = new BrowserWindow({
            width: W, height: H, x: panelX, y: panelY,
            transparent: true, frame: false, hasShadow: false,
            alwaysOnTop: true, skipTaskbar: true, resizable: false,
            ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        attachmentsWin.setAlwaysOnTop(true, 'screen-saver');
        attachmentsWin.loadFile(path.join(__dirname, 'attachments_panel.html'));
        attachmentsWin.once('ready-to-show', () => {
            attachmentsWin.show();
            setTimeout(() => {
                if (attachmentsWin && !attachmentsWin.isDestroyed()) {
                    attachmentsWin.webContents.send('attachments-data', { files, fileType });
                }
            }, 150);
        });
        attachmentsWin.on('closed', () => { attachmentsWin = null; });
    },

    highlightAttachment: (index, name) => {
        if (attachmentsWin && !attachmentsWin.isDestroyed()) {
            attachmentsWin.webContents.send('attachment-selected', { index, name });
        }
    },

    hideAttachmentsPanel: () => {
        if (attachmentsWin && !attachmentsWin.isDestroyed()) attachmentsWin.close();
    },

    closeBrowser: () => {
        if (browserWin && !browserWin.isDestroyed()) {
            browserWin.close();
        }
    },

    // ── Calendar tool handler ─────────────────────────────────────────────
    calendarActionTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[Calendar Tool]', msg);
        };
        return await handleCalendarActionTool(args, logFn);
    },

    // ── Calendar visual panel (separate floating window) ─────────────────
    showCalendarPanel: (data) => {
        // Close notes panel if open — only one side panel at a time
        if (notesWin && !notesWin.isDestroyed()) notesWin.close();

        const CAL_W = 320;
        const CAL_H = 480;
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

        if (calendarWin && !calendarWin.isDestroyed()) {
            // Already open — just update the data
            calendarWin.webContents.send('calendar-data', data);
            return;
        }

        // Position: bottom-right area, to the LEFT of the Nova widget
        const novaW  = 130;
        const gap    = 12;
        const panelX = sw - novaW - gap - CAL_W;
        const panelY = sh - CAL_H - 8;

        calendarWin = new BrowserWindow({
            width: CAL_W,
            height: CAL_H,
            x: panelX,
            y: panelY,
            transparent: true,
            frame: false,
            hasShadow: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: false,
            ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            }
        });
        calendarWin.setAlwaysOnTop(true, 'screen-saver');
        calendarWin.loadFile(path.join(__dirname, 'calendar_panel.html'));

        calendarWin.once('ready-to-show', () => {
            calendarWin.show();
            // Send data once the window is ready
            setTimeout(() => {
                if (calendarWin && !calendarWin.isDestroyed()) {
                    calendarWin.webContents.send('calendar-data', data);
                }
            }, 150);
        });

        calendarWin.on('closed', () => { calendarWin = null; });

        // Auto-dismiss after 20 seconds
        setTimeout(() => {
            if (calendarWin && !calendarWin.isDestroyed()) calendarWin.close();
        }, 20000);
    },

    // Called by calendar_panel.html when user clicks the close button
    hideCalendarPanel: () => {
        if (calendarWin && !calendarWin.isDestroyed()) calendarWin.close();
    },

    // ── Code Agent tool handler ───────────────────────────────────────────
    codeAgentTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[Code Agent]', msg);
        };
        return await handleCodeAgentTool(args, logFn);
    },

    // ── Macro Recording State Accessors ───────────────────────────────────
    isMacroRecording: () => _macroRecording,
    isMacroAwaitingName: () => _macroAwaitingName,
    getMacroSteps: () => _macroSteps,

    recordMacroStep: (step) => {
        _macroSteps.push(step);
        console.log(`[Macro] Captured step ${_macroSteps.length}: ${step.intent}`);
    },

    // ── Macro Control Tool Handler ─────────────────────────────────────────
    handleMacroControl: async (args) => {
        const { action, macro_name } = args;

        if (action === 'start_recording') {
            if (_macroRecording) {
                return { speak: 'Already recording.' };
            }
            _macroRecording = true;
            _macroSteps = [];
            _macroAwaitingName = false;
            if (mainWindow) mainWindow.webContents.send('macro-recording-started');
            console.log('[Macro] Recording started');
            return {
                speak: "Recording started. Do your thing — I'll remember every step. Say 'stop recording' when you're done.",
            };
        }

        if (action === 'stop_recording') {
            if (!_macroRecording) {
                return { speak: "I wasn't recording." };
            }
            _macroRecording = false;
            if (mainWindow) mainWindow.webContents.send('macro-recording-stopped');

            if (_macroSteps.length === 0) {
                return { speak: 'No steps were recorded.' };
            }

            if (macro_name) {
                const stepCount = _macroSteps.length;
                saveMacro(macro_name, _macroSteps);
                _macroAwaitingName = false;
                return { speak: `Got it. ${stepCount} step${stepCount !== 1 ? 's' : ''} saved as ${macro_name}. Say 'run ${macro_name}' anytime.` };
            }

            _macroAwaitingName = true;
            return {
                speak: `Got it, ${_macroSteps.length} step${_macroSteps.length !== 1 ? 's' : ''} recorded. What should I call this routine?`,
            };
        }

        if (action === 'run_macro') {
            if (_macroAwaitingName && macro_name) {
                // User is answering "what do you want to call it?"
                saveMacro(macro_name, _macroSteps);
                _macroAwaitingName = false;
                _macroSteps = [];
                return { speak: `Saved as ${macro_name}. Say 'run ${macro_name}' anytime.` };
            }
            if (!macro_name) {
                return { speak: 'Which routine should I run? Tell me the name.' };
            }
            return await replayMacro(macro_name);
        }

        if (action === 'list_macros') {
            const macros = loadMacros();
            const keys = Object.keys(macros);
            if (keys.length === 0) {
                return { speak: "No routines saved yet. Say 'remember this workflow' to start recording one." };
            }
            const list = keys.map(k => `${macros[k].name} (${(macros[k].steps || []).length} steps)`).join(', ');
            return { speak: `You have ${keys.length} saved routine${keys.length !== 1 ? 's' : ''}: ${list}.` };
        }

        if (action === 'delete_macro') {
            if (!macro_name) {
                return { speak: 'Which routine should I delete?' };
            }
            const key = macro_name.toLowerCase().replace(/\s+/g, '_');
            const macros = loadMacros();
            if (!macros[key]) {
                return { speak: `I don't have a routine called ${macro_name}.` };
            }
            delete macros[key];
            fs.writeFileSync(MACROS_FILE, JSON.stringify(macros, null, 2), 'utf8');
            return { speak: `${macro_name} routine deleted.` };
        }

        return { speak: `Unknown macro action: ${action}` };
    },

    // ── Screen Vision Tool Handler ─────────────────────────────────────────
    analyzeScreenTool: async (question) => {
        if (mainWindow) mainWindow.webContents.send('automation-log', '🖥️ Analyzing screen...');
        return await analyzeScreen(question);
    },

    // ── Notes panel ───────────────────────────────────────────────────────
    showNotesPanel: (data) => {
        // Close calendar panel if open — only one side panel at a time
        if (calendarWin && !calendarWin.isDestroyed()) calendarWin.close();

        const NOTES_W = 560;
        const NOTES_H = 700;
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        const novaW  = 130;
        const gap    = 12;
        const panelX = Math.max(8, sw - novaW - gap - NOTES_W);
        const panelY = Math.max(8, sh - NOTES_H - 8);

        if (notesWin && !notesWin.isDestroyed()) {
            notesWin.webContents.send('notes-panel-data', data);
            return;
        }

        notesWin = new BrowserWindow({
            width: NOTES_W, height: NOTES_H,
            x: panelX, y: panelY,
            transparent: true, frame: false, hasShadow: false,
            alwaysOnTop: true, skipTaskbar: true, resizable: false,
            ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        notesWin.setAlwaysOnTop(true, 'screen-saver');
        notesWin.loadFile(path.join(__dirname, 'notes_panel.html'));
        notesWin.once('ready-to-show', () => {
            notesWin.show();
            setTimeout(() => {
                if (notesWin && !notesWin.isDestroyed()) {
                    notesWin.webContents.send('notes-panel-data', data);
                }
            }, 150);
        });
        notesWin.on('closed', () => { notesWin = null; });
    },

    hideNotesPanel: () => {
        if (notesWin && !notesWin.isDestroyed()) notesWin.close();
    },

    // ── Notes Action tool handler ─────────────────────────────────────────
    notesActionTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[Notes]', msg);
        };
        const notifyPanel = (data) => {
            if (data.mode === 'close') {
                Automation.hideNotesPanel();
            } else {
                Automation.showNotesPanel(data);
            }
        };
        return await handleNotesActionTool(args, logFn, notifyPanel);
    },

    // ── Image Generation tool handler ─────────────────────────────────────
    generateImageTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[ImageGen]', msg);
        };
        return await handleImageGenerationTool(args, logFn);
    },

    // ── Video Editor tool handler ──────────────────────────────────────────
    videoEditorTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[VideoEditor]', msg);
        };
        return await handleVideoEditorTool(args, logFn);
    },

    isVideoEditorModeActive: () => isVideoEditorModeActive(),

    // ── Video Editor floating panel ────────────────────────────────────────
    showVideoEditorPanel: (data) => {
        // Close other side panels
        if (notesWin    && !notesWin.isDestroyed())    notesWin.close();
        if (calendarWin && !calendarWin.isDestroyed()) calendarWin.close();

        const PW = 280;
        const PH = 440;
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        const novaW  = 130;
        const gap    = 12;
        const panelX = sw - novaW - gap - PW;
        const panelY = sh - PH - 8;

        if (videoEditorWin && !videoEditorWin.isDestroyed()) {
            videoEditorWin.webContents.send('video-editor-panel-data', data);
            return;
        }

        videoEditorWin = new BrowserWindow({
            width: PW, height: PH,
            x: panelX, y: panelY,
            transparent: true, frame: false, hasShadow: false,
            alwaysOnTop: true, skipTaskbar: true, resizable: false,
            ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        videoEditorWin.setAlwaysOnTop(true, 'screen-saver');
        videoEditorWin.loadFile(path.join(__dirname, 'video_editor_panel.html'));
        videoEditorWin.once('ready-to-show', () => {
            videoEditorWin.show();
            setTimeout(() => {
                if (videoEditorWin && !videoEditorWin.isDestroyed()) {
                    videoEditorWin.webContents.send('video-editor-panel-data', data);
                }
            }, 150);
        });
        videoEditorWin.on('closed', () => { videoEditorWin = null; });
    },

    updateVideoEditorPanel: (data) => {
        if (videoEditorWin && !videoEditorWin.isDestroyed()) {
            videoEditorWin.webContents.send('video-editor-panel-data', data);
        }
    },

    hideVideoEditorPanel: () => {
        if (videoEditorWin && !videoEditorWin.isDestroyed()) videoEditorWin.close();
    },

    // ── Video Generation tool handler ──────────────────────────────────────
    videoGenTool: async (args) => {
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
            console.log('[VideoGen]', msg);
        };
        return await handleVideoGenerationTool(args, logFn);
    },
};

ipcMain.handle('execute-automation', async (event, action) => {
    console.log('⚡ [Live Tool Trigger] Executing OS Command:', action);
    return await executeAutomationInternal(action.trim());
});

function createBrowserWindow(incognito = false) {
    if (browserWin) {
        if (browserWin.isMinimized()) browserWin.restore();
        browserWin.focus();
        return;
    }

    browserWin = new BrowserWindow({
        width: 1024,
        height: 768,
        title: incognito ? 'Nova Browser Agent — Incognito' : 'Nova Browser Agent',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,       // CRITICAL: Enables <webview> in the browser.html
            webSecurity: false,     // Allow executeJavaScript on any origin
            allowRunningInsecureContent: true
        }
    });

    browserWin.loadFile(path.join(__dirname, 'browser.html'), {
        query: { incognito: incognito ? '1' : '0' }
    });

    browserWin.on('closed', () => {
        browserWin = null;
        isBrowserReady = false;
        pendingBrowserUrl = null;
        setBrowserOpen(false);  // Sync live.js flag when window is closed by user
        // Notify renderer to exit research paper mode
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser-window-closed');
        }
    });
}

function toggleIncognito() {
    // Close the current browser (any mode) and reopen as incognito
    const alreadyIncognito = browserWin && browserWin.getTitle().includes('Incognito');
    closeBrowser();
    // Brief delay so the old window fully closes before opening the new one
    setTimeout(() => {
        createBrowserWindow(!alreadyIncognito);
        setBrowserOpen(true);
        isBrowserReady = false;
    }, 150);
}

ipcMain.on('open-chat', () => {
    createChatWindow();
});

ipcMain.handle('ask-grok', async (event, text) => {
    return await askGemini(text);
});

ipcMain.handle('transcribe-audio', async (event, buffer) => {
    try {
        return await transcribeAudio(buffer);
    } catch (e) {
        console.error('❌ Transcription error in main:', e);
        return '';
    }
});

// Real-time IPC Hooks
ipcMain.on('live-start', (event) => {
    startLiveSession(mainWindow, Automation);
    // If a browser window is already open (e.g., research paper was open when
    // the Live session timed out and restarted), restore the _browserIsOpen flag
    // so Gemini can still close it via the control_browser tool.
    if (browserWin && !browserWin.isDestroyed()) {
        setBrowserOpen(true);
    }
});

ipcMain.on('live-audio-chunk', (event, base64Data) => {
    sendAudioChunk(base64Data);
});

ipcMain.on('calendar-panel-hide', () => {
    Automation.hideCalendarPanel();
});

ipcMain.on('notes-panel-hide', () => {
    Automation.hideNotesPanel();
});

ipcMain.on('contacts-panel-hide', () => {
    Automation.hideContactsPanel();
});

ipcMain.on('attachments-panel-hide', () => {
    Automation.hideAttachmentsPanel();
});

ipcMain.on('notes-panel-open-note', (event, title) => {
    const { getNote, openNoteInApp } = require('./notes');
    const note = getNote(title);
    if (note) {
        openNoteInApp(note.filePath, note.title, note.content);
        if (notesWin && !notesWin.isDestroyed()) {
            notesWin.webContents.send('notes-panel-data', { mode: 'note', note });
        }
    }
});

ipcMain.on('live-text-chunk', (event, text) => {
    sendTextChunk(text);
});

ipcMain.on('live-end', (event) => {
    endLiveSession();
});

ipcMain.handle('browser-open', async (event, data) => {
    // DE-BOUNCE: Prevent repetitive searches while talking
    const now = Date.now();
    const queryStr = (typeof data === 'string') ? data : (data.query || '');
    if (global.lastLaunchTimes && global.lastLaunchTimes.has('browser-search') && (now - global.lastLaunchTimes.get('browser-search') < 6000)) {
        console.log(`🛡️ De-bounce: Skipping repetitive browser search for "${queryStr.substring(0, 20)}..."`);
        return true;
    }
    if (!global.lastLaunchTimes) global.lastLaunchTimes = new Map();
    global.lastLaunchTimes.set('browser-search', now);
    openBrowser(data);
    return true;
});

ipcMain.on('browser-scroll', (event, direction) => {
    scrollBrowser(direction);
});

ipcMain.on('browser-close', () => {
    closeBrowser();
});

ipcMain.on('browser-get-map', (event) => {
    getDomMap();
});

ipcMain.on('dom-map-results', (event, { map, url }) => {
    console.log(`🧠 Bridge: Received DOM Map (${map?.length || 0} elements) from Browser URL: ${url}`);
    if (mainWindow) mainWindow.webContents.send('browser-dom-map', map);
    // Also emit to ipcMain for live.js to pick up
    ipcMain.emit('dom-map-available', { map, url });
});

ipcMain.on('browser-click-id', (event, id) => {
    clickBrowserId(id);
});

ipcMain.on('browser-click', (event, target) => {
    smartClickBrowser(target);
});


// Helper for cross-platform keyboard emulation
async function emulatePlaySequence(window) {
    if (window) window.webContents.send('automation-log', "🎹 Starting YouTube Play Automation...");
    console.log("🎹 Starting YouTube Play Automation...");

    // Give the browser time to open and load the YouTube page
    await new Promise(r => setTimeout(r, 5000));

    const runCmd = (cmd) => new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
            if (err) console.error("🎹 Cmd failed:", err.message);
            resolve(stdout ? stdout.trim() : '');
        });
    });
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // Get screen dimensions via Electron's screen module for accurate click coords
    const displayBounds = screen.getPrimaryDisplay().bounds;
    const screenW = displayBounds.width;
    const screenH = displayBounds.height;
    console.log(`🎹 Screen: ${screenW}x${screenH}`);

    // Helper: resolve browser window ID (X11 only)
    const getBrowserWinId = async () => {
        let winId = await runCmd(`xdotool search --name "YouTube" 2>/dev/null | head -1`);
        if (!winId) {
            winId = await runCmd(
                `xdotool search --onlyvisible --class "brave|Brave-browser|firefox|Firefox|chromium|Chromium|chrome|Google-chrome" 2>/dev/null | head -1`
            );
        }
        return winId;
    };

    const isWayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');

    try {
        // ── Focus browser ────────────────────────────────────────────────────
        let winId = null;
        if (process.platform === 'darwin') {
            const browsers = ['Google Chrome', 'Brave Browser', 'Firefox', 'Safari'];
            for (const b of browsers) {
                const r = await runCmd(`osascript -e 'tell application "${b}" to activate' 2>/dev/null && echo ok`);
                if (r.includes('ok')) break;
            }
            await delay(500);
        } else if (process.platform === 'win32') {
            await runCmd(`powershell -command "$p=(Get-Process | Where-Object {$_.MainWindowTitle -match 'YouTube'} | Select-Object -First 1); if($p){Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W32{[DllImport(\\"user32.dll\\")]public static extern bool SetForegroundWindow(IntPtr h);}';[W32]::SetForegroundWindow($p.MainWindowHandle)}"`);
            await delay(300);
        } else if (!isWayland) {
            // X11: get browser window by ID and focus it
            winId = await getBrowserWinId();
            if (winId) {
                if (window) window.webContents.send('automation-log', `🎹 Focusing browser (ID: ${winId})...`);
                await runCmd(`xdotool windowactivate --sync ${winId}`);
                await delay(400);
            }
        }
        // Wayland: wmctrl focus attempt (may fail, ydotool sends globally)
        if (isWayland) {
            await runCmd(`wmctrl -a "YouTube" 2>/dev/null; wmctrl -a "brave" 2>/dev/null; wmctrl -a "firefox" 2>/dev/null; true`);
            await delay(400);
        }

        // ── Press 'k' to play ────────────────────────────────────────────────
        if (window) window.webContents.send('automation-log', "▶️ Pressing play...");
        if (process.platform === 'darwin') {
            await runCmd(`osascript -e 'tell application "System Events" to keystroke "k"'`);
        } else if (process.platform === 'win32') {
            await runCmd(`powershell -command "$s=New-Object -ComObject WScript.Shell; $s.SendKeys('k')"`);
        } else if (isWayland) {
            await runCmd(`ydotool key 37:1 37:0`); // k = play/pause
        } else if (winId) {
            await runCmd(`xdotool key --window ${winId} k`);
        } else {
            await runCmd(`xdotool key k`);
        }


        if (window) window.webContents.send('automation-log', "✅ Playback sequence complete!");
        console.log("🎹 Keyboard Emulation Success");
    } catch (e) {
        console.error("🎹 Keyboard Emulation Error:", e);
        if (window) window.webContents.send('automation-log', "❌ Playback automation failed.");
    }
}



ipcMain.handle('browser-search', async (event, { platform, query }) => {
    if (platform === 'youtube') {
        try {
            console.log(`🔍 Attempting Super-Lucky async search for: ${query}`);
            // Use promise-wrapped exec to find the ID without hanging main thread
            const videoId = await new Promise((resolve, reject) => {
                exec(`yt-dlp --get-id "ytsearch1:${query}"`, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout.trim());
                });
            });

            if (videoId && videoId.length < 20) {
                console.log(`✅ Super-Lucky success: ${videoId}`);
                const url = `https://www.youtube.com/watch?v=${videoId}`;
                createBrowserWindow();
                setTimeout(() => {
                    if (browserWin) browserWin.webContents.send('navigate', url);
                }, 500);
                return true;
            }
        } catch (e) {
            console.error("Super-Lucky failed, falling back to results page:", e);
        }
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', searchUrl);
        }, 500);
        emulatePlaySequence(mainWindow); // Trigger automation
    } else {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', url);
        }, 500);
    }
    return true;
});

// Internal helper for spawning processes
function executeCommand(command, description) {
    console.log(`🌐 Executing: ${description}`);
    console.log(`🔧 Command: ${command}`);

    return new Promise((resolve, reject) => {
        const isSilent = command.includes('playerctl');
        const process = spawn(command, { shell: true, stdio: isSilent ? 'ignore' : 'pipe' });

        process.stdout.on('data', (data) => {
            console.log(`✅ Command output: ${data.toString().trim()}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`❌ Command error: ${data.toString().trim()}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Automation action executed successfully!`);
                resolve(true);
            } else {
                console.error(`❌ Command failed with code: ${code}`);
                resolve(false);
            }
        });
    });
}

async function executeAutomationInternal(command) {
    const cmd = command.toLowerCase().trim();
    console.log('🔧 Processing automation command:', cmd);

    // 0. Hotkey: Play/Pause (k or space)
    if (cmd === 'press-k' || cmd === 'stop-media' || cmd === 'pause' || cmd === 'play') {
        const platform = process.platform;
        if (platform === 'linux') {
            const windowSearch = `(xdotool search --onlyvisible --name "Nova Browser Agent" 2>/dev/null || xdotool search --onlyvisible --name "YouTube" 2>/dev/null || xdotool search --onlyvisible --class "zen" 2>/dev/null) | head -1`;
            const action = `WID=$(${windowSearch}); if [ ! -z "$WID" ]; then xdotool windowactivate --sync $WID && xdotool windowfocus --sync $WID && xdotool key --clearmodifiers k || xdotool key --clearmodifiers space; else xdotool key k || xdotool key space; fi`;
            exec(action);
        } else if (platform === 'darwin') {
            const action = `osascript -e 'tell application "System Events" to tell process "Electron" to set frontmost to true' -e 'tell application "System Events" to key code 40'`; // 40 = k
            exec(action);
        } else if (platform === 'win32') {
            const action = `powershell -Command "$obj = New-Object -ComObject WScript.Shell; if ($obj.AppActivate('Nova Browser Agent')) { $obj.SendKeys('k') } else { $obj.SendKeys('k') }"`;
            exec(action);
        }
        return 'Toggled playback hotkey.';
    }

    // 1. System Volume Control (Smooth 5% steps)
    if (cmd === 'increase-volume') {
        const platform = process.platform;
        if (platform === 'linux') exec('pactl set-sink-volume @DEFAULT_SINK@ +5%');
        else if (platform === 'darwin') exec('osascript -e "set volume output volume ((output volume of (get volume settings)) + 5)"');
        else if (platform === 'win32') exec('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
        return 'Increased volume.';
    }
    if (cmd === 'decrease-volume') {
        const platform = process.platform;
        if (platform === 'linux') exec('pactl set-sink-volume @DEFAULT_SINK@ -5%');
        else if (platform === 'darwin') exec('osascript -e "set volume output volume ((output volume of (get volume settings)) - 5)"');
        else if (platform === 'win32') exec('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
        return 'Decreased volume.';
    }

    // 2. PRIORITY: Application Closing (Catch this before "Opening" logic matches keywords like 'code')
    if (cmd.includes('close ') || cmd.includes('terminate ') || cmd.startsWith('close-')) {
        // Intercept file-manager close requests before trying pkill with the folder name
        const fileManagerWords = /\b(file\s*manager|file\s*explorer|explorer|dolphin|nautilus|thunar|nemo|folder|files|finder)\b/i;
        if (fileManagerWords.test(cmd)) {
            console.log('📂 Closing file manager windows...');
            closeFileManagers();
            return 'File manager closed.';
        }

        const appName = cmd.replace(/close |terminate |close-/g, '').trim();
        const platform = process.platform;

        // Linux uses different process names than the user-facing app alias.
        // closeAppMap[linux] overrides the pkill target on Linux only.
        const closeAppMap = {
            'vscode':               { all: 'code' },
            'vs code':              { all: 'code' },
            'visual studio code':   { all: 'code' },
            'browser':              { linux: 'zen', darwin: 'Safari', win32: 'msedge' },
            'chrome':               { linux: 'google-chrome', darwin: 'Google Chrome', win32: 'chrome' },
            'firefox':              { linux: 'firefox', darwin: 'Firefox', win32: 'firefox' },
            // Office apps — on Linux these are all soffice
            'excel':                { linux: 'soffice', darwin: 'Microsoft Excel', win32: 'excel' },
            'spreadsheet':          { linux: 'soffice', darwin: 'Microsoft Excel', win32: 'excel' },
            'calc':                 { linux: 'soffice', darwin: 'LibreOffice', win32: 'soffice' },
            'word':                 { linux: 'soffice', darwin: 'Microsoft Word', win32: 'winword' },
            'writer':               { linux: 'soffice', darwin: 'LibreOffice', win32: 'soffice' },
            'powerpoint':           { linux: 'soffice', darwin: 'Microsoft PowerPoint', win32: 'powerpnt' },
            'impress':              { linux: 'soffice', darwin: 'LibreOffice', win32: 'soffice' },
            'libreoffice':          { linux: 'soffice', darwin: 'LibreOffice', win32: 'soffice' },
        };
        const entry = closeAppMap[appName.toLowerCase()];
        const target = entry ? (entry.all || entry[platform] || entry.linux || appName) : appName;

        // SAFEGUARD: Don't kill Nova or VS Code if we're running inside it
        const selfTargets = ['node', 'electron', 'robot-widget', 'nova', 'assistant'];
        if (selfTargets.includes(target.toLowerCase())) {
            console.warn(`🛑 Safeguard: Blocked attempt to terminate assistant via target "${target}"`);
            return "I cannot close myself using this command.";
        }

        if (target.toLowerCase() === 'code' && process.env.VSCODE_PID) {
            console.warn("🛡️ Safeguard: Blocked 'pkill code' because the assistant is running in a VS Code process.");
            return "Closing VS Code would also terminate me. Please close it manually if needed.";
        }

        console.log(`📡 Terminating app: ${target} (parsed from: ${appName})`);

        if (platform === 'win32') {
            exec(`taskkill /IM ${target}.exe /F /T`);
        } else {
            exec(`pkill -i "${target}"`);
        }
        return `Closing ${target}.`;
    }

    // 3. Specific Website/URL Opening
    if (cmd.includes('http') || cmd.includes('www.') || cmd.includes('open website')) {
        let url = command.split(' ').find(word => word.includes('http') || word.includes('www.'));
        if (!url && cmd.includes('open website')) {
            url = cmd.replace(/open website/i, '').trim();
        }
        if (url) {
            console.log('🌐 Rerouting specific URL to Internal Browser Agent:', url);
            openBrowser(url);
            return `Opening requested link: ${url}`;
        }
    }

    // 4. Folder / file opening
    if (cmd.includes('folder') || cmd.includes('directory') || cmd.includes('dir') ||
        cmd.match(/\b(open|show|go to)\b.*?\b(file|folder|directory)\b/i) ||
        cmd.match(/\bopen\b.+\.(txt|pdf|docx?|xlsx?|pptx?|png|jpg|jpeg|mp4|mp3|zip|csv|json|js|ts|py|sh|md)\b/i)) {

        const homeDir = app.getPath('home');

        // ── Named system folders (checked first — fast path) ─────────────────
        const SYSTEM_FOLDERS = {
            documents:  app.getPath('documents'),
            downloads:  app.getPath('downloads'),
            desktop:    app.getPath('desktop'),
            pictures:   app.getPath('pictures'),
            music:      app.getPath('music'),
            videos:     app.getPath('videos'),
            home:       homeDir,
            temp:       app.getPath('temp'),
        };
        for (const [sysName, folderPath] of Object.entries(SYSTEM_FOLDERS)) {
            if (cmd.includes(sysName)) {
                console.log(`📂 Opening system folder: ${folderPath}`);
                openFolderExclusive(folderPath);
                return `${sysName.charAt(0).toUpperCase() + sysName.slice(1)} folder opened.`;
            }
        }

        // ── Arbitrary folder/file search (speech-aware, multi-variant) ────────
        // Strip the verb + the trailing "folder/file/directory" word from the command
        const nameMatch = cmd.match(/(?:open|show|go to|find)\s+(?:the\s+|my\s+)?(?:file\s+|folder\s+)?(.+?)(?:\s+(?:folder|file|directory))?$/i);
        const searchName = nameMatch ? nameMatch[1].trim() : null;

        if (searchName && searchName.length > 1) {
            console.log(`🔍 Searching filesystem for: "${searchName}"`);
            try {
                const result = await findFileOrFolder(searchName, homeDir);
                if (result) {
                    openFileByExtension(result);   // Extension-aware: html→browser, code→vscode, etc.
                    return `Opening ${path.basename(result)}.`;
                }
            } catch (e) {
                console.error('File search error:', e);
            }
            return `I couldn't find "${searchName}" on your system.`;
        }

        // Fallback: open home
        openFolderExclusive(homeDir);
        return 'Home folder opened.';
    }

    // 5. APP LAUNCH — check BEFORE generic search routing so "open zoom", "open docs", etc.
    //    never get swallowed by the google/search regex below.
    if (cmd.startsWith('open ') || cmd.startsWith('launch ') || cmd.startsWith('focus ')) {
        const appName = cmd.replace(/^(open |launch |focus )/, '').trim();
        const appKey = (ALIASES[appName] || appName).toLowerCase();
        // If it's a known app, focus/launch it directly
        if (APP_FOCUS_MAP[appKey]) {
            return await focusAppInternal(appName);
        }
        // Unknown app — still try to launch it rather than searching
        if (appName.length > 0 && !appName.match(/\b(browser|google|web|http|www)\b/i)) {
            return await focusAppInternal(appName);
        }
    }

    // Direct app keywords (exact matches from map or alias table)
    if (APP_FOCUS_MAP[cmd] || ALIASES[cmd]) {
        return await focusAppInternal(cmd);
    }

    // 5b. BROWSER CONTROL FALLBACK — catches scroll/click commands that Gemini
    //     accidentally routes to execute_system_command instead of control_browser.
    if (cmd.match(/^scroll (down|up|top|bottom)$/)) {
        const direction = cmd.split(' ')[1];
        scrollBrowser(direction);
        return `Scrolling ${direction}.`;
    }
    if (cmd === 'close browser' || cmd === 'close the browser') {
        closeBrowser();
        return 'Browser closed.';
    }

    // 6. MEDIA (explicit YouTube/play intent only)
    if (cmd.match(/\b(youtube|you tube|play song)\b/i)) {
        const searchTerm = cmd.replace(/\b(youtube|you tube|play song|search)\b/gi, '').trim();
        openBrowser({ platform: 'youtube', query: searchTerm || 'youtube' });
        return `Opening YouTube for "${searchTerm || 'YouTube'}".`;
    }

    // 7. EXPLICIT BROWSER OPEN only — "search X" is NOT handled here to prevent
    //    spurious searches during conversations. Searches go through control_browser.
    if (cmd === 'browser' || cmd === 'open browser' || cmd.startsWith('browse ')) {
        openBrowser({ platform: 'google', query: '' });
        return 'Opening the browser for you.';
    }

    return "Command not recognized as a system action.";
}

// Redundant helpers removed to consolidate logic above.

ipcMain.handle('stop-media', async () => {
    try {
        let stopCmd = 'playerctl pause';
        if (process.platform === 'darwin') {
            stopCmd = 'osascript -e "tell application \\"System Events\\" to key code 49"'; // Simulate Space
        } else if (process.platform === 'win32') {
            stopCmd = 'powershell -command "(New-Object -ComObject Shell.Application).PlayPause()"'; // Fallback
        }
        await executeCommand(stopCmd, 'Stopping all music/media');
        return true;
    } catch (e) {
        return false;
    }
});

ipcMain.handle('play-media', async () => {
    try {
        let playCmd = 'playerctl play';
        if (process.platform === 'darwin') {
            playCmd = 'osascript -e "tell application \\"System Events\\" to key code 49"'; // Simulate Space
        } else if (process.platform === 'win32') {
            playCmd = 'powershell -command "(New-Object -ComObject Shell.Application).PlayPause()"'; // Fallback
        }
        await executeCommand(playCmd, 'Playing music/media');
        return true;
    } catch (e) {
        return false;
    }
});

ipcMain.handle('switch-window', async () => {
    try {
        console.log('🔄 Switching to next window (Alt+Tab simulation)...');
        let cmd = '';
        if (process.platform === 'darwin') {
            // macOS: Cmd+Tab
            cmd = `osascript -e 'tell application "System Events" to key code 48 using {command down}'`;
        } else if (process.platform === 'win32') {
            // Windows: Alt+Tab via WScript.Shell
            cmd = `powershell -command "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('%{TAB}')"`;
        } else {
            // Linux: try xdotool first (X11), fall back to ydotool (Wayland)
            const isWayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
            if (isWayland) {
                // ydotool: hold Alt (56), press and release Tab (15), release Alt
                cmd = `ydotool key 56:1 15:1 15:0 56:0`;
            } else {
                cmd = `xdotool key alt+Tab`;
            }
        }
        await new Promise((resolve) => {
            exec(cmd, (err) => {
                if (err) console.error('🔄 switch-window error:', err);
                resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('🔄 switch-window exception:', e);
        return false;
    }
});

// ── App focus / launch map ─────────────────────────────────────────────────
// Keys are lowercase aliases the user might say.
// `classes`  = regex matched against WM_CLASS / window title  (xdotool/wmctrl)
// `launch`   = shell command to start the app if no window found
// `macosApp` = macOS app name for `open -a`
// `winExe`   = Windows executable / Start-Process target
const APP_FOCUS_MAP = {
    // ── Browsers ──────────────────────────────────────────────────────────
    browser: { classes: 'firefox|chromium|brave|chrome|Brave-browser|opera|vivaldi', launch: 'xdg-open https://www.google.com', macosApp: 'Safari', winExe: 'start microsoft-edge:' },
    firefox: { classes: 'firefox|Firefox', launch: 'firefox', macosApp: 'Firefox', winExe: 'firefox' },
    chrome: { classes: 'google-chrome|chromium|Chromium|brave|Brave-browser', launch: 'google-chrome || chromium || brave', macosApp: 'Google Chrome', winExe: 'chrome' },
    chromium: { classes: 'chromium|Chromium', launch: 'chromium', macosApp: 'Chromium', winExe: 'chromium' },
    brave: { classes: 'brave|Brave-browser', launch: 'brave || brave-browser', macosApp: 'Brave Browser', winExe: 'brave' },
    // ── Code editors / IDEs ───────────────────────────────────────────────
    vscode: { classes: 'code|Code|vscode', launch: 'code', macosApp: 'Visual Studio Code', winExe: 'code' },
    cursor: { classes: 'cursor|Cursor', launch: 'cursor', macosApp: 'Cursor', winExe: 'cursor' },
    intellij: { classes: 'jetbrains-idea|idea|IntelliJ', launch: 'idea || intellij-idea-ultimate', macosApp: 'IntelliJ IDEA', winExe: 'idea64' },
    idea: { classes: 'jetbrains-idea|idea|IntelliJ', launch: 'idea || intellij-idea-ultimate', macosApp: 'IntelliJ IDEA', winExe: 'idea64' },
    pycharm: { classes: 'pycharm|PyCharm', launch: 'pycharm || pycharm-professional', macosApp: 'PyCharm', winExe: 'pycharm64' },
    webstorm: { classes: 'webstorm|WebStorm', launch: 'webstorm', macosApp: 'WebStorm', winExe: 'webstorm64' },
    // ── Terminals ─────────────────────────────────────────────────────────
    terminal: { classes: 'konsole|gnome-terminal|xterm|kitty|alacritty|terminator|tilix|urxvt|st-', launch: 'konsole || gnome-terminal || xterm', macosApp: 'Terminal', winExe: 'cmd' },
    konsole: { classes: 'konsole|Konsole', launch: 'konsole', macosApp: 'Terminal', winExe: 'cmd' },
    // ── Office / productivity ─────────────────────────────────────────────
    excel: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    spreadsheet: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    calc: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    word: { classes: 'libreoffice|soffice|swriter', launch: 'libreoffice --writer', macosApp: 'Microsoft Word', winExe: 'winword' },
    writer: { classes: 'libreoffice|soffice|swriter', launch: 'libreoffice --writer', macosApp: 'Microsoft Word', winExe: 'winword' },
    powerpoint: { classes: 'libreoffice|soffice|simpress', launch: 'libreoffice --impress', macosApp: 'Microsoft PowerPoint', winExe: 'powerpnt' },
    impress: { classes: 'libreoffice|soffice|simpress', launch: 'libreoffice --impress', macosApp: 'Microsoft PowerPoint', winExe: 'powerpnt' },
    libreoffice: { classes: 'libreoffice|soffice', launch: 'libreoffice', macosApp: 'LibreOffice', winExe: 'soffice' },
    // ── File managers ─────────────────────────────────────────────────────
    files: { classes: 'dolphin|nautilus|thunar|nemo|pcmanfm|ranger', launch: 'dolphin || nautilus || thunar', macosApp: 'Finder', winExe: 'explorer' },
    dolphin: { classes: 'dolphin|Dolphin', launch: 'dolphin', macosApp: 'Finder', winExe: 'explorer' },
    nautilus: { classes: 'nautilus|Nautilus|org.gnome.Nautilus', launch: 'nautilus', macosApp: 'Finder', winExe: 'explorer' },
    // ── Communication ─────────────────────────────────────────────────────
    discord: { classes: 'discord|Discord', launch: 'discord 2>/dev/null || flatpak run com.discordapp.Discord 2>/dev/null || snap run discord 2>/dev/null', macosApp: 'Discord', winExe: 'discord' },
    slack: { classes: 'slack|Slack', launch: 'slack 2>/dev/null || flatpak run com.slack.Slack 2>/dev/null || snap run slack 2>/dev/null', macosApp: 'Slack', winExe: 'slack' },
    telegram: { classes: 'telegram|Telegram', launch: 'telegram-desktop 2>/dev/null || flatpak run org.telegram.desktop 2>/dev/null || Telegram 2>/dev/null', macosApp: 'Telegram', winExe: 'telegram' },
    // ── Media ─────────────────────────────────────────────────────────────
    spotify: { classes: 'spotify|Spotify', launch: 'spotify 2>/dev/null || flatpak run com.spotify.Client 2>/dev/null || snap run spotify 2>/dev/null', macosApp: 'Spotify', winExe: 'spotify' },
    vlc: { classes: 'vlc|VLC', launch: 'vlc 2>/dev/null || flatpak run org.videolan.VLC 2>/dev/null', macosApp: 'VLC', winExe: 'vlc' },
    // ── Other ─────────────────────────────────────────────────────────────
    obsidian: { classes: 'obsidian|Obsidian', launch: 'obsidian 2>/dev/null || flatpak run md.obsidian.Obsidian 2>/dev/null', macosApp: 'Obsidian', winExe: 'Obsidian' },
    gimp: { classes: 'gimp|Gimp', launch: 'gimp 2>/dev/null || flatpak run org.gimp.GIMP 2>/dev/null', macosApp: 'GIMP', winExe: 'gimp' },
    blender: { classes: 'blender|Blender', launch: 'blender 2>/dev/null || flatpak run org.blender.Blender 2>/dev/null', macosApp: 'Blender', winExe: 'blender' },
    zoom: { classes: 'zoom|Zoom', launch: 'zoom 2>/dev/null || /opt/zoom/zoom 2>/dev/null || flatpak run us.zoom.Zoom 2>/dev/null || snap run zoom-client 2>/dev/null', macosApp: 'zoom.us', winExe: 'zoom' },
    // ── Games ─────────────────────────────────────────────────────────────────
    antigravity: { classes: 'antigravity|Antigravity', launch: 'antigravity', macosApp: 'Antigravity', winExe: 'antigravity' },
    // ── Document apps — use local system apps (LibreOffice on Linux) ─────────
    docs: { classes: 'libreoffice|soffice|swriter', launch: 'libreoffice --writer 2>/dev/null || soffice --writer 2>/dev/null', macosApp: 'Pages', winExe: 'winword' },
    sheets: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc 2>/dev/null || soffice --calc 2>/dev/null', macosApp: 'Numbers', winExe: 'excel' },
    slides: { classes: 'libreoffice|soffice|simpress', launch: 'libreoffice --impress 2>/dev/null || soffice --impress 2>/dev/null', macosApp: 'Keynote', winExe: 'powerpnt' },
    // ── Google Web Apps (open in system default browser) ──────────────────────
    drive: { classes: 'Google Drive', launch: 'xdg-open https://drive.google.com/', macosApp: null, winExe: null },
    gmail: { classes: 'Gmail|Google Mail', launch: 'xdg-open https://mail.google.com/', macosApp: null, winExe: null },
    meet: { classes: 'Google Meet', launch: 'xdg-open https://meet.google.com/', macosApp: null, winExe: null },
};

// Normalize common speech variants → canonical APP_FOCUS_MAP key
const ALIASES = {
    'code': 'vscode', 'vs code': 'vscode', 'visual studio code': 'vscode', 'visual studio': 'vscode',
    'vs-code': 'vscode', 'vs_code': 'vscode',
    'idea': 'intellij', 'jet brains': 'intellij', 'jetbrains': 'intellij', 'android studio': 'intellij',
    'web storm': 'webstorm', 'py charm': 'pycharm',
    'konsole': 'terminal', 'gnome terminal': 'terminal', 'gnome-terminal': 'terminal',
    'xterm': 'terminal', 'kitty': 'terminal', 'alacritty': 'terminal',
    'libre office': 'libreoffice', 'libre-office': 'libreoffice', 'open office': 'libreoffice',
    'spreadsheet': 'sheets', 'calc': 'sheets',
    'libre office calc': 'sheets', 'libreoffice calc': 'sheets',
    'document': 'docs', 'libre office writer': 'docs', 'libreoffice writer': 'docs',
    'presentation': 'slides',
    'libre office impress': 'slides', 'libreoffice impress': 'slides',
    'navigator': 'browser', 'web browser': 'browser', 'internet': 'browser',
    'google chrome': 'chrome',
    'file manager': 'files', 'file explorer': 'files', 'explorer': 'files',
    'finder': 'files', 'nautilus': 'files',
    'music': 'spotify', 'media player': 'spotify',
    'video editor': 'blender', 'photo editor': 'gimp',
    'chat': 'discord', 'messages': 'telegram',
    'meetings': 'zoom', 'video call': 'zoom', 'video conference': 'zoom',
    // Google web apps
    'google docs': 'docs', 'google doc': 'docs', 'gdocs': 'docs',
    'google sheets': 'sheets', 'google sheet': 'sheets', 'gsheets': 'sheets',
    'google slides': 'slides', 'gslides': 'slides',
    'google drive': 'drive', 'gdrive': 'drive',
    'google mail': 'gmail',
    'google meet': 'meet',
    // Games / other
    'anti gravity': 'antigravity',
};

async function focusAppInternal(appName) {
    let key = appName.toLowerCase().trim();
    // Apply alias table
    if (ALIASES[key]) key = ALIASES[key];
    // Strip leading/trailing noise GPT sometimes adds
    key = key.replace(/^(the |a |my |to |on )/, '').trim();

    // DE-BOUNCE: Prevent re-launching the same app within 8 seconds
    const now = Date.now();
    if (global.lastLaunchTimes && global.lastLaunchTimes.has(key) && (now - global.lastLaunchTimes.get(key) < 8000)) {
        console.log(`🛡️ De-bounce: Skipping repetitive launch for "${key}"`);
        return `I'm already opening ${appName}. Please wait a moment.`;
    }
    if (!global.lastLaunchTimes) global.lastLaunchTimes = new Map();
    global.lastLaunchTimes.set(key, now);

    const entry = APP_FOCUS_MAP[key];

    if (!entry) {
        // Unknown app — first check if it's a folder/file name, then try direct launch.
        // This handles "open HandDetectionRobot" without the user needing to say "folder".
        const homeDir = app.getPath('home');
        const fsResult = await findFileOrFolder(appName, homeDir);
        if (fsResult) {
            console.log(`📂 Resolved "${appName}" as filesystem path: ${fsResult}`);
            openFileByExtension(fsResult);   // Extension-aware: html→browser, code→vscode, etc.
            return `Opening ${path.basename(fsResult)}.`;
        }

        // Nothing found on disk — try executing it as an app command (single-word apps like "zoom")
        // Only attempt if the name looks like a real executable (no spaces, or a known pattern)
        const isSingleWord = !appName.includes(' ');
        if (isSingleWord) {
            console.log(`🔍 Unknown app "${appName}", attempting direct launch...`);
            exec(appName, (err) => {
                if (err) console.error(`❌ Direct launch of "${appName}" failed:`, err);
            });
            return `Trying to open ${appName} for you.`;
        }

        return `I couldn't find "${appName}" as an app or folder on your system.`;
    }

    console.log(`🎯 Focusing app: "${appName}" (entry: ${JSON.stringify(entry)})`);

    if (process.platform === 'darwin') {
        if (!entry.macosApp) {
            // URL-based or web app — open with 'open' command
            const cmd = entry.launch.replace(/^xdg-open /, 'open ');
            exec(cmd, () => {});
            return `Opening ${appName}.`;
        }
        const activateCmd = `osascript -e 'tell application "${entry.macosApp}" to activate'`;
        const openCmd = `open -a "${entry.macosApp}"`;
        exec(activateCmd, (err) => {
            if (err) exec(openCmd, () => { });
        });
        return `Switching to ${appName}.`;
    }

    if (process.platform === 'win32') {
        if (!entry.winExe) {
            // URL-based app on Windows
            const url = entry.launch.replace(/^xdg-open /, '');
            exec(`start "" "${url}"`, () => {});
            return `Opening ${appName}.`;
        }
        const psCmd = `powershell -command "
            $wnd = (Get-Process | Where-Object {$_.MainWindowTitle -match '${key}'} | Select-Object -First 1);
            if ($wnd) {
                Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }';
                [Win32]::SetForegroundWindow($wnd.MainWindowHandle)
            } else { Start-Process '${entry.winExe}' }"`;
        exec(psCmd, () => { });
        return `Switching to ${appName}.`;
    }

    // Web-based apps: just open the URL directly, no window-raise needed
    if (entry.launch && entry.launch.startsWith('xdg-open http')) {
        exec(entry.launch, (err) => {
            if (err) console.error(`❌ xdg-open failed for "${appName}":`, err);
        });
        return `Opening ${appName}.`;
    }

    const isWayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
    const classRegex = entry.classes;

    const tryRaiseWindow = () => new Promise((resolve) => {
        if (isWayland) {
            exec(`wmctrl -x -a "${key}" 2>/dev/null || wmctrl -a "${key}" 2>/dev/null`, (err) => {
                resolve(!err);
            });
        } else {
            // X11: Use --regexp for multi-class patterns like 'zoom|Zoom'
            const searchBase = `xdotool search --regexp`;
            exec(
                `${searchBase} --onlyvisible --classname "${classRegex}" windowactivate --sync 2>/dev/null ` +
                `|| ${searchBase} --onlyvisible --class "${classRegex}" windowactivate --sync 2>/dev/null ` +
                `|| ${searchBase} --name "${classRegex}" windowactivate --sync 2>/dev/null`,
                (err, stdout) => {
                    resolve(!err && stdout.trim().length > 0);
                }
            );
        }
    });

    const raised = await tryRaiseWindow();
    if (raised) {
        console.log(`✅ Raised existing window for "${appName}"`);
        return `Switched to ${appName}.`;
    }

    console.log(`🚀 No open window found for "${appName}", launching...`);
    // Use sh -c so the full launch string (including || fallbacks) is handled by the shell
    const shellBin = process.platform === 'win32' ? 'cmd' : 'sh';
    const shellArg = process.platform === 'win32' ? '/c' : '-c';
    const child = spawn(shellBin, [shellArg, entry.launch], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
    });
    child.unref();

    return `${appName} wasn't open, so I'm launching it now.`;
}

ipcMain.handle('focus-app', async (event, appName) => {
    return await focusAppInternal(appName);
});

ipcMain.handle('capture-screen', async () => {
    const tmpPath = path.join(app.getPath('temp'), `nova_shot_${Date.now()}.png`);

    // Final Fallback using Electron's desktopCapturer
    const desktopShot = async () => {
        try {
            const { desktopCapturer } = require('electron');
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
            const primarySource = sources[0];
            if (primarySource) {
                console.log("📸 Fallback: Captured screen via desktopCapturer");
                return primarySource.thumbnail.toDataURL();
            }
        } catch (e) {
            console.error("Capture Fallback Error:", e);
        }
        return null;
    };

    // Silent Screenshot Triggers (Wayland/X11/macOS)
    let cmd = "";
    if (process.platform === 'darwin') {
        cmd = `screencapture -x "${tmpPath}"`;
    } else if (process.platform === 'linux') {
        if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
            cmd = `spectacle --background --nonotify --output "${tmpPath}" || grim "${tmpPath}"`;
        } else {
            cmd = `import -window root "${tmpPath}"`;
        }
    }

    console.log(`📸 Attempting screenshot with: ${cmd}`);

    try {
        if (cmd) {
            await new Promise((resolve, reject) => {
                exec(cmd, { env: process.env }, (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }

        // Polling loop: Wait for file to exist AND have content (ensures write is complete)
        let found = false;
        for (let i = 0; i < 10; i++) {
            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100)); // 100ms intervals
        }

        if (found) {
            const data = fs.readFileSync(tmpPath).toString('base64');
            const dataUrl = `data:image/png;base64,${data}`;
            fs.unlinkSync(tmpPath); // Cleanup
            console.log(`📸 Successfully captured via CLI tool`);
            return dataUrl;
        } else {
            console.log("⚠️ CLI tool completed but file is missing or empty.");
        }
    } catch (e) {
        console.error(`Capture Tool Error: ${e.message}`);
    }

    return await desktopShot();
});

ipcMain.handle('generate-speech', async (event, text) => {
    try {
        const outPath = await generateSpeech(text, 'assets/tts_output.wav');
        return outPath;
    } catch (e) {
        console.error("TTS Handle Error:", e);
        return null;
    }
});

// ── Research Paper Generator ───────────────────────────────────────────────

function buildPaperHTML(topic, paperText) {
    // Convert Gemini's markdown output to HTML for a professional APA paper
    const lines = paperText.split('\n');
    let htmlBody = '';
    let inReferencesSection = false;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) { i++; continue; }

        // Detect References / Web Sources section to apply special rendering
        const isRefHeader = /^#{1,3}\s*(references|web sources|sources used|bibliography)/i.test(line) ||
                            /^\*\*(references|web sources|sources used|bibliography)\*\*/i.test(line);
        if (isRefHeader) {
            inReferencesSection = true;
            const txt = line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '');
            htmlBody += `<h2 class="section-title">${txt}</h2>\n<div class="references-section">\n`;
            i++;
            continue;
        }

        // Heading 1 (# Title)
        if (/^#{1}\s+/.test(line)) {
            htmlBody += `<h1 class="paper-title">${line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '')}</h1>\n`;
        }
        // Heading 2+ — close references section if open
        else if (/^#{2,3}\s+/.test(line) || /^\*\*[^*]+\*\*$/.test(line)) {
            if (inReferencesSection) {
                htmlBody += `</div>\n`;
                inReferencesSection = false;
            }
            const txt = line.replace(/^#{2,3}\s+/, '').replace(/\*\*/g, '');
            htmlBody += `<h2 class="section-title">${txt}</h2>\n`;
        }
        // Reference entry (numbered or hanging indent)
        else if (inReferencesSection) {
            const refLine = line
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" class="ref-url">$1</a>');
            htmlBody += `<p class="reference">${refLine}</p>\n`;
        }
        // Bullet list
        else if (/^[-•*]\s/.test(line)) {
            let listItems = '';
            while (i < lines.length && /^[-•*]\s/.test(lines[i].trim())) {
                listItems += `<li>${lines[i].trim().replace(/^[-•*]\s+/, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')}</li>\n`;
                i++;
            }
            htmlBody += `<ul>${listItems}</ul>\n`;
            continue;
        }
        // Numbered list
        else if (/^\d+\.\s/.test(line)) {
            // In a references section, numbered items are individual references
            if (inReferencesSection) {
                const refLine = line
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" class="ref-url">$1</a>');
                htmlBody += `<p class="reference">${refLine}</p>\n`;
            } else {
                let listItems = '';
                while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
                    listItems += `<li>${lines[i].trim().replace(/^\d+\.\s+/, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')}</li>\n`;
                    i++;
                }
                htmlBody += `<ol>${listItems}</ol>\n`;
                continue;
            }
        }
        // Regular paragraph — also convert bare URLs to clickable links
        else {
            const formatted = line
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" style="color:#1a0dab;word-break:break-all;">$1</a>');
            htmlBody += `<p>${formatted}</p>\n`;
        }
        i++;
    }
    // Close references section if it was the last section
    if (inReferencesSection) {
        htmlBody += `</div>\n`;
    }

    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const runningHead = topic.toUpperCase().substring(0, 55);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Research Paper: ${topic}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 12pt;
    line-height: 2;
    color: #000;
    background: #fff;
    max-width: 8.5in;
    margin: 0 auto;
    padding: 1in;
  }
  .running-head {
    font-size: 10pt;
    text-align: left;
    margin-bottom: 1.5em;
    letter-spacing: 0.05em;
  }
  h1.paper-title {
    font-size: 14pt;
    font-weight: bold;
    text-align: center;
    margin-top: 0.5em;
    margin-bottom: 0.25em;
  }
  h2.section-title {
    font-size: 12pt;
    font-weight: bold;
    text-align: center;
    margin-top: 1.5em;
    margin-bottom: 0;
  }
  h3.subsection-title {
    font-size: 12pt;
    font-weight: bold;
    font-style: italic;
    text-align: left;
    margin-top: 1em;
    margin-bottom: 0;
  }
  p {
    margin-bottom: 0;
    text-indent: 0.5in;
  }
  p + h2.section-title, p + h3.subsection-title { margin-top: 1.5em; }
  ul, ol {
    margin-left: 1in;
    margin-bottom: 1em;
  }
  li { margin-bottom: 0.2em; }
  .footer-note {
    font-size: 9pt;
    color: #555;
    text-align: center;
    margin-top: 2.5em;
    padding-top: 0.75em;
    border-top: 1px solid #bbb;
  }
  .references-section {
    margin-top: 0.5em;
  }
  p.reference {
    text-indent: -0.5in;
    padding-left: 0.5in;
    margin-bottom: 0.75em;
    line-height: 2;
    word-break: break-word;
  }
  a.ref-url {
    color: #1a0dab;
    word-break: break-all;
    font-size: 10pt;
  }
  @media print {
    body { padding: 1in; }
    .footer-note { display: none; }
  }
</style>
</head>
<body>
<div class="running-head">Running head: ${runningHead}</div>
${htmlBody}
<div class="footer-note">
  Generated by Nova AI Research Assistant &mdash; ${currentDate}<br>
  Compiled using Gemini AI with live Google Search grounding. Citations are in APA 7th edition format.
</div>
</body>
</html>`;
}

async function generateResearchPaper(topic, mainWindow) {
    // Global lock: prevent duplicate research runs triggered by Gemini Live re-calls
    if (global.novaIsResearching) {
        console.log(`📄 Research already in progress — ignoring duplicate request for "${topic}"`);
        return;
    }
    global.novaIsResearching = true;
    global.novaLastResearchDoneAt = 0; // will be set when done

    const { GoogleGenAI } = require('@google/genai');
    const os = require('os');

    // Notify renderer immediately so it can show the overlay and block all other commands
    if (mainWindow) mainWindow.webContents.send('research-paper-started', { topic });

    // Expand the widget window to show the full research progress overlay.
    // Save the current bounds so we can restore them exactly when done.
    const RESEARCH_W = 360;
    const RESEARCH_H = 300;
    let _savedBounds = null;
    if (mainWindow) {
        _savedBounds = mainWindow.getBounds();
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        mainWindow.setResizable(true);
        mainWindow.setBounds({
            x: Math.round((sw - RESEARCH_W) / 2),
            y: Math.round((sh - RESEARCH_H) / 2),
            width: RESEARCH_W,
            height: RESEARCH_H
        }, true); // animate on macOS
        mainWindow.setResizable(false);
    }

    const sendProgress = (step, detail) => {
        console.log(`📄 [Research] ${step}: ${detail}`);
        if (mainWindow) mainWindow.webContents.send('research-paper-progress', { step, detail });
    };

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        // Phase 1: Four focused web searches — mix of general academic and specific database queries
        const searchQueries = [
            `Academic research overview of "${topic}": historical background, foundational theories, key scholars, and landmark studies. Focus on peer-reviewed sources from IEEE, ACM Digital Library, JSTOR, Google Scholar, and academic journals. Include specific authors, years, and study titles.`,
            `Recent peer-reviewed studies and findings on "${topic}" from PubMed, arXiv, ScienceDirect, Springer, and ResearchGate. Include specific paper titles, authors, publication years, methodologies, statistics, and DOI or URL links where possible.`,
            `Scholarly debates, limitations, and future research directions for "${topic}". Find academic papers from JSTOR, IEEE Xplore, ACM, and arXiv that discuss controversies, open questions, and expert disagreements. Include specific citations.`,
            `Policy reports, systematic reviews, and meta-analyses on "${topic}" from reputable sources such as WHO, World Bank, NBER, Brookings Institution, McKinsey Global Institute, or government research agencies. Include URLs and publication dates.`
        ];

        const gatheredContent = [];
        const citationMap = new Map();

        const sourceLabels = ['IEEE & arXiv', 'PubMed & Scholar', 'ResearchGate & ACM', 'Web of Science'];
        for (let idx = 0; idx < searchQueries.length; idx++) {
            sendProgress('searching', `[${idx + 1}/4] Searching ${sourceLabels[idx] || 'academic databases'}...`);
            try {
                const res = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: searchQueries[idx],
                    config: {
                        tools: [{ googleSearch: {} }],
                        temperature: 0.2,
                    }
                });

                gatheredContent.push(res.text || '');

                // Harvest grounding citations
                const cands = res.candidates;
                if (cands && cands[0] && cands[0].groundingMetadata) {
                    const chunks = cands[0].groundingMetadata.groundingChunks || [];
                    for (const chunk of chunks) {
                        if (chunk.web && chunk.web.uri && !citationMap.has(chunk.web.uri)) {
                            citationMap.set(chunk.web.uri, {
                                title: chunk.web.title || 'Untitled Source',
                                url: chunk.web.uri
                            });
                        }
                    }
                }
            } catch (searchErr) {
                console.warn(`Search ${idx + 1} warning:`, searchErr.message);
                gatheredContent.push('');
            }
        }

        const citations = Array.from(citationMap.values());

        // Phase 2: Write the full research paper
        sendProgress('writing', `[5/6] Writing paper with ${citations.length} citations (APA format)...`);

        const currentYear = new Date().getFullYear();
        const citationList = citations
            .map((c, i) => `[Source ${i + 1}] Title: "${c.title}" | URL: ${c.url}`)
            .join('\n');

        const paperPrompt = `You are an expert academic researcher and writer. Write a COMPLETE, COMPREHENSIVE, PUBLICATION-QUALITY academic research paper on: "${topic}"

Use the research information below as your primary source material.

=== RESEARCH DATA ===

[Overview & Background]
${gatheredContent[0] || 'No data gathered.'}

[Current Research & Findings]
${gatheredContent[1] || 'No data gathered.'}

[Debates, Applications & Future Directions]
${gatheredContent[2] || 'No data gathered.'}

=== SOURCES (use these for APA References) ===
${citationList || 'No specific sources captured — cite using knowledge.'}

=== PAPER STRUCTURE (write ALL sections fully) ===

## [Full Academic Title — specific and descriptive]

**Author:** Nova AI Research Assistant (${currentYear})

**Abstract**
[Write 200-280 words: background, research objectives, brief methodology, key findings, and conclusions.]

**Keywords:** [6-8 comma-separated academic keywords]

## 1. Introduction
[600-800 words. Cover: background context, problem statement, why this topic matters, gap in knowledge being addressed, research objectives, and outline of paper structure. Use in-text APA citations (Author, Year) where appropriate.]

## 2. Literature Review
[900-1200 words. Critically review existing scholarship. Discuss major theories, landmark studies, key scholars, competing views, and how prior research evolved. Use in-text citations throughout.]

## 3. Methodology / Theoretical Framework
[500-700 words. Explain the research approach, theoretical lens(es) applied, analytical framework, data sources used, and any limitations of the methodology.]

## 4. Results and Discussion
[1000-1400 words. Present key findings from the research. Analyze, interpret, and discuss implications. Compare with prior studies. Address contradictions and nuances. Support all claims with evidence and citations.]

## 5. Conclusion
[500-700 words. Summarize the major findings, restate the significance, discuss contributions to the field, acknowledge limitations, and propose future research directions.]

## References
[MANDATORY — this section MUST appear and MUST be complete.
List EVERY source cited in the paper in APA 7th edition format, sorted alphabetically.
Include the full URL for every web source. Minimum 10 references required.
Web articles: Author Surname, I. (Year, Month Day). Title of article in sentence case. *Website Name*. https://full-url-here
No-author web: Title of article in sentence case. (Year, Month Day). *Website Name*. https://full-url-here
Journal: Author, A. A., & Author, B. B. (Year). Title of article. *Journal Name*, *volume*(issue), pages. https://doi.org/xxxxx
Book: Author, A. A. (Year). *Title of book*. Publisher.
Report: Organization Name. (Year). *Title of report*. https://full-url-here
Use REAL, COMPLETE URLs from the sources provided above. Do not invent or shorten URLs.]

=== MANDATORY CITATION RULES ===
- EVERY factual claim must end with an in-text APA citation: (Author, Year) or (Source Name, Year)
- EVERY paragraph in sections 1-5 must contain at minimum 2 in-text citations
- The References section is NON-OPTIONAL — it must appear at the end with every source listed
- Every source listed in References must have been cited at least once in the body text
- Include the FULL URL for every web reference — do not abbreviate or omit URLs

=== FORMATTING RULES ===
- Minimum 4,500 words in the body sections
- Formal academic prose — no bullet points in body paragraphs
- Every paragraph must be substantive (6-10 sentences minimum)
- In-text citations: (Author, Year) or (Abbreviated Title, Year) for web sources
- Do NOT include any preamble, commentary, or notes outside the paper itself
- Begin directly with the title

WRITE THE COMPLETE PAPER NOW:`;

        // Try gemini-2.5-pro first (better quality), retry up to 2×, then fall back to flash
        let paperText = '';
        const writeModels = ['gemini-2.5-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'];
        let writeError = null;
        for (let attempt = 0; attempt < writeModels.length; attempt++) {
            const writeModel = writeModels[attempt];
            try {
                if (attempt > 0) {
                    const delay = attempt === 1 ? 8000 : 3000;
                    sendProgress('writing', attempt < 2
                        ? `Model busy — retrying in ${delay / 1000}s...`
                        : 'Switching to faster model...');
                    await new Promise(r => setTimeout(r, delay));
                }
                console.log(`📄 Writing paper with model: ${writeModel} (attempt ${attempt + 1})`);
                const paperRes = await ai.models.generateContent({
                    model: writeModel,
                    contents: paperPrompt,
                    config: {
                        temperature: 0.35,
                        maxOutputTokens: 8192,
                    }
                });
                paperText = paperRes.text;
                writeError = null;
                break; // success
            } catch (err) {
                writeError = err;
                console.warn(`⚠️ Paper write attempt ${attempt + 1} failed (${writeModel}):`, err.message);
            }
        }
        if (!paperText) throw writeError || new Error('All paper write attempts failed.');

        // Guarantee a real Web Sources section using actual grounding URLs
        // (Gemini may not include all URLs in its generated References section)
        if (citations.length > 0) {
            const webSourcesHeader = '\n\n## Web Sources Used\n';
            // Only append if we have grounding URLs
            const sourceLines = citations.map((c, i) => {
                const num = i + 1;
                return `${num}. ${c.title}. ${c.url}`;
            }).join('\n');
            // Append after the main paper text
            paperText = paperText + webSourcesHeader + sourceLines;
        }

        // Phase 3: Save to Desktop and open
        sendProgress('saving', '[6/6] Formatting HTML and saving to Desktop...');

        const desktopPath = path.join(os.homedir(), 'Desktop');
        const safeTopic = topic
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 45);
        const fileName = `Research_Paper_${safeTopic}_${Date.now()}.html`;
        const filePath = path.join(desktopPath, fileName);

        const htmlContent = buildPaperHTML(topic, paperText);
        fs.writeFileSync(filePath, htmlContent, 'utf8');

        sendProgress('opening', 'Opening your research paper in Nova Browser...');
        // Open in Nova's internal browser instead of the system default
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', `file://${filePath}`);
        }, 600);
        setBrowserOpen(true);   // Allow Gemini to close the browser after the paper is done

        global.novaIsResearching = false;
        global.novaLastResearchDoneAt = Date.now();
        if (mainWindow) {
            mainWindow.webContents.send('research-paper-done', { success: true, filePath, fileName });
            // Restore the widget to its original size and position
            if (_savedBounds) {
                mainWindow.setResizable(true);
                mainWindow.setBounds(_savedBounds, true);
                mainWindow.setResizable(false);
            }
        }

    } catch (err) {
        console.error('❌ Research paper generation failed:', err);
        global.novaIsResearching = false;
        global.novaLastResearchDoneAt = Date.now();
        if (mainWindow) {
            mainWindow.webContents.send('research-paper-done', { success: false, error: err.message });
            // Restore even on error
            if (_savedBounds) {
                mainWindow.setResizable(true);
                mainWindow.setBounds(_savedBounds, true);
                mainWindow.setResizable(false);
            }
        }
    }
}

// ── Open a file with the appropriate application based on its extension ──────
// Directories go to the file manager; .html opens in Nova browser; code files
// open in VS Code; Office docs open in the matching Office/LibreOffice app;
// everything else falls back to xdg-open / open / start.
function openFileByExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const plat = process.platform;

    // ── Escape the path for safe use in shell strings ─────────────────────
    // Wraps in double-quotes and escapes any embedded double-quotes.
    const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
    // Windows-safe path (backslashes already work in PowerShell with double-quotes)
    const qWin = (p) => `"${p.replace(/"/g, '""')}"`;

    // ── Cross-platform: open with system default handler ──────────────────
    const openDefault = () => {
        if (plat === 'darwin')      { exec(`open ${q(filePath)}`); }
        else if (plat === 'win32')  { exec(`start "" ${qWin(filePath)}`); }
        else                        { exec(`xdg-open ${q(filePath)}`); }
    };

    // ── Directory → file manager (existing behavior) ──────────────────────
    let stat;
    try { stat = fs.statSync(filePath); } catch { stat = null; }
    if (!stat || stat.isDirectory()) {
        openFolderExclusive(filePath);
        return;
    }

    // ── HTML / HTM → Nova internal browser (all platforms) ───────────────
    if (ext === '.html' || ext === '.htm') {
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', `file://${filePath}`);
        }, 600);
        setBrowserOpen(true);
        return;
    }

    // ── Code & plain-text → VS Code, fallback to system default ──────────
    // VS Code CLI is 'code' on all three platforms when installed normally.
    const codeExts = new Set([
        '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
        '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
        '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
        '.cs', '.php', '.lua', '.r', '.m', '.scala',
        '.sh', '.bash', '.zsh', '.fish',
        '.ps1',                                // PowerShell on Windows
        '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
        '.xml', '.css', '.scss', '.less', '.sass',
        '.md', '.markdown', '.rst', '.txt', '.log', '.env', '.gitignore',
        '.sql', '.graphql', '.proto', '.dart', '.vue', '.svelte'
    ]);
    if (codeExts.has(ext)) {
        // Try VS Code; if not in PATH fall through to system default
        exec(`code ${q(filePath)}`, (err) => {
            if (err) openDefault();
        });
        return;
    }

    // ── PDF → system default viewer (Preview/Acrobat/Evince/Edge) ─────────
    if (ext === '.pdf') {
        openDefault();
        return;
    }

    // ── Word-processor docs ───────────────────────────────────────────────
    // Linux: try LibreOffice Writer → xdg-open fallback
    // macOS/Windows: system default handles Pages, MS Word, LibreOffice equally
    const writerExts = new Set(['.docx', '.doc', '.odt', '.rtf', '.fodt']);
    if (writerExts.has(ext)) {
        if (plat === 'linux') {
            exec(`libreoffice --writer ${q(filePath)}`, (err) => {
                if (err) exec(`xdg-open ${q(filePath)}`);
            });
        } else {
            openDefault();
        }
        return;
    }

    // ── Spreadsheets ──────────────────────────────────────────────────────
    const calcExts = new Set(['.xlsx', '.xls', '.ods', '.csv', '.fods']);
    if (calcExts.has(ext)) {
        if (plat === 'linux') {
            exec(`libreoffice --calc ${q(filePath)}`, (err) => {
                if (err) exec(`xdg-open ${q(filePath)}`);
            });
        } else {
            openDefault();
        }
        return;
    }

    // ── Presentations ─────────────────────────────────────────────────────
    const impressExts = new Set(['.pptx', '.ppt', '.odp', '.fodp']);
    if (impressExts.has(ext)) {
        if (plat === 'linux') {
            exec(`libreoffice --impress ${q(filePath)}`, (err) => {
                if (err) exec(`xdg-open ${q(filePath)}`);
            });
        } else {
            openDefault();
        }
        return;
    }

    // ── Images, video, audio, archives, and everything else ──────────────
    openDefault();
}

// ── Close any open file-manager windows before opening a new path ────────────
// Returns a Promise that resolves after the managers have had time to exit.
function closeFileManagers() {
    return new Promise((resolve) => {
        if (process.platform === 'linux') {
            // SIGKILL (-9) cannot be caught or ignored — more reliable than SIGTERM on KDE/Dolphin
            exec('killall -9 dolphin 2>/dev/null; killall -9 dolphin5 2>/dev/null; ' +
                 'killall -9 nautilus 2>/dev/null; killall -9 thunar 2>/dev/null; ' +
                 'killall -9 nemo 2>/dev/null; killall -9 pcmanfm 2>/dev/null; killall -9 spacefm 2>/dev/null',
                () => setTimeout(resolve, 800)); // 800ms: KDE needs a bit more time to fully release
        } else if (process.platform === 'darwin') {
            exec('osascript -e \'tell application "Finder" to close every window\' 2>/dev/null',
                () => setTimeout(resolve, 300));
        } else if (process.platform === 'win32') {
            exec('powershell -NoProfile -Command "' +
                 "(New-Object -ComObject Shell.Application).Windows() | " +
                 "ForEach-Object { $_.Quit() }\"",
                () => setTimeout(resolve, 400));
        } else {
            resolve();
        }
    });
}

// ── Spawn the platform file manager directly (bypasses D-Bus single-instance) ─
// shell.openPath on KDE tells the running Dolphin to open a new TAB — we don't want that.
// Spawning 'dolphin <path>' after killing the old instance always opens a fresh window.
function spawnFileManager(targetPath) {
    const platform = process.platform;
    if (platform === 'linux') {
        // Detect installed file manager; prefer dolphin (KDE), then nautilus, then xdg-open fallback
        exec(`which dolphin 2>/dev/null`, (err, out) => {
            if (out.trim()) {
                exec(`dolphin "${targetPath}" &`);
            } else {
                exec(`which nautilus 2>/dev/null`, (err2, out2) => {
                    if (out2.trim()) exec(`nautilus "${targetPath}" &`);
                    else exec(`xdg-open "${targetPath}" &`);
                });
            }
        });
    } else if (platform === 'darwin') {
        exec(`open "${targetPath}"`);
    } else if (platform === 'win32') {
        exec(`explorer "${targetPath}"`);
    } else {
        shell.openPath(targetPath); // safe fallback for unknown platforms
    }
}

// ── Context tracking: remember the last folder the user opened ───────────────
// Used to prioritise searching inside that directory before going global.
let currentOpenPath = null;

// ── Global folder-open lock (prevents simultaneous multi-window openings) ────
let _folderOpenLock = false;
async function openFolderExclusive(targetPath) {
    if (_folderOpenLock) {
        console.log('🛡️ Folder open already in progress — skipping duplicate:', targetPath);
        return;
    }
    _folderOpenLock = true;
    try {
        await closeFileManagers();   // wait for old windows to fully die (SIGKILL + 800ms)
        spawnFileManager(targetPath); // spawn fresh independent process — no D-Bus tab reuse
        // Track context: if it's a directory, remember it; if it's a file, remember its parent
        try {
            const stat = fs.statSync(targetPath);
            currentOpenPath = stat.isDirectory() ? targetPath : path.dirname(targetPath);
        } catch { currentOpenPath = path.dirname(targetPath); }
        console.log(`📂 Opened: ${targetPath}  (context → ${currentOpenPath})`);
    } finally {
        setTimeout(() => { _folderOpenLock = false; }, 2500); // 2.5s cooldown
    }
}

// ── Levenshtein distance (for fuzzy name matching) ────────────────────────────
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({length: m + 1}, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] :
                1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
    }
    return dp[m][n];
}

// ── Split CamelCase/PascalCase/acronyms into space-separated words ────────────
// "CodingRelated" → "Coding Related"
// "WebARDevelopment" → "Web AR Development"
// "AsosiacionDelComercioCEGK" → "Asosiacion Del Comercio CEGK"
function splitCamelCase(s) {
    return s
        .replace(/([a-z])([A-Z])/g, '$1 $2')           // fooBar → foo Bar
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');    // HTMLParser → HTML Parser
}

// ── Fuzzy search within a specific directory ──────────────────────────────────
// Uses two independent scores and picks the highest:
//   • Word-overlap: fraction of search words that appear (prefix-matched) in the filename words
//   • Levenshtein: character-level similarity on joined tokens
// Filenames have CamelCase split, extension stripped, and timestamps removed before scoring
// so "CodingRelated" → "coding related", "Research_Paper_...944.html" → "research paper..."
//
// minScore: caller can pass a lower threshold for "best effort" fallback matching
function findInDir(searchName, dirPath, minScore = 0.65) {
    if (!dirPath) return null;
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { return null; }
    if (!entries.length) return null;

    // Normalise to space-separated lowercase words, strip all non-alphanumeric
    const normWords = s => s.toLowerCase()
        .replace(/['"`:;,!?()[\]{}]/g, ' ')   // punctuation → space
        .replace(/[-_./\\]+/g, ' ')             // separators → space
        .replace(/\s+/g, ' ')
        .trim();

    // Strip extension + trailing timestamps + split CamelCase from a filename
    const normFile = s => {
        const noExt = s.replace(/\.[^.]+$/, '');          // strip extension
        const camelSplit = splitCamelCase(noExt);          // CodingRelated → Coding Related
        return normWords(camelSplit)
            .replace(/\b\d{6,}\b/g, '')                   // strip 6+ digit number sequences
            .replace(/\s+/g, ' ').trim();
    };

    const searchNormWords = normWords(searchName);
    const searchWords = searchNormWords.split(' ').filter(w => w.length > 1);
    const searchJoined = searchNormWords.replace(/\s+/g, '');

    let best = null, bestScore = 0;

    for (const entry of entries) {
        const fileNormWords = normFile(entry);
        const fileWords = fileNormWords.split(' ').filter(w => w.length > 1);
        const fileJoined = fileNormWords.replace(/\s+/g, '');

        // Score 1 — Word overlap: how many search words appear in the filename
        // Uses prefix matching to handle plurals ("impact" matches "impacts")
        let matchedWords = 0;
        for (const sw of searchWords) {
            if (fileWords.some(fw => fw.startsWith(sw) || sw.startsWith(fw))) matchedWords++;
        }
        const wordScore = searchWords.length > 0 ? matchedWords / searchWords.length : 0;

        // Score 2 — Levenshtein on joined (separator-free) tokens
        const maxLen = Math.max(searchJoined.length, fileJoined.length) || 1;
        const levScore = 1 - levenshtein(searchJoined, fileJoined) / maxLen;

        // Final score: take whichever signal is stronger
        const score = Math.max(wordScore, levScore);

        if (score >= minScore && score > bestScore) {
            bestScore = score;
            best = path.join(dirPath, entry);
        }
    }
    if (best) console.log(`🎯 Context match in "${dirPath}": "${path.basename(best)}" (score=${(bestScore*100).toFixed(0)}%)`);
    return best;
}

// ── Build name variants to bridge speech gaps ─────────────────────────────────
// "ai website cloner" → ["aiwebsitecloner","ai-website-cloner","ai_website_cloner","AiWebsiteCloner",...]
function nameVariants(raw) {
    const clean = raw.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    const words  = clean.split(/\s+/);
    const joined = words.join('');
    const dashed = words.join('-');
    const under  = words.join('_');
    const pascal = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    const camel  = words[0] + words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    // de-duplicate while preserving order
    return [...new Set([clean, joined, dashed, under, pascal, camel])].filter(v => v.length > 1);
}

// ── Cross-platform file/folder search ────────────────────────────────────────
// Phase 1: fuzzy-match inside currentOpenPath (context-aware, handles STT phonetic errors)
// Phase 2: variant-based find/locate across the whole home tree (global fallback)
function findFileOrFolder(name, searchRoot) {
    return new Promise((resolve) => {
        // Sanitise: strip surrounding quotes, colons, semicolons, and collapse whitespace.
        // Gemini sometimes wraps filenames in quotes or adds a colon after a title word.
        const cleanName = name
            .replace(/^["'`]+|["'`]+$/g, '')   // strip leading/trailing quote chars
            .replace(/[:;]/g, ' ')               // colon/semicolons → space
            .replace(/\s+/g, ' ')
            .trim();

        const platform  = process.platform;
        const variants  = nameVariants(cleanName);

        // ── Phase 1: context-aware fuzzy search in the current open directory ─
        if (currentOpenPath) {
            const ctxResult = findInDir(cleanName, currentOpenPath);
            if (ctxResult) return resolve(ctxResult);
        }

        // ── Phase 1b: always check Desktop — research papers, downloads, etc. land here ─
        const desktopPath = app.getPath('desktop');
        if (desktopPath !== currentOpenPath) {
            const desktopResult = findInDir(cleanName, desktopPath);
            if (desktopResult) return resolve(desktopResult);
        }

        // ── Phase 1c: check Downloads as another high-probability location ────
        const downloadsPath = app.getPath('downloads');
        if (downloadsPath !== currentOpenPath) {
            const dlResult = findInDir(cleanName, downloadsPath);
            if (dlResult) return resolve(dlResult);
        }

        // ── Best-effort fallback: re-check current dir with a lower threshold ─
        // Used when global search also finds nothing — prefer "closest thing in sight"
        // over returning null and saying "not found".
        const bestEffortFallback = () => {
            if (currentOpenPath) {
                const soft = findInDir(cleanName, currentOpenPath, 0.40);
                if (soft) { console.log(`🔁 Best-effort match in context dir`); return resolve(soft); }
            }
            const softDesktop = findInDir(cleanName, app.getPath('desktop'), 0.40);
            if (softDesktop) { console.log(`🔁 Best-effort match on Desktop`); return resolve(softDesktop); }
            resolve(null);
        };

        console.log(`🔍 Searching variants: ${variants.join(', ')}`);

        if (platform === 'linux') {
            // Build one locate call per variant (if installed)
            const locateCmds = variants
                .map(v => `locate -i -l 5 -e "*${v}*" 2>/dev/null`)
                .join(' ; ');

            // find: exclude hidden dirs (.cache, .local, .config, node_modules) for clean results
            const findNames = variants.map(v => `-iname "*${v}*"`).join(' -o ');
            const findCmd   = `find "${searchRoot}" -maxdepth 5 ` +
                              `-not -path '*/\\.*' -not -path '*/node_modules/*' ` +
                              `\\( ${findNames} \\) -print 2>/dev/null | head -1`;

            exec(`( ${locateCmds} ) 2>/dev/null | grep -v '/\\.' | head -1`, { timeout: 6000 }, (err, stdout) => {
                const found = (stdout || '').trim().split('\n')[0].trim();
                if (found) return resolve(found);
                // locate not installed or returned nothing — fall back to find
                exec(findCmd, { timeout: 10000 }, (err2, stdout2) => {
                    const result = (stdout2 || '').trim().split('\n')[0].trim();
                    if (result) return resolve(result);
                    bestEffortFallback();
                });
            });

        } else if (platform === 'darwin') {
            const mdfindCmds = variants.map(v => `mdfind -name "${v}" 2>/dev/null`).join(' ; ');
            exec(`( ${mdfindCmds} ) | head -1`, { timeout: 6000 }, (err, stdout) => {
                const result = (stdout || '').trim().split('\n')[0].trim();
                if (result) return resolve(result);
                bestEffortFallback();
            });

        } else if (platform === 'win32') {
            const filters = variants.map(v => `"*${v}*"`).join(',');
            const cmd = `powershell -NoProfile -Command "` +
                `@(${filters}) | ForEach-Object { ` +
                `Get-ChildItem -Path '${searchRoot}' -Recurse -Filter $_ -EA SilentlyContinue | ` +
                `Select-Object -First 1 -ExpandProperty FullName } | Select-Object -First 1"`;
            exec(cmd, { timeout: 12000 }, (err, stdout) => {
                const result = (stdout || '').trim();
                if (result) return resolve(result);
                bestEffortFallback();
            });

        } else {
            bestEffortFallback();
        }
    });
}

// IPC surface: renderer can ask the main process to find & open a file/folder by name
ipcMain.handle('find-and-open-file', async (event, name) => {
    const homeDir = app.getPath('home');
    console.log(`🔍 find-and-open-file: "${name}"`);
    const result = await findFileOrFolder(name, homeDir);
    if (result) {
        openFileByExtension(result);   // Routes by extension: html→browser, code→vscode, etc.
        return { opened: path.basename(result), fullPath: result };
    }
    return { error: `Could not find "${name}" on this system.` };
});

ipcMain.handle('generate-research-paper', async (event, topic) => {
    console.log(`📄 Research paper requested for topic: "${topic}"`);
    generateResearchPaper(topic, mainWindow);
    return { started: true };
});

// ── Google Auth IPC ────────────────────────────────────────────────────────

ipcMain.handle('google-auth-status', async () => {
    return { authenticated: googleAuth.isAuthenticated() };
});

ipcMain.handle('google-auth-revoke', async () => {
    const ok = await googleAuth.revokeAccess();
    return { success: ok };
});

// ── Gmail IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('gmail-status', async () => {
    return { authenticated: googleAuth.isAuthenticated() };
});

ipcMain.handle('gmail-authenticate', async () => {
    if (googleAuth.isAuthenticated()) return 'already_authenticated';
    try {
        const { getAuthClient } = require('./google_auth');
        await getAuthClient();
        return 'authenticated';
    } catch (e) {
        console.error('[IPC] gmail-authenticate error:', e.message);
        return { error: e.message };
    }
});

ipcMain.handle('gmail-send', async (event, { to, subject, body }) => {
    try {
        const { sendEmail } = require('./gmail');
        return await sendEmail({ to, subject, body });
    } catch (e) {
        console.error('[IPC] gmail-send error:', e.message);
        return { success: false, error: e.message };
    }
});

// ── Calendar IPC ───────────────────────────────────────────────────────────

ipcMain.handle('calendar-status', async () => {
    return { authenticated: googleAuth.isAuthenticated() };
});

ipcMain.handle('calendar-get-events', async (event, { startDate, endDate }) => {
    try {
        const { getEventsInRange } = require('./calendar');
        return await getEventsInRange(startDate, endDate);
    } catch (e) {
        console.error('[IPC] calendar-get-events error:', e.message);
        return { error: e.message };
    }
});

ipcMain.handle('calendar-create-event', async (event, { title, startTime, endTime, attendees }) => {
    try {
        const { createEvent } = require('./calendar');
        return await createEvent({ title, startTime, endTime, attendees });
    } catch (e) {
        console.error('[IPC] calendar-create-event error:', e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('calendar-delete-event', async (event, { eventId }) => {
    try {
        const { deleteEvent } = require('./calendar');
        return await deleteEvent(eventId);
    } catch (e) {
        console.error('[IPC] calendar-delete-event error:', e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('analyze-screen', async (event, question) => {
    return await analyzeScreen(question);
});

// ── Project Type Auto-Detector ────────────────────────────────────────────
// Inspects a project folder and returns the code_agent project_type string,
// or null if detection fails. Used when the user opens an existing project.
function detectProjectType(projectPath) {
    const p = require('path');
    const pkgFile    = p.join(projectPath, 'package.json');
    const reqFile    = p.join(projectPath, 'requirements.txt');
    const mainPy     = p.join(projectPath, 'main.py');
    const manifestF  = p.join(projectPath, 'manifest.json');
    const frontendD  = p.join(projectPath, 'frontend');
    const backendD   = p.join(projectPath, 'backend');
    const indexHtml  = p.join(projectPath, 'index.html');
    const binDir     = p.join(projectPath, 'bin');

    try {
        // Fullstack: has both frontend/ and backend/ dirs
        if (fs.existsSync(frontendD) && fs.existsSync(backendD)) return 'fullstack';

        // Chrome extension: has manifest.json with manifest_version
        if (fs.existsSync(manifestF)) {
            try {
                const m = JSON.parse(fs.readFileSync(manifestF, 'utf8'));
                if (m.manifest_version) return 'extension';
            } catch (_) {}
        }

        // Python: has requirements.txt or main.py
        if (fs.existsSync(reqFile) || fs.existsSync(mainPy)) return 'python';

        // Node-based: read package.json
        if (fs.existsSync(pkgFile)) {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            // CLI: has bin/ directory or "bin" field in package.json
            if (fs.existsSync(binDir) || pkg.bin) return 'cli';

            // React: depends on react
            if (deps['react'] || deps['@vitejs/plugin-react']) return 'react';

            // Express API: depends on express but not react
            if (deps['express']) return 'api_only';

            // Fallback Node project: has dev/start script → treat as api_only
            if (pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) return 'api_only';
        }

        // Static site: has index.html but no package.json
        if (fs.existsSync(indexHtml)) return 'static_website';

    } catch (_) {}

    return null;
}

// ── Terminal / Project Info Demo Page ─────────────────────────────────────
// Shown in Nova's internal browser for project types that have no web server
// (CLI, Chrome extension, Python-without-port) and for existing projects
// where no server could be started.
function buildTerminalDemoHtml(projectName, projectType, projectPath) {
    const path = require('path');

    // Detect commands from project files
    let installCmd = '', runCmd = '', extraLines = [];
    const pkgPath = path.join(projectPath, 'package.json');
    const reqPath = path.join(projectPath, 'requirements.txt');

    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            installCmd = 'npm install';
            if (pkg.scripts) {
                runCmd = pkg.scripts.dev  ? 'npm run dev'
                       : pkg.scripts.start ? 'npm start'
                       : pkg.scripts.build ? 'npm run build'
                       : 'npm start';
            }
            if (projectType === 'cli' && pkg.bin) {
                const binName = Object.keys(pkg.bin)[0] || projectName.toLowerCase();
                runCmd = `node bin/index.js --help`;
                extraLines = [
                    `$ node bin/index.js --help`,
                    ``,
                    `  ${projectName} CLI v1.0.0`,
                    ``,
                    `  Usage: ${binName} [command] [options]`,
                    ``,
                    `  Options:`,
                    `    -h, --help     Show help`,
                    `    -V, --version  Show version`,
                    ``,
                    `  Commands:`,
                    `    run [options]  Run the main action`,
                    `    list           List available items`,
                    ``,
                ];
            }
        } catch (_) {}
    } else if (fs.existsSync(reqPath)) {
        installCmd = 'pip install -r requirements.txt';
        runCmd     = 'python main.py';
        extraLines = [
            `$ python main.py`,
            ``,
            `  ${projectName} — Python 3.11+`,
            `  Running...`,
            ``,
            `  ✓ Initialized`,
            `  ✓ Processing`,
            `  Done.`,
        ];
    }

    if (projectType === 'extension') {
        installCmd = '— no install needed —';
        runCmd     = '';
        extraLines = [
            `  How to load your extension in Chrome:`,
            ``,
            `  1. Open Chrome and go to:`,
            `     chrome://extensions`,
            ``,
            `  2. Enable "Developer mode" (top-right toggle)`,
            ``,
            `  3. Click "Load unpacked"`,
            ``,
            `  4. Select the project folder:`,
            `     ${projectPath}`,
            ``,
            `  ✓ Extension will appear in your toolbar`,
        ];
    }

    const steps = [
        installCmd ? { label: 'Install', cmd: installCmd } : null,
        runCmd     ? { label: 'Run',     cmd: runCmd }     : null,
    ].filter(Boolean);

    const stepsHtml = steps.map(s => `
        <div class="step">
          <div class="step-label">${s.label}</div>
          <div class="step-cmd">
            <code>${s.cmd}</code>
            <button class="copy-btn" onclick="copy(this,'${s.cmd.replace(/'/g,"\\'")}')">Copy</button>
          </div>
        </div>`).join('');

    const termLines = extraLines.length ? extraLines : [
        `$ ${runCmd || 'Run the project using the command above'}`,
        ``,
        `  ${projectName} — ready.`,
    ];
    const termHtml = termLines.map(l =>
        `<div class="tl">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`
    ).join('');

    const typeLabel = {
        cli:'CLI Tool', extension:'Chrome Extension', python:'Python Project',
        static_website:'Static Website', react:'React App',
        api_only:'REST API', fullstack:'Full-Stack App',
    }[projectType] || 'Project';

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${projectName} — Nova Preview</title>
<style>
:root{--bg:#080810;--surface:#0e0e1c;--border:rgba(255,255,255,0.07);--accent:#6366f1;--cyan:#06b6d4;--green:#10b981;--text:#f1f5f9;--text-2:#94a3b8;--muted:#475569}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.6 'Inter',system-ui,sans-serif;min-height:100vh;padding:32px 24px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.badge{background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);color:var(--accent);font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:0.5px;text-transform:uppercase}
h1{font-size:1.5rem;font-weight:700;letter-spacing:-0.02em}
.subtitle{color:var(--text-2);font-size:13px;margin-top:2px}
.dot{width:10px;height:10px;background:var(--green);border-radius:50%;box-shadow:0 0 10px var(--green);flex-shrink:0}
.steps{display:flex;flex-direction:column;gap:12px;margin-bottom:28px}
.step{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px}
.step-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.step-cmd{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:13px;color:var(--cyan);flex:1;word-break:break-all}
.copy-btn{background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.25);color:var(--cyan);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;transition:all 0.15s;flex-shrink:0}
.copy-btn:hover{background:rgba(6,182,212,0.18);border-color:rgba(6,182,212,0.5)}
.term-label{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.terminal{background:#030308;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:20px 22px;font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:12.5px;line-height:1.75;color:#a8d8b0;overflow-x:auto}
.terminal .tl:first-child{color:#6ee7b7;font-weight:600}
.term-bar{display:flex;gap:6px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.05)}
.tb{width:11px;height:11px;border-radius:50%}
.tb.r{background:#ef4444}.tb.y{background:#f59e0b}.tb.g{background:#10b981}
.footer{margin-top:28px;color:var(--muted);font-size:11px;letter-spacing:0.3px;text-align:center}
</style></head><body>
<div class="header">
  <div class="dot"></div>
  <div>
    <h1>${projectName}</h1>
    <div class="subtitle">Generated by Nova Code Engine</div>
  </div>
  <div class="badge">${typeLabel}</div>
</div>

${stepsHtml ? `<div class="steps">${stepsHtml}</div>` : ''}

<div class="term-label">Terminal Preview</div>
<div class="terminal">
  <div class="term-bar"><div class="tb r"></div><div class="tb y"></div><div class="tb g"></div></div>
  ${termHtml}
</div>

<div class="footer">Nova AI · Code Agent · ${new Date().toLocaleDateString()}</div>

<script>
function copy(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.style.color = '#10b981';
    btn.style.borderColor = 'rgba(16,185,129,0.5)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 1500);
  });
}
</script>
</body></html>`;
}

// ── Code Agent Tool Handler ────────────────────────────────────────────────
// Orchestrates the full coding session: project creation, generation, preview,
// modification, and teardown.  Called by Automation.codeAgentTool from live.js.
async function handleCodeAgentTool(args, logFn) {
    const log = logFn || console.log;
    const { action, project_name, project_type, description, instruction } = args;

    // Helper: open/navigate Nova's browser to a local URL without going
    // through the search fallback (openBrowser treats localhost as a query).
    const openCodePreview = (url) => {
        if (!browserWin) {
            createBrowserWindow();
            // browser-ready handler will send pendingBrowserUrl
            pendingBrowserUrl = url;
        } else {
            if (isBrowserReady) browserWin.webContents.send('navigate', url);
            else pendingBrowserUrl = url;
        }
        setBrowserOpen(true);
    };

    try {
        switch (action) {

            // ── start_session ──────────────────────────────────────────────
            case 'start_session': {
                const projects = codeAgent.listDesktopProjects();
                codeAgent.setActive(true);
                const list = projects.length
                    ? `I found ${projects.length} project${projects.length > 1 ? 's' : ''} on your Desktop: ${projects.slice(0, 6).join(', ')}${projects.length > 6 ? '…' : ''}.`
                    : 'Your Desktop has no project folders yet.';
                return {
                    status: 'ready',
                    speak: `Nova Code Agent activated. ${list} What project would you like to work on? Give me a name and I'll create it or open an existing one.`,
                    projects,
                };
            }

            // ── list_projects ──────────────────────────────────────────────
            case 'list_projects': {
                const projects = codeAgent.listDesktopProjects();
                return {
                    status: 'ok',
                    speak: projects.length
                        ? `Here are the projects on your Desktop: ${projects.join(', ')}. Which one would you like to open, or shall I create something new?`
                        : 'No project folders found on your Desktop. Tell me a name and I\'ll create one.',
                    projects,
                };
            }

            // ── create_project ─────────────────────────────────────────────
            case 'create_project': {
                if (!project_name) return { status: 'needs_info', speak: 'What would you like to name the project?' };

                const projects = codeAgent.listDesktopProjects();
                const match    = codeAgent.fuzzyMatchProject(project_name, projects);

                if (match && match.score >= 80) {
                    const existingPath = require('path').join(codeAgent.getDesktopPath(), match.name);
                    codeAgent.setProject(match.name, null, existingPath);
                    await codeAgent.openInVSCode(existingPath, log);
                    return {
                        status: 'opened_existing',
                        speak: `Found "${match.name}" on your Desktop — I've opened it in VS Code. What type of project is this, and what would you like to build or change?`,
                        projectPath: existingPath,
                    };
                }

                const projectPath = codeAgent.createProjectFolder(project_name);
                await codeAgent.openInVSCode(projectPath, log);
                return {
                    status: 'created',
                    speak: `Created "${require('path').basename(projectPath)}" on your Desktop and opened VS Code. What type of project is this? Say: website, React app, API, full-stack, CLI tool, Chrome extension, or Python.`,
                    projectPath,
                };
            }

            // ── open_project ───────────────────────────────────────────────
            case 'open_project': {
                if (!project_name) return { status: 'needs_info', speak: 'Which project would you like to open?' };

                const projects = codeAgent.listDesktopProjects();
                const match    = codeAgent.fuzzyMatchProject(project_name, projects);
                if (!match) {
                    return {
                        status: 'not_found',
                        speak: `I couldn't find "${project_name}" on your Desktop. ${projects.length ? 'Available: ' + projects.join(', ') + '.' : 'No projects found.'} Want to create a new one?`,
                    };
                }

                const existingPath = require('path').join(codeAgent.getDesktopPath(), match.name);
                const detectedType = detectProjectType(existingPath);
                codeAgent.setProject(match.name, detectedType, existingPath);
                await codeAgent.openInVSCode(existingPath, log);
                const typeLabel = { static_website:'static website', react:'React app', api_only:'API',
                    fullstack:'full-stack app', cli:'CLI tool', extension:'Chrome extension', python:'Python project' };
                const typeHint = detectedType ? ` Detected type: ${typeLabel[detectedType] || detectedType}.` : '';
                return {
                    status: 'opened',
                    speak: `Opened "${match.name}" in VS Code.${typeHint} What would you like to do with this project?`,
                    projectPath: existingPath,
                };
            }

            // ── generate_code ──────────────────────────────────────────────
            case 'generate_code': {
                const state = codeAgent.getState();
                if (!state.projectPath) return { status: 'needs_project', speak: 'Tell me the project name first and I\'ll create it.' };
                if (!project_type)      return { status: 'needs_type', speak: 'What type of project — website, React app, API, full-stack, CLI, Chrome extension, or Python?' };

                const projDesc = description || `A professional ${project_type} project named ${state.projectName}`;

                log(`⚙️ Generating "${state.projectName}" (${project_type})…`);

                // Generate
                const generated = await codeAgent.generateCode(state.projectName, project_type, projDesc, log);
                codeAgent.setProject(state.projectName, project_type, state.projectPath);
                codeAgent.writeProjectFiles(generated.files || [], log);
                codeAgent.setEndpoints(generated.endpoints || []);

                // Install dependencies
                const needsNpm = ['react', 'api_only', 'fullstack', 'cli'].includes(project_type);
                if (needsNpm && (generated.installCommand || '').includes('npm')) {
                    log('📦 Installing dependencies…');
                    if (project_type === 'fullstack') {
                        const pFront = require('path').join(state.projectPath, 'frontend');
                        const pBack  = require('path').join(state.projectPath, 'backend');
                        if (fs.existsSync(pFront)) await codeAgent.installDependencies(pFront, log);
                        if (fs.existsSync(pBack))  await codeAgent.installDependencies(pBack,  log);
                    } else {
                        await codeAgent.installDependencies(state.projectPath, log);
                    }
                }
                if (project_type === 'python' && (generated.installCommand || '').includes('pip')) {
                    exec(`pip install -r requirements.txt`, { cwd: state.projectPath }, () => {});
                }

                // Start server (skip for CLI / extension / bare python with no web)
                const noServer = project_type === 'cli' || project_type === 'extension'
                    || (project_type === 'python' && !generated.port);
                let serverResult = { success: false, port: generated.port };

                if (!noServer) {
                    serverResult = await codeAgent.startDevServer(
                        project_type, generated.devCommand, generated.port || null, log
                    );
                }

                // Open browser preview
                if (!noServer && serverResult.success) {
                    // React/Vite: port opens before the first compile finishes — wait for bundle
                    if (project_type === 'react' || project_type === 'fullstack') {
                        await new Promise(r => setTimeout(r, 3500));
                    }
                    if (project_type === 'api_only') {
                        const html     = codeAgent.buildApiPreviewHtml(generated.endpoints || [], serverResult.port || generated.port);
                        const prevPath = require('path').join(state.projectPath, '.nova_api_preview.html');
                        fs.writeFileSync(prevPath, html, 'utf8');
                        openCodePreview(`file://${prevPath}`);
                    } else {
                        openCodePreview(`http://localhost:${serverResult.port}`);
                    }
                } else if (project_type === 'fullstack' && serverResult.apiPort) {
                    // Show API explorer for full-stack even if frontend not ready
                    const html     = codeAgent.buildApiPreviewHtml(generated.endpoints || [], serverResult.apiPort);
                    const prevPath = require('path').join(state.projectPath, '.nova_api_preview.html');
                    fs.writeFileSync(prevPath, html, 'utf8');
                    openCodePreview(`file://${prevPath}`);
                } else if (noServer) {
                    // CLI / extension / python-no-port: show a terminal demo page instead
                    const demoHtml = buildTerminalDemoHtml(state.projectName, project_type, state.projectPath);
                    const demoPath = require('path').join(state.projectPath, '.nova_demo.html');
                    fs.writeFileSync(demoPath, demoHtml, 'utf8');
                    openCodePreview(`file://${demoPath}`);
                }

                const typeLabel = { static_website:'website', react:'React app', api_only:'REST API',
                    fullstack:'full-stack app', cli:'CLI tool', extension:'Chrome extension', python:'Python project' };
                const filesN = (generated.files || []).length;

                return {
                    status: 'success',
                    speak: noServer
                        ? `Your ${typeLabel[project_type]} "${state.projectName}" is ready — ${filesN} files generated. I've opened the project info in my browser. What would you like to add or change?`
                        : project_type === 'api_only'
                        ? `Your REST API "${state.projectName}" is live! I've opened the API Explorer — ${(generated.endpoints||[]).length} endpoints ready to test. What would you like to add?`
                        : `Your ${typeLabel[project_type]} "${state.projectName}" is running! ${filesN} files generated. I've opened the preview in my browser. What should we change or add?`,
                    filesGenerated: filesN,
                    port: serverResult.port,
                };
            }

            // ── modify_code ────────────────────────────────────────────────
            case 'modify_code': {
                const state = codeAgent.getState();
                if (!state.projectPath) return { status: 'needs_project', speak: 'No active project. Say "start coding" to begin.' };
                if (!instruction)       return { status: 'needs_info', speak: 'What changes would you like me to make?' };

                const result = await codeAgent.modifyCode(instruction, log);
                const modifiedFiles = (result.changes || []).length;

                // ── Always show a preview after modifications ──────────────
                // If project type wasn't set (e.g. opened via open_project without detection),
                // try to detect it from the filesystem now.
                const effectiveType = state.projectType || detectProjectType(state.projectPath);
                if (effectiveType && !state.projectType) {
                    codeAgent.setProject(state.projectName, effectiveType, state.projectPath);
                }

                const isNoServerType = effectiveType === 'cli'
                    || effectiveType === 'extension'
                    || (effectiveType === 'python' && !state.serverPort);

                if (isNoServerType) {
                    // CLI / extension / Python: refresh (or open) the terminal demo page
                    const demoHtml = buildTerminalDemoHtml(state.projectName, effectiveType, state.projectPath);
                    const demoPath = require('path').join(state.projectPath, '.nova_demo.html');
                    fs.writeFileSync(demoPath, demoHtml, 'utf8');
                    openCodePreview(`file://${demoPath}`);

                } else if (state.serverPort) {
                    // Server is running — wait for hot-reload then refresh/open the browser
                    await new Promise(r => setTimeout(r, 2000));
                    if (effectiveType === 'api_only') {
                        const html     = codeAgent.buildApiPreviewHtml(codeAgent.getEndpoints(), state.apiPort || state.serverPort);
                        const prevPath = require('path').join(state.projectPath, '.nova_api_preview.html');
                        fs.writeFileSync(prevPath, html, 'utf8');
                        if (browserWin && isBrowserReady) {
                            browserWin.webContents.send('navigate', `file://${prevPath}`);
                        } else {
                            openCodePreview(`file://${prevPath}`);
                        }
                    } else {
                        const url = `http://localhost:${state.serverPort}`;
                        if (browserWin && isBrowserReady) {
                            browserWin.webContents.send('navigate', url);
                        } else {
                            openCodePreview(url);
                        }
                    }

                } else if (effectiveType) {
                    // Known project type but no server yet (e.g. opened existing project).
                    // Try to start the dev server, then open preview.
                    log(`🚀 [modify_code] No server running — starting ${effectiveType} preview server...`);
                    try {
                        const portMap = { react:5173, api_only:3001, fullstack:5173, python:8000, static_website:8080 };
                        const port    = portMap[effectiveType] || 8080;

                        // Detect devCommand from package.json
                        const pkgPath = require('path').join(state.projectPath, 'package.json');
                        let devCmd = effectiveType === 'static_website' ? null : 'npm run dev';
                        if (fs.existsSync(pkgPath)) {
                            try {
                                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                                devCmd = pkg.scripts && pkg.scripts.dev   ? 'npm run dev'
                                       : pkg.scripts && pkg.scripts.start ? 'npm start'
                                       : devCmd;
                            } catch (_) {}
                        }

                        const serverResult = await codeAgent.startDevServer(effectiveType, devCmd, port, log);
                        if (serverResult.success) {
                            // Extra settle time: React/Vite needs time after port opens to finish first compile
                            const compileWait = (effectiveType === 'react' || effectiveType === 'fullstack') ? 3000 : 800;
                            await new Promise(r => setTimeout(r, compileWait));
                            if (effectiveType === 'api_only') {
                                const html = codeAgent.buildApiPreviewHtml(codeAgent.getEndpoints(), serverResult.port);
                                const prevPath = require('path').join(state.projectPath, '.nova_api_preview.html');
                                fs.writeFileSync(prevPath, html, 'utf8');
                                openCodePreview(`file://${prevPath}`);
                            } else {
                                openCodePreview(`http://localhost:${serverResult.port}`);
                            }
                        } else {
                            // Server failed to start — show terminal demo as fallback
                            const demoHtml = buildTerminalDemoHtml(state.projectName, effectiveType, state.projectPath);
                            const demoPath = require('path').join(state.projectPath, '.nova_demo.html');
                            fs.writeFileSync(demoPath, demoHtml, 'utf8');
                            openCodePreview(`file://${demoPath}`);
                        }
                    } catch (e) {
                        log(`⚠️ [modify_code] Preview server failed: ${e.message}`);
                    }
                }

                return {
                    status: 'success',
                    speak: `Done! ${result.summary || 'Changes applied'} — ${modifiedFiles} file${modifiedFiles !== 1 ? 's' : ''} updated. How does it look? What else should we change?`,
                };
            }

            // ── preview_project ────────────────────────────────────────────
            case 'preview_project': {
                const state = codeAgent.getState();
                if (!state.projectPath) return { status: 'needs_project', speak: 'No active project to preview.' };

                const pvType = state.projectType || detectProjectType(state.projectPath);
                if (pvType && !state.projectType) codeAgent.setProject(state.projectName, pvType, state.projectPath);

                // CLI / extension / python: show terminal demo page
                if (pvType === 'cli' || pvType === 'extension' || pvType === 'python') {
                    const demoHtml = buildTerminalDemoHtml(state.projectName, pvType, state.projectPath);
                    const demoPath = require('path').join(state.projectPath, '.nova_demo.html');
                    fs.writeFileSync(demoPath, demoHtml, 'utf8');
                    openCodePreview(`file://${demoPath}`);
                    return { status: 'ok', speak: `Opening the project overview for "${state.projectName}".` };
                }

                // API: show API Explorer
                if (pvType === 'api_only' || (pvType === 'fullstack' && state.apiPort)) {
                    const prevPath = require('path').join(state.projectPath, '.nova_api_preview.html');
                    if (fs.existsSync(prevPath)) {
                        openCodePreview(`file://${prevPath}`);
                        return { status: 'ok', speak: 'Opening the API Explorer.' };
                    }
                }

                // Web server: start if not running, then open browser
                if (!state.serverPort && pvType) {
                    log('🚀 [preview_project] Starting server for preview...');
                    const portMap = { react:5173, api_only:3001, fullstack:5173, static_website:8080 };
                    const port = portMap[pvType] || 8080;
                    const pkgPath = require('path').join(state.projectPath, 'package.json');
                    let devCmd = pvType === 'static_website' ? null : 'npm run dev';
                    if (fs.existsSync(pkgPath)) {
                        try {
                            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                            devCmd = pkg.scripts && pkg.scripts.dev   ? 'npm run dev'
                                   : pkg.scripts && pkg.scripts.start ? 'npm start'
                                   : devCmd;
                        } catch (_) {}
                    }
                    const sr = await codeAgent.startDevServer(pvType, devCmd, port, log);
                    if (sr.success) {
                        if (pvType === 'react' || pvType === 'fullstack') await new Promise(r => setTimeout(r, 3500));
                        openCodePreview(`http://localhost:${sr.port}`);
                        return { status: 'ok', speak: `Server started — opening preview at localhost:${sr.port}.` };
                    }
                }

                const url = `http://localhost:${state.serverPort || 8080}`;
                openCodePreview(url);
                return { status: 'ok', speak: `Opening preview at localhost:${state.serverPort || 8080}.` };
            }

            // ── end_session ────────────────────────────────────────────────
            case 'end_session': {
                const name = codeAgent.getState().projectName || 'the project';
                closeBrowser();
                codeAgent.endSession();
                return {
                    status: 'ended',
                    speak: `Coding session for "${name}" wrapped up. VS Code, servers, and the preview are all closed. Let me know what else you need!`,
                };
            }

            default:
                return { status: 'unknown', speak: `Unknown code agent action: ${action}` };
        }
    } catch (e) {
        console.error('[Code Agent] Tool error:', e.message, e.stack);
        return { status: 'error', speak: `Something went wrong in the code agent: ${e.message}` };
    }
}

// ── Macro Storage Helpers ──────────────────────────────────────────────────

const MACROS_FILE = path.join(__dirname, 'macros', 'macros.json');

function loadMacros() {
    try {
        if (!fs.existsSync(MACROS_FILE)) return {};
        return JSON.parse(fs.readFileSync(MACROS_FILE, 'utf8'));
    } catch (e) {
        console.error('[Macro] Failed to load macros.json:', e.message);
        return {};
    }
}

function saveMacro(name, steps) {
    const key = name.toLowerCase().replace(/\s+/g, '_');
    const macros = loadMacros();
    macros[key] = {
        name,
        created: new Date().toISOString(),
        steps: steps.map((s, i) => ({ ...s, id: i + 1 })),
    };
    fs.writeFileSync(MACROS_FILE, JSON.stringify(macros, null, 2), 'utf8');
    if (mainWindow) {
        mainWindow.webContents.send('automation-log', `💾 Macro saved: ${name} (${steps.length} steps)`);
    }
    console.log(`[Macro] Saved "${name}" (${steps.length} steps) → key: ${key}`);
    return key;
}

// ── Macro Replay ───────────────────────────────────────────────────────────

async function executeStep(step) {
    if (step.tool === 'execute_system_command') {
        await executeAutomationInternal(step.args.command);
    } else if (step.tool === 'control_browser') {
        const { action, query, direction, target_text, element_id } = step.args;
        if (action === 'open' && query) {
            Automation.openBrowser(query);
        } else if (action === 'scroll' && direction) {
            Automation.scrollBrowser(direction);
        } else if (action === 'smart_click' && target_text) {
            Automation.smartClickBrowser(target_text);
        } else if (action === 'click_id' && element_id) {
            Automation.clickBrowserId(element_id);
        } else if (action === 'close') {
            Automation.closeBrowser();
        }
    } else if (step.tool === 'show_stock_chart') {
        await showStockChartInternal(step.args.company, step.args.symbol || '');
    } else if (step.tool === 'calendar_action') {
        const { handleCalendarActionTool: calTool } = require('./calendar');
        const logFn = (msg) => {
            if (mainWindow) mainWindow.webContents.send('automation-log', msg);
        };
        await calTool(step.args, logFn);
    }
}

async function replayMacro(macroName) {
    const key = macroName.toLowerCase().replace(/\s+/g, '_');
    const macros = loadMacros();
    const macro = macros[key];

    if (!macro) {
        return { success: false, speak: `I don't have a routine called ${macroName}.` };
    }

    const steps = macro.steps || [];
    const log = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('automation-log', msg);
        }
        console.log('[Macro]', msg);
    };

    log(`▶️ Running "${macro.name}" (${steps.length} steps)`);

    for (const step of steps) {
        try {
            // Pre-check: skip focus-app if already frontmost (macOS only)
            if (
                process.platform === 'darwin' &&
                step.tool === 'execute_system_command' &&
                step.args.command && step.args.command.startsWith('focus-app ')
            ) {
                const appArg = step.args.command.replace('focus-app ', '').trim();
                try {
                    const { execSync } = require('child_process');
                    const front = execSync(
                        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
                        { timeout: 2000 }
                    ).toString().trim().toLowerCase();
                    if (front.includes(appArg.toLowerCase())) {
                        log(`⏩ Already frontmost — skipping: ${step.intent}`);
                        continue;
                    }
                } catch (_) { /* osascript unavailable — execute the step anyway */ }
            }

            log(`⚙️ Step: ${step.intent}`);
            await executeStep(step);

            // Give browser steps extra time to load
            const pauseMs = step.tool === 'control_browser' ? 1400 : 900;
            await new Promise(r => setTimeout(r, pauseMs));
        } catch (err) {
            log(`⚠️ Skipped: ${step.intent} — ${err.message}`);
            console.warn(`[Macro] Step skipped: ${step.intent} —`, err.message);
            // Never abort the whole macro on a single failure
        }
    }

    const doneMsg = `Done. Your ${macro.name} routine is complete.`;
    log(`✅ ${doneMsg}`);
    return { success: true, speak: doneMsg };
}

// ── Screen Vision Analysis ─────────────────────────────────────────────────

const { GoogleGenAI: _GenAI } = require('@google/genai');
const _screenAI = new _GenAI({ apiKey: process.env.GEMINI_API_KEY });

async function analyzeScreen(question = 'What is currently on the screen?') {
    try {
        const { desktopCapturer } = require('electron');
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 },
        });
        if (!sources || sources.length === 0) {
            return "I couldn't capture the screen right now.";
        }
        const png = sources[0].thumbnail.toPNG();
        const base64Image = png.toString('base64');

        const response = await _screenAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'image/png', data: base64Image } },
                    {
                        text: question +
                            ' Be concise — 2 to 4 sentences max unless the user asked for something detailed.' +
                            ' Speak naturally as if describing it to someone who cannot see the screen.'
                    }
                ]
            }]
        });

        return response.text;
    } catch (e) {
        console.error('[analyzeScreen] Error:', e.message);
        return "I had trouble analyzing the screen. Try again.";
    }
}

app.whenReady().then(() => {
    // Wire shell.openExternal into Google OAuth so consent flows open in the default browser
    googleAuth.initialize((url) => shell.openExternal(url));
    console.log(`[Nova] Google Auth status: ${googleAuth.isAuthenticated() ? '✅ authenticated' : '⚠️  not authenticated (run npm run setup-google)'}`);

    // Ensure macros/ directory exists
    const macrosDir = path.join(__dirname, 'macros');
    if (!fs.existsSync(macrosDir)) {
        fs.mkdirSync(macrosDir, { recursive: true });
        console.log('[Macro] Created macros/ directory');
    }

    const { session } = require('electron');
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));

    protocol.handle('appassets', (request) => {
        const url = request.url.replace(/^appassets:\/\//, '');
        let decodedUrl = '';
        try { decodedUrl = decodeURI(url); } catch (e) { decodedUrl = url; }

        // Remove query string or trailing slashes (Vosk engine appends trailing slashes)
        decodedUrl = decodedUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
        const absolutePath = path.join(__dirname, decodedUrl);

        try {
            const fs = require('fs');
            console.log('[Protocol] Fetching:', absolutePath);
            const data = fs.readFileSync(absolutePath);
            let contentType = 'application/octet-stream';
            if (absolutePath.endsWith('.gltf')) contentType = 'application/json';
            else if (absolutePath.endsWith('.wav')) contentType = 'audio/wav';
            else if (absolutePath.endsWith('.mp3')) contentType = 'audio/mpeg';
            else if (absolutePath.endsWith('.jpeg') || absolutePath.endsWith('.jpg')) contentType = 'image/jpeg';
            else if (absolutePath.endsWith('.png')) contentType = 'image/png';

            // Content-Length and Accept-Ranges are required for Chromium's
            // media pipeline to accept the response for HTML5 Audio playback.
            return new Response(data, {
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': String(data.length),
                    'Accept-Ranges': 'bytes',
                }
            });
        } catch (err) {
            console.error('AppAssets error reading:', absolutePath, err);
            return new Response('Not Found', { status: 404 });
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
