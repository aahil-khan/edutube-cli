/** Plan §5: overridable via environment. */

export function minVideoDurationSeconds(): number {
    const raw = process.env.EDUTUBE_MIN_VIDEO_DURATION_SECONDS;
    if (raw === undefined || raw === '') return 2;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 2;
}

export function largeFileWarnBytes(): number {
    const raw = process.env.EDUTUBE_LARGE_FILE_WARN_BYTES;
    if (raw === undefined || raw === '') return 2147483648;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 2147483648;
}
