import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultEdutubeRc, EDUTUBERC, writeEdutuberc } from './config.js';

export async function runInit(workspaceRoot: string, options: { force?: boolean } = {}): Promise<string> {
    await mkdir(workspaceRoot, { recursive: true });
    const configPath = join(workspaceRoot, EDUTUBERC);
    if (existsSync(configPath) && !options.force) {
        throw new Error(`${configPath} already exists. Pass --force to overwrite.`);
    }
    await writeEdutuberc(workspaceRoot, defaultEdutubeRc());
    return configPath;
}
