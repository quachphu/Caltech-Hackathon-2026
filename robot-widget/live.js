require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');
const { ipcMain } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Video folder helpers (used by video editor ack) ────────────────────────
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v'];
function getSystemVideosDir() {
    return process.platform === 'darwin' ? path.join(os.homedir(), 'Movies') : path.join(os.homedir(), 'Videos');
}
function scanVideoFiles() {
    const dir = getSystemVideosDir();
    try { return fs.readdirSync(dir).filter(f => VIDEO_EXTS.some(e => f.toLowerCase().endsWith(e))); }
    catch { return []; }
}
function scanOspProjects() {
    const dir = getSystemVideosDir();
    try { return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.osp')).map(f => f.replace(/\.osp$/i, '')); }
    catch { return []; }
}

let activeSession = null;
let mainWindowRef = null;
let automationRef = null;
const lastExecCommandMap = new Map(); // cmdKey → last call timestamp
const EXEC_COOLDOWN_MS = 15000; // Per-command cooldown: 15 seconds
let _browserIsOpen = false;          // True only after Nova explicitly opened the browser this session
let _lastBrowserActionAt = 0;        // Timestamp of last open/scroll/close action (debounce spam)
let _lastSmartClickAt = 0;           // Separate clock for smart_click — must not be gated by 'open'
let _lastOpenAt = 0;                 // When the last 'open' fired — smart_click waits if too recent
let _lastOpenedQuery = '';           // Last opened query — blocks re-opening the same URL within 8s
let _lastExplicitCloseAt = 0;        // When the user last explicitly said "close browser"
const POST_CLOSE_LOCKOUT_MS = 10000; // Block any open/search for 10s after explicit close
let _storeAssistantActive = false;   // True while user is on a known store — tells smart_click to follow up with get_browser_state
let _lastAutoScanAt = 0;             // Timestamp of last auto-scan inject — blocks redundant get_browser_state calls
let _lastGetBrowserStateAt = 0;      // Cooldown for get_browser_state calls to stop looping
let _lastAutoScanUrl = '';           // URL seen in the most recent auto-scan — for stuck-navigation detection
let _stuckClickCount = 0;            // How many consecutive auto-scans landed on the same URL after smart_click
let _lastSmartClickTarget = '';      // target_text of the most recent smart_click — used in fallback message
const _calendarDebounce = new Map(); // calKey → last-call timestamp, prevents Gemini from looping tool calls
const CALENDAR_DEBOUNCE_MS = 12000;  // Ignore duplicate calendar calls within 12s
let _emailInFlight = false;          // Mutex: only one email flow at a time — blocks Gemini's tendency to loop send_email
let _emailLastCompletedAt = 0;       // Timestamp when last email flow finished — enforces a cooldown
let _emailModeActive = false;        // True while user is in email mode (contacts panel open, post-send loop)
let _listContactsLastAt = 0;         // Timestamp of last list_contacts call — prevents looping
const LIST_CONTACTS_COOLDOWN_MS = 30000; // Block repeat list_contacts calls within 30s
const _codeAgentDebounce = new Map(); // action → last-call timestamp
const _macroDebounce = new Map();    // action → last-call timestamp, 8s cooldown per macro action
const MACRO_DEBOUNCE_MS = 8000;
const _screenDebounce = new Map();   // 'screen_analyze' → last-call timestamp, 5s cooldown
const SCREEN_DEBOUNCE_MS = 5000;
const CODE_AGENT_DEBOUNCE_MS = {
    generate_code:  120000,  // generation takes 30-60s — block for 2 minutes
    modify_code:     60000,  // modification takes ~20s — block for 1 minute
    create_project:  15000,
    open_project:    10000,
    list_projects:   10000,
    preview_project: 10000,
    start_session:   10000,
    end_session:     10000,
};
const _notesDebounce = new Map(); // action → last-call timestamp
const NOTES_DEBOUNCE_MS = {
    create_note:    60000,  // AI generation ~15-30s — block for 60s
    update_note:    20000,  // AI update ~10s — block for 20s to prevent rapid duplicates
    search_notes:    4000,
    list_notes:      4000,
    open_note:       2000,
    exit_notes_mode: 4000,
};
let _lastImageGenAt = 0;
const IMAGE_GEN_DEBOUNCE_MS        = 30000; // single image: ~5-10s, block 30s
const IMAGE_GEN_BATCH_DEBOUNCE_MS  = 90000; // batch: parallel ~15s, block 90s
const _videoEditorDebounce = new Map();
const VIDEO_EDITOR_DEBOUNCE_MS = {
    list_projects:   5000,   // filesystem read is instant; 5s blocks duplicate parallel calls
    open_editor:     60000,  // opening + window detection can take 15-30s; block 60s to prevent duplicate launches
    create_project:  15000,
    import_file:     12000,  // import takes ~5s; 12s allows sequential imports without long waits
    add_to_timeline: 10000,
    delete_clip:     5000,
    play_preview:    3000,
    stop_preview:    3000,
    save_project:    10000,
    export_video:    15000,
    undo:            3000,
    redo:            3000,
    guide:           3000,
    close_editor:    8000,
};
let _videoGenInFlight = false;
let _lastVideoGenAt   = 0;
const VIDEO_GEN_DEBOUNCE_MS = 120000; // video takes 2-5 min — block 2 min after call

// ── STORE AUTO-SCAN ────────────────────────────────────────────────────────
// Shared helper used after both smart_click and open (in store mode).
// Reads the current DOM map, runs stuck-navigation detection (if checkStuck),
// then injects a narration prompt so Nova always speaks after landing on a page.
async function runStoreAutoScan(checkStuck) {
    if (!activeSession || !automationRef) return;
    console.log('🛍️ [Store] Auto-scanning page...');

    const domMapPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            ipcMain.removeAllListeners('dom-map-available');
            resolve({ map: [], url: '' });
        }, 5000);
        ipcMain.once('dom-map-available', (data) => {
            clearTimeout(timer);
            resolve(data || { map: [], url: '' });
        });
    });

    automationRef.getDomMap();
    const { map, url } = await domMapPromise;
    if (!map || map.length === 0) return;

    // ── Stuck navigation detection (only for smart_click, not open) ──────────
    if (checkStuck) {
        if (_lastAutoScanUrl !== '' && url === _lastAutoScanUrl) {
            _stuckClickCount++;
            console.log(`⚠️ [Store] Navigation stuck on ${url} (attempt #${_stuckClickCount})`);
        } else {
            _stuckClickCount = 0;
        }
        _lastAutoScanUrl = url;

        if (_stuckClickCount >= 2) {
            _stuckClickCount = 0;
            const target = _lastSmartClickTarget || 'the product';
            const fallback =
                `[NAVIGATION STUCK] smart_click for "${target}" failed multiple times — URL stays at ${url}. ` +
                `The element is a nav bar dropdown, not a product link. STOP using smart_click for this. ` +
                `IMMEDIATELY call control_browser action='open' with the direct URL from your knowledge. ` +
                `Apple patterns: apple.com/shop/buy-iphone/iphone-15, apple.com/shop/buy-iphone/iphone-16, ` +
                `apple.com/shop/buy-iphone/iphone-16-pro, apple.com/shop/buy-ipad/ipad-air, ` +
                `apple.com/shop/buy-ipad/ipad-pro, apple.com/shop/buy-mac/macbook-pro, ` +
                `apple.com/shop/buy-mac/macbook-air, apple.com/shop/buy-watch/apple-watch-series-10. ` +
                `For Amazon: amazon.com/s?k=product+name. Navigate directly now — do NOT speak first.`;
            console.log(`🔀 [Store] Injecting direct-URL fallback for "${target}"`);
            try {
                _lastAutoScanAt = Date.now();
                activeSession.sendRealtimeInput({ text: fallback });
                setTimeout(() => {
                    if (activeSession) activeSession.sendRealtimeInput({ text: 'Navigate directly using action=open now.' });
                }, 300);
            } catch (e) {
                console.error('🛍️ [Store] Fallback inject failed:', e);
            }
            return;
        }
    } else {
        // For direct open: always reset stuck state since we navigated intentionally
        _stuckClickCount = 0;
        _lastAutoScanUrl = url;
    }
    // ── End stuck detection ──────────────────────────────────────────────────

    // Extract headings and product-signal elements (max 20, deduped)
    const seen = new Set();
    const highlights = (map || [])
        .filter(el => {
            const t = (el.text || '').trim();
            if (!t || t.length < 3 || seen.has(t)) return false;
            seen.add(t);
            const tag = (el.tag || '').toUpperCase();
            const isHeading = ['H1', 'H2', 'H3', 'LABEL', 'BUTTON'].includes(tag);
            const hasSignal = /\$|from |starting|new|pro|plus|ultra|mini|air|max|series|gen|inch|mm|gb|tb|watch|iphone|ipad|mac|model|plan|color|size|edition/.test(t.toLowerCase());
            return isHeading || hasSignal;
        })
        .slice(0, 20)
        .map(e => e.text)
        .join(', ');

    const prompt =
        `[STORE NAVIGATION] You are in Store Assistant Mode. ` +
        `The browser just loaded: ${url}\n` +
        `Key items visible on the page: ${highlights || '(see page)'}\n\n` +
        `Speak out loud right now — do NOT call any tools. ` +
        `Use your own knowledge of this page combined with the items listed above. ` +
        `Tell the user what products, models, prices, or options are available here in a warm, enthusiastic way. ` +
        `Add your own knowledge: notable specs, who each option is best for, popular choices. ` +
        `End by asking which one they want — you will click it or navigate to it for them.`;

    console.log(`🛍️ [Store] Injecting navigation prompt for ${url} (${highlights.split(',').length} highlights)`);
    try {
        _lastAutoScanAt = Date.now();
        activeSession.sendRealtimeInput({ text: prompt });
        setTimeout(() => {
            if (activeSession) activeSession.sendRealtimeInput({ text: 'Please speak your response out loud now.' });
        }, 300);
    } catch (e) {
        console.error('🛍️ [Store] Auto-scan inject failed:', e);
    }
}

async function startLiveSession(mainWindow, automation) {
    mainWindowRef = mainWindow;
    automationRef = automation;
    _browserIsOpen = false;      // Reset browser state for each new session
    _lastBrowserActionAt = 0;
    _lastSmartClickAt = 0;
    _lastOpenAt = 0;
    _lastExplicitCloseAt = 0;
    _lastOpenedQuery = '';
    _storeAssistantActive = false;
    _lastAutoScanAt = 0;
    _lastGetBrowserStateAt = 0;
    _lastAutoScanUrl = '';
    _stuckClickCount = 0;
    _lastSmartClickTarget = '';
    _codeAgentDebounce.clear();
    _notesDebounce.clear();
    if (activeSession) {
        console.log('Live Session already active.');
        return;
    }

    try {
        console.log('🔄 Connecting to Gemini Live API...');

        const model = 'gemini-3.1-flash-live-preview';
        activeSession = await ai.live.connect({
            model: model,
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction:
                    "You are Nova, a brilliant multilingual AI assistant. Always respond in the user's language.\n\n" +

                    "== PERSONALITY ==\n" +
                    "You are warm, curious, and genuinely informative — like a knowledgeable friend, not a search engine. " +
                    "Give complete, helpful answers. Never be vague or cut answers short just to be brief. " +
                    "Adapt your length to what the question needs — simple questions get clear short answers, complex topics get full explanations. " +
                    "NEVER ask the user where they found you, how they got you, who made you, or any meta question about your own existence or installation. " +
                    "NEVER introduce yourself unprompted.\n\n" +

                    "== YOUR PRIMARY MODE IS CONVERSATION ==\n" +
                    "You have encyclopedic knowledge: science, math, history, weather, news, coding, homework, recipes, jokes, culture — everything. " +
                    "For ANY question or topic, respond verbally with your own knowledge. NEVER open a browser or run a command just to answer a question.\n" +
                    "This means: if someone asks about news, current events, weather, sports scores, stock prices, or ANYTHING informational — answer from your knowledge. " +
                    "Do NOT open the browser. Do NOT search Google. Just talk.\n" +
                    "NEVER triggers for control_browser action='open': 'what is the news', 'noticias de hoy', 'current events', 'what happened today', 'latest news', 'tell me about X', 'what is X', 'how does X work', any question, any topic.\n\n" +

                    "== TOOL USAGE: STRICT TRIGGER RULES ==\n" +
                    "You have four tools. Use them ONLY when the user gives a direct, unambiguous action command. NEVER call a tool because the user mentioned a topic or asked a question.\n\n" +

                    "1. execute_system_command — ONLY when user explicitly says 'open', 'launch', 'start', or 'run' followed by an app name.\n" +
                    "   - Triggers: 'open zoom', 'launch terminal', 'open docs'\n" +
                    "   - NEVER triggers for 'close': closing the browser means Nova's built-in browser only — use control_browser action='close' instead. NEVER call execute_system_command to close browsers (brave, chrome, firefox, etc.) unless the user explicitly named that exact app.\n" +
                    "   - Never triggers: questions, topics, 'what is X', 'tell me about X', any conversation\n" +
                    "   - NEVER call more than once per app. If cooldown returns Skipped, do NOT retry.\n\n" +

                    "2. control_browser — ONLY for these exact browser commands:\n" +
                    "   ⚠️ NEVER call control_browser when the user is talking about NOTES. If the user says anything like:\n" +
                    "   'open my note', 'show me the note about X', 'open the note about X', 'find my note on X',\n" +
                    "   'open that recipe note', 'pull up my notes', 'the note I made about X' → use notes_action, NOT control_browser.\n" +
                    "   Notes are on the user's computer, not on the internet. NEVER Google-search for a note name.\n" +
                    "   - 'scroll down' / 'scroll up' → action='scroll', direction='down' or 'up'\n" +
                    "   - 'search for X on google' / 'go to website X' / 'open X in the browser' → action='open', query='X'\n" +
                    "   - 'play X on youtube' / 'search youtube for X' → action='search_youtube', query='X'\n" +
                    "   - 'click on X' / 'click X' → action='smart_click', target_text='X'\n" +
                    "   - 'close the browser' / 'close browser' / 'close it' (when browser is open) → action='close'\n" +
                    "   - 'switch to incognito' / 'enable incognito mode' / 'go incognito' / 'turn on incognito' → action='toggle_incognito'\n" +
                    "   - 'exit incognito' / 'disable incognito' / 'go back to normal mode' → action='toggle_incognito'\n" +
                    "   - NEVER call control_browser for general conversation, questions, topics, news requests, or anything that doesn't directly control the browser UI.\n" +
                    "   - When closing the browser: call control_browser action='close' ONCE. Do NOT also call execute_system_command to close other browsers.\n" +
                    "   - NEVER call action='close' unless the user explicitly said the word 'close' AND referred to the browser.\n\n" +

                    "3. get_browser_state — ONLY when user says 'what is on screen' or 'list the elements'. " +
                    "   Do NOT call this before clicking. For all clicks use control_browser action='smart_click' directly.\n\n" +

                    "4. create_research_paper — EXTREMELY STRICT. This tool takes several minutes and cannot be cancelled.\n" +
                    "   ONLY call it when ALL of these conditions are met simultaneously:\n" +
                    "   a) The user used an explicit creation verb: 'write', 'create', 'generate', 'make', 'build', 'compose', or 'prepare'\n" +
                    "   b) The user explicitly said the words 'research paper', 'academic paper', 'scientific paper', or 'research essay'\n" +
                    "   c) The user named a specific topic for the paper\n" +
                    "   EXAMPLE triggers: 'write me a research paper on climate change', 'create an academic paper about AI'\n" +
                    "   NEVER triggers: discussing a topic, asking questions, 'tell me about X', 'what is X', any conversation, partial sentences, ambient speech\n" +
                    "   ABSOLUTE NEVER triggers: any sentence containing 'open', 'show', 'find', 'display', 'locate', or 'get' before 'research paper' — these are file-open requests, NOT creation requests.\n" +
                    "   Examples of file-open requests (NEVER call create_research_paper for these):\n" +
                    "     'open file research paper on climate change'\n" +
                    "     'open the research paper'\n" +
                    "     'show me the research paper about AI'\n" +
                    "     'find research paper climate change'\n" +
                    "   If you are even slightly unsure, DO NOT call this tool — answer conversationally instead.\n\n" +

                    "5. show_stock_chart — Call this whenever the user asks about: stock prices, market performance, price trends, whether a product price is dropping or rising, or how a company is doing financially.\n" +
                    "   TRIGGER EXAMPLES:\n" +
                    "   - 'when is the price of iPhone dropping' → company='Apple', symbol='AAPL'\n" +
                    "   - 'when are Pokemon prices dropping' → company='Nintendo', symbol='NTDOY'\n" +
                    "   - 'how is Tesla doing in the market' → company='Tesla', symbol='TSLA'\n" +
                    "   - 'what's happening with Google stock' → company='Alphabet', symbol='GOOGL'\n" +
                    "   - 'show me the stock market for Microsoft' → company='Microsoft', symbol='MSFT'\n" +
                    "   - 'is Amazon a good buy right now' → company='Amazon', symbol='AMZN'\n" +
                    "   - 'how are Nintendo Switch prices trending' → company='Nintendo', symbol='NTDOY'\n" +
                    "   Common tickers: Apple=AAPL, Microsoft=MSFT, Tesla=TSLA, Amazon=AMZN, Google/Alphabet=GOOGL,\n" +
                    "     Meta=META, Netflix=NFLX, Nvidia=NVDA, AMD=AMD, Intel=INTC, Samsung=005930.KS,\n" +
                    "     Sony=SONY, Nintendo=NTDOY, Disney=DIS, Spotify=SPOT, Uber=UBER, Airbnb=ABNB.\n" +
                    "   If you don't know the ticker symbol, pass the company name and leave symbol empty — the system will look it up.\n" +
                    "   After calling this tool, narrate the result out loud: current price, daily change, 3-month trend, and outlook.\n" +
                    "   NEVER opens the browser for stock questions — always use show_stock_chart instead.\n\n" +

                    "== CLICKING ==\n" +
                    "When user says 'click on X' or 'click X': immediately call control_browser with action='smart_click' and target_text='X'. Do not call get_browser_state first.\n\n" +

                    "== AFTER ANY TOOL CALL ==\n" +
                    "Confirm the action in one short sentence, then return to normal conversation.\n\n" +

                    "== STORE ASSISTANT MODE — PERMANENT UNTIL BROWSER CLOSES ==\n" +
                    "Store mode is activated the moment you land on a known shopping site. It NEVER ends due to conversation, stock charts, questions, or topic changes. " +
                    "The ONLY exit is the user explicitly saying 'close the browser' and you calling control_browser action='close'. " +
                    "Even if you just spent 10 minutes discussing stocks or answering unrelated questions — if the browser is on a store, you are the shopping guide the instant the user mentions a product.\n\n" +

                    "When you receive a [STORE DETECTED - SYSTEM NOTIFICATION] message: speak a warm greeting and ask what they want to buy. " +
                    "ABSOLUTELY DO NOT call any tool when receiving this notification. Just talk.\n\n" +

                    "╔══ GOLDEN RULE — PRODUCT NAME = NAVIGATE IMMEDIATELY ══╗\n" +
                    "When on a store page and the user says ANY product name (iPhone, MacBook, iPad, AirPods, Watch, shoe, ring, console — anything), " +
                    "your ONLY valid responses are:\n" +
                    "  a) control_browser action='smart_click' target_text='[product name]' — click the nav link\n" +
                    "  b) control_browser action='open' query='[direct URL]' — navigate directly\n" +
                    "NEVER call get_browser_state in response to a product name. get_browser_state is for AFTER you navigate, not before.\n" +
                    "This rule applies whether the store greeting just fired 10 seconds ago OR you've been chatting about something else for 30 minutes.\n" +
                    "╚══════════════════════════════════════════════════════╝\n\n" +

                    "DIRECT URL NAVIGATION — If you receive a [NAVIGATION STUCK] message, or if smart_click fails once, " +
                    "immediately switch to control_browser action='open' with a direct URL. " +
                    "Apple direct URLs (use these if smart_click fails): " +
                    "apple.com/shop/buy-iphone (all iPhones), apple.com/shop/buy-iphone/iphone-16 (iPhone 16), " +
                    "apple.com/shop/buy-iphone/iphone-16-pro (iPhone 16 Pro), apple.com/shop/buy-ipad/ipad-air (iPad Air), " +
                    "apple.com/shop/buy-ipad/ipad-pro (iPad Pro), apple.com/shop/buy-mac/macbook-pro (MacBook Pro), " +
                    "apple.com/shop/buy-mac/macbook-air (MacBook Air), apple.com/shop/buy-watch/apple-watch-series-10 (Watch Series 10), " +
                    "apple.com/shop/buy-airpods (AirPods). " +
                    "Amazon: amazon.com/s?k=<product+name>. eBay: ebay.com/sch/i.html?_nkw=<product+name>.\n\n" +

                    "SHOPPING FLOW (applies on first mention AND after any conversation break):\n" +
                    "STEP 1 — NAVIGATE (do this first, always): User names a product → call smart_click with that product name. " +
                    "DO NOT call get_browser_state first. You know Apple's nav has iPhone, iPad, Mac, Watch, AirPods links. Just click. " +
                    "If the page URL does not change after 1 smart_click attempt, immediately use control_browser action='open' with a direct Apple URL.\n" +
                    "STEP 2 — READ PAGE (only after landing on a new page): Call get_browser_state ONCE after navigation. " +
                    "The response will tell you to narrate — list the products, add your knowledge, ask which one they want.\n" +
                    "STEP 3 — READ PRODUCT DETAILS: After user picks a product and you click it, call get_browser_state ONCE on that product page. " +
                    "If the response says 'NOTE: This page does not show prices', speak from your own knowledge about prices, models, storage, and variants. " +
                    "DO NOT call get_browser_state again.\n" +
                    "STEP 4 — SELECT CONFIG: User picks a variant → smart_click to select size, color, or storage. Confirm selection.\n" +
                    "STEP 5 — ADD TO CART: User says 'add to cart' / 'buy this' / 'add to bag' → smart_click 'Add to Bag' or 'Add to Cart'. " +
                    "If any option is missing, ask for it first, then click.\n\n" +

                    "6. EMAIL MODE — a focused mode for sending emails. Stays active until the user says they are done.\n" +
                    "   ENTERING EMAIL MODE:\n" +
                    "   STEP 1 — Call list_contacts FIRST to show the contacts panel.\n" +
                    "   STEP 2 — Ask: 'Who would you like to email?' and wait for a name.\n" +
                    "   STEP 3 — Ask: 'What would you like to say?' and let the user describe their intent.\n" +
                    "   STEP 4 — Call send_email with recipient_name and message_intent.\n" +
                    "   STEP 5 — Read back the subject and address confirmation: 'Should I send it?'\n" +
                    "   STEP 6 — If user confirms → re-call send_email with confirmed=true.\n" +
                    "   AFTER SENDING (stay in email mode):\n" +
                    "   STEP 7 — Say 'Email sent!' then ask: 'Would you like to send another email, or are you all done?'\n" +
                    "   STEP 8a — If user wants ANOTHER email: call control_contacts_panel with action='close_browser_keep_contacts'. Then ask 'Who would you like to email next?' and go back to STEP 3.\n" +
                    "   STEP 8b — If user is DONE: call control_contacts_panel with action='close_email_mode'. Say 'All done! Back to normal.' Do NOT call any other tool.\n" +
                    "   SCROLLING CONTACTS: If user says 'scroll up', 'scroll down', 'show more', 'go up/down' → call control_contacts_panel with action='scroll_up' or 'scroll_down'.\n" +
                    "   - AUTH: If the tool returns auth_required → tell the user to run npm run setup-google.\n" +
                    "   - CANCEL: If user says cancel/stop at any time → call control_contacts_panel with action='close_email_mode'.\n" +
                    "   - DISAMBIGUATION: If tool returns a numbered list, speak it and wait. Re-call with selected_index.\n" +
                    "   - WORD-BY-WORD: If tool asks for username or domain, speak the question and re-call with recipient_email.\n\n" +

                    "7. calendar_action — ONLY for explicit calendar operations: checking schedule, creating events, cancelling events, checking availability.\n" +
                    "   - get_events triggers: 'what's on my calendar', 'what do I have this week', 'what's my schedule', 'what's my next meeting'\n" +
                    "   - DEFAULT time_expression for get_events: always use 'this week' unless the user specifies a different day or week.\n" +
                    "   - Only use a different week/range if the user explicitly asks (e.g. 'next week', 'last week', 'on Friday', 'tomorrow').\n" +
                    "   - create_event triggers: 'block 2pm for deep work', 'schedule a call with Bryan on Monday at 10am', 'add gym at 6pm'\n" +
                    "   - delete_event triggers: 'cancel my 4pm today', 'remove the standup tomorrow'\n" +
                    "   - check_availability triggers: 'am I free at 10am', 'when am I free Friday afternoon'\n" +
                    "   - NEVER triggers for: questions about time zones, general scheduling advice, or anything that doesn't read/write the calendar\n" +
                    "   - After tool responds, speak the result naturally. Do NOT call calendar_action again.\n\n" +

                    "8. code_agent — Activate for ANY request related to coding, building, or modifying a software project.\n" +
                    "   ACTIVATION TRIGGERS: 'help me code', 'create a project', 'build a website', 'make an app', 'write code for',\n" +
                    "   'let's code', 'I want to build', 'start a new project', 'build me a [anything]', 'code something',\n" +
                    "   'make a Chrome extension', 'build an API', 'create a React app', 'help me program'\n" +
                    "   MODIFICATION TRIGGERS (when a project session is active): 'change X', 'add a feature', 'fix the bug',\n" +
                    "   'update the code', 'make it do X', 'add Y', 'remove Z', 'redesign the UI', 'add a route'\n" +
                    "   END TRIGGERS: 'I\\'m done coding', 'done with the project', 'close the project', 'end coding session',\n" +
                    "   'stop coding', 'that\\'s all for now'\n\n" +
                    "   Actions and when to call each:\n" +
                    "   - start_session: User first mentions wanting coding help — call this to activate code agent mode.\n" +
                    "   - list_projects: User wants to see what projects exist on their Desktop.\n" +
                    "   - create_project: User gives you a project name → always pass project_name.\n" +
                    "   - open_project: User wants to open/continue an existing project by name → pass project_name.\n" +
                    "   - generate_code: User has described what to build AND a project folder exists → pass project_type + description.\n" +
                    "     project_type values: 'static_website' | 'react' | 'api_only' | 'fullstack' | 'cli' | 'extension' | 'python'\n" +
                    "   - modify_code: Any change request when a coding session is active → pass instruction with full detail.\n" +
                    "   - preview_project: User asks to see the project running in the browser.\n" +
                    "   - end_session: User is done coding → closes browser, VS Code, servers.\n\n" +
                    "   IMPORTANT RULES:\n" +
                    "   - During an active coding session, ALL change requests → modify_code (even unrelated-seeming conversation).\n" +
                    "   - After generate_code succeeds, automatically say what was built and describe the preview.\n" +
                    "   - The browser shows the live preview — you can still use control_browser to navigate inside it.\n" +
                    "   - Speak progress naturally: 'Generating your project…', 'Installing dependencies…', 'Starting the server…'\n" +
                    "   - User may speak any language — always respond in their language; use English for tool parameter values.\n\n" +

                    "9. notes_action — Nova Notes: search, view, create, and update personal notes stored on the user's computer.\n" +
                    "   ╔══ CRITICAL: ANY mention of a note/notes the user HAS → notes_action. NEVER browser. ══╗\n" +
                    "   'open my note about X', 'show me the note on X', 'open that note I made', 'find my recipe note',\n" +
                    "   'pull up my notes', 'the note about ají de gallina' → ALWAYS notes_action, NEVER control_browser.\n" +
                    "   Notes live on the user's computer. NEVER search Google for a note name.\n" +
                    "   ╚══════════════════════════════════════════════════════════════════════════════════════╝\n\n" +
                    "   ACTIVATION TRIGGERS: 'look at my notes', 'find my note about X', 'show my notes', 'check my notes',\n" +
                    "   'open my note about X', 'open that note', 'show me that note', 'the note I created about X',\n" +
                    "   'create a note', 'write a note', 'make a note', 'take a note', 'save a note', 'I want to take notes',\n" +
                    "   'help me write a note about X', 'create notes on X', 'note this down', 'write this down'\n" +
                    "   UPDATE TRIGGERS (when in notes mode): 'change this', 'update the note', 'add more about X',\n" +
                    "   'fix this section', 'rewrite the part about X', 'add X to the note'\n" +
                    "   EXIT TRIGGER: 'I am done taking notes' → call exit_notes_mode\n\n" +
                    "   Actions:\n" +
                    "   - list_notes: Show all notes. User asks to 'show notes', 'see my notes', 'what notes do I have'.\n" +
                    "     ⚠️ After list_notes returns, just READ OUT the note titles. Do NOT call open_note.\n" +
                    "     WAIT for the user to explicitly say which note they want to open.\n" +
                    "   - search_notes: Use when user describes a note by topic. Pass query=<what user said>.\n" +
                    "     The tool will return the ACTUAL note titles — always say the exact title back to the user.\n" +
                    "     Example: user says 'open my ají de gallina note' → search_notes, query='ají de gallina'\n" +
                    "     The result will say 'Found your note: \"Receta de Ají de Gallina\"' — repeat that exact title to the user.\n" +
                    "     ⚠️ After search_notes returns multiple results, read out the titles and WAIT for user to pick one.\n" +
                    "     Only if the tool auto-opens one (result says 'Opening it now'), then it is already open.\n" +
                    "   - open_note: Use ONLY when user explicitly asks to open or read a specific note by name.\n" +
                    "     ⚠️ NEVER call open_note automatically after list_notes or search_notes.\n" +
                    "     ⚠️ NEVER call open_note more than ONCE per user request. Open exactly ONE note.\n" +
                    "     If a note is already open and user asks for a different one, call open_note for the NEW note only — the old one closes automatically.\n" +
                    "     Pass title=<exact title as the user said it>. The system fuzzy-matches.\n" +
                    "   - create_note: Create a new note. FIRST ask: 'What do you want to write in the note?' then wait for user to describe it.\n" +
                    "     Pass title=<topic name> and user_request=<full description of what to write>.\n" +
                    "     While creating: tell user 'I am writing your note now, just a moment.'\n" +
                    "     After creating: show the result and ask for feedback. Stay in notes mode.\n" +
                    "   - update_note: Update current note. Pass title=<note title> and user_request=<what to change>.\n" +
                    "     RENAME RULE: Pass new_title=<new title> when EITHER:\n" +
                    "       (a) User explicitly asks to rename or retitle the note (e.g., 'rename this to X', 'change the title to X'), OR\n" +
                    "       (b) The update changes the topic significantly enough that the old title no longer fits.\n" +
                    "     Leave new_title empty if the title should stay the same.\n" +
                    "   - exit_notes_mode: Call ONLY when user says exactly 'I am done taking notes'.\n\n" +
                    "   NOTES MODE RULES:\n" +
                    "   - When notes mode is active (after create_note or when reviewing a note), ALL change requests → update_note.\n" +
                    "   - Stay focused on the note until user says 'I am done taking notes' — always remind them of this exit phrase.\n" +
                    "   - For create_note: if user just says 'create a note' without content, ask: 'What would you like me to write?' then wait.\n" +
                    "   - Nova uses its AI knowledge to write high-quality notes (how-tos, essays, poems, code notes, etc.).\n" +
                    "   - After create/update succeeds, ALWAYS say what was done and remind user to say 'I am done taking notes' to exit.\n\n" +

                    "10. generate_image — Generate one or multiple AI images using Imagen and save them to the Desktop.\n" +
                    "   TRIGGER PHRASES: 'generate an image', 'create a picture', 'draw me', 'make an image of', 'create art',\n" +
                    "   'generate art', 'make a wallpaper', 'create an illustration', 'make a poster', 'draw this',\n" +
                    "   'generate multiple images', 'create a set of images', 'I need images of X, Y, and Z'\n\n" +
                    "   ╔══ MANDATORY CONVERSATION FLOW — always ask BEFORE calling ══╗\n" +
                    "   STEP 1 — Ask style: 'What style? Realistic, cartoon, anime, futuristic, fantasy,\n" +
                    "     oil painting, watercolor, sketch, cyberpunk, abstract, or 3D render?'\n" +
                    "   STEP 2 — Ask mood (ONLY if not obvious): 'Mood? Dark, bright, dramatic, calm,\n" +
                    "     mysterious, or epic?' — SKIP if the subject makes the mood clear.\n" +
                    "   STEP 3 — Ask orientation: 'Square, landscape (wide), or portrait (tall)?'\n" +
                    "   ╚═══════════════════════════════════════════════════════════════╝\n\n" +
                    "   SINGLE IMAGE — prompt is the full subject description:\n" +
                    "   generate_image({ prompt: 'full description', style, aspect_ratio, mood?, extra_details?, filename_hint? })\n\n" +
                    "   BATCH MODE — when user asks for multiple images of the SAME style:\n" +
                    "   ╔══ USE subjects ARRAY ══╗\n" +
                    "   - prompt: shared visual context / framing applied to all (e.g. 'head-and-shoulders professional portrait, soft studio lighting, clean background')\n" +
                    "   - subjects: array of distinct subjects, one per image (e.g. ['a university student with a backpack', 'a software developer at a laptop', 'a knowledge worker in an office', 'a person in a wheelchair'])\n" +
                    "   - style / aspect_ratio / mood / extra_details: shared across all images\n" +
                    "   - Max 6 subjects per call\n" +
                    "   Example batch call: generate_image({ prompt: 'professional portrait, clean background', subjects: ['a student', 'a developer', 'a nurse'], style: 'realistic', aspect_ratio: 'portrait' })\n" +
                    "   ╚══════════════════════╝\n\n" +
                    "   RULES:\n" +
                    "   - NEVER call without asking style and orientation first.\n" +
                    "   - Single: say 'Generating your [style] image, this takes a few seconds.'\n" +
                    "   - Batch: say 'Generating [N] [style] images in parallel, this will take about 15 seconds.'\n" +
                    "   - When done, tell the user all images are on their Desktop.\n" +
                    "   - Do NOT call generate_image again until current generation finishes.\n\n" +

                    (() => {
                        const projs = scanOspProjects();
                        const vids  = scanVideoFiles();
                        const projList = projs.length ? projs.map((p,i) => `${i+1}. ${p}`).join(', ') : 'none';
                        const vidList  = vids.length  ? vids.map((v,i)  => `${i+1}. ${v}`).join(', ') : 'none';
                        return (
                    "11. video_editor_action — Open and control OpenShot Video Editor. Stay in video editing mode until user says 'close', 'done editing', or 'I'm done'.\n" +
                    "   ACTIVATION TRIGGERS: 'help me edit a video', 'open openshot', 'I want to edit a video', 'let's edit a video', 'open the video editor'\n\n" +
                    `   KNOWN PROJECTS IN ~/Videos/: ${projList}\n` +
                    `   KNOWN VIDEO FILES IN ~/Videos/: ${vidList}\n\n` +
                    "   ╔══ MANDATORY WORKFLOW ══╗\n" +
                    "   STEP 1 — PROJECT SELECTION (ask once, then execute):\n" +
                    "     Ask: 'New project or open an existing one?'\n" +
                    "     If EXISTING → read the KNOWN PROJECTS list above out loud. User picks by number.\n" +
                    "       → call open_editor(project_mode='existing', file_name='<exact name from list>')\n" +
                    "       Do NOT call list_projects — you already have the list above.\n" +
                    "     If NEW → ask project name → call open_editor(project_mode='new', file_name='<name>')\n" +
                    "   STEP 2 — IMPORT LOOP:\n" +
                    "     After editor opens: read the KNOWN VIDEO FILES list above as numbered options.\n" +
                    "     User says number → call import_file(file_name='<resolved name>') immediately.\n" +
                    "     After each import → ask: 'Would you like to import another video?'\n" +
                    "     If YES → read the list again → import. Repeat until done.\n" +
                    "     If NO → ask: 'How would you like to arrange these on the timeline?'\n" +
                    "   STEP 3 — TIMELINE ORDERING:\n" +
                    "     User describes order (e.g. 'pokemon first, then video1')\n" +
                    "     → call add_to_timeline for each IN ORDER, one at a time.\n" +
                    "     Confirm each: 'Added pokemon. Adding video1 now...'\n" +
                    "   STEP 4 — EDITING: play_preview → save_project → export_video.\n" +
                    "   ╚══════════════════════════════════════════════════╝\n\n" +
                    "   ACTION MAP:\n" +
                    "   - 'open existing' → read the KNOWN PROJECTS list, then call open_editor\n" +
                    "   - 'import X' / 'number N' → action='import_file', file_name='<name from KNOWN VIDEO FILES list>'\n" +
                    "   - 'add to timeline' → action='add_to_timeline', file_name='X'\n" +
                    "   - 'play' → action='play_preview' | 'stop' → action='stop_preview'\n" +
                    "   - 'save' → action='save_project' | 'export' → action='export_video'\n" +
                    "   - 'undo' → action='undo' | 'redo' → action='redo' | 'close' → action='close_editor'\n\n" +
                    "   RULES:\n" +
                    "   - NEVER call list_projects — the project list is already in this prompt.\n" +
                    "   - NEVER call open_editor more than once per session.\n" +
                    "   - NEVER ask what folder to look in — always use the Videos folder.\n" +
                    "   - Speak naturally — you are their hands-free video editing co-pilot.\n\n"
                        );
                    })() +

                    "12. generate_video — Generate a cinematic 8-second AI video with audio/speech using Veo and save it to the Videos folder.\n" +
                    "   TRIGGER PHRASES: 'generate a video', 'create a video', 'make a video', 'make me a video about',\n" +
                    "   'produce a video', 'make an AI video', 'generate a clip', 'create a short film about',\n" +
                    "   'can you generate a video', 'I want a video of'\n\n" +
                    "   ╔══ MANDATORY 8-QUESTION FLOW — ask ONE at a time, wait for answer, then ask next ══╗\n" +
                    "   You MUST collect ALL 8 answers before calling the tool. Never skip a question.\n\n" +
                    "   Q1 — 'What is the main topic or story of the video?'\n" +
                    "   Q2 — 'What visual style? Cinematic (movie quality), animated (3D), documentary, nature, sci-fi, or commercial?'\n" +
                    "   Q3 — 'Where does it take place? Describe the environment, location, and time of day.'\n" +
                    "   Q4 — 'Are there characters? If yes, describe how they look and their personality.'\n" +
                    "   Q5 — 'Walk me through the 8-second scene: what happens at each moment, and what do the characters SAY — give me the exact words they speak and what they do.'\n" +
                    "   Q6 — 'What camera movement? Examples: slow zoom in, dramatic drone flyover, close-up on face, wide establishing shot, handheld, slow motion.'\n" +
                    "   Q7 — 'What color palette and mood? Examples: warm golden sunset, dark moody blue, vibrant neon night, cold and desaturated, natural daylight.'\n" +
                    "   Q8 — 'Landscape (16:9 for YouTube/TV), portrait (9:16 for phone/Reels), or square (1:1)?'\n" +
                    "   ╚══════════════════════════════════════════════════════════════════════════════════╝\n\n" +
                    "   After all 8 answers: call generate_video with action='generate' and ALL collected details.\n" +
                    "   Before calling, say: 'Perfect — I have everything I need. Creating your video now — this takes about 2 to 5 minutes. I'll let you know the moment it's ready!'\n\n" +
                    "   PROMPT MEMORY — Nova saves every prompt to ~/Nova/video_prompts/ for reuse and improvement:\n" +
                    "   - 'show my video prompts' / 'what video prompts do I have' → call generate_video(action='list_prompts')\n" +
                    "   - User wants to regenerate with improvements → ask WHAT to change, then call generate_video(action='generate') with the improved args.\n" +
                    "   - 'delete that prompt' / 'remove that one' / 'I don't like it, delete it' → call generate_video(action='delete_prompt', prompt_id_to_delete='<id from list>')\n\n" +
                    "   AFTER VIDEO IS DONE: Tell user the file is in their Videos folder and is opening now. Ask how it looks and if anything needs improving.\n" +
                    "   If they want changes: ask exactly WHAT to change (dialogue? camera? style? setting?), collect updated answers, then regenerate.\n" +
                    "   NEVER call generate_video again while a generation is in flight — it takes 2-5 minutes.\n\n" +

                    "== LANGUAGE ==\n" +
                    "Always respond in the user's language. Tool parameter values must be in English.",

                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "get_browser_state",
                                description: "Returns visible interactive elements on the current browser page. WHEN TO CALL: (1) user explicitly asks 'what is on screen' or 'list elements'; (2) Store Mode ONLY — AFTER you have already navigated to a new page (Step 2 or Step 3 of the shopping flow). NEVER call this as a response to a user naming a product — a product name means NAVIGATE (smart_click or open), not read the page. NEVER call on the same URL twice in a row without navigating in between. If you just called get_browser_state and received the page elements, and the user says a product name — do NOT call again. Use smart_click instead.",
                                parameters: { type: "OBJECT", properties: {} }
                            },
                            {
                                name: "control_browser",
                                description: "Controls Nova's browser. Use for explicit browser commands only: open (search/navigate), scroll (up/down), smart_click (click by visible text — use this for ALL clicks), search_youtube, close, toggle_incognito (switch between normal and incognito mode). For clicking always use smart_click with the visible text on screen — never call get_browser_state first. Never use for answering questions.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["open", "scroll", "smart_click", "search_youtube", "close", "toggle_incognito"],
                                            description: "The browser action to perform. Use smart_click for all clicks. Use toggle_incognito to switch incognito mode on or off."
                                        },
                                        query: {
                                            type: "STRING",
                                            description: "URL or search query (used with 'open' or 'search_youtube')."
                                        },
                                        direction: {
                                            type: "STRING",
                                            enum: ["up", "down", "top", "bottom"],
                                            description: "Scroll direction (used with 'scroll')."
                                        },
                                        target_text: {
                                            type: "STRING",
                                            description: "Text to fuzzy-find and click (used with 'smart_click')."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "execute_system_command",
                                description: "Executes a desktop/OS action. ONLY call when user explicitly requests to open, launch, start, close, or run an application. DO NOT call for questions, topics, or anything that does not require launching software. Supported apps: zoom, vscode, terminal, firefox, chrome, brave, discord, slack, spotify, vlc, gimp, blender, files, dolphin, libreoffice, calc, writer, impress, antigravity, docs, sheets, slides, drive, gmail, and any installed app. Also: increase/decrease volume, open documents/downloads/desktop folder.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        command: {
                                            type: "STRING",
                                            description: "Must be in English. Examples: 'open zoom', 'open terminal', 'open vscode', 'open docs', 'open sheets', 'close zoom', 'increase volume', 'open downloads folder'."
                                        }
                                    },
                                    required: ["command"]
                                }
                            },
                            {
                                name: "create_research_paper",
                                description: "Creates a full APA-formatted academic research paper. ONLY call when the user explicitly says one of these exact action verbs — write, create, generate, make, build, compose — AND explicitly says the words 'research paper', 'academic paper', 'scientific paper', or 'research essay', AND provides a topic. DO NOT call this because the user mentioned or discussed a topic. DO NOT call this for questions, summaries, or conversation. If the user is just talking about a subject, answer conversationally. Only call when the intent to produce a written paper document is completely unambiguous.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        topic: {
                                            type: "STRING",
                                            description: "The research topic or subject for the paper. Be specific and descriptive."
                                        }
                                    },
                                    required: ["topic"]
                                }
                            },
                            {
                                name: "show_stock_chart",
                                description: "Fetches live stock market data and displays an interactive chart for a company. Call this whenever the user asks about stock prices, market performance, whether a product's price is dropping, or how a company is doing financially. Examples: 'when is iPhone price dropping' (Apple/AAPL), 'when will Pokemon prices drop' (Nintendo/NTDOY), 'how is Tesla stock doing', 'show me Amazon market performance'. After calling, narrate the result: current price, daily change, 3-month trend, and what it means for the user's question.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        company: {
                                            type: "STRING",
                                            description: "The full company name (e.g., 'Apple Inc.', 'Tesla', 'Nintendo'). Required."
                                        },
                                        symbol: {
                                            type: "STRING",
                                            description: "The stock ticker symbol (e.g., 'AAPL', 'TSLA', 'NTDOY'). If you know it, provide it. If not, leave empty and the system will look it up from the company name."
                                        }
                                    },
                                    required: ["company"]
                                }
                            },
                            {
                                name: "send_email",
                                description: "Compose and send an email via Gmail. Use ONLY when the user explicitly says 'send an email', 'email someone', 'write an email to', 'draft an email', or similar direct email-sending commands. This tool uses a multi-turn confirmation flow: first call resolves the contact and returns a confirmation question; re-call with confirmed=true after the user says yes. NEVER send without confirmed=true. NEVER call for questions or general conversation.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        recipient_name: {
                                            type: "STRING",
                                            description: "Name of the person to email. Nova resolves this to an email address via Google Contacts and sent mail history."
                                        },
                                        subject: {
                                            type: "STRING",
                                            description: "Brief subject line for the email. Nova will generate one if not provided."
                                        },
                                        message_intent: {
                                            type: "STRING",
                                            description: "What the email should say — the user's spoken intent in their own words. Nova will expand this into a professional email body."
                                        },
                                        draft_only: {
                                            type: "BOOLEAN",
                                            description: "If true, save as Gmail draft instead of sending immediately. Default: false."
                                        },
                                        recipient_email: {
                                            type: "STRING",
                                            description: "The resolved email address. Only set this when Nova has already confirmed the address with the user, or when assembling an address word-by-word. Never guess or hallucinate an address — let the contact resolution system populate it."
                                        },
                                        confirmed: {
                                            type: "BOOLEAN",
                                            description: "Set to true ONLY after you have read back the recipient name, email address, and subject to the user and received verbal confirmation. Default false. ALWAYS confirm before sending — never skip this step."
                                        },
                                        selected_index: {
                                            type: "NUMBER",
                                            description: "When Nova presented a numbered list of matching contacts (1, 2, 3, or 4), set this to the number the user chose."
                                        }
                                    },
                                    required: ["recipient_name", "message_intent"]
                                }
                            },
                            {
                                name: "list_contacts",
                                description: "List the user's Google Contacts so they can see who they can email. Call this when the user asks 'who can I email?', 'show me my contacts', 'list my contacts', 'who do I have saved?', or any similar request to browse their address book. Do NOT call send_email for this request.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        limit: {
                                            type: "NUMBER",
                                            description: "How many contacts to return. Default: 10. Max: 30."
                                        }
                                    },
                                    required: []
                                }
                            },
                            {
                                name: "control_contacts_panel",
                                description: "Control the contacts panel and email mode. Use scroll_up/scroll_down when user asks to scroll through contacts. Use close_browser_keep_contacts after sending an email when user wants to send another. Use close_email_mode when user is done sending emails.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["scroll_up", "scroll_down", "close_browser_keep_contacts", "close_email_mode"],
                                            description: "scroll_up/scroll_down: scroll contacts list; close_browser_keep_contacts: close browser, keep contacts panel open for next email; close_email_mode: user is done, close everything and return to normal."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "calendar_action",
                                description: "Read or modify the user's Google Calendar. Use for any request involving schedules, meetings, events, availability, or time blocking. Actions: get_events (read calendar), create_event (add event/meeting/block), delete_event (cancel event), check_availability (find free slots). NEVER call for general questions — only for explicit calendar operations.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["get_events", "create_event", "delete_event", "check_availability"],
                                            description: "Calendar operation: get_events=read schedule, create_event=add new event, delete_event=cancel event, check_availability=find free time."
                                        },
                                        time_expression: {
                                            type: "STRING",
                                            description: "Natural language time reference. Examples: 'tomorrow', 'this week', 'Friday at 3pm', 'today at 2pm', 'next Monday morning', 'in 2 hours'."
                                        },
                                        event_title: {
                                            type: "STRING",
                                            description: "Title/name of the event. Required for create_event. Used to look up events for delete_event."
                                        },
                                        duration_minutes: {
                                            type: "NUMBER",
                                            description: "Duration of the event in minutes. Default: 60."
                                        },
                                        attendees: {
                                            type: "ARRAY",
                                            items: { type: "STRING" },
                                            description: "List of names or email addresses to invite. Nova will resolve names to email addresses."
                                        },
                                        event_id: {
                                            type: "STRING",
                                            description: "Event ID for delete_event. If omitted, Nova looks up the event by title."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "code_agent",
                                description: "Nova Code Agent — creates, generates, previews, and modifies software projects. Triggers for any coding or project-building request: 'help me code', 'create a project', 'build a website', 'make an app', 'start a React project', 'write an API', etc. Also triggers for changes during an active session: 'change X', 'add Y', 'fix Z'. And for ending: 'I'm done coding'.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["start_session", "list_projects", "create_project", "open_project",
                                                   "generate_code", "modify_code", "preview_project", "end_session"],
                                            description: "Code agent action to perform."
                                        },
                                        project_name: {
                                            type: "STRING",
                                            description: "Project name (for create_project or open_project)."
                                        },
                                        project_type: {
                                            type: "STRING",
                                            enum: ["static_website", "react", "api_only", "fullstack", "cli", "extension", "python"],
                                            description: "Project technology type (required for generate_code)."
                                        },
                                        description: {
                                            type: "STRING",
                                            description: "Detailed description of what to build (for generate_code). Be thorough — include features, UI style, data model, etc."
                                        },
                                        instruction: {
                                            type: "STRING",
                                            description: "Specific change or modification instruction (for modify_code). Include context from the conversation."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "macro_control",
                                description: "Record and replay multi-step voice routines (macros). Use 'start_recording' when user says 'remember this', 'record this workflow', 'start recording'. Use 'stop_recording' when user says 'stop recording', 'done recording', 'save this routine'. Use 'run_macro' when user says 'run [name]', 'do my [name] routine', 'start [name] workflow'. Use 'list_macros' when user asks what routines are saved. Use 'delete_macro' when user says 'forget [name] routine'. Never trigger from ambient audio.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["start_recording", "stop_recording", "run_macro", "list_macros", "delete_macro"],
                                            description: "Which macro operation to perform."
                                        },
                                        macro_name: {
                                            type: "STRING",
                                            description: "Name of the routine. Required for run_macro and delete_macro. For stop_recording, this is the name the user wants to give the routine."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "notes_action",
                                description: "Nova Notes — search, view, create, and update personal notes stored on the user's machine. MUST USE for ANY note-related request. CRITICAL: When user says 'open my note about X', 'find the note about X', 'show that note', 'pull up my notes' — call notes_action with action=search_notes and query=<topic>. NEVER call control_browser for notes. Notes are local files, not web pages. Triggers: 'check my notes', 'find a note about X', 'open my note about X', 'create a note', 'write a note on X', 'take notes', 'show me the note I made about X', 'update the note'. Stays in notes mode until user says 'I am done taking notes'.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["list_notes", "search_notes", "open_note", "create_note", "update_note", "exit_notes_mode"],
                                            description: "Notes action to perform."
                                        },
                                        title: {
                                            type: "STRING",
                                            description: "Note title (for open_note, create_note, update_note)."
                                        },
                                        query: {
                                            type: "STRING",
                                            description: "Search query or hint to find a note (for search_notes). Use exactly what the user described."
                                        },
                                        user_request: {
                                            type: "STRING",
                                            description: "Full description of what to write or what to change (for create_note and update_note). Be as detailed as the user was."
                                        },
                                        new_title: {
                                            type: "STRING",
                                            description: "New title for the note (for update_note only). Pass this when: (1) the user explicitly asks to rename or retitle the note, OR (2) the update changes the topic significantly enough that the old title no longer fits. Leave empty if the title stays the same."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "analyze_screen",
                                description: "Take a screenshot and use Gemini Vision to analyze what is currently on the user's screen. Use when user says 'summarize this', 'what\\'s on my screen', 'what am I looking at', 'read this', 'explain this', 'describe my screen', 'what does this say', 'tell me about this page'. Do NOT use for general questions that don't require seeing the screen.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        question: {
                                            type: "STRING",
                                            description: "The specific question to answer about the screen content. Examples: 'Summarize the main content', 'What application is open?', 'Read the text visible', 'Explain what this code does'."
                                        }
                                    },
                                    required: ["question"]
                                }
                            },
                            {
                                name: "generate_image",
                                description: "Generates one or more AI images using Imagen and saves them to the user's Desktop. Supports SINGLE image and BATCH (multiple subjects, same style). ONLY call AFTER gathering style and orientation. TRIGGERS: 'generate an image', 'create a picture', 'draw me', 'make an image', 'create art', 'make a wallpaper', 'generate multiple images', 'create a set of images'. CONVERSATION FLOW before calling: (1) Ask style if not given (realistic/cartoon/anime/futuristic/fantasy/oil_painting/watercolor/sketch/cyberpunk/abstract/3d_render). (2) Ask mood only if not obvious. (3) Ask orientation (square/landscape/portrait). BATCH: when user asks for multiple images of the same style (e.g. 'portraits of a student, a developer, a designer'), use the subjects array — each entry is one distinct subject/variation, all sharing the same style/mood/orientation. Max 6 subjects per call.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        prompt: {
                                            type: "STRING",
                                            description: "Shared visual context / base description applied to ALL images. For batch: describe the shared setting, lighting, framing, and style details. For single: full subject description."
                                        },
                                        subjects: {
                                            type: "ARRAY",
                                            items: { type: "STRING" },
                                            description: "BATCH MODE ONLY. List of distinct subjects/variations to generate as separate images, all sharing the same style. Each string is one subject (e.g. 'a student with a backpack', 'a software developer at a desk', 'a person in a wheelchair'). Max 6 items. When provided, each subject is combined with prompt to produce one image. Leave empty for single-image mode."
                                        },
                                        style: {
                                            type: "STRING",
                                            enum: ["realistic", "cartoon", "anime", "futuristic", "fantasy", "oil_painting", "watercolor", "sketch", "cyberpunk", "abstract", "3d_render"],
                                            description: "Visual style applied to ALL images in the batch."
                                        },
                                        aspect_ratio: {
                                            type: "STRING",
                                            enum: ["square", "landscape", "portrait"],
                                            description: "Image orientation for ALL images: square (1:1), landscape (16:9), portrait (9:16)."
                                        },
                                        mood: {
                                            type: "STRING",
                                            description: "Shared mood for all images: dark, bright, dramatic, calm, mysterious, or epic. Leave empty if described in prompt."
                                        },
                                        extra_details: {
                                            type: "STRING",
                                            description: "Shared additional details applied to every image: colors, camera angle, lighting, background, etc."
                                        },
                                        filename_hint: {
                                            type: "STRING",
                                            description: "Short prefix for filenames (e.g. 'portrait', 'fantasy_char'). Batch images are auto-numbered."
                                        }
                                    },
                                    required: ["style", "aspect_ratio"]
                                }
                            },
                            {
                                name: "video_editor_action",
                                description: "Open and control OpenShot Video Editor. ALWAYS ask new/existing and project name BEFORE calling open_editor. Nova creates or finds the .osp file automatically — no dialog needed. Actions: list_projects, open_editor, import_file, add_to_timeline, delete_clip, play_preview, stop_preview, save_project, export_video, undo, redo, guide, close_editor.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["list_projects", "open_editor", "import_file", "add_to_timeline", "delete_clip",
                                                   "play_preview", "stop_preview", "save_project", "export_video",
                                                   "undo", "redo", "guide", "close_editor"],
                                            description: "Video editor action to perform."
                                        },
                                        project_mode: {
                                            type: "STRING",
                                            enum: ["new", "existing"],
                                            description: "For open_editor only: 'new' to create a fresh project, 'existing' to open one from the Videos folder."
                                        },
                                        file_name: {
                                            type: "STRING",
                                            description: "For open_editor: the project name (e.g. 'My Holiday Edit'). For import_file/add_to_timeline: the video filename (e.g. 'vacation.mp4'). Nova resolves paths automatically."
                                        },
                                        instruction: {
                                            type: "STRING",
                                            description: "Additional instruction or context for the guide action."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "generate_video",
                                description: "Generate an 8-second AI video with speech/audio using Veo and save it to the system Videos folder. ONLY call AFTER collecting answers to all 8 required questions. Triggers: 'generate a video', 'create a video', 'make a video', 'make me a video about', 'I want a video of'. Also handles: listing saved prompts (action=list_prompts), deleting a saved prompt (action=delete_prompt). NEVER call this tool until ALL 8 questions have been answered by the user. This takes 2-5 minutes — never call twice while one is running.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["generate", "list_prompts", "delete_prompt"],
                                            description: "generate: create a new video. list_prompts: show saved prompts. delete_prompt: delete a prompt by ID."
                                        },
                                        subject: {
                                            type: "STRING",
                                            description: "Main topic or story of the video. Be specific and vivid. Required for generate."
                                        },
                                        style: {
                                            type: "STRING",
                                            enum: ["cinematic", "animated", "documentary", "nature", "sci-fi", "commercial"],
                                            description: "Visual production style."
                                        },
                                        setting: {
                                            type: "STRING",
                                            description: "Where the video takes place: environment, location, time of day, weather."
                                        },
                                        characters: {
                                            type: "STRING",
                                            description: "Description of characters — their appearance, clothing, personality."
                                        },
                                        dialogue_script: {
                                            type: "STRING",
                                            description: "Full 8-second scene breakdown: what happens moment by moment and the EXACT words characters speak. This is critical — include every line of dialogue."
                                        },
                                        camera_style: {
                                            type: "STRING",
                                            description: "Camera movement and framing: slow zoom, drone flyover, close-up, wide shot, handheld, slow motion, tracking shot, etc."
                                        },
                                        mood_color: {
                                            type: "STRING",
                                            description: "Color palette and emotional mood: warm golden tones, dark moody blue, vibrant neon, cold desaturated, natural daylight, dramatic contrast, etc."
                                        },
                                        aspect_ratio: {
                                            type: "STRING",
                                            enum: ["landscape", "portrait", "square"],
                                            description: "landscape=16:9 (YouTube/TV), portrait=9:16 (phone/Reels), square=1:1."
                                        },
                                        filename_hint: {
                                            type: "STRING",
                                            description: "Short prefix for the saved filename (e.g. 'cafe_scene', 'product_launch')."
                                        },
                                        prompt_id_to_delete: {
                                            type: "STRING",
                                            description: "ID of the saved prompt to delete (from list_prompts results). Required for delete_prompt."
                                        }
                                    },
                                    required: ["action"]
                                }
                            }
                        ]
                    }
                ]
            },
            callbacks: {
                onopen: () => {
                    console.log('✅ Connected to Gemini Live API');
                    mainWindow.webContents.send('live-session-event', { event: 'opened' });
                },
                onmessage: async (message) => {
                    if (message.serverContent && message.serverContent.interrupted) {
                        mainWindow.webContents.send('live-session-event', { event: 'interrupted' });
                    }
                    if (message.serverContent && message.serverContent.modelTurn && message.serverContent.modelTurn.parts) {
                        for (const part of message.serverContent.modelTurn.parts) {
                            if (part.inlineData && part.inlineData.data) {
                                mainWindow.webContents.send('live-audio-chunk', part.inlineData.data);
                            }
                            if (part.text) {
                                mainWindow.webContents.send('live-text-chunk', part.text);
                            }
                        }
                    }

                    // HANDLE TOOL CALLS
                    if (message.toolCall) {
                        for (const call of message.toolCall.functionCalls) {

                            // ── Macro Step Capture ──────────────────────────────────────────────
                            // When recording is active, intercept certain tool calls and store them
                            // as macro steps. The tool still EXECUTES normally (record while doing).
                            if (automationRef && automationRef.isMacroRecording()) {
                                const captureTools = new Set(['execute_system_command', 'control_browser', 'show_stock_chart']);
                                const isCalendarRead = call.name === 'calendar_action' && call.args.action === 'get_events';
                                // Only send_email and calendar mutations get a spoken warning.
                                // code_agent and create_research_paper are silently skipped (no warning).
                                const isDestructiveWithWarning = call.name === 'send_email' ||
                                    (call.name === 'calendar_action' && call.args.action !== 'get_events');

                                if (isDestructiveWithWarning) {
                                    // Warn the user but don't block the tool from executing
                                    const warnMsg = call.name === 'send_email'
                                        ? "[MACRO WARNING] I won't record email sending in the routine — that would send it every time you run it. Speak this warning to the user."
                                        : "[MACRO WARNING] I won't record calendar changes in the routine. Speak this warning to the user.";
                                    try {
                                        activeSession.sendRealtimeInput({ text: warnMsg });
                                    } catch (_) {}
                                } else if (captureTools.has(call.name) || isCalendarRead) {
                                    // Tools not in captureTools and not isDestructiveWithWarning
                                    // (get_browser_state, create_research_paper, code_agent, macro_control,
                                    //  analyze_screen) fall through the entire if/else silently.
                                    // Build a human-readable intent string
                                    let intent = call.name;
                                    if (call.name === 'execute_system_command') {
                                        const cmd = (call.args.command || '').trim();
                                        if (cmd.startsWith('focus-app ')) intent = `focus ${cmd.replace('focus-app ', '')}`;
                                        else if (cmd.startsWith('increase-volume')) intent = 'increase volume';
                                        else if (cmd.startsWith('decrease-volume')) intent = 'decrease volume';
                                        else intent = cmd;
                                    } else if (call.name === 'control_browser') {
                                        const a = call.args.action || '';
                                        if (a === 'open') intent = `open ${call.args.query || ''} in browser`;
                                        else if (a === 'scroll') intent = `scroll browser ${call.args.direction || ''}`;
                                        else if (a === 'smart_click') intent = `click "${call.args.target_text || ''}" in browser`;
                                        else intent = `browser ${a}`;
                                    } else if (call.name === 'show_stock_chart') {
                                        intent = `show stock chart for ${call.args.company || ''}`;
                                    } else if (call.name === 'calendar_action') {
                                        intent = `get calendar events for ${call.args.time_expression || 'upcoming'}`;
                                    }

                                    automationRef.recordMacroStep({
                                        intent,
                                        tool: call.name,
                                        args: call.args,
                                        safe_to_repeat: true,
                                        destructive: false,
                                    });
                                }
                            }
                            // ── End Macro Step Capture ──────────────────────────────────────────

                            if (call.name === 'get_browser_state') {
                                const nowGbs = Date.now();

                                // 1. Block calls that fire within 1.5s of an auto-scan (Gemini echo).
                                if (nowGbs - _lastAutoScanAt < 1500) {
                                    console.log('🛍️ [Store] get_browser_state suppressed — auto-scan just ran (<1.5s).');
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: "Skipped",
                                                message: "Page scan just completed. Speak the product information out loud right now — models, prices, variants. Do NOT stay silent."
                                            }
                                        }]
                                    });
                                    setTimeout(() => {
                                        if (activeSession) activeSession.sendRealtimeInput({ text: 'Please speak your response out loud now.' });
                                    }, 200);
                                    return;
                                }

                                // 2. Global 3s cooldown between consecutive get_browser_state calls —
                                //    prevents Gemini from looping when the page has no price elements.
                                if (nowGbs - _lastGetBrowserStateAt < 3000) {
                                    console.log('🛡️ get_browser_state cooldown — too soon after last call.');
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: "Skipped",
                                                message: "Already retrieved page state. Do NOT call get_browser_state again. Speak out loud right now using your own knowledge about this product — prices, models, variants. Do NOT stay silent."
                                            }
                                        }]
                                    });
                                    setTimeout(() => {
                                        if (activeSession) activeSession.sendRealtimeInput({ text: 'Please speak your response out loud now.' });
                                    }, 200);
                                    return;
                                }

                                _lastGetBrowserStateAt = nowGbs;
                                console.log('📁 [Tool] get_browser_state called');

                                // CRITICAL: Register the listener BEFORE triggering getDomMap
                                // to avoid the race condition where the response arrives before
                                // the listener is set up. Timeout after 5s to unblock Gemini.
                                const domMapPromise = new Promise((resolve) => {
                                    const timer = setTimeout(() => {
                                        ipcMain.removeAllListeners('dom-map-available');
                                        console.warn('⏱️ DOM map timeout — resolving with empty');
                                        resolve({ map: [], url: 'Timeout' });
                                    }, 5000);
                                    ipcMain.once('dom-map-available', (data) => {
                                        clearTimeout(timer);
                                        resolve(data || { map: [], url: 'Unknown' });
                                    });
                                });

                                if (automationRef) automationRef.getDomMap();

                                const { map, url } = await domMapPromise;
                                console.log(`👁️ [Tool] Browser state: ${url} (${map?.length || 0} elements)`);

                                // Extract the most useful elements: ones with real text content.
                                // Filter out blank/icon-only elements, deduplicate by text,
                                // and boost elements that look like product names or prices.
                                const seen = new Set();
                                const filtered = (map || []).filter(el => {
                                    const t = (el.text || '').trim();
                                    if (!t || t.length < 2) return false;
                                    if (seen.has(t)) return false;
                                    seen.add(t);
                                    return true;
                                });

                                // Separate price/product elements from generic nav links
                                const productEls = filtered.filter(el => {
                                    const t = el.text.toLowerCase();
                                    return /\$|price|from |starting|storage|gb|tb|inch|mm|size|color|material|edition|model|plan|tier|buy|add to cart|review|rating|stars?/.test(t);
                                });
                                const otherEls = filtered.filter(el => {
                                    const t = el.text.toLowerCase();
                                    return !/\$|price|from |starting|storage|gb|tb|inch|mm|size|color|material|edition|model|plan|tier|buy|add to cart|review|rating|stars?/.test(t);
                                });

                                // Send product-relevant elements first, then fill remaining budget
                                const budget = 120;
                                const combined = [
                                    ...productEls.slice(0, 80),
                                    ...otherEls.slice(0, budget - Math.min(productEls.length, 80))
                                ];

                                // Determine if this looks like a store page to tailor the instruction.
                                // Use _storeAssistantActive (set by store detection) OR URL-pattern fallback.
                                const looksLikeStorePage = _storeAssistantActive ||
                                    /shop|buy|product|store|cart|checkout|category|catalog|listing|pdp|item|detail|\/watch|\/iphone|\/ipad|\/mac|\/airpods|\/tv|\/accessories|\/gaming|\/electronics|\/jewelry|\/clothing|\/dp\/|\/itm\//.test((url || '').toLowerCase());

                                // Tell Gemini whether prices were visible — so it knows to use its own
                                // knowledge if the page is a marketing/overview page without pricing.
                                const hasPriceData = productEls.length > 0;
                                const priceNote = hasPriceData
                                    ? ''
                                    : ' NOTE: This page does not show prices in its elements — it may be a marketing/overview page. Use your own training knowledge to describe this product\'s current prices, models, and variants. Do NOT call get_browser_state again.';

                                // Detect if this is a store homepage (no product path) vs. a product/category page
                                const isStoreHomepage = looksLikeStorePage &&
                                    !/\/shop\/buy|\/shop\/product|\/dp\/|\/itm\/|\/s\?k=|\/buy-iphone|\/buy-ipad|\/buy-mac|\/buy-watch|\/buy-airpods|\/products?\/|\/category|\/collections?\//.test((url || '').toLowerCase());

                                const info = looksLikeStorePage
                                    ? (isStoreHomepage
                                        ? "You are on the store HOMEPAGE. The navigation links visible here (iPhone, iPad, Mac, Watch, AirPods, etc.) are what you need to click. " +
                                          "Speak briefly: tell the user you can see the main product categories and ask what they want. " +
                                          "CRITICAL: After the user names a product, do NOT call get_browser_state again. " +
                                          "Immediately call control_browser action='smart_click' with the product name, or use action='open' with a direct URL. " +
                                          "For Apple: iPhones → smart_click 'iPhone', iPads → smart_click 'iPad', Mac → smart_click 'Mac', etc." +
                                          priceNote
                                        : "You are in Store Assistant Mode on a product/category page. " +
                                          "Read through these elements carefully and extract: product names, model variants, sizes, storage tiers, colors, materials, prices, and ratings. " +
                                          "Immediately speak out loud in a friendly, enthusiastic way — list the products and prices you found, add your own knowledge about popularity and best value, and ask the user which one they want. " +
                                          "Do NOT stay silent. Do NOT say 'I found X elements'. Narrate like a shopping guide and then ask your follow-up question." +
                                          priceNote)
                                    : "List of interactive elements on the current page. Use smart_click with the element text to click any of them.";

                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: {
                                            elements: combined,
                                            url: url || 'Active Page',
                                            info
                                        }
                                    }]
                                });

                                // Double-injection for store pages: send a short follow-up to
                                // break Gemini out of silence after the functionResponse.
                                if (looksLikeStorePage) {
                                    setTimeout(() => {
                                        if (activeSession) {
                                            activeSession.sendRealtimeInput({ text: 'Please speak your response out loud now.' });
                                        }
                                    }, 300);
                                }

                            } else if (call.name === 'control_browser') {
                                const { action, query, direction, element_id, target_text } = call.args;
                                console.log(`🌍 [Browser Tool] Action: ${action}`);

                                // Debounce — smart_click uses its OWN clock so it is never
                                // blocked by a recent 'open' (Gemini often batches open+click).
                                // All other actions share the general debounce.
                                const nowBrowser = Date.now();
                                const isClick = action === 'smart_click' || action === 'click_id';
                                if (isClick) {
                                    if (nowBrowser - _lastSmartClickAt < 1500) {
                                        console.log(`🛡️ smart_click debounced — duplicate click too soon.`);
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{
                                                id: call.id,
                                                response: { status: "Skipped", message: "Already clicked recently. Resume conversation." }
                                            }]
                                        });
                                        return;
                                    }
                                } else {
                                    if (nowBrowser - _lastBrowserActionAt < 3000) {
                                        console.log(`🛡️ Browser action debounced — too soon after last action.`);
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{
                                                id: call.id,
                                                response: { status: "Skipped", message: "Already performed recently. Resume conversation." }
                                            }]
                                        });
                                        return;
                                    }
                                }

                                // Guard: 'close' is only valid if browser was actually opened this session
                                if (action === 'close' && !_browserIsOpen) {
                                    console.log('🛡️ Browser close ignored — browser is not open.');
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: "Skipped", message: "Browser is not open. Resume conversation normally without mentioning the browser." }
                                        }]
                                    });
                                    return;
                                }

                                // Record the timestamp on the correct clock
                                if (isClick) {
                                    _lastSmartClickAt = nowBrowser;
                                } else {
                                    _lastBrowserActionAt = nowBrowser;
                                }

                                if (automationRef) {
                                    if (action === 'open') {
                                        // Post-close lockout: block re-opening for 10s after user explicitly closed browser.
                                        const msSinceClose = nowBrowser - _lastExplicitCloseAt;
                                        if (msSinceClose < POST_CLOSE_LOCKOUT_MS) {
                                            console.log(`🛡️ open blocked — browser was just closed ${Math.round(msSinceClose/1000)}s ago.`);
                                            activeSession.sendRealtimeInput({
                                                functionResponses: [{ id: call.id, response: { status: "Blocked", message: "The user just closed the browser. Do NOT reopen it. Resume normal conversation." } }]
                                            });
                                            try { activeSession.sendRealtimeInput({ text: "[BROWSER CLOSED] The user explicitly closed the browser. Do not open it again unless they ask. Just talk to them normally." }); } catch (_) {}
                                            return;
                                        }

                                        // Deduplicate: skip re-opening the exact same query within 8s.
                                        // Gemini sometimes sends the same open command twice because
                                        // it gets two audio segments for a single user utterance.
                                        const normalizedQuery = (query || 'google').toLowerCase().trim();
                                        const sameQueryRecently = normalizedQuery === _lastOpenedQuery &&
                                            (nowBrowser - _lastOpenAt) < 8000;
                                        if (!sameQueryRecently) {
                                            automationRef.openBrowser(query || 'google');
                                            _lastOpenAt = nowBrowser;
                                            _lastOpenedQuery = normalizedQuery;
                                            _browserIsOpen = true;

                                            // In store mode: auto-scan after the page loads so Nova
                                            // always narrates the new page without needing to be asked.
                                            if (_storeAssistantActive) {
                                                _stuckClickCount = 0; // explicit nav — reset stuck counter
                                                _lastAutoScanUrl = ''; // treat as fresh navigation
                                                setTimeout(() => runStoreAutoScan(false), 3500);
                                            }
                                        } else {
                                            console.log(`🛡️ open skipped — same query "${normalizedQuery}" opened within 8s.`);
                                        }
                                    } else if (action === 'search_youtube') {
                                        // Post-close lockout: same guard as 'open'
                                        const msSinceClose = nowBrowser - _lastExplicitCloseAt;
                                        if (msSinceClose < POST_CLOSE_LOCKOUT_MS) {
                                            console.log(`🛡️ search_youtube blocked — browser was just closed ${Math.round(msSinceClose/1000)}s ago.`);
                                            activeSession.sendRealtimeInput({
                                                functionResponses: [{ id: call.id, response: { status: "Blocked", message: "The user just closed the browser. Do NOT reopen it. Resume normal conversation." } }]
                                            });
                                            try { activeSession.sendRealtimeInput({ text: "[BROWSER CLOSED] The user explicitly closed the browser. Do not open it again unless they ask. Just talk to them normally." }); } catch (_) {}
                                            return;
                                        }

                                        automationRef.openBrowser({ platform: 'youtube', query });
                                        _lastOpenAt = nowBrowser;
                                        _lastOpenedQuery = (query || '').toLowerCase().trim();
                                        _browserIsOpen = true;
                                    } else if (action === 'scroll') {
                                        automationRef.scrollBrowser(direction);
                                    } else if (action === 'click_id') {
                                        automationRef.clickBrowserId(element_id);
                                    } else if (action === 'smart_click') {
                                        // Track the last clicked target for stuck-navigation fallback
                                        _lastSmartClickTarget = target_text || '';

                                        // Delay click if fired immediately after an open so the page
                                        // has time to load before we query the DOM.
                                        const msSinceOpen = nowBrowser - _lastOpenAt;
                                        const waitMs = msSinceOpen < 2500 ? (2500 - msSinceOpen) : 0;
                                        if (waitMs > 0) {
                                            console.log(`⏳ smart_click delayed ${waitMs}ms to let page load.`);
                                            setTimeout(() => automationRef.smartClickBrowser(target_text), waitMs);
                                        } else {
                                            automationRef.smartClickBrowser(target_text);
                                        }

                                        // In store assistant mode: auto-scan the page after the click
                                        // so Nova always narrates what appeared — without relying on
                                        // Gemini to decide to call get_browser_state itself.
                                        if (_storeAssistantActive) {
                                            const clickDelay = waitMs + 2200; // click + page settle time
                                            setTimeout(() => runStoreAutoScan(true), clickDelay);
                                        }
                                    } else if (action === 'toggle_incognito') {
                                        automationRef.toggleIncognito();
                                        _browserIsOpen = true;  // reopens the browser
                                    } else if (action === 'close') {
                                        // Short cooldown: block accidental auto-close for 8s
                                        // right after the research paper finishes rendering.
                                        const timeSinceResearch = Date.now() - (global.novaLastResearchDoneAt || 0);
                                        if (timeSinceResearch < 8000) {
                                            console.log('🛡️ Browser close blocked — research paper just opened (8s guard).');
                                        } else {
                                            automationRef.closeBrowser();
                                            _browserIsOpen = false;
                                            _lastExplicitCloseAt = nowBrowser;
                                            _storeAssistantActive = false;
                                        }
                                    }
                                }

                                // In store assistant mode the page auto-scan fires automatically
                                // — tell Gemini to stay quiet and wait for it.
                                const isStoreNav = _storeAssistantActive && (action === 'smart_click' || action === 'open');
                                // For close: the functionResponse message alone is enough — a 400ms delayed
                                // text injection follows to guarantee Nova speaks the confirmation aloud.
                                const clickMessage = isStoreNav
                                    ? `Navigating to the product page. Stay quiet — a page scan will arrive shortly with instructions. Do NOT speak yet.`
                                    : action === 'close'
                                    ? `Browser closed successfully. Say out loud: "Done, browser closed." Do NOT call any tool again.`
                                    : `Browser ${action} performed. Confirm this to the user in one short sentence, then continue conversation normally.`;

                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: {
                                            status: "Complete",
                                            message: clickMessage
                                        }
                                    }]
                                });

                                // For close: add a 400ms delayed text injection so Nova says something.
                                // Sending text and functionResponse in the same tick causes Gemini to
                                // generate no audio output — the delay prevents that race condition.
                                if (action === 'close' && _lastExplicitCloseAt === nowBrowser) {
                                    setTimeout(() => {
                                        if (!activeSession) return;
                                        try {
                                            activeSession.sendRealtimeInput({ text: 'Say out loud right now: "Done, browser closed." — Do NOT call any tool.' });
                                        } catch (_) {}
                                    }, 400);
                                }

                            } else if (call.name === 'execute_system_command') {
                                const command = call.args.command;
                                console.log('💻 [System Tool] Command:', command);

                                const nowExec = Date.now();
                                const cmdKey = command.toLowerCase().trim();
                                const lastTime = lastExecCommandMap.get(cmdKey) || 0;

                                if (nowExec - lastTime < EXEC_COOLDOWN_MS) {
                                    console.log(`🛡️ Cooldown active for "${command}" — skipping`);
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: "Skipped",
                                                output: "Already done recently. Do not call this again. Resume conversation."
                                            }
                                        }]
                                    });
                                } else {
                                    lastExecCommandMap.set(cmdKey, nowExec);
                                    if (automationRef) {
                                        const result = await automationRef.executeCommand(command);
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{
                                                id: call.id,
                                                response: {
                                                    status: "Complete",
                                                    output: result || "Done.",
                                                    message: "Task complete. Confirm in one short sentence. Do NOT call any tool again unless the user explicitly requests a new action."
                                                }
                                            }]
                                        });
                                    }
                                }

                            } else if (call.name === 'create_research_paper') {
                                const { topic } = call.args;

                                // Block if already researching or within 10 minutes of last completion
                                const cooldownElapsed = Date.now() - (global.novaLastResearchDoneAt || 0);
                                if (global.novaIsResearching || cooldownElapsed < 600000) {
                                    console.log(`📄 [Research Tool] Blocked — already in progress or recently completed.`);
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: "Skipped",
                                                message: "The research paper was just completed or is still in progress. Tell the user the paper is ready on their desktop and ask what else they need. Do NOT call create_research_paper again."
                                            }
                                        }]
                                    });
                                    return;
                                }

                                console.log(`📄 [Research Tool] Starting paper on: "${topic}"`);
                                if (automationRef && automationRef.generatePaper) {
                                    automationRef.generatePaper(topic);
                                }

                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: {
                                            status: "Started",
                                            message: `Research paper on "${topic}" has been started. Tell the user you have started working on their research paper on "${topic}", that you are gathering information from multiple academic sources including IEEE, arXiv, and PubMed, and it will be saved to their desktop in a few minutes. Then stop talking and wait quietly.`
                                        }
                                    }]
                                });

                            } else if (call.name === 'show_stock_chart') {
                                const { company, symbol } = call.args;
                                console.log(`📈 [Stock Tool] Fetching: ${company} (${symbol || 'lookup'})`);

                                // Immediately send an ack so Nova can say "Let me pull that up..."
                                // while the fetch runs in the background — then inject result
                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: {
                                            status: "Fetching",
                                            message: `Pulling live market data for ${company}. Tell the user you are looking up the stock chart right now, then stay quiet for a moment while the data loads.`
                                        }
                                    }]
                                });

                                // Async fetch + inject result as a follow-up text message
                                if (automationRef && automationRef.showStockChart) {
                                    automationRef.showStockChart(company, symbol || '').then((result) => {
                                        if (!activeSession) return;
                                        // If the browser is currently on a store, remind Gemini it's still in store mode
                                        const storeNote = (_storeAssistantActive && _browserIsOpen)
                                            ? ' REMINDER: The browser is still open on a shopping store. You remain in Store Shopping Guide mode. After narrating this stock data, if the user asks about any product, immediately use smart_click or control_browser action=\'open\' — do NOT call get_browser_state first.'
                                            : '';
                                        const msg = result.success
                                            ? `[STOCK DATA LOADED] ${result.summary}${storeNote} Now speak out loud: describe the current price, the percentage change today, the 3-month trend shown on the chart, and what it means for the user's original question (e.g. whether prices are likely to drop or rise). Be specific and helpful. Do NOT call any tool.`
                                            : `[STOCK DATA UNAVAILABLE] ${result.summary}${storeNote} Speak from your own knowledge about this company's recent market performance and price trends. Be helpful and honest.`;
                                        try {
                                            activeSession.sendRealtimeInput({ text: msg });
                                        } catch (e) {
                                            console.error('📈 [Stock] Failed to inject result:', e.message);
                                        }
                                    }).catch((e) => {
                                        console.error('📈 [Stock] Unexpected error:', e.message);
                                        if (activeSession) {
                                            activeSession.sendRealtimeInput({ text: `[STOCK DATA ERROR] Could not retrieve data for ${company}. Answer conversationally using your training knowledge about this company's market performance.` });
                                        }
                                    });
                                }

                            } else if (call.name === 'list_contacts') {
                                const _nowContacts = Date.now();
                                const _msSinceContacts = _nowContacts - _listContactsLastAt;

                                // Block repeated list_contacts calls — contacts panel is already visible.
                                if (_msSinceContacts < LIST_CONTACTS_COOLDOWN_MS && automationRef && automationRef.isContactsPanelOpen && automationRef.isContactsPanelOpen()) {
                                    console.log(`📋 [Contacts] Debounced duplicate list_contacts call (${_msSinceContacts}ms since last)`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{
                                                id: call.id,
                                                response: { status: 'already_shown', message: 'Contacts panel is already visible. Do NOT call list_contacts again. Ask the user who they want to email.' }
                                            }]
                                        });
                                        activeSession.sendRealtimeInput({
                                            text: `[CONTACTS ALREADY VISIBLE] The contacts panel is still open. Do NOT call list_contacts again. Ask the user: "Who would you like to email?" and wait for their answer. Then call send_email with the name they say.`
                                        });
                                    } catch (_) {}
                                    return;
                                }

                                _listContactsLastAt = _nowContacts;
                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: 'Processing', message: 'Fetching your contacts...' }
                                        }]
                                    });
                                } catch (_) {}

                                if (automationRef && automationRef.listContactsTool) {
                                    automationRef.listContactsTool(call.args || {}).then((result) => {
                                        if (!activeSession) return;
                                        let instr;
                                        if (result.status === 'success') {
                                            const nameList = result.contacts
                                                .map((c, i) => `${i + 1}. ${c.displayName}`)
                                                .join(', ');
                                            instr =
                                                `[CONTACTS PANEL SHOWN] The contacts panel is now visible. ` +
                                                `EXACT contact names (use these EXACTLY when calling send_email): ${nameList}. ` +
                                                `Say out loud: "Here are your contacts. Who would you like to email?" ` +
                                                `When the user says a name, match it to the closest name from the list and pass THAT exact name to send_email. ` +
                                                `Do NOT call list_contacts again — the panel is already open.`;
                                        } else if (result.status === 'empty') {
                                            instr =
                                                `[NO CONTACTS] ${result.speak} ` +
                                                `If Google isn't authorized yet, tell the user to run npm run setup-google in a terminal, then restart Nova. Do NOT call any tool.`;
                                        } else {
                                            instr = `[CONTACTS ERROR] ${result.speak} Do NOT call any tool.`;
                                        }
                                        try { activeSession.sendRealtimeInput({ text: instr }); } catch (e) { /* ignore */ }
                                    }).catch(() => {});
                                }

                            } else if (call.name === 'control_contacts_panel') {
                                const { action } = call.args;
                                console.log(`📋 [Contacts Panel] action="${action}"`);

                                // Acknowledge immediately
                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{ id: call.id, response: { status: 'ok', action } }]
                                    });
                                } catch (_) {}

                                if (action === 'scroll_up' || action === 'scroll_down') {
                                    if (automationRef && automationRef.scrollContactsPanel) {
                                        automationRef.scrollContactsPanel(action);
                                    }
                                    try {
                                        activeSession.sendRealtimeInput({
                                            text: `[CONTACTS SCROLLED] Panel scrolled ${action === 'scroll_up' ? 'up' : 'down'}. ` +
                                                  `Say something natural like "scrolled" or "here you go" and wait for the user to pick a contact or scroll again. Do NOT call any tool.`
                                        });
                                    } catch (_) {}

                                } else if (action === 'close_browser_keep_contacts') {
                                    // Close browser but keep contacts panel open for next email
                                    if (automationRef && automationRef.closeBrowser) automationRef.closeBrowser();
                                    try {
                                        activeSession.sendRealtimeInput({
                                            text: `[BROWSER CLOSED - EMAIL MODE CONTINUES] Closed the sent folder. Contacts panel is still visible. ` +
                                                  `Say: "Alright! Who would you like to email next?" and wait for them to say a name from the contacts panel. ` +
                                                  `When they say a name, call send_email with that name. Do NOT call list_contacts again — contacts are already showing.`
                                        });
                                    } catch (_) {}

                                } else if (action === 'close_email_mode') {
                                    _emailModeActive = false;
                                    _emailInFlight = false;
                                    _emailLastCompletedAt = Date.now(); // keep cooldown active to block stale calls from the closing session
                                    if (automationRef && automationRef.closeBrowser) automationRef.closeBrowser();
                                    if (automationRef && automationRef.hideContactsPanel) automationRef.hideContactsPanel();
                                    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                        mainWindowRef.webContents.send('show-status-message', '');
                                    }
                                    try {
                                        activeSession.sendRealtimeInput({
                                            text: `[EMAIL MODE ENDED] Contacts panel and browser closed. ` +
                                                  `Say: "All done! Back to normal mode. Is there anything else I can help you with?" Do NOT call any tool.`
                                        });
                                    } catch (_) {}
                                }

                            } else if (call.name === 'send_email') {
                                const _emailArgs = call.args;
                                console.log(`📧 [Email Tool] recipient="${_emailArgs.recipient_name}" confirmed=${!!_emailArgs.confirmed} intent="${_emailArgs.message_intent}"`);

                                // Block duplicate/looping calls: only one email flow at a time.
                                // IMPORTANT: confirmed=true calls (user said "yes") are ALWAYS allowed
                                // through — they are the intentional confirmation step, never duplicates.
                                // Only unconfirmed calls are subject to the mutex and cooldown.
                                const _isConfirmation = !!_emailArgs.confirmed;
                                const _emailCooldownMs = 8000;
                                const _confirmCooldownMs = 6000; // short window after a send to block stale confirmed=true duplicates
                                const _timeSinceLast = Date.now() - _emailLastCompletedAt;
                                const _effectiveCooldown = _isConfirmation ? _confirmCooldownMs : _emailCooldownMs;
                                if (_emailInFlight || _timeSinceLast < _effectiveCooldown) {
                                    console.log(`📧 [Email] Blocked duplicate call (inFlight=${_emailInFlight}, msSinceLast=${_timeSinceLast}, cooldown=${_effectiveCooldown})`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{
                                                id: call.id,
                                                response: {
                                                    status: 'already_processing',
                                                    message: 'An email is already being processed. Do NOT call send_email again. Stay quiet and wait for the current flow to finish.'
                                                }
                                            }]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _emailInFlight = true;

                                // Acknowledge immediately so Nova says something while the async
                                // contact lookup runs. The real instruction (confirm / send / ask)
                                // arrives via a text injection after the lookup completes.
                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: {
                                            status: "Processing",
                                            message: `Looking up the contact for this email request. Say out loud: "Let me look that up." Then stay quiet while processing.`
                                        }
                                    }]
                                });

                                // If the contacts panel isn't already open, auto-fetch contacts
                                // first so the user always sees the panel before email is sent.
                                const _runEmail = (extraNames) => {
                                    if (!(automationRef && automationRef.sendEmailTool)) return;
                                    automationRef.sendEmailTool(_emailArgs).then((result) => {
                                        if (!activeSession) return;
                                        const speakText = result.speak || result.message || 'Email processed.';
                                        let instr;

                                        switch (result.status) {
                                            case 'success':
                                                _emailModeActive = true;
                                                if (automationRef && automationRef.openBrowser) {
                                                    automationRef.openBrowser('https://mail.google.com/mail/u/0/#sent');
                                                }
                                                instr =
                                                    `[EMAIL SENT - EMAIL MODE ACTIVE] ${speakText} ` +
                                                    `Say: "Email sent! I've opened your sent folder to confirm." ` +
                                                    `Then ask: "Would you like to send another email, or are you all done?" ` +
                                                    `Wait for their answer. ` +
                                                    `If they want to send ANOTHER: call control_contacts_panel with action="close_browser_keep_contacts", then ask who they want to email next. ` +
                                                    `If they are DONE: call control_contacts_panel with action="close_email_mode". ` +
                                                    `Do NOT call send_email yet — wait for their response first.`;
                                                break;
                                            case 'draft_saved':
                                                instr = `[EMAIL DRAFT SAVED] ${speakText} Speak this out loud now. Do NOT call any tool.`;
                                                break;
                                            case 'needs_confirmation':
                                                instr =
                                                    `[EMAIL CONFIRM NEEDED] Speak this EXACT sentence to the user: "${speakText}" — then wait for their answer. ` +
                                                    `If they say yes/sure/ok/send it/confirm: call send_email again with these EXACT args: ` +
                                                    `confirmed=true, ` +
                                                    `recipient_name="${_emailArgs.recipient_name || ''}", ` +
                                                    `recipient_email="${result.recipient_email || ''}", ` +
                                                    `subject="${result.confirmed_subject || _emailArgs.subject || ''}", ` +
                                                    `message_intent="${_emailArgs.message_intent || ''}", ` +
                                                    `draft_only=${!!_emailArgs.draft_only}. ` +
                                                    `If they say no/cancel/stop: say "Got it, email cancelled." and do NOT call send_email again.` +
                                                    (extraNames ? ` [Known contacts: ${extraNames}]` : '');
                                                break;
                                            case 'needs_disambiguation':
                                                instr =
                                                    `[EMAIL MULTIPLE CONTACTS] Speak this out loud: "${speakText}" — then wait for the user's choice. ` +
                                                    `When they say a number (1, 2, 3, or 4) or pick by name, call send_email again with the same ` +
                                                    `recipient_name, subject, message_intent, and draft_only, plus selected_index set to the number they chose.`;
                                                break;
                                            case 'needs_username':
                                                instr =
                                                    `[EMAIL NO CONTACT FOUND] Speak this out loud: "${speakText}" — then wait for their answer. ` +
                                                    `When they say the username, call send_email again with the same args plus ` +
                                                    `recipient_email set to exactly what they said (the username only — no @ symbol, no domain yet).`;
                                                break;
                                            case 'needs_domain':
                                                instr =
                                                    `[EMAIL NEEDS DOMAIN] Speak this out loud: "${speakText}" — then wait for their answer. ` +
                                                    `When they say the domain, call send_email again with the same args plus ` +
                                                    `recipient_email set to "${result.partial_username || ''}@[domain they said]". ` +
                                                    `Assemble the full address as: ${result.partial_username || '[username]'}@[domain they say].`;
                                                break;
                                            case 'auth_required':
                                                instr =
                                                    `[EMAIL AUTH REQUIRED] Tell the user: "Gmail isn't authorized yet. ` +
                                                    `Please open a terminal in the robot-widget folder and run: npm run setup-google — ` +
                                                    `it will open a browser to grant access to Gmail, Calendar, and Contacts. ` +
                                                    `After that, restart Nova and everything will work." Do NOT call any tool.`;
                                                break;
                                            default:
                                                instr = result.status === 'needs_clarification'
                                                    ? `[EMAIL NEEDS INPUT] ${speakText} Ask the user for the missing information.`
                                                    : `[EMAIL ERROR] ${speakText} Tell the user what went wrong.`;
                                        }

                                        try {
                                            activeSession.sendRealtimeInput({ text: instr });
                                        } catch (e) {
                                            console.error('📧 [Email] Failed to inject result:', e.message);
                                        } finally {
                                            _emailInFlight = false;
                                            _emailLastCompletedAt = Date.now();
                                        }
                                    }).catch((e) => {
                                        _emailInFlight = false;
                                        _emailLastCompletedAt = Date.now();
                                        console.error('📧 [Email] Unexpected error:', e.message);
                                        if (activeSession) {
                                            activeSession.sendRealtimeInput({
                                                text: `[EMAIL ERROR] The email could not be processed: ${e.message}. Tell the user there was a problem.`
                                            });
                                        }
                                    });
                                };

                                // Always show contacts panel first (guaranteed step)
                                if (automationRef && automationRef.isContactsPanelOpen && !automationRef.isContactsPanelOpen() && automationRef.listContactsTool) {
                                    automationRef.listContactsTool({ limit: 20 }).then((contactResult) => {
                                        const nameList = (contactResult.contacts || []).map(c => c.displayName).join(', ');
                                        _runEmail(nameList);
                                    }).catch((e) => {
                                        console.error('📧 [Email] listContacts prefetch failed:', e.message);
                                        _runEmail(null);
                                    });
                                } else {
                                    _runEmail(null);
                                }

                            } else if (call.name === 'calendar_action') {
                                const { action } = call.args;
                                const calKey = `${action}:${call.args.time_expression || ''}:${call.args.event_title || ''}`;
                                const nowCal = Date.now();

                                // Debounce: block the same action+args within 12s
                                if (nowCal - (_calendarDebounce.get(calKey) || 0) < CALENDAR_DEBOUNCE_MS) {
                                    console.log(`📅 [Calendar] Debounced duplicate call: ${calKey}`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_done',
                                                message: 'This calendar action was just completed. Tell the user the result you already have. Do NOT call calendar_action again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _calendarDebounce.set(calKey, nowCal);

                                console.log(`📅 [Calendar Tool] action="${action}" time="${call.args.time_expression || ''}"`);

                                // STEP 1 — Acknowledge immediately so Nova speaks right away.
                                // This is the same pattern as code_agent: send a "Processing"
                                // functionResponse now so Gemini can say something while we wait
                                // for the Google Calendar API (which takes 2-3+ seconds).
                                // The tool call is considered "complete" by this response; the
                                // actual result is delivered via a plain text injection after.
                                const ackMsg = action === 'get_events'
                                    ? `Say out loud right now: "Give me just a moment, I'm pulling up your calendar." Do NOT call calendar_action again.`
                                    : action === 'create_event'
                                    ? `Say out loud right now: "On it — adding that to your calendar right now." Do NOT call calendar_action again.`
                                    : action === 'delete_event'
                                    ? `Say out loud right now: "Sure, removing that from your calendar." Do NOT call calendar_action again.`
                                    : action === 'check_availability'
                                    ? `Say out loud right now: "Let me check if that time is free for you." Do NOT call calendar_action again.`
                                    : `Say out loud right now that you are processing the calendar request. Do NOT call calendar_action again.`;

                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: 'ok', message: ackMsg }
                                        }]
                                    });
                                } catch (_) {}

                                // Show loading badge on the widget
                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('show-status-message', 'Checking your calendar...');
                                }

                                // STEP 2 — Run the real API call. When done, inject the result
                                // as plain text — NOT another functionResponse (tool call is
                                // already closed). This is exactly how code_agent delivers results.
                                if (automationRef && automationRef.calendarActionTool) {
                                    automationRef.calendarActionTool(call.args).then((result) => {
                                        if (!activeSession) return;
                                        const speakText = result.speak || result.message || 'Calendar action complete.';

                                        // Clear loading badge
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }

                                        // Deliver result as text injection (tool call already closed above)
                                        let resultPrompt;
                                        if (result.status === 'auth_required') {
                                            resultPrompt = `[CALENDAR AUTH NEEDED] ${speakText} Tell the user they need to authorize Google Calendar.`;
                                        } else if (result.status === 'error' || result.status === 'not_found') {
                                            resultPrompt = `[CALENDAR ERROR] ${speakText} Tell the user what went wrong naturally. Do NOT call any tool.`;
                                        } else {
                                            resultPrompt = `[CALENDAR RESULT] ${speakText} Say this out loud naturally to the user now. Do NOT call any tool.`;
                                        }

                                        try {
                                            activeSession.sendRealtimeInput({ text: resultPrompt });
                                        } catch (e) {
                                            console.error('📅 [Calendar] Failed to deliver result:', e.message);
                                        }

                                        // Forward events to the calendar visual panel
                                        if (automationRef && automationRef.showCalendarPanel) {
                                            automationRef.showCalendarPanel({
                                                action,
                                                events: result.events || [],
                                                timeExpression: call.args.time_expression || 'this week',
                                                statusMessage: speakText,
                                            });
                                        }
                                    }).catch((e) => {
                                        console.error('📅 [Calendar] Unexpected error:', e.message);
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[CALENDAR ERROR] ${e.message}. Tell the user there was a problem with their calendar. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }

                            } else if (call.name === 'code_agent') {
                                const { action } = call.args;
                                const codeKey = `${action}:${call.args.project_name || ''}`;
                                const nowCode = Date.now();
                                const codeCooldown = CODE_AGENT_DEBOUNCE_MS[action] || 15000;

                                // Debounce: block duplicate code_agent calls.
                                // generate_code is blocked for 2 minutes since generation is slow.
                                if (nowCode - (_codeAgentDebounce.get(codeKey) || 0) < codeCooldown) {
                                    console.log(`💻 [Code Agent] Debounced duplicate: ${codeKey}`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_running',
                                                message: 'This code agent action is already in progress. Tell the user to wait — do NOT call code_agent again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _codeAgentDebounce.set(codeKey, nowCode);

                                console.log(`💻 [Code Agent] action="${action}" project="${call.args.project_name || ''}" type="${call.args.project_type || ''}"`);

                                // Show status badge on widget
                                const statusLabels = {
                                    generate_code:  'Building project...',
                                    modify_code:    'Updating code...',
                                    create_project: 'Creating project...',
                                    open_project:   'Opening project...',
                                    list_projects:  'Scanning projects...',
                                    preview_project:'Opening preview...',
                                    start_session:  'Starting code mode...',
                                    end_session:    'Closing code session...',
                                };
                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('show-status-message', statusLabels[action] || 'Working...');
                                }

                                // Acknowledge immediately so Nova speaks right away while work runs.
                                // Same two-step pattern as calendar_action.
                                const ackMessages = {
                                    start_session:   `Nova Code Agent is now active. Say out loud: "Code mode activated — what are we building today?" Do NOT call code_agent again.`,
                                    list_projects:   `Say out loud: "Let me check what projects you have on your Desktop." Do NOT call code_agent again.`,
                                    create_project:  `Say out loud: "Creating your project folder right now." Do NOT call code_agent again.`,
                                    open_project:    `Say out loud: "Opening your project in VS Code now." Do NOT call code_agent again.`,
                                    generate_code:   `Say out loud right now: "I'm generating your project — this will take about a minute, I'll let you know when it's ready." Do NOT call code_agent again.`,
                                    modify_code:     `Say out loud right now: "Applying your changes now, just a moment." Do NOT call code_agent again.`,
                                    preview_project: `Say out loud: "Opening the browser preview for you." Do NOT call code_agent again.`,
                                    end_session:     `Say out loud: "Wrapping up the coding session, closing everything now." Do NOT call code_agent again.`,
                                };

                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: 'ok',
                                                message: ackMessages[action] || `Acknowledged. Say briefly what you are doing for action: ${action}. Do NOT call code_agent again.`,
                                            }
                                        }]
                                    });
                                } catch (_) {}

                                if (automationRef && automationRef.codeAgentTool) {
                                    automationRef.codeAgentTool(call.args).then((result) => {
                                        if (!activeSession) return;
                                        const speakText = result.speak || 'Done.';

                                        // Clear status badge
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }

                                        // Delay before speaking result to avoid collision with
                                        // browser navigation events opening the preview simultaneously.
                                        const resultDelay = (action === 'generate_code' || action === 'modify_code') ? 1800 : 0;

                                        let prompt;
                                        if (result.status === 'error') {
                                            prompt = `[CODE AGENT ERROR] ${speakText} Tell the user what went wrong in a friendly way. Do NOT call any tool.`;
                                        } else if (result.status === 'needs_info' || result.status === 'needs_type' || result.status === 'needs_project') {
                                            prompt = `[CODE AGENT NEEDS INPUT] ${speakText} Ask the user for the missing information naturally. Do NOT call any tool.`;
                                        } else if (result.status === 'success' || result.status === 'ready' || result.status === 'ok') {
                                            prompt = `[CODE AGENT RESULT] ${speakText} Speak this to the user enthusiastically and naturally. ` +
                                                (action === 'generate_code'
                                                    ? 'Describe what was built and invite them to tell you what to change or add. Do NOT call any tool.'
                                                    : action === 'modify_code'
                                                    ? 'Confirm the change and ask if anything else needs adjusting. Do NOT call any tool.'
                                                    : 'Do NOT call any tool.');
                                        } else if (result.status === 'ended') {
                                            prompt = `[CODE AGENT ENDED] ${speakText} Speak this naturally to the user and return to normal conversation mode. Do NOT call any tool.`;
                                        } else {
                                            prompt = `[CODE AGENT] ${speakText} Speak this naturally to the user. Do NOT call any tool.`;
                                        }

                                        const injectResult = () => {
                                            if (!activeSession) return;
                                            try {
                                                activeSession.sendRealtimeInput({ text: prompt });
                                            } catch (e) {
                                                console.error('💻 [Code Agent] Failed to inject result:', e.message);
                                            }
                                        };
                                        if (resultDelay > 0) {
                                            setTimeout(injectResult, resultDelay);
                                        } else {
                                            injectResult();
                                        }
                                    }).catch((e) => {
                                        console.error('💻 [Code Agent] Unexpected error:', e.message);
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[CODE AGENT ERROR] ${e.message}. Tell the user there was a problem with the code agent. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }
                            } else if (call.name === 'macro_control') {
                                const { action } = call.args;
                                const nowMacro = Date.now();

                                // Debounce: 8s cooldown per action key
                                if (nowMacro - (_macroDebounce.get(action) || 0) < MACRO_DEBOUNCE_MS) {
                                    console.log(`🎙️ [Macro] Debounced duplicate: ${action}`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_done',
                                                message: 'This macro action was just handled. Tell the user what happened. Do NOT call macro_control again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _macroDebounce.set(action, nowMacro);

                                console.log(`🎙️ [Macro Tool] action="${action}" name="${call.args.macro_name || ''}"`);

                                // Acknowledge immediately
                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: 'ok', message: `Processing macro ${action}. Say out loud what you are doing for the user, then wait for the result.` }
                                        }]
                                    });
                                } catch (_) {}

                                if (automationRef && automationRef.handleMacroControl) {
                                    automationRef.handleMacroControl(call.args).then((result) => {
                                        if (!activeSession) return;
                                        const speakText = result.speak || 'Done.';
                                        try {
                                            activeSession.sendRealtimeInput({
                                                text: `[MACRO RESULT] ${speakText} Speak this to the user naturally. Do NOT call any tool.`
                                            });
                                        } catch (e) {
                                            console.error('🎙️ [Macro] Failed to inject result:', e.message);
                                        }
                                    }).catch((e) => {
                                        console.error('🎙️ [Macro] Unexpected error:', e.message);
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[MACRO ERROR] ${e.message}. Tell the user something went wrong. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }

                            } else if (call.name === 'notes_action') {
                                const { action } = call.args;
                                // open_note uses a single shared key so only ONE note can open at a time
                                const notesKey = action === 'open_note' ? 'open_note' : `${action}:${call.args.title || ''}`;
                                const nowNotes = Date.now();
                                const notesCooldown = NOTES_DEBOUNCE_MS[action] || 10000;

                                if (nowNotes - (_notesDebounce.get(notesKey) || 0) < notesCooldown) {
                                    console.log(`📝 [Notes] Debounced: ${notesKey}`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_running',
                                                message: 'This notes action is already running. Tell the user to wait — do NOT call notes_action again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _notesDebounce.set(notesKey, nowNotes);

                                console.log(`📝 [Notes] action="${action}" title="${call.args.title || ''}" query="${call.args.query || ''}"`);

                                const notesStatusLabels = {
                                    list_notes:      'Loading notes...',
                                    search_notes:    'Searching notes...',
                                    open_note:       'Opening note...',
                                    create_note:     'Writing note...',
                                    update_note:     'Updating note...',
                                    exit_notes_mode: 'Closing notes...',
                                };
                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('show-status-message', notesStatusLabels[action] || 'Working...');
                                }

                                // Immediate acknowledge so Nova can speak while work runs
                                const notesAckMessages = {
                                    list_notes:      `Say out loud: "Let me pull up your notes." Do NOT call notes_action again.`,
                                    search_notes:    `Say out loud: "Let me search through your notes." Do NOT call notes_action again.`,
                                    open_note:       `Say out loud: "Opening that note for you." Do NOT call notes_action again.`,
                                    create_note:     `Say out loud right now: "I am writing your note now, just a moment." Do NOT call notes_action again.`,
                                    update_note:     `Say out loud right now: "Updating your note now, one moment." Do NOT call notes_action again.`,
                                    exit_notes_mode: `Say out loud: "Closing notes mode." Do NOT call notes_action again.`,
                                };

                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: 'ok',
                                                message: notesAckMessages[action] || `Acknowledged. Say briefly what you are doing. Do NOT call notes_action again.`
                                            }
                                        }]
                                    });
                                } catch (_) {}

                                if (automationRef && automationRef.notesActionTool) {
                                    automationRef.notesActionTool(call.args).then((result) => {
                                        if (!activeSession) return;
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        const speakText = result.speak || 'Done.';
                                        let prompt;
                                        if (result.status === 'error') {
                                            prompt = `[NOTES ERROR] ${speakText} Tell the user what went wrong right now. Do NOT call any tool.`;
                                        } else if (result.status === 'not_found') {
                                            prompt = `[NOTES NOT FOUND] ${speakText} Ask which note they meant — the panel shows options. Say this out loud now. Do NOT call any tool.`;
                                        } else if (result.status === 'created') {
                                            prompt = `[NOTE CREATED] ${speakText} Say this out loud to the user right now. Do NOT call any tool.`;
                                        } else if (result.status === 'updated') {
                                            prompt = `[NOTE UPDATED] ${speakText} Say this out loud to the user right now. Do NOT call any tool.`;
                                        } else if (result.status === 'exited') {
                                            prompt = `[NOTES MODE EXITED] ${speakText} Say this out loud and return to normal conversation. Do NOT call any tool.`;
                                        } else {
                                            prompt = `[NOTES RESULT] ${speakText} Say this out loud to the user right now. Do NOT call any tool.`;
                                        }
                                        // Delay for fast ops (list/search/open complete in <100ms) so the ack
                                        // audio has time to start before the result injection arrives.
                                        const fastOps = ['list_notes', 'search_notes', 'open_note', 'exit_notes_mode'];
                                        const injectDelay = fastOps.includes(action) ? 700 : 0;
                                        setTimeout(() => {
                                            try {
                                                if (activeSession) activeSession.sendRealtimeInput({ text: prompt });
                                            } catch (e) {
                                                console.error('📝 [Notes] Failed to inject result:', e.message);
                                            }
                                        }, injectDelay);
                                    }).catch((e) => {
                                        console.error('📝 [Notes] Unexpected error:', e.message);
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[NOTES ERROR] ${e.message}. Tell the user there was a problem with their notes. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }

                            } else if (call.name === 'analyze_screen') {
                                const { question } = call.args;
                                const nowScreen = Date.now();
                                const screenKey = 'screen_analyze';

                                // Debounce: 5s cooldown
                                if (nowScreen - (_screenDebounce.get(screenKey) || 0) < SCREEN_DEBOUNCE_MS) {
                                    console.log('🖥️ [Screen] Debounced — too soon after last capture.');
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'cooldown',
                                                message: 'I just analyzed the screen. Tell the user to ask again in a moment if they need a fresh look. Do NOT call analyze_screen again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _screenDebounce.set(screenKey, nowScreen);

                                console.log(`🖥️ [Screen Tool] question="${question}"`);

                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('automation-log', '🖥️ Analyzing screen...');
                                }

                                // Acknowledge immediately
                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: 'ok', message: `Capturing and analyzing the screen right now. Say out loud: "Let me take a look at your screen." Then wait quietly for the result.` }
                                        }]
                                    });
                                } catch (_) {}

                                if (automationRef && automationRef.analyzeScreenTool) {
                                    automationRef.analyzeScreenTool(question).then((description) => {
                                        if (!activeSession) return;
                                        try {
                                            activeSession.sendRealtimeInput({
                                                text: `[SCREEN ANALYSIS] ${description} Speak this description naturally to the user right now. Do NOT call any tool.`
                                            });
                                        } catch (e) {
                                            console.error('🖥️ [Screen] Failed to inject result:', e.message);
                                        }
                                    }).catch((e) => {
                                        console.error('🖥️ [Screen] Unexpected error:', e.message);
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[SCREEN ERROR] I had trouble analyzing the screen: ${e.message}. Apologize to the user briefly. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }

                            } else if (call.name === 'generate_image') {
                                const nowImg        = Date.now();
                                const isBatchCall   = Array.isArray(call.args.subjects) && call.args.subjects.length > 1;
                                const imgDebounce   = isBatchCall ? IMAGE_GEN_BATCH_DEBOUNCE_MS : IMAGE_GEN_DEBOUNCE_MS;
                                if (nowImg - _lastImageGenAt < imgDebounce) {
                                    console.log('🎨 [ImageGen] Debounced — generation already in progress.');
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_running',
                                                message: 'Image generation is already in progress. Tell the user to wait — do NOT call generate_image again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _lastImageGenAt = nowImg;

                                console.log(`🎨 [ImageGen] prompt="${(call.args.prompt || '').slice(0, 60)}" style=${call.args.style} aspect=${call.args.aspect_ratio}`);

                                const _isBatch  = Array.isArray(call.args.subjects) && call.args.subjects.length > 1;
                                const _imgCount = _isBatch ? Math.min(call.args.subjects.length, 6) : 1;
                                const _badgeMsg = _isBatch ? `✨ Creating ${_imgCount} images...` : '✨ Creating image...';
                                const _ackMsg   = _isBatch
                                    ? `Say out loud right now: "Generating ${_imgCount} ${call.args.style || ''} images in parallel — this takes about 15 seconds." Do NOT call generate_image again.`
                                    : `Say out loud right now: "Generating your ${call.args.style || ''} image now, this will take a few seconds." Do NOT call generate_image again.`;

                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('show-status-message', _badgeMsg);
                                    mainWindowRef.webContents.send('image-generating-state', true);
                                }

                                // Immediate ack so Nova speaks while Imagen runs
                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: { status: 'ok', message: _ackMsg }
                                        }]
                                    });
                                } catch (_) {}

                                const _clearImageState = () => {
                                    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                        mainWindowRef.webContents.send('show-status-message', '');
                                        mainWindowRef.webContents.send('image-generating-state', false);
                                    }
                                };

                                if (automationRef && automationRef.generateImageTool) {
                                    automationRef.generateImageTool(call.args).then((result) => {
                                        if (!activeSession) return;
                                        _clearImageState();
                                        const speakText = result.speak || 'Done.';
                                        let injectPrompt;
                                        if (result.status === 'created') {
                                            injectPrompt = `[IMAGE CREATED] ${speakText} Say this out loud to the user right now. Do NOT call any tool.`;
                                        } else if (result.status === 'batch_created') {
                                            injectPrompt = `[BATCH IMAGES CREATED — ${result.count} images] ${speakText} Say this out loud to the user right now. Do NOT call any tool.`;
                                        } else {
                                            injectPrompt = `[IMAGE ERROR] ${speakText} Tell the user right now. Do NOT call any tool.`;
                                        }
                                        setTimeout(() => {
                                            try {
                                                if (activeSession) activeSession.sendRealtimeInput({ text: injectPrompt });
                                            } catch (e) {
                                                console.error('🎨 [ImageGen] Failed to inject result:', e.message);
                                            }
                                        }, 500);
                                    }).catch((e) => {
                                        console.error('🎨 [ImageGen] Unexpected error:', e.message);
                                        _clearImageState();
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[IMAGE ERROR] ${e.message}. Tell the user there was a problem generating the image. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }
                            } else if (call.name === 'video_editor_action') {
                                const { action } = call.args;
                                const veKey = action;
                                const nowVE = Date.now();

                                if (nowVE - (_videoEditorDebounce.get(veKey) || 0) < (VIDEO_EDITOR_DEBOUNCE_MS[veKey] || 5000)) {
                                    console.log(`🎬 [VideoEditor] Debounced duplicate: ${veKey}`);
                                    try {
                                        activeSession.sendRealtimeInput({
                                            functionResponses: [{ id: call.id, response: {
                                                status: 'already_running',
                                                message: 'This video editor action is already running. Tell the user to wait — do NOT call video_editor_action again.'
                                            }}]
                                        });
                                    } catch (_) {}
                                    return;
                                }
                                _videoEditorDebounce.set(veKey, nowVE);

                                console.log(`🎬 [VideoEditor] action="${action}" file="${call.args.file_name || ''}" instruction="${call.args.instruction || ''}"`);

                                const veStatusLabels = {
                                    list_projects:   '',  // no status bar flash — result is spoken immediately
                                    open_editor:     'Opening OpenShot...',
                                    import_file:     'Importing file...',
                                    add_to_timeline: 'Adding to timeline...',
                                    delete_clip:     'Deleting clip...',
                                    play_preview:    'Playing preview...',
                                    stop_preview:    'Stopping preview...',
                                    save_project:    'Saving project...',
                                    export_video:    'Opening export...',
                                    undo:            'Undoing...',
                                    redo:            'Redoing...',
                                    guide:           'Thinking...',
                                    close_editor:    'Closing editor...',
                                };
                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    mainWindowRef.webContents.send('show-status-message', veStatusLabels[action] || 'Video editing...');
                                }

                                const veAckMessages = {
                                    list_projects:   (() => {
                                        const projs = scanOspProjects();
                                        if (projs.length === 0) {
                                            return `Say: "You don't have any saved projects in your Videos folder yet. Would you like to create a new one? Just tell me a project name." Do NOT call list_projects again.`;
                                        }
                                        const numbered = projs.map((p, i) => `${i + 1}. ${p}`).join(', ');
                                        return `Say this out loud as a numbered list: "Here are your saved projects: ${numbered}. Which one would you like to open? Just say the number." Then call open_editor(project_mode='existing', file_name='<the chosen project name>') as soon as the user picks one. Do NOT call list_projects again.`;
                                    })(),
                                    open_editor:     `Say out loud: "Opening your project in the video editor now!" Then listen for the user.`,
                                    import_file:     `Say out loud: "Importing that video now!" Then listen for the result.`,
                                    add_to_timeline: `Say out loud: "Adding that to the timeline now!" Then listen for the result.`,
                                    delete_clip:     `Say out loud: "Deleting that clip now." Do NOT call video_editor_action again.`,
                                    play_preview:    `Say out loud: "Playing your video preview." Do NOT call video_editor_action again.`,
                                    stop_preview:    `Say out loud: "Stopping playback." Do NOT call video_editor_action again.`,
                                    save_project:    `Say out loud: "Saving your project now." Do NOT call video_editor_action again.`,
                                    export_video:    `Say out loud: "Opening the export dialog to render your final video." Do NOT call video_editor_action again.`,
                                    undo:            `Say out loud: "Undoing your last action." Do NOT call video_editor_action again.`,
                                    redo:            `Say out loud: "Redoing." Do NOT call video_editor_action again.`,
                                    guide:           `Say out loud: "I'm here to help." Do NOT call video_editor_action again.`,
                                    close_editor:    `Say out loud: "Closing the video editor session." Do NOT call video_editor_action again.`,
                                };

                                // Show / update the video editor panel on key actions
                                if (action === 'open_editor' && automationRef && automationRef.showVideoEditorPanel) {
                                    const panelProjs = scanOspProjects();
                                    const panelVids  = scanVideoFiles();
                                    automationRef.showVideoEditorPanel({
                                        projects: panelProjs,
                                        videos:   panelVids,
                                        currentProject: call.args.file_name || null,
                                        status: 'Opening editor...',
                                    });
                                } else if (action === 'import_file' && automationRef && automationRef.updateVideoEditorPanel) {
                                    automationRef.updateVideoEditorPanel({ status: `Importing: ${call.args.file_name || ''}` });
                                } else if (action === 'close_editor' && automationRef && automationRef.hideVideoEditorPanel) {
                                    automationRef.hideVideoEditorPanel();
                                }

                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: 'ok',
                                                message: veAckMessages[action] || `Acknowledged. Say briefly what you are doing for action: ${action}. Do NOT call video_editor_action again.`
                                            }
                                        }]
                                    });
                                } catch (_) {}

                                // list_projects is stateless — the ack already contains the full answer.
                                // Running the async tool would fire a duplicate injection that confuses Gemini.
                                if (action === 'list_projects') {
                                    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                        mainWindowRef.webContents.send('show-status-message', '');
                                    }
                                    // Nothing else to do — Gemini already received the list in the ack.
                                } else if (automationRef && automationRef.videoEditorTool) {
                                    automationRef.videoEditorTool(call.args).then((result) => {
                                        if (!activeSession) return;
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        const speakText = result.speak || 'Done.';
                                        let prompt;
                                        if (result.status === 'error') {
                                            prompt = `[VIDEO EDITOR ERROR] ${speakText} Tell the user exactly this. Do NOT call any tool.`;
                                        } else if (result.status === 'debounced') {
                                            prompt = `[VIDEO EDITOR BUSY] ${speakText} Tell the user to wait. Do NOT call any tool.`;
                                        } else if (result.status === 'needs_xdotool') {
                                            prompt = `[VIDEO EDITOR NEEDS XDOTOOL] ${speakText} Say this EXACTLY to the user — include the sudo pacman command. Do NOT call any tool.`;
                                        } else if (action === 'list_projects') {
                                            prompt = `[PROJECT LIST] ${speakText} Say this list out loud as numbered options. Wait for the user to say a number or name, then call open_editor(project_mode='existing', file_name='<chosen>') immediately.`;
                                        } else if (action === 'open_editor') {
                                            const vf = result.video_files || [];
                                            console.log(`🎬 [VideoEditor] Injecting EDITOR OPEN prompt`);
                                            prompt = `[EDITOR OPEN] Say this to the user RIGHT NOW: "The editor is open! Do you need help importing a video, or would you like help editing this project?" Then wait for their answer and take action.`;
                                            if (automationRef && automationRef.updateVideoEditorPanel) {
                                                automationRef.updateVideoEditorPanel({
                                                    videos: vf,
                                                    status: 'Editor ready — import or edit?',
                                                });
                                            }
                                        } else if (action === 'create_project') {
                                            prompt = `[PROJECT SAVED] ${speakText} Say this naturally, then ask: "What video files would you like to import? Just tell me the file name and I'll grab it from your Videos folder." Do NOT call any tool yet — wait for the user's answer.`;
                                        } else if (action === 'import_file') {
                                            const vf2 = scanVideoFiles();
                                            const listStr = vf2.length > 0
                                                ? ` Videos still available: ${vf2.slice(0, 8).map((f, i) => `${i + 1}. ${f}`).join(', ')}.`
                                                : '';
                                            console.log(`🎬 [VideoEditor] Injecting FILE IMPORTED prompt`);
                                            prompt = `[FILE IMPORTED] Say this to the user NOW: "${speakText}${listStr} Want to import another, or add this one to the timeline?" Then act on their answer immediately.`;
                                        } else if (action === 'close_editor') {
                                            prompt = `[VIDEO EDITOR CLOSED] ${speakText} Say this naturally and return to normal conversation. Do NOT call any tool.`;
                                        } else {
                                            prompt = `[VIDEO EDITOR ACTION DONE] ${speakText} Say this out loud, then ask what to do next. Do NOT call any tool until the user responds.`;
                                        }
                                        const injectDelay = 500; // fire fast — reduce echo window
                                        setTimeout(() => {
                                            try {
                                                console.log(`🎬 [VideoEditor] Sending injection for ${action}: ${prompt.slice(0, 80)}...`);
                                                if (activeSession) activeSession.sendRealtimeInput({ text: prompt });
                                                else console.warn('🎬 [VideoEditor] No active session — injection dropped');
                                            } catch (e) {
                                                console.error('🎬 [VideoEditor] Failed to inject result:', e.message);
                                            }
                                        }, injectDelay);
                                    }).catch((e) => {
                                        console.error('🎬 [VideoEditor] Unexpected error:', e.message);
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[VIDEO EDITOR ERROR] ${e.message}. Tell the user there was a problem. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                } // end if (list_projects) / else if (automationRef)
                            } else if (call.name === 'generate_video') {
                                const { action: vgAction } = call.args;
                                const nowVG = Date.now();

                                // Debounce: block duplicate generate calls while one is in flight
                                if (vgAction === 'generate') {
                                    if (_videoGenInFlight) {
                                        console.log('🎥 [VideoGen] Already generating — blocked duplicate');
                                        try {
                                            activeSession.sendRealtimeInput({
                                                functionResponses: [{ id: call.id, response: {
                                                    status: 'already_running',
                                                    message: 'A video is already being generated. Tell the user it takes 2-5 minutes — do NOT call generate_video again.'
                                                }}]
                                            });
                                        } catch (_) {}
                                        return;
                                    }
                                    if (nowVG - _lastVideoGenAt < VIDEO_GEN_DEBOUNCE_MS) {
                                        console.log('🎥 [VideoGen] Cooldown active — blocked');
                                        try {
                                            activeSession.sendRealtimeInput({
                                                functionResponses: [{ id: call.id, response: {
                                                    status: 'cooldown',
                                                    message: 'Video generation just completed — tell the user to wait a moment before generating another. Do NOT call generate_video again.'
                                                }}]
                                            });
                                        } catch (_) {}
                                        return;
                                    }
                                }

                                console.log(`🎥 [VideoGen] action="${vgAction}"`);

                                if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                    const statusLabels = {
                                        generate:       'Generating video... (2-5 min)',
                                        list_prompts:   'Loading video prompts...',
                                        delete_prompt:  'Deleting prompt...',
                                    };
                                    mainWindowRef.webContents.send('show-status-message', statusLabels[vgAction] || 'Processing video...');
                                }

                                const vgAckMessages = {
                                    generate:      `Say out loud right now: "I have everything I need — creating your video now! This takes about 2 to 5 minutes. I'll let you know the moment it's ready. Feel free to chat while you wait!" Do NOT call generate_video again.`,
                                    list_prompts:  `Say out loud: "Let me pull up your saved video prompts." Do NOT call generate_video again.`,
                                    delete_prompt: `Say out loud: "Deleting that prompt now." Do NOT call generate_video again.`,
                                };

                                try {
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                status: 'ok',
                                                message: vgAckMessages[vgAction] || `Acknowledged. Say briefly what you are doing. Do NOT call generate_video again.`
                                            }
                                        }]
                                    });
                                } catch (_) {}

                                if (vgAction === 'generate') {
                                    _videoGenInFlight = true;
                                    _lastVideoGenAt   = nowVG;
                                }

                                if (automationRef && automationRef.videoGenTool) {
                                    automationRef.videoGenTool(call.args).then((result) => {
                                        _videoGenInFlight = false;
                                        if (vgAction === 'generate') _lastVideoGenAt = Date.now();

                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (!activeSession) return;

                                        const speakText = result.speak || 'Done.';
                                        let injectPrompt;
                                        if (result.status === 'error') {
                                            injectPrompt = `[VIDEO GEN ERROR] ${speakText} Tell the user naturally and ask if they want to try again or adjust the details. Do NOT call any tool.`;
                                        } else if (vgAction === 'list_prompts') {
                                            injectPrompt = `[VIDEO PROMPTS] ${speakText} Read the list to the user. If they want to reuse one, ask what to change then call generate_video with the improved details. Do NOT call any tool until they respond.`;
                                        } else if (vgAction === 'delete_prompt') {
                                            injectPrompt = `[VIDEO PROMPT DELETED] ${speakText} Say this naturally. Do NOT call any tool.`;
                                        } else {
                                            injectPrompt = `[VIDEO READY] ${speakText} Say this enthusiastically — the video is in their Videos folder and is now opening. Ask how it looks and if anything needs improving. Do NOT call any tool until they respond.`;
                                        }

                                        const delay = vgAction === 'generate' ? 1000 : 700;
                                        setTimeout(() => {
                                            try {
                                                if (activeSession) activeSession.sendRealtimeInput({ text: injectPrompt });
                                            } catch (e) {
                                                console.error('🎥 [VideoGen] Failed to inject result:', e.message);
                                            }
                                        }, delay);
                                    }).catch((e) => {
                                        _videoGenInFlight = false;
                                        console.error('🎥 [VideoGen] Unexpected error:', e.message);
                                        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                                            mainWindowRef.webContents.send('show-status-message', '');
                                        }
                                        if (activeSession) {
                                            try {
                                                activeSession.sendRealtimeInput({ text: `[VIDEO GEN ERROR] ${e.message}. Tell the user there was a problem and ask if they want to try again. Do NOT call any tool.` });
                                            } catch (_) {}
                                        }
                                    });
                                }
                            }
                        }
                    }
                },
                onerror: (e) => {
                    console.error('❌ Gemini Live WebSocket Error:', e.message);
                    mainWindow.webContents.send('live-session-event', { event: 'error', message: e.message });
                },
                onclose: () => {
                    console.log('🏁 Gemini Live Session Closed.');
                    activeSession = null;
                    _emailInFlight = false;
                    _emailLastCompletedAt = 0;
                    _emailModeActive = false;
                    _listContactsLastAt = 0;
                    _videoGenInFlight = false;
                    mainWindow.webContents.send('live-session-event', { event: 'closed' });
                },
            },
        });

    } catch (err) {
        console.error('❌ Failed to start live session:', err);
        activeSession = null;
    }
}

function sendAudioChunk(base64Data) {
    if (activeSession) {
        try {
            activeSession.sendRealtimeInput({
                audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
            });
        } catch (e) {
            console.error("❌ Failed to send audio input:", e);
        }
    }
}

function sendTextChunk(text) {
    if (activeSession) {
        try {
            activeSession.sendRealtimeInput({ text: text });
        } catch (e) {
            console.error("❌ Failed to send text input:", e);
        }
    }
}

function endLiveSession() {
    if (activeSession) {
        console.log('🛑 Terminating Live Session...');
        activeSession = null;
    }
    _emailInFlight = false;
    _emailLastCompletedAt = 0;
    _emailModeActive = false;
    _listContactsLastAt = 0;
    _videoGenInFlight = false;
}

function setBrowserOpen(value) {
    _browserIsOpen = value;
    if (!value) {
        _storeAssistantActive = false; // browser closed — exit store mode
        _lastAutoScanUrl = '';
        _stuckClickCount = 0;
    }
}

function setStoreAssistantActive(value) {
    _storeAssistantActive = value;
    console.log(`🛍️ [Live] Store assistant mode: ${value}`);
}

module.exports = {
    startLiveSession,
    sendAudioChunk,
    sendTextChunk,
    endLiveSession,
    setBrowserOpen,
    setStoreAssistantActive
};
