import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile, rm, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CliLecture, CliTreeChapter, CliTreeCourseInstance, CliTreeResponse, CliTreeTeacher } from '../../types/cli-api.js';
import type { ChapterSyncFile, CourseInstanceSyncFile, EdutubeSyncPayload, TeacherSyncFile, WorkspaceSyncFile } from '../../types/sync-metadata.js';
import { fetchCliTree } from '../api.js';
import { chapterDirName, courseInstanceDirName, lectureUrlFileName, teacherDirName } from './layout.js';
import { formatUrlShortcut } from './url-shortcut.js';

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

function syncMatchesKindId(payload: EdutubeSyncPayload | null, kind: 'teacher' | 'course_instance' | 'chapter', id: number): boolean {
    return Boolean(payload && 'kind' in payload && payload.kind === kind && 'id' in payload && (payload as { id: number }).id === id);
}

/** Subdirectories whose `.edutube-sync` claims this entity (same `kind` + `id`). */
async function findDirsWithKindAndId(
    parentDir: string,
    kind: 'teacher' | 'course_instance' | 'chapter',
    id: number
): Promise<string[]> {
    if (!existsSync(parentDir)) return [];
    let entries: import('node:fs').Dirent[];
    try {
        entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const dirPath = join(parentDir, ent.name);
        const payload = await readSyncPayload(dirPath);
        if (syncMatchesKindId(payload, kind, id)) {
            out.push(dirPath);
        }
    }
    return out;
}

/**
 * Move children from `fromDir` into `toDir` (destination wins on name clash). Skips `.edutube-sync`
 * from the source so the tree metadata written by pull stays authoritative. Removes `fromDir` when done.
 */
async function mergeDirIntoPreferDestination(fromDir: string, toDir: string, dryRun: boolean, warnings: string[]): Promise<void> {
    if (dryRun) return;
    const entries = await readdir(fromDir, { withFileTypes: true });
    for (const ent of entries) {
        const name = ent.name;
        if (name === '.edutube-sync') continue;
        const from = join(fromDir, name);
        const to = join(toDir, name);
        if (!existsSync(to)) {
            await rename(from, to);
            continue;
        }
        const fromStat = await lstat(from);
        const toStat = await lstat(to);
        if (ent.isDirectory() && fromStat.isDirectory() && toStat.isDirectory()) {
            await mergeDirIntoPreferDestination(from, to, dryRun, warnings);
        } else {
            warnings.push(`Merge conflict: keeping destination ${to}`);
            if (fromStat.isDirectory()) {
                await rm(from, { recursive: true, force: true });
            } else {
                await rm(from, { force: true });
            }
        }
    }
    await rm(fromDir, { recursive: true, force: true });
}

/**
 * Resolve the folder for a teacher / course instance / chapter:
 * - Canonical name comes from the API (`NN_title`, `Tid_name`, etc.).
 * - If the admin renames a chapter (or similar), the old folder name may still exist with the same id
 *   in `.edutube-sync`. We find **all** sibling dirs with that id and merge into the canonical path so
 *   duplicate folders (e.g. `05_xyz` and `05_abc`) are not left behind.
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

    if (!existsSync(parentDir)) {
        if (dryRun) {
            warnings.push(`[dry-run] would create parent: ${parentDir}`);
            return canonicalPath;
        }
        await mkdir(parentDir, { recursive: true });
    }

    // Something already at the canonical path without valid sync for this entity (empty stub, wrong id) blocks rename/merge.
    if (existsSync(canonicalPath)) {
        const payload = await readSyncPayload(canonicalPath);
        if (!syncMatchesKindId(payload, kind, id)) {
            warnings.push(`Remove folder blocking canonical name ${canonicalName}: ${canonicalPath}`);
            if (!dryRun) {
                await rm(canonicalPath, { recursive: true, force: true });
            }
        }
    }

    let matches = await findDirsWithKindAndId(parentDir, kind, id);

    if (matches.length === 0) {
        if (!dryRun) {
            await mkdir(canonicalPath, { recursive: true });
        } else {
            warnings.push(`[dry-run] would create: ${canonicalPath}`);
        }
        return canonicalPath;
    }

    const atCanonical = matches.filter((p) => basename(p) === canonicalName);
    const elsewhere = matches.filter((p) => basename(p) !== canonicalName);

    // Single folder, wrong name → rename to canonical
    if (matches.length === 1 && elsewhere.length === 1 && atCanonical.length === 0) {
        const only = elsewhere[0];
        warnings.push(`Rename folder: ${basename(only)} → ${canonicalName}`);
        if (!dryRun) {
            if (!existsSync(canonicalPath)) {
                await rename(only, canonicalPath);
            } else {
                await mergeDirIntoPreferDestination(only, canonicalPath, dryRun, warnings);
            }
        }
        return canonicalPath;
    }

    // Folder already at canonical name: absorb any other dirs with the same id (rename drift).
    if (atCanonical.length >= 1) {
        const keeper = join(parentDir, canonicalName);
        for (const src of elsewhere) {
            warnings.push(`Merge duplicate ${kind} id ${id}: ${basename(src)} → ${canonicalName}`);
            if (!dryRun) {
                await mergeDirIntoPreferDestination(src, keeper, dryRun, warnings);
            }
        }
        return canonicalPath;
    }

    // Multiple dirs, none yet named canonically — pick one to rename, merge the rest
    const primary = elsewhere[0];
    const rest = elsewhere.slice(1);
    warnings.push(`Rename folder: ${basename(primary)} → ${canonicalName}`);
    if (!dryRun) {
        if (!existsSync(canonicalPath)) {
            await rename(primary, canonicalPath);
        } else {
            await mergeDirIntoPreferDestination(primary, canonicalPath, dryRun, warnings);
        }
        for (const src of rest) {
            warnings.push(`Merge duplicate ${kind} id ${id}: ${basename(src)} → ${canonicalName}`);
            await mergeDirIntoPreferDestination(src, canonicalPath, dryRun, warnings);
        }
    }
    return canonicalPath;
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
