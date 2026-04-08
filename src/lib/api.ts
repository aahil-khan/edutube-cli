import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { CliHealthData, CliTreeResponse } from '../types/cli-api.js';

function getEnv(name: string, fallback?: string): string {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
}

export function getBackendUrl(): string {
    return getEnv('EDUTUBE_BACKEND_URL', 'http://127.0.0.1:5001');
}

export function getCliApiKey(): string {
    return getEnv('EDUTUBE_API_KEY');
}

/** Plain http(s) — avoids undici/fetch teardown issues on Windows (libuv UV_HANDLE_CLOSING). */
function cliHttpGet(urlStr: string, headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const agent = new lib.Agent({ keepAlive: false, maxSockets: 1 });

        const req = lib.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: `${u.pathname}${u.search}`,
                method: 'GET',
                headers,
                agent
            },
            (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8')
                    });
                });
                res.on('error', reject);
            }
        );

        req.on('error', reject);
        req.setTimeout(60_000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

async function cliFetch<T>(path: string): Promise<{ data: T; created?: boolean }> {
    const url = `${getBackendUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const { statusCode, body } = await cliHttpGet(url, {
        'Content-Type': 'application/json',
        'X-CLI-API-Key': getCliApiKey()
    });

    let json: { data: T; created?: boolean } | { error: { code: string; message: string; details?: unknown } };
    try {
        json = JSON.parse(body) as typeof json;
    } catch {
        throw new Error('Invalid JSON from server');
    }

    const ok = statusCode >= 200 && statusCode < 300;
    if (!ok || 'error' in json) {
        const msg =
            'error' in json
                ? `${json.error.code}: ${json.error.message}`
                : `HTTP ${statusCode}`;
        throw new Error(msg);
    }

    return json as { data: T; created?: boolean };
}

export async function fetchCliHealth(): Promise<{ data: CliHealthData; created?: boolean }> {
    return cliFetch<CliHealthData>('/api/cli/health');
}

export async function fetchCliTree(): Promise<{ data: CliTreeResponse; created?: boolean }> {
    return cliFetch<CliTreeResponse>('/api/cli/tree');
}
