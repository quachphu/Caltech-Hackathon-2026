require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const NOTES_DIR = path.join(os.homedir(), 'Documents', 'Nova Notes');

let _currentOpenFilePath = null;

function ensureNotesDir() {
    if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function sanitizeFilename(title) {
    return title.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function getAllNotes() {
    ensureNotesDir();
    try {
        return fs.readdirSync(NOTES_DIR)
            .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
            .map(filename => {
                const filePath = path.join(NOTES_DIR, filename);
                try {
                    const stat    = fs.statSync(filePath);
                    const content = fs.readFileSync(filePath, 'utf8');
                    const title   = filename.replace(/\.(md|txt)$/, '');
                    return {
                        filename, title, content,
                        preview:  content.slice(0, 160).replace(/[#*`>\-]/g, '').replace(/\n+/g, ' ').trim(),
                        created:  stat.birthtime,
                        modified: stat.mtime,
                        filePath
                    };
                } catch (_) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.modified - a.modified);
    } catch (_) { return []; }
}

function getNote(title) {
    if (!title) return null;
    const notes = getAllNotes();
    const lower = title.toLowerCase().trim();

    // 1. Exact match
    let match = notes.find(n => n.title.toLowerCase() === lower);
    if (match) return match;

    // 2. One contains the other
    match = notes.find(n => n.title.toLowerCase().includes(lower) || lower.includes(n.title.toLowerCase()));
    if (match) return match;

    // 3. Word-overlap fuzzy scoring
    const queryWords = lower.split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length === 0) return null;
    const scored = notes.map(note => {
        const noteWords = note.title.toLowerCase().split(/[\s\-_()]+/);
        let score = 0;
        for (const qw of queryWords) {
            for (const nw of noteWords) {
                if (nw === qw) { score += 3; continue; }
                if (nw.includes(qw) || qw.includes(nw)) { score += 1; }
            }
        }
        return { note, score };
    }).sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 2) return scored[0].note;
    return null;
}

function searchNotes(query) {
    const notes = getAllNotes();
    if (!query || notes.length === 0) return notes;
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return notes;
    const scored = notes.map(note => {
        const text = (note.title + ' ' + note.content).toLowerCase();
        let score = 0;
        for (const w of words) {
            const hits = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
            score += hits;
            if (note.title.toLowerCase().includes(w)) score += 4;
        }
        return { ...note, score };
    });
    return scored.sort((a, b) => b.score - a.score);
}

function createNote(title, content) {
    ensureNotesDir();
    const safeName = sanitizeFilename(title);
    const filename = safeName + '.md';
    const filePath = path.join(NOTES_DIR, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    const stat = fs.statSync(filePath);
    return {
        filename, title: safeName, content,
        preview:  content.slice(0, 160).replace(/[#*`>\-]/g, '').replace(/\n+/g, ' ').trim(),
        created:  stat.birthtime,
        modified: stat.mtime,
        filePath
    };
}

function updateNote(title, newContent, newTitle) {
    const note = getNote(title);
    if (!note) return null;
    if (newTitle) {
        const safeName = sanitizeFilename(newTitle);
        if (safeName !== note.title) {
            const newFilename = safeName + '.md';
            const newFilePath = path.join(NOTES_DIR, newFilename);
            fs.writeFileSync(newFilePath, newContent, 'utf8');
            try { fs.unlinkSync(note.filePath); } catch (_) {}
            const stat = fs.statSync(newFilePath);
            return {
                filename: newFilename, title: safeName, content: newContent,
                preview: newContent.slice(0, 160).replace(/[#*`>\-]/g, '').replace(/\n+/g, ' ').trim(),
                created: note.created, modified: stat.mtime, filePath: newFilePath
            };
        }
    }
    fs.writeFileSync(note.filePath, newContent, 'utf8');
    const stat = fs.statSync(note.filePath);
    return { ...note, content: newContent, modified: stat.mtime };
}

function closeNoteInApp() {
    if (!_currentOpenFilePath) return;
    const fp = _currentOpenFilePath;
    _currentOpenFilePath = null;

    if (process.platform === 'linux') {
        // Kill every process that has the file open — most reliable on Linux
        spawn('bash', ['-c', `fuser -k "${fp}" 2>/dev/null; true`],
            { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
        // lsof lists processes that have the file open; kill them
        spawn('bash', ['-c',
            `lsof "${fp}" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u | xargs -r kill 2>/dev/null`
        ], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
        // Windows: close any window whose title matches the note filename
        const titleHint = path.basename(fp, '.md');
        spawn('cmd', ['/c', `taskkill /FI "WINDOWTITLE eq ${titleHint}*" /F 2>nul`],
            { detached: true, stdio: 'ignore' }).unref();
    }
}

function openNoteInApp(filePath) {
    closeNoteInApp(); // close previous system editor window if any
    _currentOpenFilePath = filePath;
    // Open with the OS default app on every platform — consistent cross-platform behaviour
    if (process.platform === 'darwin') {
        spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
        spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
}

async function generateNoteContent(userRequest, noteTitle) {
    const prompt =
        `You are Nova — an AI assistant creating a high-quality personal note.\n\n` +
        `Note title: "${noteTitle}"\n` +
        `User's request: ${userRequest}\n\n` +
        `Create a well-structured, concise note that gives the user exactly what they need.\n` +
        `RULES:\n` +
        `- Start with "# ${noteTitle}" as the very first line\n` +
        `- Use markdown: ## for sections, - for bullet points, **bold** for key terms, \`code\` for commands/code\n` +
        `- If technical (how-to, troubleshooting, code, setup): include numbered steps, exact commands, examples\n` +
        `- If creative (poem, story, essay, script): write the full creative piece in the best quality possible\n` +
        `- If informational: bullet points with key facts, highlight what matters most\n` +
        `- Concise but complete — like the best AI answer compressed into note format\n` +
        `- NO preamble, NO explanation, NO "Here is your note:" — just the note content directly`;

    let attempt = 0;
    while (attempt < 3) {
        try {
            const model = attempt < 2 ? 'gemini-2.5-flash' : 'gemini-2.0-flash';
            console.log(`[Notes] generateNoteContent attempt ${attempt + 1} model=${model}`);
            const response = await ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { temperature: 0.65 }
            });
            const text = response.text;
            if (!text || text.trim().length === 0) {
                throw new Error('AI returned empty content');
            }
            console.log(`[Notes] generateNoteContent success, length=${text.length}`);
            return text;
        } catch (e) {
            console.error(`[Notes] generateNoteContent attempt ${attempt + 1} failed: ${e.message}`);
            if ((e.status === 503 || e.status === 429) && attempt < 2) {
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
                attempt++;
            } else { throw e; }
        }
    }
}

async function handleNotesActionTool(args, logFn, notifyPanel) {
    const { action, title, user_request, content, query, new_title } = args;
    logFn(`[Notes] action=${action} title="${title || ''}" query="${query || ''}"`);

    try {
        // ── list_notes ────────────────────────────────────────────────────
        if (action === 'list_notes') {
            const notes = getAllNotes();
            notifyPanel({ mode: 'list', notes: notes.slice(0, 20) });
            const titles = notes.slice(0, 5).map(n => `"${n.title}"`).join(', ');
            return {
                status: 'ok',
                count: notes.length,
                speak: notes.length === 0
                    ? 'You have no notes yet. I can create one for you — just tell me what you want to write.'
                    : `You have ${notes.length} note${notes.length !== 1 ? 's' : ''}: ${titles}${notes.length > 5 ? ', and more' : ''}. Which one would you like to open?`
            };
        }

        // ── search_notes ──────────────────────────────────────────────────
        if (action === 'search_notes') {
            const q       = query || user_request || '';
            const results = searchNotes(q);
            const top     = results.slice(0, 8);

            if (top.length === 0) {
                const all = getAllNotes().slice(0, 8);
                notifyPanel({ mode: 'list', notes: all, searchQuery: q });
                return {
                    status: 'not_found',
                    notes: all.map(n => ({ title: n.title })),
                    speak: `I couldn't find any notes matching that. Showing all your notes on screen.`
                };
            }

            // Auto-open best match when it's clearly the right one
            const best = top[0];
            const secondScore = top[1] ? (top[1].score || 0) : 0;
            const bestScore   = best.score || 0;
            const autoOpen    = top.length === 1 || (bestScore > 2 && bestScore >= secondScore * 1.5);

            if (autoOpen) {
                notifyPanel({ mode: 'note', note: best });
                openNoteInApp(best.filePath, best.title, best.content);
                global.currentNoteName   = best.title;
                global.novaIsInNotesMode = true;
                return {
                    status: 'ok',
                    notes: top.map(n => ({ title: n.title })),
                    speak: `Found your note: "${best.title}". Opening it now — it's on screen. You can ask me to update it or say "I am done taking notes" when finished.`
                };
            }

            notifyPanel({ mode: 'list', notes: top, searchQuery: q });
            const titleList = top.slice(0, 3).map(n => `"${n.title}"`).join(', ');
            return {
                status: 'ok',
                count: top.length,
                notes: top.map(n => ({ title: n.title, preview: n.preview })),
                speak: `I found ${top.length} notes that match. The closest ones are: ${titleList}. Which one did you want?`
            };
        }

        // ── open_note ─────────────────────────────────────────────────────
        if (action === 'open_note') {
            // Try fuzzy match first — getNote already does fuzzy internally
            const note = getNote(title || '');
            if (!note) {
                // Fall back to search
                const results = searchNotes(title || query || '');
                const top = results.slice(0, 8);
                if (top.length > 0 && (top[0].score || 0) > 0) {
                    // Open the best match directly
                    const best = top[0];
                    notifyPanel({ mode: 'note', note: best });
                    openNoteInApp(best.filePath, best.title, best.content);
                    global.currentNoteName   = best.title;
                    global.novaIsInNotesMode = true;
                    return {
                        status: 'ok',
                        speak: `Opening "${best.title}" — it's on screen now.`
                    };
                }
                notifyPanel({ mode: 'list', notes: top });
                return {
                    status: 'not_found',
                    notes: top.map(n => ({ title: n.title })),
                    speak: `I couldn't find a note called "${title}". These are your closest notes — which one did you mean?`
                };
            }
            notifyPanel({ mode: 'note', note });
            openNoteInApp(note.filePath, note.title, note.content);
            global.currentNoteName   = note.title;
            global.novaIsInNotesMode = true;
            return {
                status: 'ok',
                speak: `Opening "${note.title}" — it's on screen now.`
            };
        }

        // ── create_note ───────────────────────────────────────────────────
        if (action === 'create_note') {
            const noteTitle = (title || 'Untitled Note').trim();
            const request   = user_request || content || noteTitle;
            notifyPanel({ mode: 'writing', noteTitle });
            logFn(`[Notes] Creating note: "${noteTitle}" request="${request.slice(0,80)}"`);

            let generated;
            try {
                generated = await generateNoteContent(request, noteTitle);
            } catch (genErr) {
                logFn(`[Notes] AI generation failed (${genErr.message}), using plain content fallback`);
                // Fallback: save a basic note so the file is at least created
                generated = `# ${noteTitle}\n\n${request}`;
            }

            logFn(`[Notes] Writing file, content length=${generated.length}`);
            let note;
            try {
                note = createNote(noteTitle, generated);
                logFn(`[Notes] File saved: ${note.filePath}`);
            } catch (writeErr) {
                logFn(`[Notes] File write FAILED: ${writeErr.message}`);
                throw writeErr;
            }

            openNoteInApp(note.filePath, note.title, note.content);
            notifyPanel({ mode: 'note', note });
            global.currentNoteName    = note.title;
            global.novaIsInNotesMode  = true;
            return {
                status: 'created',
                speak: `Done! "${note.title}" is written and open on screen. Take a look — does it look right, or should I change anything? When you're all set, say "I am done taking notes" to exit.`
            };
        }

        // ── update_note ───────────────────────────────────────────────────
        if (action === 'update_note') {
            const noteTitle = (title || global.currentNoteName || '').trim();
            if (!noteTitle) return { status: 'error', speak: 'Which note should I update?' };
            // Fuzzy match: getNote already tries exact then word-overlap
            let existing = getNote(noteTitle);
            // Last resort: search by title words
            if (!existing) {
                const results = searchNotes(noteTitle);
                if (results.length > 0 && (results[0].score || 0) > 0) existing = results[0];
            }
            if (!existing) return { status: 'error', speak: `I couldn't find a note called "${noteTitle}".` };
            const request = user_request || content || '';
            notifyPanel({ mode: 'writing', noteTitle, updating: true });
            logFn(`[Notes] Updating note: "${noteTitle}" request="${request.slice(0,80)}"`);
            const effectiveNewTitle = (new_title || '').trim() || null;
            const generateTitle    = effectiveNewTitle || noteTitle;
            let newContent;
            try {
                newContent = await generateNoteContent(
                    `Here is the existing note:\n\n${existing.content}\n\n---\nUpdate request: ${request}\n\nGenerate the complete updated note incorporating these changes.`,
                    generateTitle
                );
            } catch (genErr) {
                logFn(`[Notes] AI update generation failed (${genErr.message}), keeping original with appended note`);
                newContent = `${existing.content}\n\n---\n\n## Update\n\n${request}`;
            }
            logFn(`[Notes] Writing update, content length=${newContent.length}`);
            const updated = updateNote(noteTitle, newContent, effectiveNewTitle);
            if (!updated) return { status: 'error', speak: 'I had trouble saving the update.' };
            if (effectiveNewTitle) {
                global.currentNoteName = updated.title;
            }
            notifyPanel({ mode: 'note', note: updated });
            openNoteInApp(updated.filePath, updated.title, updated.content);
            return {
                status: 'updated',
                speak: `Updated! Check "${updated.title}" on screen. Does it look good, or need more changes? Say "I am done taking notes" when you're finished.`
            };
        }

        // ── exit_notes_mode ───────────────────────────────────────────────
        if (action === 'exit_notes_mode') {
            global.novaIsInNotesMode = false;
            global.currentNoteName   = null;
            closeNoteInApp();
            notifyPanel({ mode: 'close' });
            return { status: 'exited', speak: 'Notes mode closed. What else can I help you with?' };
        }

        return { status: 'error', speak: 'Unknown notes action.' };

    } catch (e) {
        logFn(`[Notes] Error: ${e.message}`);
        notifyPanel({ mode: 'error', message: e.message });
        return { status: 'error', speak: `I ran into an issue with your notes: ${e.message}` };
    }
}

module.exports = {
    getAllNotes,
    getNote,
    searchNotes,
    createNote,
    updateNote,
    openNoteInApp,
    closeNoteInApp,
    generateNoteContent,
    handleNotesActionTool,
    NOTES_DIR
};
