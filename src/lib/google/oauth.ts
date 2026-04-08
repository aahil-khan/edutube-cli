import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import { edutubeConfigDir, googleTokenPath } from './paths.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export function getOAuthRedirectUri(): string {
    const port = parseInt(process.env.EDUTUBE_OAUTH_PORT || '38475', 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error('EDUTUBE_OAUTH_PORT must be a positive integer');
    }
    return `http://127.0.0.1:${port}/oauth2callback`;
}

export function readGoogleClientEnv(): { clientId: string; clientSecret: string } {
    const clientId = process.env.EDUTUBE_GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.EDUTUBE_GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
        throw new Error(
            'Set EDUTUBE_GOOGLE_CLIENT_ID and EDUTUBE_GOOGLE_CLIENT_SECRET (Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → Desktop app).'
        );
    }
    return { clientId, clientSecret };
}

export async function saveGoogleTokens(tokens: Credentials): Promise<void> {
    await mkdir(edutubeConfigDir(), { recursive: true });
    await writeFile(googleTokenPath(), JSON.stringify(tokens, null, 2), 'utf8');
}

export async function loadGoogleTokens(): Promise<Credentials | null> {
    const p = googleTokenPath();
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as Credentials;
}

/**
 * Returns true if we have tokens on disk and they still work (refreshes access token if needed).
 * Persists refreshed credentials back to disk when Google rotates the access token.
 */
export async function tryUseSavedGoogleTokens(): Promise<boolean> {
    const existing = await loadGoogleTokens();
    if (!existing?.refresh_token && !existing?.access_token) {
        return false;
    }
    try {
        const client = createOAuth2Client();
        client.setCredentials(existing);
        await client.getAccessToken();
        const next = client.credentials;
        const merged: Credentials = { ...existing, ...next };
        if (existing.refresh_token && merged.refresh_token === undefined) {
            merged.refresh_token = existing.refresh_token;
        }
        await saveGoogleTokens(merged);
        return true;
    } catch {
        return false;
    }
}

export function createOAuth2Client(): OAuth2Client {
    const { clientId, clientSecret } = readGoogleClientEnv();
    return new OAuth2Client(clientId, clientSecret, getOAuthRedirectUri());
}

/** Loopback: open browser, receive code, save refresh token. */
export async function runGoogleAuthInteractive(): Promise<void> {
    const redirectUri = getOAuthRedirectUri();
    const oauth2Client = createOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        /** Explicit for spec; also avoids broken requests if URL is ever truncated (e.g. Windows shell). */
        response_type: 'code'
    });

    const code = await new Promise<string>((resolve, reject) => {
        const u = new URL(redirectUri);
        const port = Number(u.port);
        const server = createServer((req, res) => {
            if (!req.url) {
                res.statusCode = 400;
                res.end();
                return;
            }
            const reqUrl = new URL(req.url, 'http://127.0.0.1');
            if (reqUrl.pathname !== '/oauth2callback') {
                res.statusCode = 404;
                res.end();
                return;
            }
            const err = reqUrl.searchParams.get('error');
            const c = reqUrl.searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><meta charset="utf-8"><title>EduTube</title><p>Authorized. You can close this tab.</p>');
            server.close();
            if (err) {
                reject(new Error(`OAuth error: ${err}`));
                return;
            }
            if (!c) {
                reject(new Error('No authorization code in callback'));
                return;
            }
            resolve(c);
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            console.log('If the browser does not open, visit this URL:\n');
            console.log(authUrl);
            console.log('');
            void import('node:child_process').then(({ execFile }) => {
                try {
                    if (process.platform === 'win32') {
                        /** Do not use `cmd /c start` — `&` in the query string is treated as CMD chaining and truncates the URL. */
                        execFile('rundll32', ['url.dll,FileProtocolHandler', authUrl], { windowsHide: true }, () => {});
                    } else if (process.platform === 'darwin') {
                        execFile('open', [authUrl], () => {});
                    } else {
                        execFile('xdg-open', [authUrl], () => {});
                    }
                } catch {
                    /* ignore */
                }
            });
        });
    });

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveGoogleTokens(tokens);
    console.log(`Saved tokens to ${googleTokenPath()}`);
}

/**
 * Skip browser if tokens already exist and validate; use `--force` to re-consent or fix a broken file.
 */
export async function runGoogleAuthFlow(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force) {
        const ok = await tryUseSavedGoogleTokens();
        if (ok) {
            console.log(`Google OAuth already OK — using ${googleTokenPath()}`);
            console.log('Pass --force to sign in again (new account or refresh consent).');
            return;
        }
    }
    await runGoogleAuthInteractive();
}

export async function getOAuthClientForYouTube(): Promise<OAuth2Client> {
    const oauth2Client = createOAuth2Client();
    const tokens = await loadGoogleTokens();
    if (!tokens?.refresh_token && !tokens?.access_token) {
        throw new Error('Not signed in to Google. Run: edutube auth google');
    }
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
}
