import { createReadStream } from 'node:fs';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface UploadVideoParams {
    filePath: string;
    title: string;
    description?: string;
}

/** Plan §5: privacy unlisted, made for kids false. */
export async function uploadLocalVideo(auth: OAuth2Client, params: UploadVideoParams): Promise<{ videoId: string }> {
    const youtube = google.youtube({ version: 'v3', auth });
    const res = await youtube.videos.insert({
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
    });
    const id = res.data?.id;
    if (!id) {
        throw new Error('YouTube API returned no video id');
    }
    return { videoId: id };
}

export function watchUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
}
