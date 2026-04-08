import { existsSync } from 'node:fs';
import { cliRegisterLecture, getBackendUrl } from '../api.js';
import { jobIdempotencyKey, getJobById, openJobsDb, updateJobState } from '../db/jobs-db.js';
import { largeFileWarnBytes } from '../env/thresholds.js';
import { getOAuthClientForYouTube } from '../google/oauth.js';
import { uploadLocalVideo, watchUrl } from '../google/upload.js';
import { bootstrapBackendUrl } from '../workspace/config.js';

function isQuotaError(e: unknown): boolean {
    const x = e as { code?: number; response?: { status?: number } };
    return x.response?.status === 403 || x.code === 403;
}

/** Gaxios / YouTube often throw with little context; pull nested message when present. */
function summarizeExternalError(e: unknown): string {
    const x = e as {
        response?: { status?: number; data?: { error?: { message?: string }; message?: string } };
        message?: string;
    };
    if (x.response?.data) {
        const d = x.response.data;
        const inner =
            typeof d === 'object' && d !== null && 'error' in d && typeof (d as { error?: { message?: string } }).error === 'object'
                ? (d as { error?: { message?: string } }).error?.message
                : undefined;
        const text = inner ?? (typeof d === 'object' && d !== null && 'message' in d ? String((d as { message?: string }).message) : JSON.stringify(d));
        return `HTTP ${x.response.status ?? '?'} — ${text}`;
    }
    return e instanceof Error ? e.message : String(e);
}

export async function runJobUpload(opts: {
    workspaceRoot: string;
    jobId: number;
    chapterId: number;
    title: string;
    description?: string;
    lectureNumber?: number;
    confirmLargeFile: boolean;
}): Promise<{ youtubeVideoId: string; lectureId: number; registerCreated: boolean }> {
    const db = openJobsDb(opts.workspaceRoot);
    try {
        const job = getJobById(db, opts.jobId);
        if (!job) {
            throw new Error(`Job ${opts.jobId} not found`);
        }
        if (job.state !== 'pending_upload') {
            throw new Error(`Job ${opts.jobId} is not pending_upload (current: ${job.state})`);
        }
        if (!existsSync(job.path)) {
            throw new Error(`Video file missing: ${job.path}`);
        }
        if (job.duration_seconds === null || job.duration_seconds === undefined) {
            throw new Error('Job has no duration_seconds; run jobs enqueue again after fixing the file');
        }

        const fsz = job.file_size_bytes ?? 0;
        if (fsz > largeFileWarnBytes() && !opts.confirmLargeFile) {
            throw new Error(
                'File exceeds EDUTUBE_LARGE_FILE_WARN_BYTES. Re-run with --i-understand-large-file to confirm upload.'
            );
        }

        let uploadedId: string | undefined;

        try {
            const auth = await getOAuthClientForYouTube();
            updateJobState(db, job.id, {
                state: 'uploading',
                chapter_id: opts.chapterId,
                title: opts.title,
                error: null
            });

            const { videoId } = await uploadLocalVideo(auth, {
                filePath: job.path,
                title: opts.title,
                description: opts.description
            });
            uploadedId = videoId;

            updateJobState(db, job.id, {
                youtube_video_id: videoId,
                state: 'pending_register'
            });

            await bootstrapBackendUrl(opts.workspaceRoot);

            const { data, created } = await cliRegisterLecture({
                chapter_id: opts.chapterId,
                title: opts.title,
                youtube_url: watchUrl(videoId),
                youtube_video_id: videoId,
                duration_seconds: job.duration_seconds,
                idempotency_key: jobIdempotencyKey(job.id),
                ...(opts.lectureNumber !== undefined && !Number.isNaN(opts.lectureNumber)
                    ? { lecture_number: opts.lectureNumber }
                    : {}),
                ...(opts.description !== undefined ? { description: opts.description } : {})
            });

            updateJobState(db, job.id, {
                state: 'completed',
                lecture_id: data.lecture.id,
                error: null
            });

            return {
                youtubeVideoId: videoId,
                lectureId: data.lecture.id,
                registerCreated: created === true
            };
        } catch (e) {
            const raw = summarizeExternalError(e);
            const msg =
                uploadedId === undefined
                    ? `YouTube: ${raw} — enable YouTube Data API v3 for your GCP project and ensure the signed-in account may upload.`
                    : `Backend ${getBackendUrl()}: ${raw} — set EDUTUBE_API_KEY in this shell (same as edutube health); chapter_id must exist on that server.`;
            if (uploadedId !== undefined) {
                updateJobState(db, job.id, {
                    state: 'failed_register',
                    youtube_video_id: uploadedId,
                    error: msg
                });
            } else if (isQuotaError(e)) {
                updateJobState(db, job.id, { state: 'quota_exceeded', error: msg });
            } else {
                updateJobState(db, job.id, { state: 'failed_upload', error: msg });
            }
            throw new Error(msg, { cause: e });
        }
    } finally {
        db.close();
    }
}
