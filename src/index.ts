#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import {
    getJobsDbPath,
    getJobByPath,
    insertJob,
    listJobs,
    openJobsDb,
    resetJobForUploadRetry
} from './lib/db/jobs-db.js';
import { largeFileWarnBytes, minVideoDurationSeconds } from './lib/env/thresholds.js';
import { probeVideoFile } from './lib/ffprobe/probe.js';
import {
    cliCreateChapter,
    cliRegisterLecture,
    fetchCliCourseInstanceTree,
    fetchCliHealth,
    fetchCliLectureByVideo,
    fetchCliTree
} from './lib/api.js';
import { getVideoIdFromUrl } from './lib/youtube.js';
import { bootstrapBackendUrl, findWorkspaceRoot } from './lib/workspace/config.js';
import { runInit } from './lib/workspace/initWorkspace.js';
import { runGoogleAuthFlow } from './lib/google/oauth.js';
import { runJobUpload } from './lib/jobs/run-upload.js';
import { runPull } from './lib/sync/pull.js';

const program = new Command();

program.name('edutube').description('EduTube workstation CLI').version('0.1.0');

program
    .command('init')
    .argument('[dir]', 'workspace directory (default: current directory)', '.')
    .description('Create workspace and write .edutuberc with backend_url (no URL is hardcoded in the CLI binary)')
    .option('--force', 'Overwrite an existing .edutuberc')
    .option(
        '--backend-url <url>',
        'API base URL (e.g. https://api.example.com). If omitted, uses EDUTUBE_BACKEND_URL.'
    )
    .action(async (dir: string, opts: { force?: boolean; backendUrl?: string }) => {
        try {
            const root = resolve(dir);
            const url = (opts.backendUrl ?? process.env.EDUTUBE_BACKEND_URL)?.trim().replace(/\/$/, '');
            if (!url) {
                throw new Error('Pass --backend-url or set EDUTUBE_BACKEND_URL before running init.');
            }
            const configPath = await runInit(root, { force: opts.force, backendUrl: url });
            console.log(`Created ${configPath}`);
            console.log('Set EDUTUBE_API_KEY in your environment, then run: edutube pull');
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program
    .command('pull')
    .argument('[dir]', 'workspace directory (default: current directory)', '.')
    .description(
        'Fetch GET /api/cli/tree and mirror folders, .edutube-sync metadata, and lecture .url shortcuts (Explorer sync MVP)'
    )
    .option('--dry-run', 'Print planned renames/creates/removals without writing')
    .action(async (dir: string, opts: { dryRun?: boolean }) => {
        try {
            const root = resolve(dir);
            await bootstrapBackendUrl(root);
            if (!findWorkspaceRoot(root)) {
                console.error(
                    'Warning: no .edutuberc found walking up from this path — using EDUTUBE_BACKEND_URL only. Run `edutube init` in your workspace to pin backend_url in a file.'
                );
            }
            const stats = await runPull(root, { dryRun: opts.dryRun === true });
            console.log(
                JSON.stringify(
                    {
                        dry_run: stats.dryRun,
                        workspace: stats.workspaceRoot,
                        teachers: stats.teachers,
                        course_instances: stats.courseInstances,
                        chapters: stats.chapters,
                        lecture_urls_written_or_updated: stats.lecturesWritten,
                        orphan_lecture_urls_removed: stats.urlsRemoved,
                        warnings: stats.warnings.length > 0 ? stats.warnings : undefined
                    },
                    null,
                    2
                )
            );
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

const authCli = program.command('auth').description('Sign in to external services (tokens outside the course workspace)');

authCli
    .command('google')
    .description(
        'OAuth 2.0 for YouTube upload. Set EDUTUBE_GOOGLE_CLIENT_ID / EDUTUBE_GOOGLE_CLIENT_SECRET (Desktop client). Add authorized redirect: http://127.0.0.1:38475/oauth2callback (or EDUTUBE_OAUTH_PORT).'
    )
    .option('--force', 'Always open the browser (ignore working saved tokens)')
    .action(async (opts: { force?: boolean }) => {
        try {
            await runGoogleAuthFlow({ force: opts.force === true });
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program
    .command('probe')
    .argument('<file>', 'Video file to validate with ffprobe (same checks as upload pipeline)')
    .description(
        'Run ffprobe: duration, video stream, min duration / large-file rules (EDUTUBE_MIN_VIDEO_DURATION_SECONDS, EDUTUBE_LARGE_FILE_WARN_BYTES)'
    )
    .option('--json', 'Print raw probe result JSON only')
    .action(async (file: string, opts: { json?: boolean }) => {
        try {
            const abs = resolve(file);
            const r = probeVideoFile(abs);
            if (opts.json) {
                console.log(JSON.stringify(r, null, 2));
                process.exitCode = r.ok ? 0 : 1;
                return;
            }
            if (!r.ok) {
                console.error(r.message);
                if (r.ffprobeStderr) console.error(r.ffprobeStderr);
                process.exitCode = 1;
                return;
            }
            console.log(
                JSON.stringify(
                    {
                        file: abs,
                        duration_seconds: r.durationSeconds,
                        file_size_bytes: r.fileSizeBytes,
                        format: r.formatName,
                        warn_large_file: r.warnLargeFile,
                        min_duration_seconds: minVideoDurationSeconds(),
                        large_file_warn_bytes: largeFileWarnBytes()
                    },
                    null,
                    2
                )
            );
            if (r.warnLargeFile) {
                console.error(
                    'Warning: file exceeds EDUTUBE_LARGE_FILE_WARN_BYTES — the future upload step will require confirmation.'
                );
            }
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

const jobsCli = program.command('jobs').description('Local SQLite job journal (.edutube/jobs.sqlite)');

jobsCli
    .command('list')
    .argument('[dir]', 'Workspace directory containing .edutuberc', '.')
    .description('List upload jobs (newest first)')
    .action(async (dir: string) => {
        try {
            const root = findWorkspaceRoot(resolve(dir));
            if (!root) {
                throw new Error('No .edutuberc found — run from your workspace or pass the workspace directory.');
            }
            const db = openJobsDb(root);
            const rows = listJobs(db);
            db.close();
            console.log(JSON.stringify({ workspace: root, db: getJobsDbPath(root), jobs: rows }, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

jobsCli
    .command('enqueue')
    .argument('<file>', 'Video file (ffprobe + SQLite row)')
    .argument('[dir]', 'Workspace directory', '.')
    .description('Probe file and store result in SQLite (pending_upload or failed_validation)')
    .action(async (file: string, dir: string) => {
        try {
            const root = findWorkspaceRoot(resolve(dir));
            if (!root) {
                throw new Error('No .edutuberc found — run from workspace or pass [dir].');
            }
            const abs = resolve(file);
            const r = probeVideoFile(abs);
            const db = openJobsDb(root);
            const existing = getJobByPath(db, abs);
            if (existing) {
                db.close();
                throw new Error(`A job already exists for this path (job id ${existing.id}).`);
            }
            if (r.ok) {
                const id = insertJob(db, {
                    path: abs,
                    state: 'pending_upload',
                    duration_seconds: r.durationSeconds,
                    file_size_bytes: r.fileSizeBytes,
                    ffprobe_json: r.ffprobeJson
                });
                db.close();
                console.log(
                    JSON.stringify(
                        {
                            job_id: id,
                            state: 'pending_upload',
                            idempotency_key: `job_${id}`,
                            warn_large_file: r.warnLargeFile
                        },
                        null,
                        2
                    )
                );
                if (r.warnLargeFile) {
                    console.error(
                        'Warning: file exceeds large-file threshold — future upload step will require confirmation.'
                    );
                }
                process.exitCode = 0;
            } else {
                const id = insertJob(db, {
                    path: abs,
                    state: 'failed_validation',
                    error: r.message,
                    ffprobe_json: r.ffprobeJson
                });
                db.close();
                console.error(r.message);
                console.log(JSON.stringify({ job_id: id, state: 'failed_validation' }, null, 2));
                process.exitCode = 1;
            }
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

jobsCli
    .command('retry')
    .argument('<jobId>', 'Job id to reset after failed_upload or quota_exceeded (e.g. forgot auth google)')
    .argument('[dir]', 'Workspace directory', '.')
    .description('Set job back to pending_upload so you can run jobs upload again')
    .action(async (jobIdStr: string, dir: string) => {
        try {
            const root = findWorkspaceRoot(resolve(dir));
            if (!root) {
                throw new Error('No .edutuberc found — run from workspace or pass [dir].');
            }
            const jobId = parseInt(jobIdStr, 10);
            if (Number.isNaN(jobId)) {
                throw new Error('jobId must be a number');
            }
            const db = openJobsDb(root);
            const row = resetJobForUploadRetry(db, jobId);
            db.close();
            console.log(JSON.stringify({ ok: true, job: row }, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

jobsCli
    .command('upload')
    .argument('<jobId>', 'Job id from `edutube jobs list`')
    .argument('[dir]', 'Workspace directory containing .edutuberc', '.')
    .description('YouTube upload (unlisted) then POST /api/cli/lectures/register for a pending_upload job')
    .requiredOption('--chapter-id <n>', 'Chapter id', (v) => parseInt(v, 10))
    .requiredOption('--title <title>', 'Lecture title')
    .option('--description <text>', 'Lecture description')
    .option('--lecture-number <n>', 'Lecture order in chapter', (v) => parseInt(v, 10))
    .option(
        '--i-understand-large-file',
        'Required when file size exceeds EDUTUBE_LARGE_FILE_WARN_BYTES (plan: confirm before consuming quota)'
    )
    .action(
        async (
            jobIdStr: string,
            dir: string,
            opts: {
                chapterId: number;
                title: string;
                description?: string;
                lectureNumber?: number;
                iUnderstandLargeFile?: boolean;
            }
        ) => {
            try {
                const root = findWorkspaceRoot(resolve(dir));
                if (!root) {
                    throw new Error('No .edutuberc found — run from workspace or pass [dir].');
                }
                const jobId = parseInt(jobIdStr, 10);
                if (Number.isNaN(jobId)) {
                    throw new Error('jobId must be a positive integer');
                }
                const result = await runJobUpload({
                    workspaceRoot: root,
                    jobId,
                    chapterId: opts.chapterId,
                    title: opts.title,
                    description: opts.description,
                    lectureNumber: opts.lectureNumber,
                    confirmLargeFile: opts.iUnderstandLargeFile === true
                });
                console.log(
                    JSON.stringify(
                        {
                            ok: true,
                            youtube_video_id: result.youtubeVideoId,
                            lecture_id: result.lectureId,
                            register_created: result.registerCreated
                        },
                        null,
                        2
                    )
                );
                process.exitCode = 0;
            } catch (e) {
                console.error(e instanceof Error ? e.message : e);
                process.exitCode = 1;
            }
        }
    );

program
    .command('health')
    .description('Check CLI API key and backend connectivity (GET /api/cli/health)')
    .action(async () => {
        try {
            await bootstrapBackendUrl(process.cwd());
            const { data } = await fetchCliHealth();
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program
    .command('tree')
    .description('Print full course tree JSON (GET /api/cli/tree)')
    .action(async () => {
        try {
            await bootstrapBackendUrl(process.cwd());
            const { data } = await fetchCliTree();
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program
    .command('instance-tree')
    .argument('<id>', 'course instance id')
    .description('Print one course instance tree (GET /api/cli/course-instances/:id/tree)')
    .action(async (idStr: string) => {
        try {
            await bootstrapBackendUrl(process.cwd());
            const id = parseInt(idStr, 10);
            if (Number.isNaN(id)) {
                throw new Error('Invalid course instance id');
            }
            const { data } = await fetchCliCourseInstanceTree(id);
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

const chapters = program.command('chapters').description('Chapter operations');

chapters
    .command('create')
    .description('Create a chapter (POST /api/cli/chapters)')
    .requiredOption('--course-instance-id <n>', 'Course instance id', (v) => parseInt(v, 10))
    .requiredOption('--name <name>', 'Chapter name')
    .option('--description <text>', 'Chapter description', '')
    .option('--number <n>', 'Chapter number (default: next after last)', (v) => parseInt(v, 10))
    .action(async (opts: {
        courseInstanceId: number;
        name: string;
        description?: string;
        number?: number;
    }) => {
        try {
            await bootstrapBackendUrl(process.cwd());
            const body: Parameters<typeof cliCreateChapter>[0] = {
                course_instance_id: opts.courseInstanceId,
                name: opts.name,
                description: opts.description !== undefined ? opts.description : ''
            };
            if (opts.number !== undefined && !Number.isNaN(opts.number)) {
                body.number = opts.number;
            }
            const { data, created } = await cliCreateChapter(body);
            console.log(JSON.stringify({ ...data, _meta: { created } }, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

const lectures = program.command('lectures').description('Lecture operations');

lectures
    .command('register')
    .description('Register a lecture / idempotent by youtube_video_id (POST /api/cli/lectures/register)')
    .requiredOption('--chapter-id <n>', 'Chapter id', (v) => parseInt(v, 10))
    .requiredOption('--title <title>', 'Lecture title')
    .requiredOption('--youtube-url <url>', 'YouTube watch URL')
    .requiredOption('--duration <seconds>', 'Duration in seconds', (v) => parseInt(v, 10))
    .option('--youtube-video-id <id>', 'Override video id (default: parsed from --youtube-url)')
    .option('--lecture-number <n>', 'Lecture order in chapter (default: next)', (v) => parseInt(v, 10))
    .option('--description <text>', 'Lecture description')
    .option('--idempotency-key <key>', 'Optional idempotency key (audit)')
    .action(
        async (opts: {
            chapterId: number;
            title: string;
            youtubeUrl: string;
            duration: number;
            youtubeVideoId?: string;
            lectureNumber?: number;
            description?: string;
            idempotencyKey?: string;
        }) => {
            try {
                await bootstrapBackendUrl(process.cwd());
                const vid = opts.youtubeVideoId ?? getVideoIdFromUrl(opts.youtubeUrl);
                if (!vid) {
                    throw new Error('Could not parse youtube_video_id from --youtube-url; pass --youtube-video-id');
                }
                if (Number.isNaN(opts.duration) || opts.duration < 0) {
                    throw new Error('--duration must be a non-negative integer');
                }
                const { data, created } = await cliRegisterLecture({
                    chapter_id: opts.chapterId,
                    title: opts.title,
                    youtube_url: opts.youtubeUrl,
                    youtube_video_id: vid,
                    duration_seconds: opts.duration,
                    ...(opts.lectureNumber !== undefined && !Number.isNaN(opts.lectureNumber)
                        ? { lecture_number: opts.lectureNumber }
                        : {}),
                    ...(opts.description !== undefined ? { description: opts.description } : {}),
                    ...(opts.idempotencyKey !== undefined ? { idempotency_key: opts.idempotencyKey } : {})
                });
                console.log(JSON.stringify({ ...data, _meta: { created } }, null, 2));
                process.exitCode = 0;
            } catch (e) {
                console.error(e instanceof Error ? e.message : e);
                process.exitCode = 1;
            }
        }
    );

lectures
    .command('by-video')
    .argument('<videoId>', '11-character YouTube video id')
    .description('Look up lecture by video id (GET /api/cli/lectures/by-video/:videoId)')
    .action(async (videoId: string) => {
        try {
            await bootstrapBackendUrl(process.cwd());
            const { data } = await fetchCliLectureByVideo(videoId);
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program.parse();
