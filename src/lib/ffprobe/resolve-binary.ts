import { existsSync } from 'node:fs';

/**
 * Bundled ffprobe lives next to the CLI in production; dev uses PATH or EDUTUBE_FFPROBE_PATH.
 */
export function resolveFfprobeBinary(): string {
    const override = process.env.EDUTUBE_FFPROBE_PATH?.trim();
    if (override) {
        if (!existsSync(override)) {
            throw new Error(`EDUTUBE_FFPROBE_PATH does not exist: ${override}`);
        }
        return override;
    }
    return 'ffprobe';
}
