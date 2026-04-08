import { createReadStream, statSync } from 'node:fs';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface UploadVideoParams {
    filePath: string;
    title: string;
    description?: string;
    /** Fired as bytes are sent (loaded may equal total when complete). */
    onUploadProgress?: (loaded: number, total: number) => void;
}

const UPLOAD_TIMEOUT_MS = 3_600_000; // 1 hour — large campus uploads

/** Plan §5: privacy unlisted, made for kids false. */
export async function uploadLocalVideo(auth: OAuth2Client, params: UploadVideoParams): Promise<{ videoId: string }> {
    const fileSize = statSync(params.filePath).size;
    const youtube = google.youtube({ version: 'v3', auth });

    params.onUploadProgress?.(0, fileSize);

    try {
        const res = await youtube.videos.insert(
            {
                part: ['snippet', 'status'],
                requestBody: {
                    snippet: {
                        title: params.title,
                        description: params.description ?? ''
                    },
                    status: {
                        privacyStatus: 'unlisted',
                        selfDeclaredMadeForKids: false
                    }
                },
                media: {
                    body: createReadStream(params.filePath)
                }
            },
            {
                timeout: UPLOAD_TIMEOUT_MS,
                onUploadProgress: (evt: unknown) => {
                    const e = evt as { loaded?: number; total?: number; bytesRead?: number };
                    const loaded = typeof e.loaded === 'number' ? e.loaded : typeof e.bytesRead === 'number' ? e.bytesRead : 0;
                    const total =
                        typeof e.total === 'number' && e.total > 0
                            ? e.total
                            : fileSize;
                    params.onUploadProgress?.(loaded, total);
                }
            }
        );
        const id = res.data?.id;
        if (!id) {
            throw new Error('YouTube API returned no video id');
        }
        params.onUploadProgress?.(fileSize, fileSize);
        return { videoId: id };
    } catch (e: unknown) {
        const gx = e as { response?: { status?: number; data?: unknown }; message?: string };
        const detail =
            gx.response?.data !== undefined
                ? ` ${JSON.stringify(gx.response.data)}`
                : gx.message
                  ? ` ${gx.message}`
                  : '';
        throw new Error(`YouTube videos.insert failed:${detail}`, { cause: e });
    }
}

export function watchUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
}
