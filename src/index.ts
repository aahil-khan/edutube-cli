#!/usr/bin/env node
import { Command } from 'commander';
import {
    cliCreateChapter,
    cliRegisterLecture,
    fetchCliCourseInstanceTree,
    fetchCliHealth,
    fetchCliLectureByVideo,
    fetchCliTree
} from './lib/api.js';
import { getVideoIdFromUrl } from './lib/youtube.js';

const program = new Command();

program.name('edutube').description('EduTube workstation CLI').version('0.1.0');

program
    .command('health')
    .description('Check CLI API key and backend connectivity (GET /api/cli/health)')
    .action(async () => {
        try {
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
            const { data } = await fetchCliLectureByVideo(videoId);
            console.log(JSON.stringify(data, null, 2));
            process.exitCode = 0;
        } catch (e) {
            console.error(e instanceof Error ? e.message : e);
            process.exitCode = 1;
        }
    });

program.parse();
