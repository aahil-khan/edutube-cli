import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliLecture, CliTreeChapter, CliTreeCourseInstance, CliTreeResponse, CliTreeTeacher } from '../../types/cli-api.js';
import type { ChapterSyncFile, CourseInstanceSyncFile, EdutubeSyncPayload, TeacherSyncFile, WorkspaceSyncFile } from '../../types/sync-metadata.js';
import { fetchCliTree } from '../api.js';
import { chapterDirName, courseInstanceDirName, lectureUrlFileName, teacherDirName } from './layout.js';

const URL_LINE_ENDING = '\r\n';

export interface PullStats {
    workspaceRoot: string;
    dryRun: boolean;
    teachers: number;
    courseInstances: number;
    chapters: number;
    lecturesWritten: number;
    urlsRemoved: number;
    warnings: string[];
}

function isOurLectureUrl(name: string): boolean {
    return /^L\d{2}_\d+_.+\.url$/i.test(name);
}

async function readSyncPayload(dir: string): Promise<EdutubeSyncPayload | null> {
    const p = join(dir, '.edutube-sync');
    if (!existsSync(p)) return null;
    try {
        const raw = await readFile(p, 'utf8');
        return JSON.parse(raw) as EdutubeSyncPayload;
    } catch {
        return null;
    }
}

/**
 * If the canonical folder name does not exist, look for a sibling directory whose
 * `.edutube-sync` matches `kind` + `id`, and rename it to the canonical name.
 */
async function ensureDirResolved(
    parentDir: string,
    canonicalName: string,
    kind: 'teacher' | 'course_instance' | 'chapter',
    id: number,
    dryRun: boolean,
    warnings: string[]
): Promise<string> {
    const canonicalPath = join(parentDir, canonicalName);
    if (existsSync(canonicalPath)) {
        return canonicalPath;
    }

    if (!existsSync(parentDir)) {
        if (dryRun) {
            warnings.push(`[dry-run] would create parent: ${parentDir}`);
            return canonicalPath;
        }
        await mkdir(parentDir, { recursive: true });
    }

    let entries: import('node:fs').Dirent[];
    try {
        entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
        if (!dryRun) {
            await mkdir(canonicalPath, { recursive: true });
        } else {
            warnings.push(`[dry-run] would create: ${canonicalPath}`);
        }
        return canonicalPath;
    }

    for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        if (ent.name === canonicalName) continue;
        const candidate = join(parentDir, ent.name);
        const payload = await readSyncPayload(candidate);
        if (!payload || !('kind' in payload)) continue;
        if (payload.kind === kind && 'id' in payload && payload.id === id) {
            if (ent.name !== canonicalName) {
                warnings.push(`Rename folder: ${ent.name} → ${canonicalName}`);
                if (!dryRun) {
                    await rename(candidate, canonicalPath);
                }
            }
            return canonicalPath;
        }
    }

    if (!dryRun) {
        await mkdir(canonicalPath, { recursive: true });
    } else {
        warnings.push(`[dry-run] would create: ${canonicalPath}`);
    }
    return canonicalPath;
}

function formatUrlShortcut(targetUrl: string): string {
    return `[InternetShortcut]${URL_LINE_ENDING}URL=${targetUrl}${URL_LINE_ENDING}`;
}

async function writeJson(path: string, value: unknown, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    const body = JSON.stringify(value, null, 2) + '\n';
    await writeFile(path, body, 'utf8');
}

async function writeIfChanged(path: string, content: string, dryRun: boolean): Promise<boolean> {
    if (dryRun) {
        return true;
    }
    if (existsSync(path)) {
        const prev = await readFile(path, 'utf8');
        if (prev === content) return false;
    }
    await writeFile(path, content, 'utf8');
    return true;
}

async function reconcileLectureUrls(chapterDir: string, lectures: CliLecture[], dryRun: boolean, stats: PullStats): Promise<void> {
    const expected = new Set<string>();
    for (const lec of lectures) {
        expected.add(lectureUrlFileName(lec));
    }

    if (!existsSync(chapterDir)) {
        return;
    }

    const names = await readdir(chapterDir);
    for (const name of names) {
        if (!name.endsWith('.url') || !isOurLectureUrl(name)) continue;
        if (expected.has(name)) continue;
        const full = join(chapterDir, name);
        if (dryRun) {
            stats.warnings.push(`[dry-run] would remove orphan lecture shortcut: ${full}`);
            continue;
        }
        stats.warnings.push(`Remove orphan lecture shortcut: ${full}`);
        await rm(full, { force: true });
        stats.urlsRemoved += 1;
    }
}

async function pullChapter(ch: CliTreeChapter, ciDir: string, dryRun: boolean, stats: PullStats): Promise<void> {
    const canonical = chapterDirName(ch);
    const chapterDir = await ensureDirResolved(ciDir, canonical, 'chapter', ch.id, dryRun, stats.warnings);

    const chapterSync: ChapterSyncFile = {
        version: 1,
        kind: 'chapter',
        id: ch.id,
        number: ch.number,
        name: ch.name,
        ...(ch.description ? { description: ch.description } : {})
    };
    await writeJson(join(chapterDir, '.edutube-sync'), chapterSync, dryRun);

    for (const lec of ch.lectures) {
        const fileName = lectureUrlFileName(lec);
        const urlPath = join(chapterDir, fileName);
        const target = lec.youtube_url?.trim();
        if (!target) {
            stats.warnings.push(`Lecture ${lec.id} has no youtube_url; skipping ${fileName}`);
            continue;
        }
        const content = formatUrlShortcut(target);
        const changed = await writeIfChanged(urlPath, content, dryRun);
        if (changed) stats.lecturesWritten += 1;
    }

    await reconcileLectureUrls(chapterDir, ch.lectures, dryRun, stats);
}

export async function runPull(workspaceRoot: string, options: { dryRun?: boolean } = {}): Promise<PullStats> {
    const dryRun = options.dryRun === true;
    const stats: PullStats = {
        workspaceRoot,
        dryRun,
        teachers: 0,
        courseInstances: 0,
        chapters: 0,
        lecturesWritten: 0,
        urlsRemoved: 0,
        warnings: []
    };

    const { data } = await fetchCliTree();
    const tree: CliTreeResponse = data;

    const rootSync: WorkspaceSyncFile = {
        version: 1,
        kind: 'workspace',
        pulled_at: new Date().toISOString()
    };
    await writeJson(join(workspaceRoot, '.edutube-sync'), rootSync, dryRun);

    for (const teacher of tree.teachers) {
        const tName = teacherDirName(teacher);
        const teacherDir = await ensureDirResolved(workspaceRoot, tName, 'teacher', teacher.id, dryRun, stats.warnings);
        stats.teachers += 1;

        const teacherSync: TeacherSyncFile = {
            version: 1,
            kind: 'teacher',
            id: teacher.id,
            displayName: teacher.display_name
        };
        await writeJson(join(teacherDir, '.edutube-sync'), teacherSync, dryRun);

        for (const ci of teacher.course_instances) {
            const ciName = courseInstanceDirName(ci);
            const ciDir = await ensureDirResolved(teacherDir, ciName, 'course_instance', ci.id, dryRun, stats.warnings);
            stats.courseInstances += 1;

            const label =
                (ci.instance_name && ci.instance_name.trim()) ||
                `${ci.course_template.course_code} — ${ci.course_template.name}`;
            const ciSync: CourseInstanceSyncFile = {
                version: 1,
                kind: 'course_instance',
                id: ci.id,
                displayName: label
            };
            await writeJson(join(ciDir, '.edutube-sync'), ciSync, dryRun);

            for (const ch of ci.chapters) {
                stats.chapters += 1;
                await pullChapter(ch, ciDir, dryRun, stats);
            }
        }
    }

    return stats;
}
