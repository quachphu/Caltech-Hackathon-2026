# Caltech-Hackathon-2026

# Nova AI — Complete Implementation Reference

> **For any AI or developer debugging or continuing this project:** This document is the ground truth. Read it fully before touching any code. It describes every system, every critical invariant, every known failure mode, and the exact design decisions made after extensive debugging. Violating any of the invariants here will break things in non-obvious ways.

---

## Table of Contents

1. [What is Nova?](#what-is-nova)
2. [Architecture Overview](#architecture-overview)
3. [How to Run](#how-to-run)
4. [Environment & Dependencies](#environment--dependencies)
5. [File Map](#file-map)
6. [Core Pipeline: Voice → Gemini → Action](#core-pipeline-voice--gemini--action)
7. [Gemini Live API — Critical Invariants](#gemini-live-api--critical-invariants)
8. [Feature: Video Editor](#feature-video-editor)
9. [Feature: Email with Attachments](#feature-email-with-attachments)
10. [Feature: Calendar](#feature-calendar)
11. [Feature: Code Agent](#feature-code-agent)
12. [Feature: AI Image Generation](#feature-ai-image-generation)
13. [Feature: AI Video Generation](#feature-ai-video-generation)
14. [Feature: Browser Control](#feature-browser-control)
15. [Feature: Notes](#feature-notes)
16. [Feature: Research Paper Generation](#feature-research-paper-generation)
17. [Feature: Stock Charts](#feature-stock-charts)
18. [Feature: Macro Recording](#feature-macro-recording)
19. [Feature: Screen Analysis](#feature-screen-analysis)
20. [Debounce Architecture](#debounce-architecture)
21. [UI: The Orb & Motion Engine](#ui-the-orb--motion-engine)
22. [Known Failure Modes & Fixes](#known-failure-modes--fixes)
23. [Platform Notes](#platform-notes)
24. [Quick Debug Checklist](#quick-debug-checklist)

---

## What is Nova?

Nova is a **desktop AI assistant** built with Electron. It renders as a small glowing orb pinned to the bottom-right corner of the screen, always on top of all windows. The user speaks to it via microphone; it listens using Vosk (offline English STT for wake-word/trigger detection in the UI), forwards raw audio to Gemini Live API for real-time multilingual understanding, and executes tool calls (email, video editing, calendar, code, browser automation, etc.) in response to voice commands.

**Key design principle:** Nova is voice-first. Everything goes through Gemini Live API's audio stream. Vosk is only for local trigger detection and UI feedback — Gemini does all real speech understanding. This is why Spanish, Portuguese, and other languages work even though Vosk only understands English.

---

## Architecture Overview

```
User speaks
    ↓
[renderer.js] — Captures mic via Web Audio API at 16kHz mono PCM
    ↓ (PCM audio chunks over IPC)
[main.js] — Bridges renderer ↔ live session
    ↓
[live.js] — Gemini Live API (WebSocket bidirectional)
    ↓
Gemini interprets speech, calls tools
    ↓
Tool handlers:
  video_editor.js, gmail.js, calendar.js, code_agent.js,
  image_gen.js, video_gen.js, notes.js, gemini.js
    ↓
Results injected back via sendRealtimeInput({ text: ... }) or functionResponses
    ↓
Gemini generates TTS audio
    ↓
[renderer.js] — Plays audio, updates orb animation
```

### Two-layer STT architecture

Nova runs **two speech recognizers simultaneously**:

| Layer                  | What                        | Why                                                                |
| ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| Vosk (in-browser WASM) | English STT, always-on      | Local, zero latency, shows live transcript in UI as debug feedback |
| Gemini Live API        | Multilingual, streaming PCM | Real understanding — hears raw audio, no transcription needed      |

Vosk transcriptions are shown in the UI but are NOT what Gemini acts on. Gemini hears the raw audio. This is why multilingual commands work even when Vosk shows garbled English text.

---

## How to Run

```bash
cd robot-widget
npm install
npm run start
```

**Linux:** The start script forces X11: `--ozone-platform=x11`. Required for `alwaysOnTop`, transparency, and `xdotool` automation.

### Google Auth Setup (Email + Calendar + Contacts)

```bash
npm run setup-google
```

Runs `scripts/setup_google_auth.js`, opens OAuth browser flow, saves token to `credentials/google_token.json`. Required for: email, calendar, contacts.

### OpenShot (Video Editor) — Linux

```bash
# Flatpak (recommended):
flatpak install flathub org.openshot.OpenShot

# Native package managers:
sudo pacman -S openshot      # Arch
sudo apt install openshot-qt  # Debian/Ubuntu
```

The video editor also needs libopenshot Python bindings accessible for `clip_gen.py`:

```bash
# Test it:
flatpak run --command=python3 org.openshot.OpenShot -c "import openshot; print('OK')"
```

### xdotool (Linux only, for OpenShot window control)

```bash
sudo pacman -S xdotool   # Arch
sudo apt install xdotool  # Debian/Ubuntu
```

### ffmpeg (Video Preview rendering)

```bash
sudo pacman -S ffmpeg      # Arch
sudo apt install ffmpeg     # Debian/Ubuntu
brew install ffmpeg         # macOS
# Windows: download from https://ffmpeg.org/download.html and add to PATH
```

---

## Environment & Dependencies

### `.env` file (in `robot-widget/`)

```
GEMINI_API_KEY=your_gemini_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

All three required. `GEMINI_API_KEY` covers Gemini Live API, Imagen (image gen), and Veo (video gen). Google credentials are for Gmail/Calendar/Contacts OAuth.

### npm packages

| Package             | Use                          |
| ------------------- | ---------------------------- |
| `@google/genai`     | Gemini Live API, Imagen, Veo |
| `googleapis`        | Gmail, Calendar, Contacts    |
| `dotenv`            | env file loading             |
| `three`             | Three.js 3D orb              |
| `vosk-browser`      | Offline English WASM STT     |
| `electron` (devDep) | Desktop shell                |

### Vosk models (bundled)

- `vosk-model/` — English model (~40MB)
- `vosk-model-es/vosk-model-small-es-0.42/` — Spanish small model (future use)

---

## File Map

| File                           | Role                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`                      | Electron main process. Creates `BrowserWindow`, owns all IPC, drives motion engine, initializes tool handlers.                                           |
| `renderer.js`                  | Electron renderer. Three.js orb, Vosk STT, mic capture at 16kHz, Gemini audio playback, echo-tail gating, status badge, editor beep system.              |
| `live.js`                      | **The brain.** Connects to Gemini Live API, defines all 20+ tools in the system prompt, routes tool calls to handlers, manages all live-layer debounces. |
| `video_editor.js`              | All OpenShot video editor logic: create/read/write `.osp` files directly, add/delete clips, `play_preview` via ffmpeg, save/export. Tool-level debounce. |
| `clip_gen.py`                  | Python script called via `flatpak run`. Uses libopenshot Python bindings to generate 100%-compatible clip JSON entries.                                  |
| `gmail.js`                     | Gmail send/draft, Google Contacts resolution, attachment handling.                                                                                       |
| `calendar.js`                  | Google Calendar: get events, create event, delete event, check availability.                                                                             |
| `code_agent.js`                | AI coding agent: generates full projects, modifies code, opens browser preview. Uses Gemini text API.                                                    |
| `image_gen.js`                 | Imagen 3 integration. Single images and batch (multiple subjects). Saves to `~/Desktop`.                                                                 |
| `video_gen.js`                 | Veo 2 integration. 8-second AI cinematic video with speech/audio. Saves to `~/Videos`.                                                                   |
| `notes.js`                     | AI notes system: create (full AI content), update, search, list, open. Stored as `.md` files in `~/Documents/Nova Notes/`.                               |
| `gemini.js`                    | Research paper generation via Gemini text API. Full APA-format academic papers.                                                                          |
| `tts.js`                       | Text-to-speech via Gemini TTS API. Outputs WAV played by renderer. (Used for intro message, not main conversation.)                                      |
| `stt.js`                       | Whisper STT fallback (not used in Live mode).                                                                                                            |
| `google_auth.js`               | OAuth2 token management for Google APIs.                                                                                                                 |
| `index.html`                   | Minimal HTML shell. Loads Three.js orb and renderer.js.                                                                                                  |
| `chat.html` / `chat.js`        | Floating text chat panel (opened by double-clicking orb).                                                                                                |
| `attachments_panel.html`       | File picker panel for email attachments.                                                                                                                 |
| `contacts_panel.html`          | Contacts list panel for email mode.                                                                                                                      |
| `calendar_panel.html`          | Calendar events panel.                                                                                                                                   |
| `video_editor_panel.html`      | Video editor status panel.                                                                                                                               |
| `notes_panel.html`             | Notes viewer panel.                                                                                                                                      |
| `scripts/setup_google_auth.js` | OAuth setup script.                                                                                                                                      |

---

## Core Pipeline: Voice → Gemini → Action

### 1. Mic Capture (renderer.js)

Mic captured at **16kHz mono PCM** via Web Audio API with a **2.5× gain boost** (for distant voice / quiet mics). Audio flows through a `ScriptProcessorNode` (4096 samples/chunk) into two paths:

- **Vosk path:** WASM recognizer → live transcript shown in UI
- **Gemini Live path:** raw PCM chunks → IPC to main process → Gemini websocket

**Echo-tail gate (`ECHO_TAIL_MS = 2500ms`):** When Gemini's TTS finishes playing, the mic is blocked for 2500ms. This prevents Nova from hearing its own voice and re-triggering tool calls. `_speakingEndedAt` is set when TTS ends; audio chunks are dropped while `Date.now() - _speakingEndedAt < ECHO_TAIL_MS`.

### 2. Gemini Live Connection (live.js)

**Model:** `gemini-3.1-flash-live-preview`

Session config:

```javascript
{
    responseModalities: [Modality.AUDIO],  // Nova speaks, never types
    systemInstruction: "..."               // Full tool definitions + personality
}
```

Audio chunks flow: `sendAudioChunk(base64Data)` → `activeSession.sendRealtimeInput({ media: { data, mimeType: 'audio/pcm;rate=16000' } })`

### 3. Tool Call Processing

When Gemini fires a `toolCall` event on the session:

```
toolCall received
    ↓
[live.js] checks debounce (per-action or per-filename key)
    ↓ (passes)
Sends IMMEDIATE ACK (functionResponse) with speaking instructions
    ↓
Runs async tool handler in background
    ↓
On completion: sends text injection (sendRealtimeInput({ text: ... })) with next-step guidance
    ↓ (1500ms delay for file operations, 200ms for others)
```

### 4. THE IMMEDIATE ACK PATTERN — Most Critical Invariant

**Gemini Live API only reliably generates TTS when it receives a `functionResponse` while the user's audio turn is still "hot."** Delayed responses (sent seconds later) often produce no audio at all.

**The correct pattern (used everywhere):**

```javascript
// Step 1: Send ACK immediately — this triggers Gemini TTS
activeSession.sendRealtimeInput({
  functionResponses: [
    {
      id: call.id,
      response: {
        status: "ok",
        message:
          'Say out loud: "Adding League1.mp4, one moment!" Then wait. Do NOT call any tool.',
      },
    },
  ],
});

// Step 2: Run actual tool async in background
automationRef.videoEditorTool(call.args).then((result) => {
  // Step 3: After tool finishes, inject context via text (not function response)
  setTimeout(() => {
    activeSession.sendRealtimeInput({
      text: `[CLIP_ADDED] File added. Say: "Done! ..."`,
    });
  }, 1500); // delay lets ACK TTS finish first
});
```

**Never** delay the function response to wait for the tool result. The ACK always goes first.

### 5. Text Injections for Post-Tool Guidance

After a tool completes, context is delivered via `sendRealtimeInput({ text: "..." })`. These are injected as user-side context updates (not function responses).

**Injection delays:**

- File operations (`import_file`, `add_to_timeline`, `delete_clip`): **1500ms** — lets ACK TTS finish
- Other operations: **200ms**
- If injection arrives during TTS playback → TTS gets interrupted → Gemini may go silent

---

## Gemini Live API — Critical Invariants

Hard-won lessons from debugging. Violating any of these breaks audio or causes loops.

### 1. Only functionResponses trigger audio reliably

Text injections (`sendRealtimeInput({ text: ... })`) update context but do NOT reliably trigger TTS. Only `functionResponses` reliably trigger audio generation. This is why every tool uses immediate ACK with speaking instructions.

### 2. Never mention the just-processed filename in post-success injections

After importing `League1.mp4`, if CLIP_ADDED says "Do NOT add League1.mp4 again", Gemini reads "League1.mp4" and may call import_file for it again. Only mention the NEXT file(s), never the file just processed.

### 3. Debounce responses must always include a speak instruction

If a debounce response returns `"already_running"` with no `Say:` instruction, Gemini goes silent. Every debounce response must tell Gemini what to say:

```javascript
// Bad:
message: "already_running";

// Good:
message: 'Say: "Let me add League2.mp4 for you!" Then call import_file(file_name="League2.mp4") immediately.';
```

### 4. Per-filename debounce, never per-action, for file operations

`import_file:league1` and `import_file:league2` are independent keys. Using just `import_file` blocks different files from being imported within the window.

### 5. Concurrent tool calls with different files must both run

When Gemini calls `add_to_timeline("League1")` and `add_to_timeline("League2")` simultaneously, both should execute. Both layers (live.js + video_editor.js) use per-filename keys to allow this.

### 6. Text injection timing relative to TTS is critical

Injection during TTS → TTS interrupted → silence. For file operations: 1500ms delay. For others: 200ms.

### 7. ACK messages must NOT pre-confirm tool results

Wrong: `"Say: 'Done! League1 removed from timeline.'"` (before tool confirms it worked)
Right: `"Say: 'Removing League1 from the timeline, one moment!' Then wait."` (neutral, waits for actual result)
If the tool fails after a pre-confirmation ACK, Gemini gets contradicting signals → silence.

---

## Feature: Video Editor

### Overview

Voice-controlled OpenShot video editor. Nova creates/opens `.osp` project files directly (bypasses OpenShot GUI), manipulates them programmatically, relaunches OpenShot to display changes.

### Key Files

- `video_editor.js` — All logic
- `clip_gen.py` — libopenshot clip JSON generator (Python, called via flatpak)

### Architecture: Direct `.osp` File Editing

Nova does NOT use the OpenShot GUI to add clips. Instead:

1. Kill OpenShot (if running)
2. Read `.osp` JSON file directly
3. Add/modify JSON (file entries + clip entries)
4. Write `.osp` back to disk
5. Relaunch OpenShot in background (non-blocking via `spawn + detached + unref`)

This makes operations take ~0.5s instead of several seconds via GUI automation.

### OpenShot Project File (`.osp`) Format

```json
{
  "id": "uuid",
  "fps": { "num": 24, "den": 1 },
  "width": 1280,
  "height": 720,
  "sample_rate": 48000,
  "channels": 2,
  "files": [
    {
      "id": "uuid",
      "path": "/absolute/path/to/video.mp4",
      "name": "video.mp4",
      "has_audio": true,
      "has_video": true,
      "duration": 30.5,
      "fps": { "num": 30, "den": 1 },
      "width": 1920,
      "height": 1080
    }
  ],
  "clips": [
    {
      "id": "uuid",
      "file_id": "matches files[*].id",
      "layer": 5000000,
      "position": 0.0,
      "start": 0.0,
      "end": 30.5,
      "has_video": {
        "Points": [{ "co": { "X": 1, "Y": 1 }, "interpolation": 0 }]
      },
      "has_audio": {
        "Points": [{ "co": { "X": 1, "Y": 1 }, "interpolation": 0 }]
      }
    }
  ],
  "layers": [
    { "id": "L5", "number": 5000000, "label": "", "y": 0, "lock": false }
  ]
}
```

**Critical details:**

- Clips always use layer **5000000** (Track 5, top visible track in OpenShot default view)
- `has_video`/`has_audio` in clips use **keyframe format** (Y=1 = enabled, Y=-1 = disabled)
- `has_audio` in file entries is stored as **boolean** (`true`/`false`) by Nova, but OpenShot may convert to keyframe format on save
- Paths in file entries must be **absolute** to survive cross-session use

### clip_gen.py — Why It Exists

Manually constructing clip JSON causes version-mismatch warnings and corrupted clips in OpenShot. `clip_gen.py` uses the actual libopenshot Python bindings to generate 100%-compatible JSON, then overrides key fields:

```python
clip = openshot.Clip(video_path)
clip.Position(position)
clip.Layer(layer)
d = json.loads(clip.Json())
d['id'] = str(uuid.uuid4())
d['file_id'] = file_id
d['position'] = position
d['layer'] = layer
d['start'] = 0.0
d['end'] = end_time
# Override has_video/has_audio to Y=1 (enabled)
_kf_true = {"Points": [{"co": {"X": 1, "Y": 1}, "handle_left": {"X": 0.5, "Y": 1}, "handle_right": {"X": 0.5, "Y": 0}, "handle_type": 0, "interpolation": 0}]}
d['has_video'] = _kf_true
d['has_audio'] = _kf_true
```

The Y=-1 default from libopenshot means "disabled" — overriding to Y=1 is required for clips to render in OpenShot.

### Video Editor Actions

| Action            | What Happens                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`   | Scans `~/Videos/*.osp`, returns project names                                                                                                       |
| `open_editor`     | Creates or finds `.osp`, kills existing OpenShot, launches OpenShot with project file. Sets `_videoEditorModeActive = true`, `_currentProjectPath`. |
| `import_file`     | Kills OpenShot, adds file entry + clip to `.osp` via `clip_gen.py`, relaunches OpenShot in background                                               |
| `add_to_timeline` | Same as import_file but auto-imports the file entry if not yet in `proj.files`                                                                      |
| `delete_clip`     | Removes clip entries from `.osp` (keeps file entry intact), relaunches OpenShot                                                                     |
| `play_preview`    | Reads clips from `.osp`, builds ffmpeg filter_complex, renders `{project}_movie.mp4`, opens with system player                                      |
| `save_project`    | Relaunches OpenShot if killed, waits for window, sends Ctrl+S via xdotool                                                                           |
| `export_video`    | Focuses OpenShot, sends Ctrl+E to open OpenShot's export dialog                                                                                     |
| `undo`            | Focuses OpenShot, sends Ctrl+Z                                                                                                                      |
| `redo`            | Focuses OpenShot, sends Ctrl+Y                                                                                                                      |
| `close_editor`    | Kills OpenShot, resets state variables, clears debounces                                                                                            |

### State Variables (video_editor.js)

```javascript
let _videoEditorModeActive = false; // true after open_editor succeeds
let _editorOpening = false; // hard lock during open_editor launch sequence
let _currentProjectPath = null; // absolute path to active .osp
let _openShotKilled = false; // true when we killed OpenShot to edit .osp
```

### Debounce Architecture (Two Layers)

**Layer 1 — live.js (`_videoEditorDebounce` Map, per-filename keys):**

```javascript
VIDEO_EDITOR_DEBOUNCE_MS = {
  list_projects: 30000, // user takes time to pick; prevent re-call loop
  open_editor: 300000, // 5-minute session lock
  import_file: 30000, // per-filename: import_file:league1
  add_to_timeline: 15000, // per-filename: add_to_timeline:league2
  delete_clip: 15000, // per-filename: delete_clip:league1
  play_preview: 30000, // ffmpeg takes 10-60s
  save_project: 10000,
  close_editor: 8000,
};

// Key format for file operations:
const veKey =
  (action === "import_file" || action === "add_to_timeline") && _veFileName
    ? `${action}:${_veFileName}` // "import_file:league1"
    : action; // "play_preview"
```

**Layer 2 — video_editor.js (`_veDebounce` Map, also per-filename):**

```javascript
VE_DEBOUNCE_MS = {
  import_file: 12000,
  add_to_timeline: 3000, // prevents race condition when two files fire simultaneously
  delete_clip: 3000,
};

// Same per-filename key format:
const _deKey =
  (action === "import_file" ||
    action === "add_to_timeline" ||
    action === "delete_clip") &&
  file_name
    ? `${action}:${file_name
        .toLowerCase()
        .replace(/\.[^.]+$/, "")
        .trim()}`
    : action;
```

**Cross-debounce after import_file** — prevents Gemini calling add_to_timeline for the same file that was just imported via import_file:

```javascript
if (action === "import_file") {
  const crossKey = _veFileName
    ? `add_to_timeline:${_veFileName}`
    : "add_to_timeline";
  _videoEditorDebounce.set(
    crossKey,
    nowVE + VIDEO_EDITOR_DEBOUNCE_MS.add_to_timeline,
  );
}
```

### play_preview — ffmpeg Rendering

Reads clips from `.osp`, handles both boolean and keyframe `has_audio` formats, resolves relative paths, builds a filter_complex:

```
// Per clip with audio:
[i:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,trim=start=S:end=E,setpts=PTS-STARTPTS[vi]
[i:a]atrim=start=S:end=E,asetpts=PTS-STARTPTS[ai]

// Per clip without audio (synthesized silence):
aevalsrc=0:channel_layout=stereo:sample_rate=44100[_silenti]
[_silenti]atrim=0:DUR,asetpts=PTS-STARTPTS[ai]

// Concat:
[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]
```

Output: `{projectName}_movie.mp4` in same folder as `.osp`. Opened with system player (`xdg-open` Linux, `open` Mac, `start` Windows).

**Fallback:** If no clips on layer 5000000, fall back to all clips in project (handles cases where OpenShot reorganized layers).

**has_audio detection:**

```javascript
function _hasAudioEnabled(val) {
  if (typeof val === "boolean") return val;
  if (val && typeof val === "object" && Array.isArray(val.Points)) {
    const y = val.Points[0]?.co?.Y;
    return y === undefined || Number(y) >= 0; // Y=-1 = disabled
  }
  return !!val;
}
```

**Relative path resolution:**

```javascript
const fPath =
  rawPath && !path.isAbsolute(rawPath)
    ? path.resolve(ospDir, rawPath) // ospDir = dirname(_currentProjectPath)
    : rawPath;
```

### ACK Messages for Video Editor Actions

| Action            | ACK Message                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `open_editor`     | `"Say: 'Opening project [name], one moment!' Listen — if user says name is wrong, acknowledge it but do NOT call open_editor again."` |
| `import_file`     | `"Say out loud: 'Adding [file] to your timeline, one moment!' Then wait."`                                                            |
| `add_to_timeline` | `"Say: 'Adding [file] to the timeline, one moment!' Then wait."`                                                                      |
| `delete_clip`     | `"Say: 'Removing [file] from the timeline, one moment!' Then wait."`                                                                  |
| `play_preview`    | `"Say out loud: 'Rendering your movie now — this takes a few seconds!' Do NOT call any tool. Wait for the result."`                   |
| `save_project`    | `"Say out loud: 'Saving your project! I'll use keyboard shortcuts.' Then wait silently."`                                             |

### Post-Completion Injections

**After `import_file` success (1500ms delay):**

```
// If 1 file remains:
[CLIP_ADDED] File added. Say: "Done! Want to add League2.mp4 as well? Say yes."
If yes: call import_file(file_name='League2.mp4').
Do NOT call import_file for any previously added file.

// If multiple remain:
[CLIP_ADDED] File added. Say: "Done! You can add: League2.mp4, League3.mp4. Which one?"

// If none remain:
[CLIP_ADDED] All files on timeline. Say: "All done! Say play to preview or save."
```

**After `add_to_timeline` success (1500ms delay):** Same CLIP_ADDED pattern.

**After `delete_clip` success (1500ms delay):**

```
[CLIP_DELETED] Say: "[tool speak text]" Then guide: "Say a filename to add ([available files]), say play to preview, or say save."
```

**After `open_editor` success (200ms delay):**

```
[FILE_IMPORT_MODE] The video editor is open with project "[name]".
Available video files: League1.mp4, League2.mp4.
Say to the user: "The editor is open! Which video file would you like to add? Here are your files: ..."
The INSTANT the user says any filename, call import_file(file_name='[exact filename]') IMMEDIATELY.
NEVER call open_editor again. You ARE in the editor.
```

### Debounce Responses for Video Editor

**When same file is called again after already added (1 remaining):**

```
Say: "Let me add [remaining_file] for you!" Then IMMEDIATELY call import_file(file_name='[remaining_file]') RIGHT NOW.
```

Note: Never mention the blocked filename. Gemini latches onto any filename it reads.

**When play_preview is debounced (mid-render):**

```
Say out loud: "Still rendering your video, please wait a moment!" Do NOT call play_preview again.
```

**When open_editor is debounced (editor already open, user says video filename):**

```
EDITOR IS ALREADY OPEN. The user wants to ADD "[filename]" to the timeline. Call import_file(file_name='[filename]') RIGHT NOW.
```

### System Prompt for Video Editor

Defined in live.js as a dynamic function (captures current project list). Key elements:

- Mandatory 4-step workflow in a visual box
- Project naming guard: filter out Spanish/Portuguese conversational filler
- Multilingual triggers: "import X" / "importar X" / "agregar X" / "añadir X" → `import_file`
- Play triggers: "play" / "preview" / "reproducir" / "ver el video" → `play_preview`
- KEY DISTINCTION: "generate/create a new video" = `generate_video` tool; "edit/compile existing videos" = `video_editor_action`

---

## Feature: Email with Attachments

### Mandatory 9-Step Flow (enforced by system prompt + hard gate)

```
STEP 1 — Call list_contacts → shows contacts panel
STEP 2 — Ask: "Who would you like to email?" → get recipient name
STEP 3 — Ask: "Would you like to include an attachment?"
         YES → ask type (video/document/image) → list_attachable_files
               Panel shows files with numbered lookup table
               User picks → Gemini confirms → remembers exact absPath
         NO  → proceed to STEP 4
STEP 4 — Ask: "What would you like the subject to be?" → collect subject
STEP 5 — Ask: "What would you like to say?" → collect message_intent
STEP 6 — Call send_email(recipient_name, subject, message_intent, [attachment_path])
STEP 7 — Read back [EMAIL PREVIEW]: subject, body summary, attachment note
         Ask: "Does this look good? Say yes to send."
         YES → send_email(confirmed=true, [all args])
         Change → re-call send_email with new subject/message_intent (no confirmed_body)
         Cancel → "Got it, email cancelled."
STEP 8 — "Email sent!" → open Gmail sent folder
STEP 9 — Ask: "Send another email, or are you all done?"
```

**Hard gate at send_email handler:** If `message_intent` is empty on a non-confirmed call → rejected:

```
"You skipped required steps. Ask STEP 3 (attachment?), STEP 4 (subject?), STEP 5 (what to say?). Only THEN call send_email."
```

### Attachable Files (`scanAttachableFiles`)

Scans these directories by file type:

```javascript
video:    { dirs: [~/Videos, ~/Movies, ~/Downloads] }
document: { dirs: [~/Documents, ~/Downloads, ~/Desktop] }
image:    { dirs: [~/Pictures, ~/Desktop, ~/Downloads] }
```

Scans one level of subdirectories (catches `Screenshots/`, `Work/`, etc.). Returns `{ name, absPath }` pairs. Presented as numbered lookup table to Gemini so it passes exact absolute path as `attachment_path`.

### Email Tool Result States

| `result.status`        | Meaning                             | Injection                                    |
| ---------------------- | ----------------------------------- | -------------------------------------------- |
| `needs_confirmation`   | Body generated, needs user approval | [EMAIL PREVIEW] injection with confirm args  |
| `success`              | Email sent                          | Opens Gmail sent folder, asks "another?"     |
| `draft_saved`          | Saved as draft                      | Spoken naturally                             |
| `needs_disambiguation` | Multiple contacts with same name    | Numbered list, re-call with `selected_index` |
| `needs_username`       | Contact not found                   | Ask for email username                       |
| `needs_domain`         | Have username, need domain          | Ask for domain, assemble full address        |
| `auth_required`        | Not authenticated                   | Tell user to run `npm run setup-google`      |

### Email Debounces

```javascript
_emailInFlight = true / false; // mutex: one flow at a time
_emailCooldownMs = 8000; // block unconfirmed re-calls within 8s
_confirmCooldownMs = 6000; // block stale confirmed=true duplicates
LIST_CONTACTS_COOLDOWN_MS = 30000; // contacts panel already showing
LIST_ATTACH_COOLDOWN_MS = 20000; // file list already showing
```

---

## Feature: Calendar

### Actions

| Action               | Trigger Examples                                    |
| -------------------- | --------------------------------------------------- |
| `get_events`         | "what's on my calendar", "what do I have this week" |
| `create_event`       | "schedule a call with Bryan on Monday at 10am"      |
| `delete_event`       | "cancel my 4pm today"                               |
| `check_availability` | "am I free Friday afternoon"                        |

Default `time_expression` for `get_events`: `"this week"` (not "today").

**Debounce:** 12 seconds per action key. Prevents Gemini looping calendar calls.

---

## Feature: Code Agent

### Actions

```javascript
CODE_AGENT_DEBOUNCE_MS = {
  generate_code: 120000, // 30-60s generation
  modify_code: 60000, // ~20s modification
  create_project: 15000,
  open_project: 10000,
  list_projects: 10000,
  preview_project: 10000,
  start_session: 10000,
  end_session: 10000,
};
```

`generate_code` creates a full project from description. `modify_code` changes specific parts of an existing project. `preview_project` opens in Nova's built-in browser.

---

## Feature: AI Image Generation

### Tool: `generate_image` (Imagen 3)

Saves to `~/Desktop`.

**Two modes:**

- **Single:** One image from full prompt
- **Batch:** Multiple subjects sharing same style (max 6)

**Required collection before calling:**

1. Style
2. Mood (only if not obvious)
3. Orientation (square/landscape/portrait)

**Debounce:** 30s single, 90s batch.

### Batch example

```javascript
generate_image({
  prompt: "professional portrait, studio lighting, clean background",
  subjects: [
    "a university student",
    "a software developer",
    "a nurse in scrubs",
  ],
  style: "realistic",
  aspect_ratio: "portrait",
});
// Generates 3 separate images, one per subject
```

---

## Feature: AI Video Generation

### Tool: `generate_video` (Veo 2)

8-second cinematic AI video with speech and audio. Saves to `~/Videos`.

**Mandatory 8-question collection (one at a time, in order):**

1. Main topic/story
2. Visual style (cinematic/animated/documentary/nature/sci-fi/commercial)
3. Environment + location + time of day
4. Characters (appearance + personality)
5. Scene breakdown: second-by-second events + exact dialogue
6. Camera movement (zoom/drone/close-up/wide/handheld/slow-mo)
7. Color palette and mood
8. Aspect ratio (16:9/9:16/1:1)

**Debounce:** 120 seconds. Mutex flag `_videoGenInFlight` also blocks concurrent calls. Video takes 2–5 minutes.

---

## Feature: Browser Control

### Tool: `control_browser`

Opens Nova's own `BrowserWindow` (not the system browser).

| Action             | Trigger                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `open`             | "search for X on Google", "go to website X", "open X in the browser" |
| `search_youtube`   | "play X on YouTube", "search YouTube for X"                          |
| `smart_click`      | "click on X", "click X" — clicks element by visible text             |
| `scroll`           | "scroll down/up"                                                     |
| `close`            | "close the browser" — only after user explicitly says "close"        |
| `toggle_incognito` | "switch to incognito", "exit incognito"                              |

### Store Assistant Mode

Activates on Apple, Amazon, and other stores. Auto-scans DOM after each navigation, narrates products/prices/options. Stuck-URL detection: 3 consecutive same-URL auto-scans → direct-navigation fallback with hardcoded Apple/Amazon URL patterns.

### get_browser_state

Only called when user asks "what's on screen" or "list the elements". Never before smart_click.

**Debounce:** 8s for get_browser_state. 10s post-close lockout.

---

## Feature: Notes

### Tool: `notes_action`

Stored as `.md` in `~/Documents/Nova Notes/`.

```javascript
NOTES_DEBOUNCE_MS = {
  create_note: 60000, // AI generation 15-30s
  update_note: 20000, // AI update ~10s
  search_notes: 4000,
  list_notes: 4000,
  open_note: 2000,
  exit_notes_mode: 4000,
};
```

---

## Feature: Research Paper Generation

### Tool: `create_research_paper`

Full APA-format academic paper via Gemini text API. Opens in browser. Takes several minutes.

**Extremely strict trigger — ALL of these must be true:**

1. Explicit creation verb: write/create/generate/make/build/compose/prepare
2. Exact phrase: "research paper"/"academic paper"/"scientific paper"/"research essay"
3. Specific topic named

"Open the research paper" → file-open request, NOT a trigger. "Show me the research paper" → file-open. When in doubt, answer conversationally.

---

## Feature: Stock Charts

### Tool: `show_stock_chart`

Shows chart panel. Narrates: current price, daily change, 3-month trend. **Never opens browser for stock questions.**

Common tickers in system prompt: Apple=AAPL, Microsoft=MSFT, Tesla=TSLA, Amazon=AMZN, Google=GOOGL, Meta=META, Netflix=NFLX, Nvidia=NVDA, Nintendo=NTDOY, Sony=SONY.

---

## Feature: Macro Recording

### Tool: `macro_control`

Records and replays sequences of Nova actions.

- `start_recording` — enters recording mode
- `stop_recording` — ends, asks for name
- `run_macro` — replays saved macro
- `list_macros` — lists saved macros
- `delete_macro` — removes a macro

**Cannot record:** `send_email` or calendar mutations (would execute on every replay). System prompt warns Gemini about this.

---

## Feature: Screen Analysis

### Tool: `analyze_screen`

Screenshot → Gemini Vision → narrated description. Triggers: "what's on my screen?", "what am I looking at?".

**Debounce:** 5 seconds.

---

## Debounce Architecture

### Summary Table

| Location        | Map Name               | Key Format                    | Purpose                        |
| --------------- | ---------------------- | ----------------------------- | ------------------------------ |
| live.js         | `_videoEditorDebounce` | `action` or `action:filename` | API-layer gate, long windows   |
| live.js         | `_calendarDebounce`    | `action`                      | Calendar loop prevention       |
| live.js         | `_codeAgentDebounce`   | `action`                      | Code agent long-running gate   |
| live.js         | `_notesDebounce`       | `action`                      | Notes operation gate           |
| live.js         | `_macroDebounce`       | `action`                      | Macro operation gate           |
| live.js         | `_screenDebounce`      | `'screen_analyze'`            | Screen analysis rate limit     |
| video_editor.js | `_veDebounce`          | `action` or `action:filename` | Tool-level race condition gate |

### Why Two Layers for Video Editor

The live.js layer has long windows (15–30s) to handle echo and Gemini retry behavior. The video_editor.js tool-level layer has short windows (3–12s) to prevent concurrent calls for the same file from running the tool twice. Both must use per-filename keys — if either uses just `action` as the key, different files will block each other.

---

## UI: The Orb & Motion Engine

### Three.js Orb

A 3D sphere with CSS state classes: `listening`, `speaking`, `thinking`. Set by `setOrbState()` in renderer.js.

### Motion Engine (main.js)

Nova wanders during conversation via lerp-based position updates (30ms interval):

| Mode        | Lerp speed | Target change | Screen range |
| ----------- | ---------- | ------------- | ------------ |
| `speaking`  | 0.012      | every 5000ms  | 42%W × 38%H  |
| `listening` | 0.018      | every 3500ms  | 65%W × 58%H  |
| `thinking`  | 0.022      | every 2200ms  | 55%W × 50%H  |

Home position: bottom-right corner. Nova drifts toward upper-center area while active, returns home when task completes. Drag pauses bounce; bounce resumes from new position after drag.

### Editor Beep System (renderer.js)

Independent audio feedback via Web AudioContext (no Gemini TTS needed):

```javascript
function _playEditorBeep(type) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  // 'done':  660Hz → 880Hz ramp (file added)
  // 'ready': 523Hz → 659Hz ramp (editor opened)
  // 'error': 200Hz flat (something failed)
  // Duration: 300ms, gain: 0.3
}
ipcRenderer.on("play-editor-beep", (_e, type) => _playEditorBeep(type));
```

### IPC Channel Reference

| Channel                  | Direction | Purpose                             |
| ------------------------ | --------- | ----------------------------------- |
| `drag-start/move/end`    | R→M       | Widget drag                         |
| `open-chat`              | R→M       | Double-click opens chat             |
| `audio-chunk`            | R→M       | PCM mic audio                       |
| `live-audio-chunk`       | M→R       | Gemini TTS audio                    |
| `show-status-message`    | M→R       | Status badge text                   |
| `play-editor-beep`       | M→R       | Audio beep ('done'/'ready'/'error') |
| `video-editor-ready-cue` | M→R       | Status cue text + mic icon flash    |
| `motion-mode`            | M→R       | Wander mode update                  |

---

## Known Failure Modes & Fixes

### 1. Nova goes silent after opening the video editor

**Cause A:** ACK had "wait silently" → Gemini obeyed and stayed mute.
**Fix:** ACK now says "Listen — if user says that name is wrong, acknowledge but don't call open_editor again."

**Cause B:** `isProcessingCommand = true` in `show-status-message` handler blocked `speak()` and `askNova()`.
**Fix:** Removed the flag from that handler.

### 2. Same file imported multiple times (duplicates)

**Cause:** Import debounce expired; Gemini mapped another utterance to same filename.
**Fix 1:** Per-filename debounce key.
**Fix 2:** Hard duplicate detection in `addClipToOspTimeline` — checks `file_id` against existing clips before adding.

### 3. Gemini calls `import_file("League1")` when user says "League 2"

**Cause:** CLIP_ADDED injection said "Do NOT add League1.mp4 again" → Gemini read "League1.mp4" → latched onto it.
**Fix 1:** CLIP_ADDED injection never names the just-added file. Only names remaining files.
**Fix 2:** When debounce fires for a file already added and only 1 remains, auto-redirect: `"Say: 'Let me add League2.mp4 for you!' Then IMMEDIATELY call import_file(file_name='League2.mp4')."`

### 4. `add_to_timeline(League2)` blocked when called concurrently with League1

**Cause:** Tool-level `_veDebounce` used `action` as key. League1 set `add_to_timeline` debounce; League2 hit it 1ms later → returned `status: 'debounced'`.
**Fix:** Tool-level debounce also uses per-filename key: `add_to_timeline:league2`.

### 5. Nova goes silent after `add_to_timeline` success

**Cause A:** `prompt = result.status === 'ok' ? null : ...` → no injection for success. Gemini had nothing to act on.
**Fix:** Add success injection with remaining files, same pattern as import_file.

**Cause B:** ACK pre-confirmed "Done! That clip is on your timeline" before tool ran. If tool then returned an error, contradicting messages → silence.
**Fix:** ACK now says "Adding X, one moment!" (neutral). Success/error both handled in post-completion injection.

### 6. `delete_clip` contradicts itself

**Cause:** ACK said "Done! It's been removed." before tool confirmed. Second delete of same clip → tool returned error. Two conflicting signals → silence.
**Fix:** ACK changed to "Removing X from the timeline, one moment!" Both success and error get post-completion injections.

### 7. `play_preview` — "Could not find video files"

**Cause A:** OpenShot saved `.osp` with relative paths. `fs.existsSync('./video.mp4')` failed (wrong CWD).
**Fix:** `path.resolve(ospDir, rawPath)` where `ospDir = path.dirname(_currentProjectPath)`.

**Cause B:** OpenShot converted `has_audio: true` (boolean) to keyframe object. `f.has_audio === true` → `false`.
**Fix:** `_hasAudioEnabled()` handles both boolean and `{Points: [{co: {X, Y}}]}` formats.

**Cause C:** Clips on wrong layer after OpenShot reorganized.
**Fix:** If no clips on layer 5000000, fall back to rendering all clips.

### 8. Project named "piensas" (Spanish filler word)

**Cause:** User said "piensas tú" (you think) in Spanish; Gemini extracted "piensas" as the project name.
**Fix:** System prompt tells Gemini to filter out conversational filler words in any language and ask again if the name sounds like conversation.

### 9. Email skips attachment/subject/content steps

**Cause:** Gemini called `send_email` directly without following mandatory collection steps.
**Fix:** Hard gate: empty `message_intent` on non-confirmed call → rejected with step-by-step redirect back to STEP 3.

### 10. Gemini calls `open_editor` instead of `import_file` after editor opens

**Cause:** Without file list in context, Gemini confused "League" with project name "League of Legends".
**Fix:** FILE_IMPORT_MODE injection includes actual file list from `scanVideoFiles()`.

**open_editor debounce redirect:** If debounced call has a video filename as `file_name`:

```
EDITOR IS ALREADY OPEN. The user wants to ADD "[filename]". Call import_file(file_name='[filename]') RIGHT NOW.
```

### 11. `import_file` debounce blocks different files

**Old:** Key = `"import_file"`. After League1, League2 blocked for 30s.
**Fix:** Keys = `"import_file:league1"` and `"import_file:league2"` independently.

### 12. Debounce fires but Gemini silent

**Cause:** Debounce response message was `"already_running"` with no `Say:` instruction.
**Fix:** Every debounce response includes explicit speech instruction. For video file repeats with 1 remaining: auto-redirect to next file. For play_preview: "Still rendering, please wait!"

---

## Platform Notes

### Linux (Primary — fully tested)

- Run with `--ozone-platform=x11`
- xdotool required: `sudo pacman -S xdotool` or `sudo apt install xdotool`
- OpenShot via Flatpak: `flatpak install flathub org.openshot.OpenShot`
- Videos folder: `~/Videos`
- Open video file: `xdg-open 'path/to/file.mp4'`
- Kill OpenShot: `flatpak kill org.openshot.OpenShot 2>/dev/null; pkill -f openshot-qt`
- `BrowserWindow` type hint: `'toolbar'` (keeps above desktop without stealing focus)

### macOS (Stubbed, not fully tested)

- Remove `--ozone-platform=x11` from start script
- No `BrowserWindow` type hint (conditional in main.js: Linux-only)
- OpenShot: `open -a "OpenShot Video Editor" /path/to/project.osp`
- Videos folder: `~/Movies`
- Open video file: `open 'path/to/file.mp4'`
- Kill OpenShot: `osascript -e 'tell application "OpenShot Video Editor" to quit'`
- xdotool unavailable → window automation disabled; `canAutomate = false`

### Windows (Stubbed, not fully tested)

- Remove `--ozone-platform=x11` from start script
- OpenShot: `C:\Program Files\OpenShot Video Editor\openshot-qt.exe`
- Videos folder: `%USERPROFILE%\Videos` (`os.homedir() + '/Videos'` works correctly)
- Open video file: `start "" "path\to\file.mp4"`
- Kill OpenShot: `taskkill /IM openshot-qt.exe /F`
- xdotool unavailable → window automation disabled

---

## Quick Debug Checklist

**Nova goes silent after an action:**

1. Check if ACK message has "wait silently" → remove it
2. Check if `prompt = null` for success case → add a success injection
3. Check if ACK pre-confirms before tool result → make ACK neutral ("one moment!")
4. Check if `isProcessingCommand` is being set anywhere that blocks speak → remove it

**Gemini loops the same function call:**

1. Check if debounce key is per-action instead of per-filename → fix to `action:filename`
2. Check if both live.js AND video_editor.js debounce use per-filename keys
3. Check if the debounce response includes a speak instruction and next-step guidance

**`play_preview` — "no clips" or "could not find files":**

1. Check console `🎬 play_preview:` logs for clip count, layers, and file paths
2. If paths show as relative: relative-path resolution is needed (ospDir + resolve)
3. If has_audio is an object: `_hasAudioEnabled()` must be used
4. If layer != 5000000: layer fallback should activate

**Import works but then goes silent (stops responding):**

1. CLIP_ADDED injection mentions the just-added filename → remove it
2. CLIP_ADDED missing from success path (`prompt = null`) → add injection
3. Injection delay is 0ms → set to 1500ms for file operations

**Email steps being skipped:**

1. Verify hard gate is in place at send_email handler (checks `message_intent`)
2. Verify system prompt still has STEP 1–9 in order with mandatory sequence markers
3. Verify STEP 3 (attachment) and STEP 4 (subject) are explicitly numbered

**Project gets wrong name from multilingual speech:**

1. System prompt filler-word filter covers: "piensas", "pienso", "quiero", "maybe", "um"
2. If new filler words appear in logs, add them to the filter list in the open_editor pre-check in live.js
3. ACK says the project name aloud so user can hear and correct it immediately

**Concurrent file calls blocking each other:**

1. live.js `veKey` uses per-filename format for `import_file` and `add_to_timeline`
2. video_editor.js `_deKey` uses per-filename format for `import_file`, `add_to_timeline`, `delete_clip`
3. If either uses just `action` → different files block each other within the debounce window
