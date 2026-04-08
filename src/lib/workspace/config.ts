import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const EDUTUBERC = '.edutuberc';

export interface EdutubeRc {
    version: 1;
    /** API base URL (no trailing slash). Never committed with a fixed production host — operators set per machine. */
    backend_url: string;
}

export function buildEdutubeRc(backendUrl: string): EdutubeRc {
    const u = backendUrl.trim().replace(/\/$/, '');
    if (!u) {
        throw new Error('backend_url is empty');
    }
    return { version: 1, backend_url: u };
}

/**
 * Walk up from `startDir` (inclusive) to find a directory containing `.edutuberc`
 * (same idea as finding a git root).
 */
export function findWorkspaceRoot(startDir: string): string | null {
    let dir = resolve(startDir);
    for (;;) {
        if (existsSync(join(dir, EDUTUBERC))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

export async function readEdutuberc(workspaceRoot: string): Promise<EdutubeRc | null> {
    const p = join(workspaceRoot, EDUTUBERC);
    try {
        const raw = await readFile(p, 'utf8');
        const j = JSON.parse(raw) as EdutubeRc;
        if (j.version !== 1 || typeof j.backend_url !== 'string') {
            throw new Error('Invalid .edutuberc: expected version 1 and backend_url string');
        }
        return { ...j, backend_url: j.backend_url.replace(/\/$/, '').trim() };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
}

export async function writeEdutuberc(workspaceRoot: string, config: EdutubeRc): Promise<void> {
    const p = join(workspaceRoot, EDUTUBERC);
    const body = JSON.stringify(config, null, 2) + '\n';
    await writeFile(p, body, 'utf8');
}

/**
 * Env wins over file (plan: operators often set EDUTUBE_BACKEND_URL for one-off runs).
 * Call before any `fetchCli*` that uses `getBackendUrl()`.
 */
export function applyBackendUrlFromRc(config: EdutubeRc | null): void {
    if (process.env.EDUTUBE_BACKEND_URL && process.env.EDUTUBE_BACKEND_URL !== '') {
        return;
    }
    if (config?.backend_url) {
        process.env.EDUTUBE_BACKEND_URL = config.backend_url;
    }
}

/**
 * Load `.edutuberc` from `searchFrom` or any parent directory, apply to `process.env` if env not set,
 * then require `EDUTUBE_BACKEND_URL` to be set (from env or file).
 */
export async function bootstrapBackendUrl(searchFrom: string): Promise<void> {
    const root = findWorkspaceRoot(searchFrom);
    const rc = root ? await readEdutuberc(root) : null;
    applyBackendUrlFromRc(rc);
    const v = process.env.EDUTUBE_BACKEND_URL?.trim();
    if (!v) {
        throw new Error(
            'Missing backend URL: set environment variable EDUTUBE_BACKEND_URL, or create .edutuberc (e.g. run `edutube init --backend-url <url>` in your workspace).'
        );
    }
    process.env.EDUTUBE_BACKEND_URL = v.replace(/\/$/, '');
}
