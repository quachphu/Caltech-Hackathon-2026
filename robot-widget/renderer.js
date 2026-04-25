/**
 * renderer.js — Nova AI desktop widget
 * Orb-based UI with voice + Gemini Live integration.
 */

// Electron Native Modules
const { ipcRenderer } = window.require('electron');
const fs = window.require('fs');
const path = window.require('path');

let isDragging = false;

// Search & Automation Global State (Attached to window for absolute scoping in module context)
window.novaState = {
    pendingChoices: [],
    pendingTopic: null,
    isAwaitingPlatform: false,
    isProcessingCommand: false,
    isSpeaking: false,
    currentPlatform: null,
    isAwake: false,
    isInConversation: false,
    isSilenced: false,
    lastDirectCommandTime: 0,
    lastDirectCommandText: '',
    isResearching: false,
    researchJustCompleted: 0,
    isInResearchPaperMode: false,  // True while a research paper is open — Nova stays as paper guide
    lastResearchTopic: null        // Topic of the last completed paper (for context re-injection)
};

window.novaVoice = {
    wakeUp: null,
    endConversation: null,
    startRecording: null,
    stopRecording: null
};

window.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
        isDragging = true;
        ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY });
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        ipcRenderer.send('drag-move', { x: e.screenX, y: e.screenY });
    }
});

window.addEventListener('mouseup', () => {
    if (isDragging) {
        ipcRenderer.send('drag-end');
    }
    isDragging = false;
});

// Double-click on orb opens chat
window.addEventListener('dblclick', () => {
    ipcRenderer.send('open-chat');
});

// ── Widget State Management ────────────────────────────────────────────────
const novaWidget = document.getElementById('widget');

function setOrbState(state) {
    if (!novaWidget) return;
    novaWidget.classList.remove('listening', 'speaking', 'thinking');
    if (state) novaWidget.classList.add(state);
}

// Poll novaState and reflect it on the badge visually
setInterval(() => {
    if (window.novaState.isResearching || window.novaState.isProcessingCommand) {
        setOrbState('thinking');
    } else if (window.novaState.isSpeaking) {
        setOrbState('speaking');
    } else if (window.novaState.isAwake) {
        setOrbState('listening');
    } else {
        setOrbState(null);
    }
}, 100);

// ── Expressive Movement Control ────────────────────────────────────────────
// Conversation mode → Nova wanders expressively, movement character driven by
// emotional state (listening / speaking / thinking).
// Task mode → Nova snaps back to bottom-right corner (focused / serious).
let _prevNovaBounceState = null;
let _prevNovaMoveMode    = null;
setInterval(() => {
    // Active wander only when in pure conversation — no task running
    const shouldWander = window.novaState.isAwake &&
        !window.novaState.isProcessingCommand &&
        !window.novaState.isResearching &&
        !window.novaState.isAwaitingPlatform &&
        window.novaState.pendingChoices.length === 0;

    if (shouldWander !== _prevNovaBounceState) {
        _prevNovaBounceState = shouldWander;
        if (shouldWander) {
            ipcRenderer.send('nova-bounce-start');
        } else {
            ipcRenderer.send('nova-bounce-stop');
        }
    }

    // While wandering, keep main.js updated on the emotional state so it can
    // adjust movement character in real-time (no need to restart the interval)
    if (shouldWander) {
        let mode;
        if (window.novaState.isSpeaking) {
            mode = 'speaking';   // Nova is talking — animated, expressive
        } else if (window.novaState.isProcessingCommand || window.novaState.isResearching) {
            mode = 'thinking';   // Brief thinking moment before a task locks in
        } else {
            mode = 'listening';  // Nova is waiting / listening — gentle drift
        }
        if (mode !== _prevNovaMoveMode) {
            _prevNovaMoveMode = mode;
            ipcRenderer.send('nova-move-state', mode);
        }
    } else {
        _prevNovaMoveMode = null; // Reset so next conversation starts fresh
    }
}, 150);

window.onerror = function (msg, url, line, col, error) {
    console.error("Window Error: ", msg, url, line, col, error);
};

window.addEventListener('unhandledrejection', function (event) {
    console.error('Unhandled Rejection: ', event.reason);
});


// ── TTS & Offline Voice Recognition (VOSK) ─────────────────────────────────
let currentAudio = null;
let recognizer = null;

// ── Audio Playback (for Gemini TTS WAV files) ─────────────────────────────
let geminiAudioContext = new window.AudioContext({ sampleRate: 24000 });

function stopAllPlayback() {
    // Stop Piper/Local TTS
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = ""; // Clear src to stop loading
        currentAudio = null;
    }
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    window.novaState.isSpeaking = false;
}


// ── Nova Conversational Response via Gemini ─────────────────────────────────
async function askNova(text) {
    if (window.novaState.isProcessingCommand || window.novaState.isAwaitingPlatform || window.novaState.pendingChoices.length > 0) {
        console.log('🤫 Silencing Nova because an action is in progress.');
        return;
    }
    stopAllPlayback();
    window.novaState.isSpeaking = true;
    listeningSymbol.innerHTML = '🤖 Thinking...';
    listeningSymbol.style.display = 'block';
    console.log(`📡 Sending to Gemini: "${text}"`);
    try {
        const reply = await ipcRenderer.invoke('ask-grok', text);
        if (reply) {
            console.log('🤖 Nova:', reply);
            await speak(reply);
        }
    } catch (e) {
        console.error('Nova response error:', e);
        window.novaState.isSpeaking = false;
        listeningSymbol.style.display = 'none';
    }
}


// Speak function for automation responses
// Speak function for automation responses
async function speak(text) {
    if (!text) return;

    // Stop any current speech/audio across all engines
    stopAllPlayback();

    // Safety: Reset speaking state
    window.novaState.isSpeaking = false;
    listeningSymbol.style.opacity = '1';

    let hasStartedAnySpeech = false;

    const useWebSpeech = (txt) => {
        if (hasStartedAnySpeech) return;
        hasStartedAnySpeech = true;
        if (!('speechSynthesis' in window)) return;
        window.novaState.isSpeaking = true;
        const utterance = new SpeechSynthesisUtterance(txt);
        utterance.rate = 0.9;
        utterance.onend = () => {
            window.novaState.isSpeaking = false;
            listeningSymbol.style.opacity = '1';
            listeningSymbol.style.display = 'none';
            if (window.novaState.isAwake && window.novaVoice.startRecording) {
                setTimeout(() => window.novaVoice.startRecording(), 1000);
            }
        };
        utterance.onerror = () => {
            window.novaState.isSpeaking = false;
            listeningSymbol.style.opacity = '1';
        };
        speechSynthesis.speak(utterance);
        uiLog(`🔊 Voice (Web Speech): "${txt}"`);
    };

    try {
        console.log('🔊 Generating Piper speech for:', text);
        const audioPath = await ipcRenderer.invoke('generate-speech', text);

        if (audioPath) {
            console.log('🔊 Audio generated at:', audioPath);
            const audio = new Audio();
            currentAudio = audio; // Track this so we can cancel it

            audio.addEventListener('error', (e) => {
                console.error('🔊 Audio error, falling back to Web Speech:', e);
                useWebSpeech(text);
            });

            audio.addEventListener('loadeddata', () => {
                if (hasStartedAnySpeech) {
                    audio.pause();
                    audio.src = "";
                    return;
                }
                hasStartedAnySpeech = true;
                window.novaState.isSpeaking = true;
                listeningSymbol.innerHTML = '🔊 Speaking...';
                listeningSymbol.style.color = '#fff';
                listeningSymbol.style.opacity = '0.5';

                audio.play().then(() => {
                    uiLog(`🔊 Voice (Piper): "${text}"`);
                }).catch(err => {
                    console.error('🔊 Audio play error, falling back to Web Speech:', err);
                    useWebSpeech(text);
                });
            });

            audio.addEventListener('ended', () => {
                if (currentAudio === audio) currentAudio = null;
                window.novaState.isSpeaking = false;
                listeningSymbol.style.opacity = '1';
                listeningSymbol.style.display = 'none';
                if (window.novaState.isAwake && window.novaVoice.startRecording) {
                    setTimeout(() => window.novaVoice.startRecording(), 1000);
                }
            });

            // Safety timeout: Reset isSpeaking after 15s max if it gets stuck
            setTimeout(() => {
                if (window.novaState.isSpeaking && currentAudio === audio) {
                    window.novaState.isSpeaking = false;
                    listeningSymbol.style.opacity = '1';
                }
            }, 15000);

            // Add small delay to avoid race condition with file system and retry if needed
            let retryCount = 0;
            const loadAudio = () => {
                audio.src = `appassets:///${audioPath}`;
                currentAudio = audio;
                audio.load();
            };

            setTimeout(loadAudio, 150);
        } else {
            // Fallback if no audio path returned
            useWebSpeech(text);
        }
    } catch (error) {
        console.error('🔊 Speech system error, falling back to Web Speech:', error);
        useWebSpeech(text);
    }
}

// listeningSymbol kept as a detached element — logic uses it internally but it is never shown
let listeningSymbol = document.createElement('div');
listeningSymbol.innerHTML = '🎤 Listening...';
listeningSymbol.style.display = 'none';

// subtitleElement kept as a detached element — logic uses it internally but it is never shown
let subtitleElement = document.createElement('div');
subtitleElement.id = 'subtitle';
subtitleElement.style.display = 'none';

function uiLog(msg) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`[UI LOG ${timestamp}] ${msg}`);
}

ipcRenderer.on('automation-log', (event, msg) => {
    uiLog(msg);
});

let choicesOverlay = null;
function showChoices(choices) {
    if (!choicesOverlay) {
        choicesOverlay = document.createElement('div');
        choicesOverlay.id = 'choices-overlay';
        choicesOverlay.style.position = 'absolute';
        choicesOverlay.style.top = '50%';
        choicesOverlay.style.left = '50%';
        choicesOverlay.style.transform = 'translate(-50%, -50%)';
        choicesOverlay.style.width = '200px';
        choicesOverlay.style.backgroundColor = 'rgba(0, 20, 40, 0.9)';
        choicesOverlay.style.border = '2px solid #0ff';
        choicesOverlay.style.borderRadius = '10px';
        choicesOverlay.style.padding = '10px';
        choicesOverlay.style.zIndex = '1000';
        choicesOverlay.style.boxShadow = '0 0 15px #0ff';
        choicesOverlay.style.color = '#fff';
        choicesOverlay.style.fontFamily = 'sans-serif';
        document.body.appendChild(choicesOverlay);
    }

    choicesOverlay.innerHTML = '<div style="font-weight: bold; border-bottom: 1px solid #0ff; margin-bottom: 10px; text-align: center; font-size: 14px;">Select match:</div>';
    choicesOverlay.style.display = 'block';

    choices.forEach((choice, index) => {
        const btn = document.createElement('div');
        btn.innerText = `${index + 1}. ${choice.title}`;
        btn.style.cursor = 'pointer';
        btn.style.padding = '8px';
        btn.style.margin = '5px 0';
        btn.style.border = '1px solid rgba(0, 255, 255, 0.2)';
        btn.style.borderRadius = '5px';
        btn.style.fontSize = '12px';
        btn.style.transition = 'all 0.2s';

        btn.onmouseover = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.2)';
            btn.style.borderColor = '#0ff';
        };
        btn.onmouseout = () => {
            btn.style.backgroundColor = 'transparent';
            btn.style.borderColor = 'rgba(0, 255, 255, 0.2)';
        };

        btn.onclick = () => {
            window.novaState.pendingTopic = choice.title;
            window.novaState.isAwaitingPlatform = true;
            showPlatformChoices();
            speak(`Great choice: ${window.novaState.pendingTopic}. Would you like to search for this on Google or YouTube?`);
            uiLog(`📌 Selected topic: ${window.novaState.pendingTopic}. Awaiting platform choice...`);
        };
        choicesOverlay.appendChild(btn);
    });
}

function showPlatformChoices() {
    if (!choicesOverlay) return;
    choicesOverlay.innerHTML = `
        <div style="font-weight: bold; border-bottom: 1px solid #0ff; margin-bottom: 10px; text-align: center; font-size: 14px;">
            Topic: ${window.novaState.pendingTopic}
        </div>
        <div style="text-align: center; margin-bottom: 10px; font-size: 12px;">Search on:</div>
    `;

    const platforms = [
        { name: '🌐 Google Search', value: 'google' },
        { name: '🎬 YouTube Video', value: 'youtube' }
    ];

    platforms.forEach(p => {
        const btn = document.createElement('div');
        btn.innerText = p.name;
        btn.style.cursor = 'pointer';
        btn.style.padding = '10px';
        btn.style.margin = '8px 0';
        btn.style.border = '1px solid #0ff';
        btn.style.borderRadius = '5px';
        btn.style.textAlign = 'center';
        btn.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
        btn.style.fontSize = '13px';
        btn.style.transition = 'all 0.2s';

        btn.onmouseover = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.3)';
            btn.style.transform = 'scale(1.05)';
        };
        btn.onmouseout = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
            btn.style.transform = 'scale(1)';
        };

        btn.onclick = () => {
            const platform = p.value;
            const query = window.novaState.pendingTopic;
            uiLog(`🌐 Opening ${platform} for: ${query}`);
            speak(`Searching ${platform} for ${query}`);
            ipcRenderer.invoke('browser-open', { platform, query });
            window.novaState.isAwaitingPlatform = false;
            window.novaState.pendingTopic = null;
            hideChoices();
        };
        choicesOverlay.appendChild(btn);
    });
}

function hideChoices() {
    if (choicesOverlay) {
        choicesOverlay.style.display = 'none';
        choicesOverlay.innerHTML = '';
    }
    window.novaState.pendingChoices = []; // CRITICAL: Clear choices state
}

// ── Research Paper Overlay ────────────────────────────────────────────────

let researchOverlay = null;

function showResearchOverlay(topic) {
    if (!researchOverlay) {
        researchOverlay = document.createElement('div');
        researchOverlay.id = 'research-overlay';
        document.body.appendChild(researchOverlay);
    }
    researchOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(2, 6, 24, 0.97);
        border: 1px solid rgba(0, 210, 255, 0.40);
        border-radius: 12px;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 99999; padding: 24px 22px 20px;
        box-shadow: 0 0 40px rgba(0, 180, 255, 0.22), inset 0 0 20px rgba(0, 0, 40, 0.5);
        font-family: monospace;
    `;
    researchOverlay.innerHTML = `
        <style>
            @keyframes nova-spin   { to { transform: rotate( 360deg); } }
            @keyframes nova-spin-r { to { transform: rotate(-360deg); } }
            @keyframes nova-pulse  { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
            @keyframes nova-scan   { 0%{left:-40%;} 100%{left:110%;} }
            @keyframes nova-dot    { 0%,80%,100%{opacity:0.2;} 40%{opacity:1;} }
        </style>

        <!-- Dual spinner -->
        <div style="position:relative;width:52px;height:52px;margin-bottom:16px;flex-shrink:0;">
            <div style="width:52px;height:52px;border:2.5px solid rgba(0,220,255,0.12);border-top:2.5px solid #0df;border-radius:50%;animation:nova-spin 1.1s linear infinite;position:absolute;"></div>
            <div style="width:34px;height:34px;border:2px solid rgba(0,180,255,0.10);border-bottom:2px solid #0af;border-radius:50%;animation:nova-spin-r 0.7s linear infinite;position:absolute;top:9px;left:9px;"></div>
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:#0df;box-shadow:0 0 8px #0df;animation:nova-pulse 1.4s ease-in-out infinite;"></div>
        </div>

        <!-- Title -->
        <div style="color:#0df;font-size:11px;font-weight:bold;letter-spacing:3px;text-shadow:0 0 10px #0df;animation:nova-pulse 2s ease-in-out infinite;margin-bottom:8px;text-align:center;">
            NOVA RESEARCH ENGINE
        </div>

        <!-- Topic -->
        <div style="color:#8be;font-size:9.5px;text-align:center;margin-bottom:14px;max-width:290px;line-height:1.55;word-break:break-word;font-style:italic;opacity:0.85;">
            "${topic}"
        </div>

        <!-- Progress bar -->
        <div style="width:100%;height:3px;background:rgba(0,200,255,0.10);border-radius:2px;margin-bottom:12px;overflow:hidden;position:relative;">
            <div style="position:absolute;height:100%;width:40%;background:linear-gradient(90deg,transparent,#0df,transparent);border-radius:2px;animation:nova-scan 1.6s ease-in-out infinite;"></div>
        </div>

        <!-- Current step -->
        <div id="nova-research-status" style="color:#7ce;font-size:9px;text-align:center;max-width:295px;line-height:1.65;min-height:30px;word-break:break-word;margin-bottom:10px;">
            Initializing research engines...
        </div>

        <!-- Step log (last 4 steps) -->
        <div id="nova-research-log" style="width:100%;background:rgba(0,180,255,0.05);border:1px solid rgba(0,180,255,0.12);border-radius:6px;padding:6px 8px;max-height:72px;overflow:hidden;display:flex;flex-direction:column;gap:2px;">
        </div>

        <!-- Footer -->
        <div style="margin-top:12px;color:rgba(255,160,0,0.60);font-size:7.5px;text-align:center;letter-spacing:1.5px;">
            VOICE PAUSED &bull; RESEARCH IN PROGRESS
        </div>
    `;
    researchOverlay.style.display = 'flex';
    window._researchStepCount = 0;
}

function updateResearchStatus(message) {
    const statusEl = document.getElementById('nova-research-status');
    if (statusEl) statusEl.innerText = message;

    // Append to step log (keep last 4)
    const logEl = document.getElementById('nova-research-log');
    if (logEl) {
        window._researchStepCount = (window._researchStepCount || 0) + 1;
        const row = document.createElement('div');
        row.style.cssText = 'color:rgba(100,200,255,0.65);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        row.innerText = `› ${message}`;
        logEl.appendChild(row);
        // Keep only last 4 rows
        while (logEl.children.length > 4) logEl.removeChild(logEl.firstChild);
    }
}

function hideResearchOverlay() {
    if (researchOverlay) {
        researchOverlay.style.display = 'none';
    }
}

/**
 * After a Live session starts (or restarts), re-inject research paper context
 * so Gemini doesn't forget the paper mid-conversation.
 * Called with a delay to let the session fully connect before injecting.
 */
function injectPaperContextIfNeeded(delayMs = 3500) {
    if (!window.novaState.isInResearchPaperMode) return;
    const topic = window.novaState.lastResearchTopic || 'the research paper';
    setTimeout(() => {
        if (!window.novaState.isInResearchPaperMode) return;
        if (!window.novaState.isLiveActive) return;
        ipcRenderer.send('live-text-chunk',
            `[PAPER OPEN — RESEARCH MODE ACTIVE] ` +
            `A research paper on "${topic}" is currently open in Nova's browser. ` +
            `You are in RESEARCH PAPER MODE. ` +
            `Your ONLY job right now is to answer questions about this paper: its content, findings, sources, methodology, citations, conclusions, and summary. ` +
            `Do NOT deviate to other topics. Do NOT say you don't have access to the paper — you wrote it. ` +
            `Keep the browser open. Do NOT call any tools. ` +
            `STAY in Research Paper Mode until the user explicitly says "close the browser" or "close the paper".`
        );
        uiLog(`📄 [Research Mode] Context re-injected for "${topic}"`);
    }, delayMs);
}

// IPC: Research paper lifecycle events
ipcRenderer.on('research-paper-started', (event, { topic }) => {
    window.novaState.isResearching = true;
    window.novaState.lastResearchTopic = topic; // remember for context injection on session restart
    stopAllPlayback();
    showResearchOverlay(topic);
    listeningSymbol.style.display = 'none';
    subtitleElement.style.display = 'none';
    uiLog(`📄 Research started: "${topic}"`);
});

ipcRenderer.on('research-paper-progress', (event, { step, detail }) => {
    // Show overlay in case it wasn't shown yet (fallback)
    if (window.novaState.isResearching) {
        updateResearchStatus(detail);
    }
    uiLog(`📄 ${detail}`);
});

ipcRenderer.on('research-paper-done', (event, data) => {
    window.novaState.isResearching = false;
    window.novaState.researchJustCompleted = Date.now(); // 60-second cooldown
    window.novaState.isProcessingCommand = false;
    window.novaState.isAwaitingPlatform = false;
    hideResearchOverlay();
    subtitleElement.style.display = '';  // Restore subtitle visibility
    listeningSymbol.style.display = 'block';

    if (data.success) {
        const name = data.fileName || 'the research paper';
        const topic = window.novaState.lastResearchTopic || name;
        uiLog(`✅ Research paper saved: ${name}`);

        // Mark Nova as being in research paper mode — survives session restarts
        window.novaState.isInResearchPaperMode = true;

        // Route through Gemini Live if active so the conversation pipeline stays alive.
        // Small delay lets the audio gate (isResearching=false) open before we send.
        setTimeout(() => {
            if (window.novaState.isLiveActive) {
                // Put Nova into research paper Q&A mode — stay until user closes browser
                ipcRenderer.send('live-text-chunk',
                    `[PAPER DONE] Research paper "${name}" is complete and now displaying in Nova's browser. ` +
                    `Announce to the user that their paper is ready. ` +
                    `Then enter RESEARCH PAPER MODE: you are now the expert guide for this paper on "${topic}". ` +
                    `Answer any questions about the paper's content, findings, sources, methodology, citations, or summary. ` +
                    `STAY in Research Paper Mode and keep the browser open. ` +
                    `Do NOT close the browser. Do NOT call any tools. ` +
                    `Only exit this mode when the user explicitly says "close the browser" or "close the paper".`
                );
            } else {
                // Live session timed out during the long research — restart it then speak
                speak(`Research paper complete. It's now open in my browser. Feel free to ask me anything about it.`);
                // Restart Gemini Live so future voice commands still work
                setTimeout(() => {
                    ipcRenderer.send('live-start');
                    uiLog('🔄 Restarting Gemini Live after research completion.');
                    injectPaperContextIfNeeded(3500);
                }, 1500);
            }
        }, 600);
    } else {
        uiLog(`❌ Research paper failed: ${data.error || 'Unknown error'}`);
        speak(`I ran into a problem generating the research paper. Please try again.`);
    }
});

// Show/hide a small status badge below the Nova widget during async tool fetches
// (e.g. "Checking your calendar..." while the Google Calendar API call runs).
const _statusBadge = document.getElementById('nova-status-badge');
ipcRenderer.on('show-status-message', (_e, msg) => {
    if (!_statusBadge) return;
    if (msg) {
        _statusBadge.textContent = msg;
        _statusBadge.style.display = 'flex';
    } else {
        _statusBadge.style.display = 'none';
        _statusBadge.textContent = '';
    }
});

// Image generation visual state — purple creative pulse on the robot + tinted badge
const _widget = document.getElementById('widget');
ipcRenderer.on('image-generating-state', (_e, active) => {
    if (!_widget || !_statusBadge) return;
    if (active) {
        _widget.classList.add('generating');
        _statusBadge.classList.add('image-gen');
    } else {
        _widget.classList.remove('generating');
        _statusBadge.classList.remove('image-gen');
    }
});

// When the browser window is closed (by user clicking X or via voice command),
// exit research paper mode so context is no longer injected on reconnect.
ipcRenderer.on('browser-window-closed', () => {
    if (window.novaState.isInResearchPaperMode) {
        window.novaState.isInResearchPaperMode = false;
        uiLog('📄 Research Paper Mode ended (browser closed)');
    }
});

// Calendar panel is in its own floating window (calendar_panel.html).
// Log events for debugging when the panel window opens.
ipcRenderer.on('calendar-events', (event, { events, timeExpression }) => {
    uiLog(`📅 Calendar panel: ${(events || []).length} event(s) for "${timeExpression || 'today'}"`);
});

// Macro recording state — adds/removes red pulsing glow on the orb widget.
ipcRenderer.on('macro-recording-started', () => {
    document.getElementById('widget').classList.add('recording');
    uiLog('🎙️ Macro recording started');
});
ipcRenderer.on('macro-recording-stopped', () => {
    document.getElementById('widget').classList.remove('recording');
    uiLog('🎙️ Macro recording stopped');
});

async function analyzeScreen(userText) {
    try {
        uiLog('📸 Capturing screen for vision analysis...');
        const screenshot = await ipcRenderer.invoke('capture-screen');
        if (!screenshot) {
            uiLog('❌ Screen capture failed.');
            return null;
        }

        const visionPrompt = `The user is looking at this screen and said: "${userText}".
        Identify if there is a video player on screen (like YouTube) or a play button.
        If the user wants to "play it", look for a video player or an active video thumbnail.

        Return ONLY a JSON object: { "found": true, "title": "...", "url": "...", "platform": "youtube", "is_video_player": true|false }
        
        CRITICAL:
        1. If "is_video_player" is true, the user is likely on a video page.
        2. If you can see or infer the direct URL, provide it.
        3. If it is a YouTube video and you can\u2019t get the exact URL, provide the title.
        4. "Play it" implies the user wants to play what's currently on screen or selected.`;

        // Use Gemini via the ask-grok IPC but send screenshot context separately
        // Since the main gemini.js only accepts text, we send a text description request.
        // For a full vision call we pass the screenshot through a direct Gemini SDK call.
        const { GoogleGenAI } = window.require('@google/genai');
        const dotenv = window.require('dotenv');
        dotenv.config();
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        // Extract base64 from data URL
        const base64Image = screenshot.replace(/^data:image\/\w+;base64,/, '');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{
                parts: [
                    { inlineData: { mimeType: 'image/png', data: base64Image } },
                    { text: visionPrompt }
                ]
            }]
        });

        const content = response.text.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        console.log('👁️ Vision result:', result);
        return result;
    } catch (e) {
        console.error('👁️ Vision error:', e);
        return null;
    }
}


async function initOfflineVoice() {
    try {
        uiLog("1/3 Requesting Microphone...");
        const mediaStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 16000
            }
        });

        uiLog("2/3 Loading AI Voice Model (40MB)...");
        const modelUrl = 'appassets://model.tar.gz';
        const model = await window.Vosk.createModel(modelUrl);
        uiLog("3/3 AI Engine Ready!");

        recognizer = new model.KaldiRecognizer(16000); // Restore full vocabulary for better wake-word coverage
        recognizer.setWords(true);

        let accumulatedSpeech = "";
        let sleepTimer;
        let speechTimer = null;
        let lastUserCommand = ""; // Track last command for context awareness
        let silenceThreshold = 0.01; // Volume threshold for silence
        let silenceDuration = 2500; // MS of silence to trigger Whisper
        let lastAudioTime = Date.now();

        const startRecording = async () => { }; // STUB
        const stopRecording = () => { }; // STUB

        const wakeUp = () => {
            stopAllPlayback();
            window.novaState.isAwake = true;
            window.novaState.isInConversation = true;

            // Notify backend wrapper to open ai.live.connect WebSockets!
            ipcRenderer.send('live-start');

            // If a research paper is still open, re-inject context once the session connects
            injectPaperContextIfNeeded(3500);

            // Deliver any pending store greeting (queued while Nova was asleep)
            if (window._pendingStoreGreeting) {
                const greet = window._pendingStoreGreeting;
                window._pendingStoreGreeting = null;
                // Short delay so the live session has time to fully connect first
                setTimeout(() => {
                    if (window.novaState.isAwake) {
                        ipcRenderer.send('live-text-chunk', greet);
                    }
                }, 2000);
            }

            clearTimeout(sleepTimer);
            sleepTimer = setTimeout(() => {
                window.novaState.isAwake = false;
                window.novaState.isInConversation = false;
                uiLog("💤 Entered Sleep Mode");
                ipcRenderer.send('live-end');
            }, 300000); // 5 minutes — keeps session alive during long conversations
        };

        const endConversation = () => {
            window.novaState.isAwake = false;
            window.novaState.isInConversation = false;
            accumulatedSpeech = "";
            clearTimeout(sleepTimer);
            ipcRenderer.send('live-end');
            uiLog("👋 Conversation ended. Say 'Hey Nova' to start again.");
        };

        // Expose to global scope via window.novaVoice
        window.novaVoice.startRecording = startRecording;
        window.novaVoice.stopRecording = stopRecording;
        window.novaVoice.wakeUp = wakeUp;
        window.novaVoice.endConversation = endConversation;

        // Listen dynamically as the user speaks words
        recognizer.on("partialresult", (message) => {
            if (window.novaState.isSpeaking) return; // Prevent loop where Nova hears itself
            const text = message.result.partial.toLowerCase();
            if (!text) return;

            // Start recording as soon as we hear a potential wake word or direct control
            if (!window.novaState.isAwake && text.match(/\b(hey|hay|hi|play|look|see|volume|lower|higher|quieter|louder|stop|pause)\b/i)) {
                window.novaVoice.wakeUp();
                window.novaVoice.startRecording();
            }

            // INSTANT WAKE: Unsilence immediately if wake word is heard in partials
            const wakeRegex = /\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noiva|noah|noa|know|no|know a)\b/i;
            if (window.novaState.isSilenced && text.match(wakeRegex)) {
                window.novaState.isSilenced = false;
                uiLog("🔔 Instant Wake detected in Partial (Unsilencing)");
            }

            if (window.novaState.isAwake) {
                listeningSymbol.innerHTML = window.novaState.isInConversation ? '🎤 Continuing conversation...' : '🎤 Listening...';
                listeningSymbol.style.color = '#0ff';
                listeningSymbol.style.display = 'block';

                // Hide [unk] from the subtitle to avoid confusion
                const cleanText = text.replace(/\[unk\]/g, '').trim();
                if (cleanText) {
                    // SILENCE VISIBILITY: Hide transcripts if silenced
                    if (!window.novaState.isSilenced) {
                        subtitleElement.innerText = cleanText;
                    } else {
                        subtitleElement.innerText = "";
                    }
                    uiLog(`Partial (Vosk): "${cleanText}"`);
                }

                clearTimeout(sleepTimer);
                clearTimeout(speechTimer);
            }
        });

        // Triggered when user finishes sentence and falls silent
        recognizer.on("result", (message) => {
            if (window.novaState.isSpeaking && !message.result.text.match(/\b(stop|quiet|hush|cancel)\b/i)) return; // Allow early exit interruptions but block self-talk
            let text = message.result.text.toLowerCase().trim();

            // Filter [unk] from final result
            text = text.replace(/\[unk\]/g, '').trim();
            if (!text) return;

            // WAKE WORD DETECTION (Instant Wake)
            const wakeRegex = /\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noiva|noah|noa|know|no|know a)\b/i;
            if (text.match(wakeRegex)) {
                if (window.novaState.isSilenced) {
                    console.log("🔔 Instant Wake detected in Vosk (Unsilencing)");
                    window.novaState.isSilenced = false;
                    uiLog("🔔 Nova is back!");
                }
            }

            // SILENCE MODE: Ignore everything except the wake word if silenced
            if (text) window.novaState.lastVoskText = text;

            if (window.novaState.isSilenced && !text.match(wakeRegex)) {
                console.log("🤫 Vosk Ignored (Silenced Mode):", text);
                subtitleElement.innerText = ""; // Ensure UI is clean
                return;
            }

            // INSTANT SILENCE: Catch "silence" immediately from the fast engine
            if (text.match(/\b(silence|stop listening|shut up)\b/i)) {
                console.log("⚡ Instant Silence detected in Vosk:", text);
                window.novaState.isSilenced = true;
                uiLog("🔇 Silence mode activated (Instant).");
                subtitleElement.innerText = "";
                speak("Okay, I'll be quiet now.");
                return;
            }

            const interruptKeywords = ['stop', 'play it', 'see', 'look', 'wait', 'quiet', 'hey', 'nova', 'click', 'select', 'pick'];
            const isInterrupt = interruptKeywords.some(kw => text.includes(kw));

            // IGNORE INPUT WHILE NOVA IS SPEAKING unless it's an interruption
            if (window.novaState.isSpeaking && !isInterrupt) {
                console.log("🤫 Ignoring STT input because Nova is speaking.");
                return;
            } else if (window.novaState.isSpeaking && isInterrupt) {
                console.log("🛑 Interruption detected! Stopping speech...");
                // Stop any audio being played by Piper or Fallback
                const audioPlayer = document.querySelector('audio');
                if (audioPlayer) {
                    audioPlayer.pause();
                    audioPlayer.currentTime = 0;
                }
                window.speechSynthesis.cancel();
                window.novaState.isSpeaking = false;
            }

            // WAKE UP: If asleep, wake up on greeting or direct command
            const isSelection = window.novaState.pendingChoices.length > 0 && text.match(/\b(one|first|two|second|three|third|four|fourth|1|2|3|4)\b/i);

            if (!window.novaState.isAwake && (text.match(/\b(hey|hay|hi|volume|lower|higher|stop|pause|scroll|noiva)\b/i) || isSelection)) {
                window.novaVoice.wakeUp();
                // DIRECT TACTICAL COMMANDS ONLY (Volume, Pause, Scroll)
                if (text.match(/\b(pause|stop|resume|volume|lower|higher|quieter|louder|increase|decrease|scroll|hey|nova)\b/i)) {
                    console.log("⚡ Tactical Direct Command detected in Vosk (Waking up):", text);
                    window.novaState.lastDirectCommandTime = Date.now();
                    window.novaState.lastDirectCommandText = text;
                    processCommand(text);
                } else {
                    window.novaVoice.startRecording();
                }
                return;
            }

            if (window.novaState.isAwake && text.match(/\b(pause|stop|resume|volume|lower|higher|quieter|louder|increase|decrease|scroll|close|open)\b/i)) {
                // GEMINI LIVE SUPPRESSION: If Gemini is active, let it handle ALL intent. 
                // Only allow volume control via Vosk if specifically needed, but for now, complete silence is safer.
                if (window.novaState.isLiveActive) {
                    console.log(`🛡️ Gemini Live active: Ignoring Vosk tactical command: "${text}"`);
                    return;
                }

                console.log("⚡ Tactical Direct Command detected in Vosk (Active):", text);
                window.novaState.lastDirectCommandTime = Date.now();
                window.novaState.lastDirectCommandText = text;
                stopRecording();
                processCommand(text);
                return;
            }

            if (window.novaState.isAwake && window.novaState.pendingChoices.length > 0) {
                if (window.novaState.isLiveActive) return; // Gemini takes priority
                const selectionPattern = /\b(one|first|two|second|three|third|four|fourth|1|2|3|4)\b/i;
                if (selectionPattern.test(text)) {
                    console.log("⚡ Immediate Selection detected in Vosk:", text);
                    uiLog(`⚡ Selection: "${text}"`);
                    stopRecording();
                    processCommand(text);
                    return;
                }
            }

            // IMMEDIATE PLATFORM HANDLING: If we are awaiting choice between Google vs YouTube,
            // process it instantly to avoid the Whisper silencer delay.
            if (window.novaState.isAwake && window.novaState.isAwaitingPlatform) {
                const platformPattern = /\b(google|youtube|video|search|browser)\b/i;
                if (platformPattern.test(text)) {
                    console.log("⚡ Immediate Platform selection detected in Vosk:", text);
                    uiLog(`⚡ Platform: "${text}"`);
                    stopRecording();
                    processCommand(text);
                    return;
                }
            }

            if (window.novaState.isAwake) {
                // We no longer stop recording here; the volume-based silencer handles it!
                // This prevents "hey nova" from cutting off the actual command.
                console.log("👂 Vosk segment ended, but keeping Whisper recording active...");
            }
        });

        const audioContext = new window.AudioContext({ sampleRate: 16000 });
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 2.5; // Significant boost for distant voice / low-signal mics

        const micSource = audioContext.createMediaStreamSource(mediaStream);
        micSource.connect(gainNode);

        // Chromium Autoplay Policies strictly suspend AudioContexts if they are created without a user gesture.
        // Because Electron auto-grants microphone permissions, this script runs 0ms after boot, 
        // completely starving the AI Vosk engine of an active ticking microphone array unless we resume!
        if (audioContext.state === 'suspended') {
            uiLog("⚠️ Click the Robot once to activate Voice AI");
            const resumeAudio = () => {
                if (audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        uiLog("🎙️ Engine Unlocked! Say 'Hey'");
                    }).catch(err => console.error("Resume failed:", err));
                }
                window.removeEventListener('pointerdown', resumeAudio);
            };
            window.addEventListener('pointerdown', resumeAudio);
        } else {
            uiLog("🎙️ Engine Active! Say 'Hey'");
        }
        const recognizerNode = audioContext.createScriptProcessor(4096, 1, 1);
        gainNode.connect(recognizerNode);
        let meterThrottle = 0;

        // --- WebSockets Audio Playback Engine ---
        let audioQueue = [];
        let isPlayingLive = false;
        let livePlaybackStuckTimer = null;       // Watchdog for stuck isPlayingLive
        const livePlaybackContext = new window.AudioContext({ sampleRate: 24000 });

        function resetLivePlayback() {
            isPlayingLive = false;
            window.novaState.isSpeaking = false;
            listeningSymbol.style.display = 'none';
            if (livePlaybackStuckTimer) { clearTimeout(livePlaybackStuckTimer); livePlaybackStuckTimer = null; }
        }

        async function playLiveQueue() {
            if (isPlayingLive || audioQueue.length === 0) return;

            // Resume AudioContext if it was suspended (Chromium autoplay policy)
            if (livePlaybackContext.state === 'suspended') {
                await livePlaybackContext.resume().catch(() => {});
            }

            isPlayingLive = true;
            window.novaState.isSpeaking = true;
            listeningSymbol.innerHTML = '🔊 Speaking...';
            listeningSymbol.style.display = 'block';

            const audioBuffer = audioQueue.shift();

            // Safety watchdog: if onended never fires within 20s, force-reset
            if (livePlaybackStuckTimer) clearTimeout(livePlaybackStuckTimer);
            livePlaybackStuckTimer = setTimeout(() => {
                if (isPlayingLive) {
                    console.warn('[Live Audio] Watchdog: resetting stuck playback state');
                    resetLivePlayback();
                    if (audioQueue.length > 0) playLiveQueue();
                }
            }, 20000);

            const source = livePlaybackContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(livePlaybackContext.destination);
            source.onended = () => {
                if (livePlaybackStuckTimer) { clearTimeout(livePlaybackStuckTimer); livePlaybackStuckTimer = null; }
                if (audioQueue.length > 0) {
                    isPlayingLive = false;
                    playLiveQueue();
                } else {
                    resetLivePlayback();
                }
            };
            source.start();
        }

        ipcRenderer.on('live-audio-chunk', (event, base64Data) => {
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const int16Array = new Int16Array(bytes.buffer);

            const float32Array = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768.0;
            }

            const audioBuffer = livePlaybackContext.createBuffer(1, float32Array.length, 24000);
            audioBuffer.copyToChannel(float32Array, 0);

            audioQueue.push(audioBuffer);
            playLiveQueue();
        });

        ipcRenderer.on('live-session-event', (event, status) => {
            if (status.event === 'opened') {
                window.novaState.isLiveActive = true;
                uiLog("🔴 [LIVE] Bi-directional mode active");
            }
            if (status.event === 'closed') {
                window.novaState.isLiveActive = false;
                audioQueue = [];
                resetLivePlayback();      // Clear any audio state from the dropped session
                uiLog("⚪ [LIVE] Bi-directional mode ended");
                // Auto-reconnect if the user is still awake — the session dropped unexpectedly
                if (window.novaState.isAwake && !window.novaState.isResearching) {
                    uiLog("🔄 Session dropped — reconnecting in 2s...");
                    setTimeout(() => {
                        if (window.novaState.isAwake && !window.novaState.isLiveActive) {
                            ipcRenderer.send('live-start');
                            // Re-inject paper context after the new session connects
                            injectPaperContextIfNeeded(4000);
                        }
                    }, 2000);
                }
            }
            if (status.event === 'interrupted') {
                audioQueue = [];          // Clear queue on interrupt
                resetLivePlayback();      // Also clear the stuck-speaking state
            }
            if (status.event === 'closed' && status.code === 1007) {
                console.log("❌ API Key Error: Google dropped the connection");
                const utterance = new window.SpeechSynthesisUtterance("Your API key is invalid or missing. Please insert a real API key into the dot env file.");
                window.speechSynthesis.speak(utterance);
                subtitleElement.innerText = "Error: Invalid API Key. Please edit .env file.";
                subtitleElement.style.color = '#ff4444';

                // Force sleep
                window.novaState.isAwake = false;
                window.novaState.isInConversation = false;
                clearTimeout(sleepTimer);
            }
        });

        ipcRenderer.on('live-command-trigger', (event, action) => {
            console.log('⚡ [Live Tool Trigger] Executing OS Command:', action);
            ipcRenderer.invoke('execute-automation', action.trim());
        });

        // Agentic Browser Relays: Nova -> Engine -> Browser
        ipcRenderer.on('browser-open', (event, data) => {
            console.log('🌍 Relay: Opening Browser for', data);
            ipcRenderer.invoke('browser-open', data);
        });
        ipcRenderer.on('browser-scroll', (event, direction) => {
            console.log('🌍 Relay: Scrolling Browser', direction);
            ipcRenderer.send('browser-scroll', direction);
        });
        ipcRenderer.on('browser-click', (event, target) => {
            console.log('🌍 Relay: Clicking Browser Element:', target);
            ipcRenderer.send('browser-click', target);
        });
        ipcRenderer.on('browser-close', () => {
            console.log('🌍 Relay: Closing Browser');
            ipcRenderer.send('browser-close');
        });

        // ── STORE DETECTION ───────────────────────────────────────────────────
        // When main.js detects the browser navigated to a known store, inject
        // a greeting prompt into the live session (or queue it for next wake-up).
        window._pendingStoreGreeting = null;
        ipcRenderer.on('store-detected', (event, { storeName }) => {
            console.log('🛒 Store detected:', storeName);
            const msg =
                `[STORE DETECTED - SYSTEM NOTIFICATION] The user's browser just navigated to ${storeName}. ` +
                `CRITICAL INSTRUCTIONS: Do NOT call any tools. Do NOT call get_browser_state. Do NOT call control_browser. ` +
                `Just speak out loud right now — greet the user warmly and ask what they are looking to find or buy on ${storeName}. ` +
                `Example: "Oh nice, we're on ${storeName}! What are you looking for today? I can help you find the right product and tell you about the different options and prices." ` +
                `After the user replies with what they want, THEN you may use tools to navigate.`;
            if (window.novaState.isAwake) {
                ipcRenderer.send('live-text-chunk', msg);
            } else {
                window._pendingStoreGreeting = msg;
            }
        });

        let streamingTextBuffer = "";
        ipcRenderer.on('live-text-chunk', (event, text) => {
            streamingTextBuffer += text;

            subtitleElement.style.color = '#fb0';
            subtitleElement.innerText = streamingTextBuffer;
        });

        recognizerNode.onaudioprocess = (event) => {
            try {
                if (recognizer) recognizer.acceptWaveform(event.inputBuffer);

                const data = event.inputBuffer.getChannelData(0);
                let maxVol = 0;
                for (let i = 0; i < data.length; i++) {
                    if (Math.abs(data[i]) > maxVol) maxVol = Math.abs(data[i]);
                }

                // If Awake, stream WebSockets chunks natively
                if (window.novaState.isAwake) {
                    if (maxVol > silenceThreshold) {
                        lastAudioTime = Date.now();
                    } else {
                        if (Date.now() - lastAudioTime > silenceDuration) {
                            if (!window.novaState.isSpeaking) {
                                // Just a visual sleep hint — log at most once every 10s to avoid spam
                                if (!window._lastSilenceLog || Date.now() - window._lastSilenceLog > 10000) {
                                    console.log("🤫 Silence detected. Waiting...");
                                    window._lastSilenceLog = Date.now();
                                }
                            }
                        }
                    }

                    // Route out Float32 PCM arrays into 16kHz Int16 for Gemini
                    // Block audio during research so Nova isn't interrupted by voice commands
                    if (!window.novaState.isSpeaking && !window.novaState.isResearching) {
                        const pcm = new Int16Array(data.length);
                        for (let i = 0; i < data.length; i++) {
                            let s = Math.max(-1, Math.min(1, data[i]));
                            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                        }
                        const buffer = Buffer.from(pcm.buffer);
                        ipcRenderer.send('live-audio-chunk', buffer.toString('base64'));
                    }
                }

                if (meterThrottle++ % 10 === 0) {
                    const bars = '|'.repeat(Math.min(20, Math.floor(maxVol * 100)));
                    uiLog(`🎙️ Engine Active!\nVol: [${bars.padEnd(20, ' ')}]`);
                }
            } catch (error) { console.error('acceptWaveform error:', error); }
        };
        gainNode.connect(recognizerNode);

        // Prevent Chromium from garbage collecting the graph by connecting it to the destination speaker.

        const silentNode = audioContext.createGain();
        silentNode.gain.value = 0;
        recognizerNode.connect(silentNode);
        silentNode.connect(audioContext.destination);

    } catch (e) {
        uiLog("Voice Error: " + (e.message || e));
    }
}

// Start watching microphone after a short delay to ensure UI renders
setTimeout(() => {
    initOfflineVoice();
}, 2000);

// ── Startup introduction ───────────────────────────────────────────────────
// Plays a one-way announcement via Piper TTS WITHOUT touching novaState so
// Vosk keeps running and "Hey Nova" is detectable during/after the intro.
setTimeout(async () => {
    try {
        console.log('[Nova Startup] Generating intro audio...');
        const audioPath = await ipcRenderer.invoke('generate-speech',
            "Nova online. I am your personal AI assistant. " +
            "Say Hey Nova at any time to start a conversation with me in any language.");
        if (!audioPath) { console.warn('[Nova Startup] No audio path'); return; }
        const audio = new Audio();
        audio.addEventListener('loadeddata', () => {
            audio.play()
                .then(() => {
                    console.log('[Nova Startup] Intro playing.');
                    // Power-on: remove offline state so orb comes alive with its full colors
                    if (novaWidget) novaWidget.classList.remove('offline');
                })
                .catch(err => console.error('[Nova Startup] play() failed:', err));
        });
        audio.addEventListener('ended',  () => console.log('[Nova Startup] Intro finished.'));
        audio.addEventListener('error',  (e) => {
            console.error('[Nova Startup] Audio error:', e.target?.error?.code);
            // Still power-on even if audio fails so the UI isn't stuck offline
            if (novaWidget) novaWidget.classList.remove('offline');
        });
        audio.src = `appassets:///${audioPath}`;
        audio.load();
    } catch (err) {
        console.error('[Nova Startup] TTS error:', err);
    }
}, 1200);

// Helper to detect music intent
function isMusicIntent(query) {
    const musicKeywords = /\b(song|music|band|album|artist|singer|lyrics|concert|performance|live|track|playlist|official video|music video|coldplay|queen|beatles|adele|drake|bts|radiohead|nirvana|metallica)\b/i;
    return musicKeywords.test(query);
}

// Helper to fetch search suggestions from GPT
async function getSearchSuggestions(searchTerm, hasMusicVideo) {
    const needsMusicFocus = hasMusicVideo && isMusicIntent(searchTerm);
    const searchContext = needsMusicFocus ? 'music video' : 'video';
    if (window.novaState.isLiveActive) return;
    uiLog(`🔍 Searching for: "${searchTerm}"${needsMusicFocus ? ' [music video]' : ''}...`);

    try {
        const shoppingKeywords = ['pixel', 'phone', 'android', 'iphone', 'ps4', 'ps5', 'buy', 'price', 'amazon', 'ebay', 'shopping', 'product', 'laptop', 'device', 'console', 'android phone'];
        const isShopping = shoppingKeywords.some(kw => searchTerm.toLowerCase().includes(kw));

        if (isShopping) {
            uiLog(`🛒 Product intent detected. Opening Search...`);
            speak(`Searching for ${searchTerm} to help you find it.`);
            ipcRenderer.invoke('browser-open', { platform: 'google', query: searchTerm });
            window.novaState.isProcessingCommand = false;
            return;
        }

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: `Suggest 2-3 precise SEARCH TOPICS for: "${searchTerm}"${searchContext ? ` (context: ${searchContext})` : ''}. ${needsMusicFocus ? 'Focus on official music videos and live performances.' : ''} Respond ONLY with a JSON array of [{"title": "...", "url": "#"}].` }],
                max_tokens: 300,
                temperature: 0.1
            })
        });
        const d = await res.json();
        const results = JSON.parse(d.choices[0].message.content.trim().replace(/```json|```/g, ''));
        window.novaState.pendingChoices = results;
        window.novaState.isProcessingCommand = false;
        showChoices(results);
        await speak(`I found a few things about ${searchTerm}. Which one did you mean?`);
    } catch (e) {
        console.error("Search suggestion error:", e);
        // Fallback to direct search if GPT fails
        window.novaState.pendingTopic = searchTerm;
        window.novaState.isAwaitingPlatform = true;
        window.novaState.isProcessingCommand = false;
        showPlatformChoices();
        await speak(`I couldn't get suggestions, but I can search for ${searchTerm}. Google or YouTube?`);
    }
}

const processSelection = async (choice) => {
    if (!choice) return;
    window.novaState.pendingTopic = choice.title;
    window.novaState.isAwaitingPlatform = true;
    window.novaState.pendingChoices = [];
    showPlatformChoices();
    await speak(`Great choice: ${window.novaState.pendingTopic}. Would you like to search for this on Google or YouTube?`);
    window.novaState.isProcessingCommand = false;
};

// The high-accuracy Whisper transcription comes here
async function processCommand(cmd) {
    if (!cmd || cmd.trim().length === 0) {
        if (!isInConversation) {
            askGrokRealtime("Hello, Nova.");
        } else {
            askGrokRealtime("I'm listening. What can I help you with?");
        }
        subtitleElement.innerText = "";
        listeningSymbol.style.display = 'none';
        subtitleElement.style.color = '#fff';
        return;
    }

    // ── RESEARCH PAPER BLOCK: block all commands while research is running ──
    if (window.novaState.isResearching) {
        console.log('📄 Research in progress — ignoring command:', cmd);
        return;
    }

    // ── RESEARCH PAPER DETECTION: catch research paper requests early ───────
    // Skip detection for 10 minutes after a paper just completed to prevent re-triggering
    const _researchCooldownElapsed = Date.now() - (window.novaState.researchJustCompleted || 0);
    if (_researchCooldownElapsed > 600000) {
    const normalized_rp = cmd.toLowerCase().trim();
        // Guard: if user says "open/show/find/display ... research paper", this is a file-open request — never create
        const _isOpenFileIntent = /\b(?:open|show|find|display|locate|get)\b/i.test(normalized_rp);
        const researchMatch = _isOpenFileIntent ? null : (
            normalized_rp.match(/\b(?:write|create|generate|make|build|prepare|do|compose)\b.*?\b(?:research\s+paper|academic\s+paper|scientific\s+paper|research\s+essay|research\s+report)\b.*?\b(?:about|on|regarding|covering|for|of)\b\s*(.+)/i)
            || normalized_rp.match(/\b(?:write|create|generate|make|compose)\b.*?\b(?:paper|essay|report)\b.*?\b(?:about|on|regarding)\b\s*(.+)/i)
            || normalized_rp.match(/\b(?:research|academic)\s+paper\b\s+(?:about|on|for|regarding)\s+(.+)/i)
            || normalized_rp.match(/\b(?:research\s+paper|academic\s+paper)\b.*?\bon\s+(.+)/i)
        );

        if (researchMatch) {
            const rawTopic = researchMatch[1] || researchMatch[0];
            // Clean trailing noise words
            const topic = rawTopic
                .replace(/\b(please|for me|now|today|quickly|asap|right now)\b/gi, '')
                .replace(/[?!.,]+$/, '')
                .trim();

            if (topic.length > 2) {
                console.log(`📄 Research paper detected! Topic: "${topic}"`);
                window.novaState.isResearching = true;
                stopAllPlayback();
                showResearchOverlay(topic);
                listeningSymbol.style.display = 'none';
                subtitleElement.style.display = 'none';
                uiLog(`📄 Starting research on: "${topic}"`);
                speak(`Starting research on ${topic}. Please wait while I compile a comprehensive paper — this may take a couple of minutes.`);
                ipcRenderer.invoke('generate-research-paper', topic);
                return;
            }
        }
    } // end cooldown if

    // DEDUPLICATION GUARD: If Gemini Live is active, we ignore legacy command parsing
    // to prevent "Double VS Code" or "Double Search" issues.
    if (window.novaState.isLiveActive) {
        console.log('🛡️ GEMINI LIVE OVERRIDE: Suppressing offline intent to prevent collisions.');
        return;
    }

    if (window.novaState.isAwake) {
        console.log('🛡️ WAKE OVERRIDE: Suppressing intent while Nova is in active talk mode.');
        return;
    }

    console.log('🎯 Processing Whisper command:', cmd);
    uiLog(`🎯 Whisper: "${cmd}"`);

    let normalized = cmd.toLowerCase().trim();
    const now = Date.now();

    // 🩹 VOSK HEALING: Repair clipped transcriptions
    if (window.novaState.lastVoskText) {
        const vosk = window.novaState.lastVoskText.toLowerCase();
        const whisper = normalized;
        const tacticalVerbs = ['click', 'press', 'select', 'search', 'buy', 'find', 'open', 'close', 'scroll', 'go', 'move'];
        const vVerb = tacticalVerbs.find(v => vosk.match(new RegExp('\\b' + v + '\\b', 'i')));
        const wVerb = tacticalVerbs.some(v => whisper.match(new RegExp('\\b' + v + '\\b', 'i')));

        // TACTICAL DOMINANCE: If local ears saw a verb and Whisper didn't, heal it!
        const noiseKeywords = ["thank you", "watching", "video", "have fun", "enjoy", "subscribe", "you you", "thanks"];
        const whisperIsNoise = noiseKeywords.some(n => whisper.includes(n)) || whisper.length < 3;

        if (vVerb && !wVerb) {
            if (whisperIsNoise) {
                console.log(`🩹 Tactical Override: Whisper is noise ("${whisper}"). Using Vosk: "${vosk}"`);
                normalized = vosk;
            } else {
                console.log(`🩹 Tactical Healing: Prepending "${vVerb}" to "${whisper}" based on Vosk: "${vosk}"`);
                normalized = vVerb + " " + whisper;
            }
            uiLog("🩹 Hearing repaired...");
            // Stop talking immediately if we're healing a command
            if (window.novaState.isSpeaking) window.speechSynthesis.cancel();
        }
    }

    // ── HIGH PRIORITY FAST INTERCEPTS (Scroll, Pause, Volume) ────────────────
    // These bypass AI and deduplication to ensure instant tactical response
    if (normalized.match(/\b(scroll|go|move)\b.*?\b(down|up|bottom|top)\b/i)) {
        const direction = normalized.includes('up') || normalized.includes('top') ? 'up' : 'down';
        uiLog(`🌐 Scrolling ${direction}...`);
        ipcRenderer.send('browser-scroll', direction);
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    if (normalized.match(/\b(pause|stop|resume|play the video)\b/i) && !normalized.includes('play ')) {
        uiLog("⏯️ Media control...");
        ipcRenderer.invoke('execute-automation', 'press-k');
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 📁 DIRECT FOLDER / FILE OPENING (Bypass AI)

    // 1. System-named folders → fast path through execute-automation
    const sysFolderMatch = normalized.match(
        /\b(open|show|go to)\b.*?\b(documents|downloads|desktop|pictures|music|videos|home|temp)\b/i
    );
    if (sysFolderMatch) {
        uiLog(`📁 Opening system folder: ${normalized}...`);
        ipcRenderer.invoke('execute-automation', normalized);
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 2. File with extension → search & open the file
    const fileOpenMatch = normalized.match(
        /\b(open|show|find)\b\s+(?:my\s+|the\s+)?(.+?\.(txt|pdf|docx?|xlsx?|pptx?|png|jpe?g|mp4|mp3|zip|csv|json|js|ts|py|sh|md))\b/i
    );
    if (fileOpenMatch) {
        const fileName = fileOpenMatch[2].trim();
        uiLog(`📂 Searching for file: ${fileName}...`);
        window.novaState.isProcessingCommand = true;
        ipcRenderer.invoke('find-and-open-file', fileName).then(res => {
            if (res.error) speak(`I couldn't find ${fileName} on your system.`);
            else speak(`Opening ${res.opened}.`);
            window.novaState.isProcessingCommand = false;
        });
        return;
    }

    // 3. Named folder (explicit "folder"/"directory" word) → search & open
    const namedFolderMatch = normalized.match(
        /\b(open|show|go to)\b\s+(?:the\s+|my\s+)?(.+?)\s+(?:folder|directory)\b/i
    );
    if (namedFolderMatch) {
        const folderName = namedFolderMatch[2].trim();
        uiLog(`📂 Searching for folder: ${folderName}...`);
        window.novaState.isProcessingCommand = true;
        ipcRenderer.invoke('find-and-open-file', folderName).then(res => {
            if (res.error) speak(`I couldn't find a folder named ${folderName}.`);
            else speak(`Opening ${res.opened}.`);
            window.novaState.isProcessingCommand = false;
        });
        return;
    }

    // 4. "open <name>" without "folder" keyword — pass to execute-automation so it
    //    can try app-launch first, then fall back to folder search in main.js
    if (normalized.match(/\b(open|go to|show)\b.*?\b(dir|directory|folder|project)\b/i)) {
        uiLog(`📁 Opening folder: ${normalized}...`);
        ipcRenderer.invoke('execute-automation', normalized);
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 🛒 SHOPPING & SEARCH SHORTCUT (Direct Bypass)
    // Matches "buy X", "search for X", "help me buy X", "find X"
    const shoppingMatch = normalized.match(/\b(help me (search|find|buy)|search for buying|search for|buy|find)\b\s+(.+)/i);
    if (shoppingMatch && !normalized.includes('how to')) {
        const query = shoppingMatch[3].trim();
        const isVideo = query.includes('video') || query.includes('music');
        const platform = isVideo ? 'youtube' : 'google';
        uiLog(`🛒 Direct Shopping: "${query}"...`);
        speak(`Searching for ${query} on ${platform}.`);
        ipcRenderer.invoke('browser-open', { platform, query: query });
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // SILENCE VISIBILITY: Hide transcripts if silenced
    if (!window.novaState.isSilenced) {
        subtitleElement.innerText = cmd;
        subtitleElement.style.color = '#fb0';
    } else {
        subtitleElement.innerText = "";
    }

    // ── CRITICAL INTERCEPTS (Silence & Hotkeys) ─────────────────────────
    // Deduplication: prevent Vosk and Whisper from double-firing direct commands
    const isDirectDedupe = (now - (window.novaState.lastDirectCommandTime || 0) < 2500);

    // 1. Volume Control
    if (normalized.match(/\b(higher the volume|volume up|increase volume|louder|increase)\b/i)) {
        uiLog("🔊 Increasing system volume...");
        ipcRenderer.invoke('execute-automation', 'increase-volume');
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }
    if (normalized.match(/\b(lower the volume|volume down|decrease volume|quieter|decrease)\b/i)) {
        uiLog("🔉 Decreasing system volume...");
        ipcRenderer.invoke('execute-automation', 'decrease-volume');
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 2. Browser Window Management (Close)
    if (normalized.match(/\b(close|exit|terminate|hide)\b.*?\b(browser|window|nova browser|paper|research)\b/i)) {
        uiLog("🌐 Closing Nova Browser...");
        ipcRenderer.send('browser-close');
        // Exit research paper mode — no more context injections
        window.novaState.isInResearchPaperMode = false;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 3. Silence Mode (Quiet Mode)
    if (normalized.match(/\b(silence|stop listening|shut up|be quiet|go to sleep|sleep mode|deactivate|quiet mode|go quiet|ignore me|don't listen)\b/i)) {
        if (!window.novaState.isSilenced) {
            window.novaState.lastDirectCommandTime = now;
            window.novaState.isSilenced = true;
            uiLog("🔇 Silence mode activated. Say 'Hey' to wake me.");
            speak("I'm going into standby now. Just let me know when you need me.");
        }
        return;
    }

    // 6. Waking from Silence
    if (window.novaState.isSilenced) {
        // Stricter wake word for silence: require a greeting and the name
        const wakeMatch = normalized.match(/\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noah|noa|know|no|know a)\b/i);
        if (wakeMatch) {
            window.novaState.isSilenced = false;
            uiLog("🔔 Nova is back!");
            // Strip everything BEFORE the wake word (it was said during silence)
            const wakeIdx = normalized.indexOf(wakeMatch[0]);
            if (wakeIdx >= 0) {
                cmd = cmd.substring(wakeIdx).trim();
                normalized = cmd.toLowerCase();
                console.log("✂️ Stripped prep-talk precisely. New cmd:", cmd);
            }
            // Fall through to process the rest of the command!
        } else {
            console.log("🤫 Whisper Ignored (Silenced Mode):", cmd);
            window.novaState.isProcessingCommand = false; // Reset if ignored
            return;
        }
    }



    // ── LOCAL SELECTION INTERCEPT (ZERO LATENCY) ────────────────────────────
    if (window.novaState.pendingChoices.length > 0) {
        const selMatch = normalized.match(/\b(one|first|1|two|second|2|three|third|3|four|fourth|4)\b/i);
        if (selMatch) {
            const word = selMatch[0].toLowerCase();
            let index = -1;
            if (word.match(/\b(one|first|1)\b/)) index = 0;
            else if (word.match(/\b(two|second|2)\b/)) index = 1;
            else if (word.match(/\b(three|third|3)\b/)) index = 2;
            else if (word.match(/\b(four|fourth|4)\b/)) index = 3;

            if (index >= 0 && index < window.novaState.pendingChoices.length) {
                const choice = window.novaState.pendingChoices[index];
                uiLog(`✅ Local Selection: ${choice.title}`);
                processSelection(choice); // Use the correct internal name or refactor
                return;
            }
        }
    }

    // Refresh sleep timer since user is active
    if (window.novaState.isAwake) window.novaVoice.wakeUp();

    // Clean wake words if they were caught in the recording (with optional punctuation)
    cmd = cmd.replace(/^(hey|hay|hi|ey|hello)\b[.,:]*\s+(nova|noah|noa|know|no|know a)\b[.,:]*/i, '').trim();

    // Check for context reset
    if (cmd.match(/\b(hey|hay|hi)\s+nova\b/)) {
        window.novaState.currentPlatform = null;
        window.novaState.pendingTopic = null;
        window.novaState.isAwaitingPlatform = false;
        hideChoices();
        uiLog("🔄 Context reset by 'Hey Nova'");
    }

    // Check for conversation end commands (ignore if we have pending choices to avoid noise-driven sleep)
    if ((cmd.includes('bye') || cmd.includes('goodbye') || cmd.includes('see you')) && window.novaState.pendingChoices.length === 0) {
        ipcRenderer.invoke('stop-media'); // Pause if talking
        speak("Goodbye! Have a great day!");
        window.novaVoice.endConversation();
        subtitleElement.innerText = "";
        listeningSymbol.style.display = 'none';
        subtitleElement.style.color = '#fff';
        return;
    }

    // ── BROWSER AGENT COMMANDS ──────────────────────────────────────────────
    if (normalized.match(/\b(click|press|select)\s+(on\s+)?(.+)/i)) {
        // PREVENT ECHO: If we just processed a direct command, ignore this Whisper transcript of it
        if (now - (window.novaState.lastDirectCommandTime || 0) < 3000) {
            console.log("🛡️ Suppression: Ignoring 'click' transcript because a direct tactical command just fired.");
            return;
        }

        const clickMatch = normalized.match(/\b(click|press|select)\s+(on\s+)?(.+)/i);
        let target = clickMatch[3].trim().replace(/[.,?!]+$/, '');
        if (window.novaState.isSpeaking) window.speechSynthesis.cancel();
        if (target.length > 0) {
            uiLog(`🖱️ Scanning for: "${target}"...`);

            // 1. Register listener BEFORE sending request (Fix Race Condition)
            const mapHandler = async (event, elements) => {
                clearTimeout(mapTimeout);
                console.log(`🧠 AI Click: Received DOM map with ${elements?.length || 0} elements.`);
                if (!elements || elements.length === 0) {
                    uiLog("⚠️ No interactive elements found.");
                    ipcRenderer.send('browser-click', target); // Fallback
                    return;
                }

                // FAST MATCH: Exact text or title match
                const exactMatch = elements.find(el =>
                    (el.text && el.text.toLowerCase().trim() === target.toLowerCase().trim()) ||
                    (el.title && el.title.toLowerCase().trim() === target.toLowerCase().trim()) ||
                    (el.ariaLabel && el.ariaLabel.toLowerCase().trim() === target.toLowerCase().trim())
                );

                if (exactMatch) {
                    uiLog(`🖱️ Exact Match: "${target}" -> ID ${exactMatch.id}`);
                    ipcRenderer.send('browser-click-id', exactMatch.id);
                    return;
                }

                const prompt = `Which element ID (number) best matches the user's intent to click on "${target}"?\nInteractive Elements:\n${JSON.stringify(elements)}\nReturn ONLY the ID number. If no match, return -1.`;
                console.log("🧠 Sending resolution prompt to Grok...");
                const result = await ipcRenderer.invoke('ask-grok', prompt);
                console.log("🧠 Grok resolution result:", result);
                const elementId = parseInt(result.replace(/[^0-9-9]/g, ''));

                if (elementId !== -1 && !isNaN(elementId)) {
                    ipcRenderer.send('browser-click-id', elementId);
                    uiLog(`🖱️ AI Clicked element ID ${elementId}`);
                } else {
                    uiLog(`⚠️ AI couldn't resolve "${target}". Trying literal...`);
                    ipcRenderer.send('browser-click', target); // Fallback
                }
            };

            ipcRenderer.once('browser-dom-map', mapHandler);

            // 2. Clear previous handlers and send request
            ipcRenderer.send('browser-get-map');

            // Timeout for map request
            let mapTimeout = setTimeout(() => {
                ipcRenderer.removeListener('browser-dom-map', mapHandler);
                console.error("🕒 AI Click Error: DOM Map request timed out (5s).");
                uiLog("🕒 Nova is taking too long to see the page. Trying fallback...");
                ipcRenderer.send('browser-click', target);
            }, 5000);

            window.novaState.isProcessingCommand = false;
            return;
        }
    }

    // Directly handle "search for X" or "find X" to prevent GPT from misrouting
    // it to "switch window" or other intents. Allow for leading non-word characters.
    const searchMatch = cmd.match(/^\W*(search for|find|look up|show me)\s+(.+)/i);
    if (searchMatch) {
        const query = searchMatch[2].trim();
        if (query.length > 2) {
            console.log("⚡ Search Intercept Triggered:", query);
            uiLog(`⚡ Search: "${query}"`);
            ipcRenderer.invoke('stop-media');
            const hasMusic = isMusicIntent(query);
            await getSearchSuggestions(query, hasMusic);
            return;
        }
    }

    if (window.novaState.isProcessingCommand) {
        // HANDSHAKE: If this is a Whisper/Vosk race, allow the incoming command to "upgrade" the previous fast one
        const now = Date.now();
        const isDeduplication = (now - window.novaState.lastDirectCommandTime < 2500);
        if (isDeduplication) {
            console.log("🔄 Whisper Upgraded command:", cmd);
            uiLog(`🔄 Upgrading: "${cmd}"`);
            // Force reset processing flag to allow this upgrade to go through
            window.novaState.isProcessingCommand = false;
        } else {
            console.log('⏳ Already processing a command, ignoring...');
            uiLog('⏳ Still thinking, please wait...');
            return;
        }
    }

    // Prefix Cleanup: Strip misheard Nova/Nobody/Body
    let cleanedCmd = cmd.replace(/^(nova|nobody|body|hey nova|hey nobody|hey body)\s+/i, '').trim();

    // ── PRE-GPT SELECTION INTERCEPT ─────────────────────────────────────────
    // When choices are displayed, resolve number-selection locally so GPT can't
    // misroute "number two", "option 2", "select 3", etc. to other commands.
    if (window.novaState.pendingChoices.length > 0) {
        const t = cleanedCmd.toLowerCase().replace(/[.,?!-]/g, ' ').replace(/\s+/g, ' ').trim();
        let selIndex = -1;
        // digit match: "2", "select 2", "option 2", "number 2"
        const digitMatch = t.match(/\b([1-9])\b/);
        if (digitMatch) {
            selIndex = parseInt(digitMatch[1]) - 1;
        } else if (/\b(one|first|number one|option one|select one)\b/.test(t)) {
            selIndex = 0;
        } else if (/\b(two|second|number two|option two|select two)\b/.test(t)) {
            selIndex = 1;
        } else if (/\b(three|third|number three|option three|select three)\b/.test(t)) {
            selIndex = 2;
        } else if (/\b(four|fourth)\b/.test(t)) {
            selIndex = 3;
        }

        // Guard: if the user said goodbye/bye while choices are showing,
        // treat it as noise and reprompt instead of ending the conversation.
        const goodbyePattern = /\b(bye|goodbye|good bye|bye bye|see you|exit|quit|stop|cancel)\b/;
        if (selIndex < 0 && goodbyePattern.test(t)) {
            window.novaState.isProcessingCommand = false;
            await speak('Please choose one of the options — say a number like "one", "two", or "three".');
            return;
        }

        if (selIndex >= 0 && selIndex < window.novaState.pendingChoices.length) {
            const choice = window.novaState.pendingChoices[selIndex];
            window.novaState.pendingTopic = choice.title;
            window.novaState.isAwaitingPlatform = true;
            window.novaState.pendingChoices = [];
            window.novaState.isProcessingCommand = false;
            showPlatformChoices();
            uiLog(`📌 Selected: "${choice.title}". Awaiting platform...`);
            await speak(`Great choice: ${choice.title}. Would you like to search on Google or YouTube?`);
            return;
        }
    }

    // FIRST, send to ChatGPT/Grok to interpret command
    const interpretationPrompt = `Interpret this user command: "${cleanedCmd}"
    
    Context: 
    - Available Choices: ${window.novaState.pendingChoices.length}
    - Awaiting Platform: ${window.novaState.isAwaitingPlatform ? 'YES' : 'NO'} (Topic: "${window.novaState.pendingTopic}")
    - Active Platform Context: ${window.novaState.currentPlatform || 'Desktop'}

    Rules (apply in order, stop at first match):

    1. APP LAUNCH (any language): If user says "open X", "launch X", "start X", "run X", or equivalent in any language (Spanish "abre X", French "ouvre X", Portuguese "abrir X", Chinese "打开X", etc.) where X is an application name → respond: focus <appname_english_lowercase>
       Supported: zoom, vscode, terminal, firefox, chrome, brave, discord, slack, telegram, spotify, vlc, gimp, blender, obsidian, antigravity, docs, sheets, slides, drive, gmail, meet, files, dolphin, libreoffice, word, excel, powerpoint, and any installed app.

    2. EXPLICIT SEARCH ONLY: ONLY return "search <query>" when user EXPLICITLY uses the words "search for", "search online", "look up", "browse for", or "find online". A general question about ANY topic is NOT a search — answer it with chat instead.

    3. MEDIA PLAY: If user says "play X" (song/video/music) → respond: play <query>

    4. MEDIA CONTROL: If user says only "pause", "resume", or "stop" for media playback → respond: play

    5. WINDOW SWITCH: If user says "switch window", "alt tab", "next window" without naming an app → respond: switch window

    6. PLATFORM CHOICE: If Awaiting Platform is YES and user says "google" or "youtube" → respond with just that word.

    7. SELECTION: If Choices > 0 and user picks a number (one/1/first, two/2/second, etc.) → respond: select <number>

    8. DEFAULT — EVERYTHING ELSE → respond: chat <original_text>
       This includes ALL questions and conversations: weather, news, coding help, homework, science, math, history, jokes, "how does X work", "what is X", "tell me about X", "how are you", greetings, and anything not explicitly matched above.

    Respond with ONLY the final command string. No brackets unless literally part of the command.`;

    window.novaState.isProcessingCommand = true;
    uiLog('🤖 Thinking...');
    try {
        const { GoogleGenAI } = window.require('@google/genai');
        const dotenv = window.require('dotenv');
        dotenv.config();
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',

            contents: interpretationPrompt,
            config: {
                systemInstruction: `You are a voice command classifier. Output ONLY one of these, nothing else:
"focus <appname>" — user wants to open/switch to an app (any language)
"play <query>" — user wants to play music or video
"search <query>" — ONLY when user explicitly says "search for", "look up", "browse for", or "find online"
"switch window" — cycle windows, no specific app named
"select <n>" — pick numbered option (only if choices exist)
"chat <text>" — DEFAULT for ALL questions, conversations, knowledge requests, greetings, weather, news, coding help, homework, science, math, jokes, and anything not matching the above
When in doubt: chat <text>`,
                temperature: 0.1,
                maxOutputTokens: 50
            }
        });
        let interpretedCommand = response.text.trim().toLowerCase();

        // Handle explicit "CHAT" intent
        if (interpretedCommand.startsWith('chat ')) {
            window.novaState.isProcessingCommand = false;
            await askNova(interpretedCommand.replace('chat ', ''));
            return;
        }

        console.log('🤖 Interpreted command:', interpretedCommand);
        uiLog(`🤖 Interpreted: "${interpretedCommand}"`);

        // ── STRUCTURED COMMAND ROUTING ─────────────────────────────────────
        // Gemini returns structured prefixes: focus / play / search / switch window / select / chat

        // 1. APP LAUNCH
        if (interpretedCommand.startsWith('focus ')) {
            const appName = interpretedCommand.replace(/^focus\s+/, '').trim();
            const resultMsg = await ipcRenderer.invoke('focus-app', appName);
            window.novaState.isProcessingCommand = false;
            await speak(resultMsg);
            return;
        }

        // 2. PLATFORM CHOICE (pending google/youtube selection)
        if (window.novaState.isAwaitingPlatform) {
            const plat = interpretedCommand.trim();
            if (plat === 'google' || plat === 'youtube' || plat === 'video') {
                const platform = (plat === 'youtube' || plat === 'video') ? 'youtube' : 'google';
                await ipcRenderer.invoke('browser-search', { platform, query: window.novaState.pendingTopic });
                window.novaState.isAwaitingPlatform = false;
                window.novaState.isProcessingCommand = false;
                hideChoices();
                if (platform === 'youtube') {
                    setTimeout(async () => { await ipcRenderer.invoke('execute-automation', 'press-k'); }, 5000);
                }
                return;
            }
        }

        // 3. SELECTION
        if (interpretedCommand.startsWith('select ') && window.novaState.pendingChoices.length > 0) {
            const numStr = interpretedCommand.replace(/^select\s+/, '').trim();
            const wordMap = { one: 0, first: 0, '1': 0, two: 1, second: 1, '2': 1, three: 2, third: 2, '3': 2, four: 3, fourth: 3, '4': 3 };
            const parsed = parseInt(numStr);
            const index = !isNaN(parsed) ? parsed - 1 : (wordMap[numStr] !== undefined ? wordMap[numStr] : -1);
            if (index >= 0 && index < window.novaState.pendingChoices.length) {
                processSelection(window.novaState.pendingChoices[index]);
                return;
            }
        }

        // 4. MEDIA PLAY
        if (interpretedCommand.startsWith('play ') || interpretedCommand === 'play') {
            const query = interpretedCommand.replace(/^play\s*/, '').trim();
            if (!query) {
                await ipcRenderer.invoke('play-media');
                await speak("Resuming playback.");
            } else {
                speak(`Playing ${query}.`);
                ipcRenderer.invoke('browser-open', { platform: 'youtube', query });
            }
            window.novaState.isProcessingCommand = false;
            return;
        }

        // 5. EXPLICIT SEARCH (only when Gemini classified it as search)
        if (interpretedCommand.startsWith('search ')) {
            const query = interpretedCommand.replace(/^search\s+/, '').trim();
            if (query) {
                speak(`Searching for ${query}.`);
                ipcRenderer.invoke('browser-open', { platform: 'google', query });
            }
            window.novaState.isProcessingCommand = false;
            return;
        }

        // 6. WINDOW SWITCH
        if (interpretedCommand === 'switch window' || interpretedCommand.startsWith('switch window')) {
            await ipcRenderer.invoke('switch-window');
            await speak('Switching to the next window.');
            window.novaState.isProcessingCommand = false;
            return;
        }

        // 7. DEFAULT → conversation (covers all questions, weather, news, coding, homework, etc.)
        window.novaState.isProcessingCommand = false;
        await askNova(cmd);

    } catch (error) {
        window.novaState.isProcessingCommand = false;
        console.error('interpretation error:', error);
        await askNova(cmd);
    }

    subtitleElement.innerText = "";
    subtitleElement.style.color = '#fff';
    listeningSymbol.style.display = 'none';
    if (window.novaVoice.wakeUp) window.novaVoice.wakeUp();
}
