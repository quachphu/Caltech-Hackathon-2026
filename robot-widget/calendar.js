'use strict';
require('dotenv').config();
const { google }                    = require('googleapis');
const { GoogleGenAI }               = require('@google/genai');
const { getAuthClient, isAuthenticated } = require('./google_auth');
const { searchContacts }            = require('./gmail');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function getCalendarClient() {
    const auth = await getAuthClient();
    return google.calendar({ version: 'v3', auth });
}

/**
 * Convert a natural language time expression like "tomorrow at 3pm" or
 * "this Friday morning" into { start, end } ISO 8601 strings.
 * The user's local timezone is detected automatically.
 */
async function parseNaturalTime(utterance) {
    const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date().toLocaleString('en-US', { timeZone: tz });

    const prompt =
        `Convert this natural language time expression to an ISO 8601 date-time range.\n` +
        `Current local time: ${now}\n` +
        `User timezone: ${tz}\n` +
        `Expression: "${utterance}"\n\n` +
        `Rules:\n` +
        `- Return ONLY a JSON object: { "start": "...", "end": "..." }\n` +
        `- Both values must be full ISO 8601 strings WITH timezone offset (e.g. 2026-04-16T14:00:00-07:00)\n` +
        `- If no time is given (e.g. "tomorrow"), use 08:00–09:00 as the default window\n` +
        `- If "this week" → start=today 00:00, end=Sunday 23:59\n` +
        `- If "today" with no time → start=now, end=today 23:59\n` +
        `- Default event duration: 1 hour unless stated otherwise\n` +
        `Respond with only the JSON, no markdown or explanation.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ text: prompt }] }],
            config: { temperature: 0 },
        });

        const text      = (response.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) throw new Error('No JSON in parseNaturalTime response');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.start || !parsed.end) throw new Error('Missing start/end in parsed time');
        return { start: parsed.start, end: parsed.end };

    } catch (e) {
        console.error('[Calendar] parseNaturalTime error:', e.message, '— using fallback');
        const start = new Date();
        start.setMinutes(0, 0, 0);
        start.setHours(start.getHours() + 1);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return { start: start.toISOString(), end: end.toISOString() };
    }
}

function toLocalTime(isoString) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Date(isoString).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
    });
}

function toLocalDate(isoString) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return new Date(isoString).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: tz,
    });
}

function normalizeEvent(raw) {
    return {
        id:          raw.id,
        title:       raw.summary              || 'Untitled Event',
        start:       raw.start?.dateTime      || raw.start?.date,
        end:         raw.end?.dateTime        || raw.end?.date,
        location:    raw.location             || '',
        attendees:   (raw.attendees || []).map(a => a.email),
        description: raw.description          || '',
        htmlLink:    raw.htmlLink             || '',
        allDay:      !raw.start?.dateTime,
    };
}

/**
 * Format an event list into a single sentence Nova can speak.
 */
function formatEventsForSpeech(events, timeframeLabel) {
    if (events.length === 0) {
        return `You have nothing scheduled ${timeframeLabel}. Your day is clear.`;
    }

    const items     = events.map(e => `${e.allDay ? 'all day' : toLocalTime(e.start)}: ${e.title}`).join('. ');
    const first     = events[0];
    const firstTime = first.allDay ? 'all day' : toLocalTime(first.start);

    return (
        `You have ${events.length} ${events.length === 1 ? 'event' : 'events'} ${timeframeLabel}. ` +
        `${items}. ` +
        `First up is ${first.title} at ${firstTime}.`
    );
}

/**
 * Fetch events from the primary calendar within a time range.
 * @returns {Array} normalized event objects
 */
async function getEventsInRange(startISO, endISO) {
    const calendar = await getCalendarClient();
    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin:    startISO,
        timeMax:    endISO,
        singleEvents: true,
        orderBy:    'startTime',
        maxResults: 50,
    });
    return (response.data.items || []).map(normalizeEvent);
}

/**
 * Get events for the next `days` days starting from now.
 */
async function getUpcomingEvents(days = 1) {
    const now     = new Date();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return getEventsInRange(now.toISOString(), timeMax.toISOString());
}

/**
 * Create a new event on the primary calendar.
 * @param {{ title, startTime, endTime, description?, attendees?: string[] }}
 * @returns {{ success, eventId?, htmlLink?, error? }}
 */
async function createEvent({ title, startTime, endTime, description, attendees }) {
    try {
        const calendar = await getCalendarClient();
        const tz       = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const eventBody = {
            summary:     title,
            description: description || '',
            start: { dateTime: startTime, timeZone: tz },
            end:   { dateTime: endTime,   timeZone: tz },
        };

        if (attendees && attendees.length > 0) {
            eventBody.attendees = attendees.map(email => ({ email }));
        }

        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: eventBody,
        });
        console.log('[Calendar] Event created:', response.data.id);
        return { success: true, eventId: response.data.id, htmlLink: response.data.htmlLink };

    } catch (e) {
        console.error('[Calendar] createEvent error:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Delete an event from the primary calendar by its ID.
 * @returns {{ success, error? }}
 */
async function deleteEvent(eventId) {
    try {
        const calendar = await getCalendarClient();
        await calendar.events.delete({ calendarId: 'primary', eventId });
        console.log('[Calendar] Deleted event:', eventId);
        return { success: true };
    } catch (e) {
        console.error('[Calendar] deleteEvent error:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Find free time windows on a given date that fit the requested duration.
 * Scans between 08:00 and 20:00 local time.
 * @param {string} dateISO - any ISO string representing the target date
 * @param {number} durationMinutes
 * @returns {Array<{ start: string, end: string }>}
 */
async function findFreeSlots(dateISO, durationMinutes = 60) {
    const targetDate = new Date(dateISO);
    const dayStart   = new Date(targetDate);
    const dayEnd     = new Date(targetDate);
    dayStart.setHours(8, 0, 0, 0);
    dayEnd.setHours(20, 0, 0, 0);

    const events = await getEventsInRange(dayStart.toISOString(), dayEnd.toISOString());

    const busySlots = events
        .filter(e => !e.allDay && e.start && e.end)
        .map(e => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
        .sort((a, b) => a.start - b.start);

    const freeSlots = [];
    let cursor = dayStart.getTime();

    for (const busy of busySlots) {
        if (busy.start > cursor && busy.start - cursor >= durationMinutes * 60_000) {
            freeSlots.push({ start: new Date(cursor).toISOString(), end: new Date(busy.start).toISOString() });
        }
        cursor = Math.max(cursor, busy.end);
    }

    if (dayEnd.getTime() - cursor >= durationMinutes * 60_000) {
        freeSlots.push({ start: new Date(cursor).toISOString(), end: dayEnd.toISOString() });
    }

    return freeSlots;
}

/**
 * Top-level handler called by the Gemini Live calendar_action tool dispatch.
 * Handles get_events, create_event, delete_event, and check_availability.
 *
 * @param {{ action, time_expression?, event_title?, duration_minutes?, attendees?, event_id? }} args
 * @param {Function} logFn - optional, write to the automation-log IPC channel
 * @returns {object} tool call response payload
 */
async function handleCalendarActionTool(args, logFn) {
    const log = logFn || ((msg) => console.log('[Calendar Tool]', msg));
    const { action, time_expression, event_title, duration_minutes = 60, attendees = [], event_id } = args;

    // Guard: never trigger the interactive OAuth browser flow inside the live session.
    // The user must run `npm run setup-google` first to save a token.
    if (!isAuthenticated()) {
        const msg = 'Google Calendar is not connected yet. To use it, open a terminal in the robot-widget folder and run: npm run setup-google — it will open a browser to authorize access. After that, restart Nova and calendar will work.';
        log('⚠️ [Calendar] Not authenticated — returning auth_required');
        return { status: 'auth_required', speak: msg, message: msg };
    }

    try {
        if (action === 'get_events') {
            log(`📅 get_events: "${time_expression || 'today'}"`);

            let startISO, endISO, label;
            try {
                const range = await parseNaturalTime(time_expression || 'this week');
                startISO = range.start;
                endISO   = range.end;

                // For range expressions (week, month) use the expression itself as the label.
                const expr = (time_expression || 'this week').toLowerCase();
                if (expr.includes('week')) {
                    label = expr.includes('next') ? 'next week' : expr.includes('last') ? 'last week' : 'this week';
                } else if (expr.includes('month')) {
                    label = expr.includes('next') ? 'next month' : expr.includes('last') ? 'last month' : 'this month';
                } else {
                    // For specific dates, compare date strings (not timestamps) to avoid
                    // off-by-one errors when startISO is midnight and current time is later in the day.
                    const startStr     = new Date(startISO).toDateString();
                    const today        = new Date();
                    const todayStr     = today.toDateString();
                    const tomorrowStr  = new Date(today.getTime() + 86_400_000).toDateString();
                    const yesterdayStr = new Date(today.getTime() - 86_400_000).toDateString();
                    if (startStr === todayStr)     label = 'today';
                    else if (startStr === tomorrowStr)  label = 'tomorrow';
                    else if (startStr === yesterdayStr) label = 'yesterday';
                    else label = toLocalDate(startISO);
                }
            } catch (e) {
                // Fallback: this week
                const now = new Date();
                startISO  = new Date(now.setHours(0, 0, 0, 0)).toISOString();
                const end = new Date(); end.setDate(end.getDate() + (7 - end.getDay())); end.setHours(23, 59, 59, 999);
                endISO    = end.toISOString();
                label     = 'this week';
            }

            const events  = await getEventsInRange(startISO, endISO);
            const summary = formatEventsForSpeech(events, label);
            log(`📅 ${summary}`);
            return { status: 'success', events: events.slice(0, 10), speak: summary, message: summary };
        }

        if (action === 'create_event') {
            if (!event_title) {
                return { status: 'error', message: 'No event title provided.', speak: 'What should I call the event?' };
            }

            log(`📅 create_event: "${event_title}" at "${time_expression}"`);
            const range   = await parseNaturalTime(time_expression || 'in 1 hour');
            const startDT = range.start;
            const endDT   = new Date(new Date(range.start).getTime() + duration_minutes * 60_000).toISOString();

            const resolvedAttendees = [];
            for (const attendee of attendees) {
                if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendee)) {
                    resolvedAttendees.push(attendee);
                } else {
                    const contact = await searchContacts(attendee).catch(() => null);
                    if (contact) resolvedAttendees.push(contact.email);
                    else log(`⚠️ Could not resolve attendee "${attendee}" — skipping`);
                }
            }

            const existingEvents = await getEventsInRange(startDT, endDT);
            let conflictNote = '';
            if (existingEvents.length > 0) {
                const names = existingEvents.map(e => e.title).join(', ');
                conflictNote = ` Note: there is already ${existingEvents.length === 1 ? 'an event' : 'events'} at that time: ${names}. Mention this to the user and ask if they still want to proceed.`;
            }

            const result = await createEvent({ title: event_title, startTime: startDT, endTime: endDT, description: '', attendees: resolvedAttendees });
            if (!result.success) {
                const errMsg = `I couldn't create the event. ${result.error || ''}`;
                return { status: 'error', message: errMsg, speak: errMsg };
            }

            const successMsg = `${event_title} has been added to your calendar for ${toLocalDate(startDT)} at ${toLocalTime(startDT)}.`;
            log(`✅ ${successMsg}`);
            return { status: 'success', eventId: result.eventId, speak: successMsg + conflictNote, message: successMsg + conflictNote };
        }

        if (action === 'delete_event') {
            let targetId    = event_id;
            let targetTitle = event_title || 'that event';

            if (!targetId) {
                log(`📅 delete_event: looking up "${event_title}"`);
                const range  = await parseNaturalTime(time_expression || 'today').catch(() => ({
                    start: new Date().toISOString(),
                    end:   new Date(Date.now() + 2 * 86_400_000).toISOString(),
                }));
                const events = await getEventsInRange(range.start, range.end);
                const match  = events.find(e => e.title.toLowerCase().includes((event_title || '').toLowerCase()));

                if (!match) {
                    const msg = `I couldn't find an event called "${event_title}" on your calendar.`;
                    return { status: 'not_found', message: msg, speak: msg };
                }
                targetId    = match.id;
                targetTitle = match.title;
            }

            const result = await deleteEvent(targetId);
            if (!result.success) {
                const errMsg = `I couldn't cancel ${targetTitle}. ${result.error || ''}`;
                return { status: 'error', message: errMsg, speak: errMsg };
            }

            const doneMsg = `${targetTitle} has been cancelled.`;
            log(`🗑️ ${doneMsg}`);
            return { status: 'success', message: doneMsg, speak: doneMsg };
        }

        if (action === 'check_availability') {
            log(`📅 check_availability: "${time_expression}"`);
            const range = await parseNaturalTime(time_expression || 'today');
            const slots = await findFreeSlots(range.start, duration_minutes);

            if (slots.length === 0) {
                const msg = `You're fully booked during ${time_expression || 'that time'}. No free slots available.`;
                return { status: 'success', freeSlots: [], message: msg, speak: msg };
            }

            const slotList = slots.map(s => `${toLocalTime(s.start)} to ${toLocalTime(s.end)}`).join(', and ');
            const freeMsg  = `You're free from ${slotList} on ${toLocalDate(range.start)}.`;
            log(`📅 ${freeMsg}`);
            return { status: 'success', freeSlots: slots, message: freeMsg, speak: freeMsg };
        }

        return { status: 'error', message: `Unknown action: ${action}`, speak: `I don't know how to do that calendar action.` };

    } catch (e) {
        if (e.message.includes('GOOGLE_CLIENT_ID') || e.message.includes('credentials') || e.message.includes('Token')) {
            const authMsg = 'I need access to your Google Calendar. Opening authorization now.';
            log(`🔐 ${authMsg}`);
            return { status: 'auth_required', message: authMsg, speak: authMsg };
        }

        const errMsg = `I had a problem with the calendar. ${e.message}`;
        console.error('[Calendar] handleCalendarActionTool error:', e.message);
        return { status: 'error', message: errMsg, speak: errMsg };
    }
}

module.exports = {
    getUpcomingEvents,
    getEventsInRange,
    createEvent,
    deleteEvent,
    findFreeSlots,
    parseNaturalTime,
    formatEventsForSpeech,
    handleCalendarActionTool,
};
