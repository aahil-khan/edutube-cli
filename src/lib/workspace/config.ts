import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EDUTUBERC = '.edutuberc';

export interface EdutubeRc {
    version: 1;
    /** API base URL (no trailing slash). */
    backend_url: string;
}

export function defaultEdutubeRc(): EdutubeRc {
    return {
        version: 1,
        backend_url: process.env.EDUTUBE_BACKEND_URL?.replace(/\/$/, '') || 'http://127.0.0.1:5001'
    };
}

export async function readEdutuberc(workspaceRoot: string): Promise<EdutubeRc | null> {
    const p = join(workspaceRoot, EDUTUBERC);
    try {
        const raw = await readFile(p, 'utf8');
        const j = JSON.parse(raw) as EdutubeRc;
        if (j.version !== 1 || typeof j.backend_url !== 'string') {
            throw new Error('Invalid .edutuberc: expected version 1 and backend_url string');
        }
        return { ...j, backend_url: j.backend_url.replace(/\/$/, '') };
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
