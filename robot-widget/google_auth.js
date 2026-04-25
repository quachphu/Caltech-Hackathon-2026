'use strict';
require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const TOKEN_PATH    = path.join(__dirname, 'credentials', 'google_token.json');
const REDIRECT_PORT = 3141;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// ⚠️  Scope change note: adding a new scope invalidates any existing saved token.
// After modifying this array, the user must re-run `npm run setup-google` once
// to re-authorize and get a new token that includes all scopes.
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
    // Searches the manually-saved Contacts list (Google Contacts app).
    'https://www.googleapis.com/auth/contacts.readonly',
    // Searches "Other contacts" — auto-populated by Gmail when you exchange
    // emails with someone (required for READ_SOURCE_TYPE_OTHER_CONTACT).
    'https://www.googleapis.com/auth/contacts.other.readonly',
];

// Set once by initialize() so all callers share the same browser-open function.
let _shellOpen = null;

/**
 * Wire in Electron's shell.openExternal before any OAuth flow runs.
 * Call this from main.js on app.whenReady:
 *   googleAuth.initialize((url) => shell.openExternal(url));
 */
function initialize(shellOpenFn) {
    _shellOpen = shellOpenFn;
}

function createOAuth2Client() {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error(
            'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env. ' +
            'Run `npm run setup-google` to configure them.'
        );
    }
    return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function loadToken() {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('[GoogleAuth] Could not read token file:', e.message);
    }
    return null;
}

function saveToken(token) {
    const dir = path.dirname(TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
    console.log('[GoogleAuth] Token saved to', TOKEN_PATH);
}

function openUrl(url) {
    if (typeof _shellOpen === 'function') {
        _shellOpen(url);
        return;
    }
    // Fallback for CLI usage (setup script runs outside Electron)
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32'  ? `start "" "${url}"` :
                `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.warn('[GoogleAuth] Could not open browser:', err.message);
    });
}

function waitForOAuthCode() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            try {
                const url  = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
                const code = url.searchParams.get('code');
                const err  = url.searchParams.get('error');

                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html><head><style>
                          body { font-family: sans-serif; background: #0d1117; color: #fff; text-align: center; padding: 60px; }
                          h2 { color: #00ffcc; }
                          p  { color: #8b949e; }
                        </style></head><body>
                        <h2>✅ Nova Authorization Complete</h2>
                        <p>Google access granted. You can close this window and return to Nova.</p>
                        </body></html>
                    `);
                    server.close();
                    resolve(code);
                } else {
                    const reason = err || 'Unknown error';
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ Authorization failed</h2><p>${reason}</p></body></html>`);
                    server.close();
                    reject(new Error(`OAuth denied: ${reason}`));
                }
            } catch (parseErr) {
                server.close();
                reject(parseErr);
            }
        });

        server.listen(REDIRECT_PORT, 'localhost', () => {
            console.log(`[GoogleAuth] Waiting for OAuth callback on http://localhost:${REDIRECT_PORT}/oauth2callback`);
        });

        server.on('error', (e) => {
            reject(new Error(`OAuth callback server error (is port ${REDIRECT_PORT} already in use?): ${e.message}`));
        });

        setTimeout(() => {
            server.close();
            reject(new Error('OAuth flow timed out after 5 minutes. Please try again.'));
        }, 5 * 60 * 1000);
    });
}

async function runOAuthFlow(client) {
    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
    });

    // Always print the URL so the user can copy-paste it manually if the
    // browser doesn't open automatically (common on headless / Wayland setups).
    console.log('\n[GoogleAuth] ─────────────────────────────────────────────');
    console.log('[GoogleAuth] Opening OAuth consent URL in your browser...');
    console.log('[GoogleAuth] If the browser does NOT open automatically,');
    console.log('[GoogleAuth] copy and paste this URL into your browser:\n');
    console.log('  ' + authUrl + '\n');
    console.log('[GoogleAuth] ─────────────────────────────────────────────\n');

    openUrl(authUrl);

    const code = await waitForOAuthCode();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    saveToken(tokens);
    return client;
}

/**
 * Returns an authenticated OAuth2 client.
 * Loads a cached token if one exists, refreshing it automatically when stale.
 * Falls back to the browser consent flow on first use or after revocation.
 */
async function getAuthClient() {
    const client = createOAuth2Client();
    const token  = loadToken();

    if (token) {
        // Check that the saved token covers all required scopes.
        // A token from before a scope was added will silently fail API calls.
        const savedScopes = (token.scope || '').split(' ').filter(Boolean);
        const missingScopes = SCOPES.filter(s => !savedScopes.includes(s));
        if (missingScopes.length > 0) {
            console.warn('[GoogleAuth] Token is missing scopes, re-authenticating:', missingScopes);
            try { fs.unlinkSync(TOKEN_PATH); } catch (_) {}
            return await runOAuthFlow(client);
        }

        client.setCredentials(token);

        if (token.expiry_date && Date.now() > token.expiry_date - 120_000) {
            try {
                const { credentials } = await client.refreshAccessToken();
                client.setCredentials(credentials);
                saveToken(credentials);
                console.log('[GoogleAuth] Access token refreshed.');
            } catch (refreshErr) {
                console.warn('[GoogleAuth] Token refresh failed, re-authenticating:', refreshErr.message);
                return await runOAuthFlow(client);
            }
        }

        return client;
    }

    return await runOAuthFlow(client);
}

/**
 * Returns true if a token file exists on disk.
 * Note: existence does not guarantee the token is still valid — call getAuthClient for that.
 */
function isAuthenticated() {
    return fs.existsSync(TOKEN_PATH);
}

/**
 * Revokes the stored token with Google and deletes the local credentials file.
 */
async function revokeAccess() {
    try {
        if (isAuthenticated()) {
            const client = createOAuth2Client();
            const token  = loadToken();
            if (token) {
                client.setCredentials(token);
                await client.revokeCredentials();
            }
            fs.unlinkSync(TOKEN_PATH);
            console.log('[GoogleAuth] Access revoked and token deleted.');
        }
        return true;
    } catch (e) {
        console.error('[GoogleAuth] revokeAccess error:', e.message);
        return false;
    }
}

module.exports = { initialize, getAuthClient, isAuthenticated, revokeAccess };
