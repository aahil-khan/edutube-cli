import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { largeFileWarnBytes, minVideoDurationSeconds } from '../env/thresholds.js';
import { resolveFfprobeBinary } from './resolve-binary.js';

export interface ProbeOk {
    ok: true;
    durationSeconds: number;
    fileSizeBytes: number;
    hasVideoStream: boolean;
    formatName: string;
    ffprobeJson: string;
    warnLargeFile: boolean;
}

export interface ProbeErr {
    ok: false;
    message: string;
    ffprobeStderr?: string;
    ffprobeJson?: string;
}

export type ProbeResult = ProbeOk | ProbeErr;

interface FfprobeFormat {
    format_name?: string;
    duration?: string;
}

interface FfprobeStream {
    codec_type?: string;
}

interface FfprobeRoot {
    format?: FfprobeFormat;
    streams?: FfprobeStream[];
}

export function probeVideoFile(absolutePath: string): ProbeResult {
    if (!existsSync(absolutePath)) {
        return { ok: false, message: `File not found: ${absolutePath}` };
    }

    const bin = resolveFfprobeBinary();
    const st = statSync(absolutePath);
    const fileSizeBytes = st.size;

    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolutePath];
    const proc = spawnSync(bin, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });

    if (proc.error) {
        return {
            ok: false,
            message: `Failed to spawn ffprobe (${bin}): ${proc.error.message}. Install ffmpeg/ffprobe or set EDUTUBE_FFPROBE_PATH.`
        };
    }

    if (proc.status !== 0) {
        return {
            ok: false,
            message: `ffprobe exited with code ${proc.status}`,
            ffprobeStderr: proc.stderr || undefined
        };
    }

    let root: FfprobeRoot;
    try {
        root = JSON.parse(proc.stdout || '{}') as FfprobeRoot;
    } catch {
        return { ok: false, message: 'ffprobe returned invalid JSON', ffprobeJson: proc.stdout || undefined };
    }

    const fmt = root.format;
    const durationRaw = fmt?.duration !== undefined ? parseFloat(String(fmt.duration)) : NaN;
    if (!Number.isFinite(durationRaw) || durationRaw < 0) {
        return {
            ok: false,
            message: 'Could not read duration from ffprobe output',
            ffprobeJson: proc.stdout || undefined
        };
    }

    const durationSeconds = Math.floor(durationRaw);
    const hasVideoStream = Array.isArray(root.streams) && root.streams.some((s) => s.codec_type === 'video');

    if (!hasVideoStream) {
        return {
            ok: false,
            message: 'No video stream found (not a decodable video file)',
            ffprobeJson: proc.stdout || undefined
        };
    }

    const minDur = minVideoDurationSeconds();
    if (durationSeconds < minDur) {
        return {
            ok: false,
            message: `Duration ${durationSeconds}s is below EDUTUBE_MIN_VIDEO_DURATION_SECONDS (${minDur}s)`,
            ffprobeJson: proc.stdout || undefined
        };
    }

    const warnBytes = largeFileWarnBytes();
    const warnLargeFile = fileSizeBytes > warnBytes;

    return {
        ok: true,
        durationSeconds,
        fileSizeBytes,
        hasVideoStream,
        formatName: fmt?.format_name ?? 'unknown',
        ffprobeJson: proc.stdout ?? '{}',
        warnLargeFile
    };
}
