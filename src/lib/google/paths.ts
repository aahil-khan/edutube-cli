import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user config (not the course workspace). Tokens live here. */
export function edutubeConfigDir(): string {
    if (process.platform === 'win32') {
        return join(process.env.APPDATA || homedir(), 'edutube');
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg !== '') {
        return join(xdg, 'edutube');
    }
    return join(homedir(), '.config', 'edutube');
}

export function googleTokenPath(): string {
    return join(edutubeConfigDir(), 'google-youtube-tokens.json');
}
