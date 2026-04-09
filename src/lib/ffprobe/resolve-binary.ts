import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function bundledFfprobePath(): string | null {
    try {
        const mod = require('@ffprobe-installer/ffprobe') as { path?: string };
        const p = mod?.path;
        if (typeof p === 'string' && p.length > 0 && existsSync(p)) {
            return p;
        }
    } catch {
        /* unsupported platform or install incomplete */
    }
    return null;
}

/**
 * Resolution order:
 * 1. `EDUTUBE_FFPROBE_PATH` — explicit override (portable installs, CI, custom ffmpeg build).
 * 2. `@ffprobe-installer/ffprobe` — binary shipped with the npm package for the current OS/arch.
 * 3. `ffprobe` on `PATH` — development machines with ffmpeg installed.
 */
export function resolveFfprobeBinary(): string {
    const override = process.env.EDUTUBE_FFPROBE_PATH?.trim();
    if (override) {
        if (!existsSync(override)) {
            throw new Error(`EDUTUBE_FFPROBE_PATH does not exist: ${override}`);
        }
        return override;
    }
    const bundled = bundledFfprobePath();
    if (bundled !== null) {
        return bundled;
    }
    return 'ffprobe';
}
