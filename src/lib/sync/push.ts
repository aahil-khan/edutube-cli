import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import type { CliLecture } from '../../types/cli-api.js';
import type { ChapterSyncFile } from '../../types/sync-metadata.js';
import { cliCreateChapter } from '../api.js';
import { getJobById, getJobByPath, insertJob, openJobsDb, updateJobState } from '../db/jobs-db.js';
import { largeFileWarnBytes } from '../env/thresholds.js';
import { probeVideoFile } from '../ffprobe/probe.js';
import { runJobUpload } from '../jobs/run-upload.js';
import { bootstrapBackendUrl } from '../workspace/config.js';
import { lectureUrlFileName } from './layout.js';
import { scanPushWorkspace } from './push-scan.js';
import { formatUrlShortcut } from './url-shortcut.js';

export interface RunPushOptions {
    workspaceRoot: string;
    dryRun: boolean;
    yes: boolean;
    confirmLargeFile: boolean;
}

export interface PushSummary {
    dry_run: boolean;
    workspace: string;
    created_chapters: Array<{ chapter_id: number; chapter_dir: string; name: string }>;
    uploads: Array<{
        path: string;
        youtube_video_id: string;
        lecture_id: number;
        register_created: boolean;
        url_written: string;
        moved_to: string;
    }>;
    skipped: Array<{ path: string; reason: string }>;
    failed: Array<{ path: string; error: string }>;
    warnings: string[];
}

function lectureTitleFromMp4Path(filePath: string): string {
    const base = basename(filePath);
    return base.toLowerCase().endsWith('.mp4') ? base.slice(0, -4) : base;
}

async function writeLectureUrlFile(chapterDir: string, lecture: CliLecture, dryRun: boolean): Promise<string> {
    const name = lectureUrlFileName(lecture);
    const path = join(chapterDir, name);
    const content = formatUrlShortcut(lecture.youtube_url);
    if (!dryRun) {
        await writeFile(path, content, 'utf8');
    }
    return path;
}

async function moveMp4ToUploaded(mp4Path: string, chapterDir: string, dryRun: boolean): Promise<string> {
    const uploadedDir = join(chapterDir, '_uploaded');
    const base = basename(mp4Path);
    let dest = join(uploadedDir, base);
    if (dryRun) {
        return dest;
    }
    if (!existsSync(uploadedDir)) {
        await mkdir(uploadedDir, { recursive: true });
    }
    if (existsSync(dest)) {
        const dot = base.lastIndexOf('.');
        const stem = dot >= 0 ? base.slice(0, dot) : base;
        const ext = dot >= 0 ? base.slice(dot) : '';
        dest = join(uploadedDir, `${stem}_${Date.now()}${ext}`);
    }
    await rename(mp4Path, dest);
    return dest;
}

async function confirmProceed(): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question('Apply push (create chapters, upload, write .url, move .mp4)? [y/N] ')).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    } finally {
        rl.close();
    }
}

export async function runPush(opts: RunPushOptions): Promise<PushSummary> {
    const summary: PushSummary = {
        dry_run: opts.dryRun,
        workspace: opts.workspaceRoot,
        created_chapters: [],
        uploads: [],
        skipped: [],
        failed: [],
        warnings: []
    };

    await bootstrapBackendUrl(opts.workspaceRoot);

    const scan = scanPushWorkspace(opts.workspaceRoot);
    summary.warnings.push(...scan.warnings);

    const blocking = [...scan.blockingErrors];
    if (blocking.length > 0) {
        throw new Error(blocking.join('\n'));
    }

    const chapterDirToId = new Map<string, number>();
    for (const m of scan.mp4Items) {
        if (m.chapterId !== null) {
            chapterDirToId.set(m.chapterDir, m.chapterId);
        }
    }

    const planPreview = {
        new_chapters: scan.newChapters.map((c) => ({
            course_instance_id: c.courseInstanceId,
            chapter_dir: c.chapterDir,
            name: c.nameForApi,
            number: c.parsedNumber
        })),
        mp4_files: scan.mp4Items.map((m) => ({
            path: m.filePath,
            chapter_dir: m.chapterDir,
            chapter_id_resolved: m.chapterId
        }))
    };

    if (opts.dryRun) {
        console.error('[dry-run] Planned operations:');
        console.error(JSON.stringify(planPreview, null, 2));
        return summary;
    }

    if (!opts.yes) {
        console.error('[plan]');
        console.error(JSON.stringify(planPreview, null, 2));
        const ok = await confirmProceed();
        if (!ok) {
            throw new Error('Push cancelled.');
        }
    }

    for (const nc of scan.newChapters) {
        const body: Parameters<typeof cliCreateChapter>[0] = {
            course_instance_id: nc.courseInstanceId,
            name: nc.nameForApi
        };
        if (nc.parsedNumber !== undefined) {
            body.number = nc.parsedNumber;
        }
        const { data } = await cliCreateChapter(body);
        const ch = data.chapter;
        const chapterSync: ChapterSyncFile = {
            version: 1,
            kind: 'chapter',
            id: ch.id,
            number: ch.number,
            name: ch.name,
            ...(ch.description ? { description: ch.description } : {})
        };
        await writeFile(
            join(nc.chapterDir, '.edutube-sync'),
            JSON.stringify(chapterSync, null, 2) + '\n',
            'utf8'
        );
        chapterDirToId.set(nc.chapterDir, ch.id);
        summary.created_chapters.push({
            chapter_id: ch.id,
            chapter_dir: nc.chapterDir,
            name: ch.name
        });
        console.error(`Created chapter ${ch.id} (${ch.name}) → ${nc.chapterDir}`);
    }

    for (const item of scan.mp4Items) {
        const chapterId = chapterDirToId.get(item.chapterDir);
        if (chapterId === undefined) {
            summary.failed.push({
                path: item.filePath,
                error: `No chapter id for folder ${item.chapterDir} (pull or create chapters first)`
            });
            continue;
        }

        const db = openJobsDb(opts.workspaceRoot);
        let jobId: number;
        try {
            const existing = getJobByPath(db, item.filePath);

            if (existing?.state === 'completed') {
                summary.skipped.push({ path: item.filePath, reason: 'job completed' });
                continue;
            }
            if (
                existing?.state === 'failed_register' ||
                existing?.state === 'failed_upload' ||
                existing?.state === 'quota_exceeded'
            ) {
                summary.skipped.push({ path: item.filePath, reason: `job state ${existing.state} — use jobs retry or fix manually` });
                continue;
            }

            const r = probeVideoFile(item.filePath);
            if (!r.ok) {
                const fj = r.ffprobeJson ?? null;
                if (existing) {
                    updateJobState(db, existing.id, {
                        state: 'failed_validation',
                        error: r.message,
                        ffprobe_json: fj
                    });
                } else {
                    insertJob(db, {
                        path: item.filePath,
                        state: 'failed_validation',
                        error: r.message,
                        ffprobe_json: fj ?? undefined
                    });
                }
                summary.failed.push({ path: item.filePath, error: r.message });
                continue;
            }

            if (existing?.state === 'failed_validation') {
                updateJobState(db, existing.id, {
                    state: 'pending_upload',
                    duration_seconds: r.durationSeconds,
                    file_size_bytes: r.fileSizeBytes,
                    ffprobe_json: r.ffprobeJson,
                    error: null
                });
                jobId = existing.id;
            } else if (!existing) {
                jobId = insertJob(db, {
                    path: item.filePath,
                    state: 'pending_upload',
                    duration_seconds: r.durationSeconds,
                    file_size_bytes: r.fileSizeBytes,
                    ffprobe_json: r.ffprobeJson
                });
            } else {
                jobId = existing.id;
                if (existing.state !== 'pending_upload') {
                    summary.skipped.push({ path: item.filePath, reason: `job state ${existing.state}` });
                    continue;
                }
                if (
                    existing.duration_seconds === null ||
                    existing.file_size_bytes === null
                ) {
                    updateJobState(db, existing.id, {
                        duration_seconds: r.durationSeconds,
                        file_size_bytes: r.fileSizeBytes,
                        ffprobe_json: r.ffprobeJson ?? existing.ffprobe_json
                    });
                }
            }

            const job = getJobById(db, jobId);
            if (!job || job.state !== 'pending_upload') {
                summary.skipped.push({ path: item.filePath, reason: job ? `job state ${job.state}` : 'job missing' });
                continue;
            }

            if (job.file_size_bytes !== null && job.file_size_bytes >= largeFileWarnBytes() && !opts.confirmLargeFile) {
                summary.failed.push({
                    path: item.filePath,
                    error: `File exceeds EDUTUBE_LARGE_FILE_WARN_BYTES — pass --i-understand-large-file`
                });
                continue;
            }
        } finally {
            db.close();
        }

        const title = lectureTitleFromMp4Path(item.filePath);

        try {
            const uploadResult = await runJobUpload({
                workspaceRoot: opts.workspaceRoot,
                jobId,
                chapterId,
                title,
                confirmLargeFile: opts.confirmLargeFile
            });
            const urlPath = await writeLectureUrlFile(item.chapterDir, uploadResult.lecture, false);
            const movedTo = await moveMp4ToUploaded(item.filePath, item.chapterDir, false);
            summary.uploads.push({
                path: item.filePath,
                youtube_video_id: uploadResult.youtubeVideoId,
                lecture_id: uploadResult.lectureId,
                register_created: uploadResult.registerCreated,
                url_written: urlPath,
                moved_to: movedTo
            });
        } catch (e) {
            summary.failed.push({
                path: item.filePath,
                error: e instanceof Error ? e.message : String(e)
            });
        }
    }

    return summary;
}
