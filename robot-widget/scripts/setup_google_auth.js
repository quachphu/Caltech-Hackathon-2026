#!/usr/bin/env node
'use strict';

/**
 * Nova — Google Services Setup
 * Run with: npm run setup-google
 *
 * Opens a browser OAuth consent flow so Nova can send Gmail
 * and manage Google Calendar by voice. Saves the token to
 * robot-widget/credentials/google_token.json.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { exec } = require('child_process');

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║   Nova — Google Services Setup (Gmail + Calendar + Contacts) ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

async function main() {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env\n');
        printSetupInstructions();
        process.exit(1);
    }

    console.log('✅  Credentials found in .env');
    console.log(`    Client ID: ${clientId.substring(0, 30)}...`);
    console.log('');
    console.log('🔐  Starting OAuth2 authorization flow...');
    console.log('    Your browser will open for Google authorization.');
    console.log('    Please sign in and grant access to:');
    console.log('      • Gmail (send mail + read sent history)');
    console.log('      • Google Calendar (read and write events)');
    console.log('      • Google Contacts (read-only, for voice contact resolution)');
    console.log('');

    try {
        require('googleapis');
    } catch (e) {
        console.error('❌  googleapis is not installed. Run: npm install googleapis');
        process.exit(1);
    }

    try {
        const googleAuth = require('../google_auth');

        const openUrl = (url) => {
            const cmd = process.platform === 'darwin' ? `open "${url}"` :
                        process.platform === 'win32'  ? `start "" "${url}"` :
                        `xdg-open "${url}"`;
            exec(cmd, (err) => {
                if (err) {
                    console.log('\n🌐  Browser could not open automatically. Visit this URL manually:\n');
                    console.log(`    ${url}\n`);
                }
            });
        };

        googleAuth.initialize(openUrl);

        console.log('⏳  Waiting for browser authorization...');
        console.log('    (You have 5 minutes to complete this step)\n');

        await googleAuth.getAuthClient();

        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║  ✅  Google authorization complete!                          ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('Nova can now:');
        console.log('  📧  Send Gmail      → "Hey Nova, send an email to Bryan..."');
        console.log('  📅  Calendar        → "Hey Nova, what\'s on my calendar tomorrow?"');
        console.log('  👤  Contacts lookup → Nova resolves names via Google Contacts first,');
        console.log('                        then Gmail sent history, then asks word-by-word.');
        console.log('');
        console.log('  npm start   ← launch Nova');
        console.log('');

    } catch (e) {
        console.error('\n❌  Authorization failed:', e.message);
        console.log('');
        console.log('Troubleshooting:');
        console.log('  • Make sure port 3141 is not in use by another app');
        console.log('  • Confirm your OAuth redirect URI is: http://localhost:3141/oauth2callback');
        console.log('  • Ensure Gmail API and Google Calendar API are enabled in Google Cloud Console');
        console.log('  • Add yourself as a test user if the OAuth consent screen is not yet published');
        console.log('');
        process.exit(1);
    }
}

function printSetupInstructions() {
    console.log('Steps to get Google OAuth credentials:\n');
    console.log('  1. Go to https://console.cloud.google.com/');
    console.log('  2. Create or select a project');
    console.log('  3. APIs & Services → Library → enable Gmail API and Google Calendar API');
    console.log('  4. Credentials → Create Credentials → OAuth 2.0 Client ID → Desktop app');
    console.log('  5. Copy client_id and client_secret into robot-widget/.env:\n');
    console.log('       GOOGLE_CLIENT_ID=your_client_id');
    console.log('       GOOGLE_CLIENT_SECRET=your_client_secret');
    console.log('       GOOGLE_REDIRECT_URI=http://localhost:3141/oauth2callback\n');
    console.log('  6. Run: npm run setup-google\n');
}

main();
