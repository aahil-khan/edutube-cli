import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChapterSyncFile, CourseInstanceSyncFile, EdutubeSyncPayload } from '../../types/sync-metadata.js';

const TEACHER_DIR = /^T\d+_/;
const CI_DIR = /^CI\d+_/;
const CHAPTER_FOLDER = /^(\d{2})_(.+)$/;

function readSyncFileSync(dir: string): EdutubeSyncPayload | null {
    const p = join(dir, '.edutube-sync');
    if (!existsSync(p)) return null;
    try {
        const raw = readFileSync(p, 'utf8');
        return JSON.parse(raw) as EdutubeSyncPayload;
    } catch {
        return null;
    }
}

export interface ScanNewChapter {
    courseInstanceId: number;
    ciDir: string;
    chapterDir: string;
    folderName: string;
    parsedNumber?: number;
    nameForApi: string;
}

export interface ScanMp4Item {
    filePath: string;
    chapterDir: string;
    chapterId: number | null;
    courseInstanceId: number;
}

export interface PushScanResult {
    newChapters: ScanNewChapter[];
    mp4Items: ScanMp4Item[];
    warnings: string[];
    blockingErrors: string[];
}

function parseChapterFolderName(folderName: string): { parsedNumber?: number; nameForApi: string } {
    const m = CHAPTER_FOLDER.exec(folderName);
    if (!m) {
        return { nameForApi: folderName.replace(/_/g, ' ').trim() || folderName };
    }
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) {
        return { nameForApi: m[2].replace(/_/g, ' ').trim() || folderName };
    }
    return { parsedNumber: n, nameForApi: m[2].replace(/_/g, ' ').trim() || `Chapter ${n}` };
}

function listMp4FilesInChapterDir(chapterDir: string): string[] {
    if (!existsSync(chapterDir)) return [];
    const names = readdirSync(chapterDir);
    const out: string[] = [];
    for (const name of names) {
        if (name.startsWith('.')) continue;
        if (name.toLowerCase() === '_uploaded') continue;
        if (!name.toLowerCase().endsWith('.mp4')) continue;
        const full = join(chapterDir, name);
        try {
            if (!statSync(full).isFile()) continue;
        } catch {
            continue;
        }
        out.push(full);
    }
    out.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base' }));
    return out;
}

/**
 * Walk pull layout: T* / CI* / chapter folders. Find chapters without a server id (new) and .mp4 files to upload.
 */
export function scanPushWorkspace(workspaceRoot: string): PushScanResult {
    const warnings: string[] = [];
    const blockingErrors: string[] = [];
    const newChapters: ScanNewChapter[] = [];
    const mp4Items: ScanMp4Item[] = [];

    if (!existsSync(workspaceRoot)) {
        blockingErrors.push(`Workspace not found: ${workspaceRoot}`);
        return { newChapters, mp4Items, warnings, blockingErrors };
    }

    let top: import('node:fs').Dirent[];
    try {
        top = readdirSync(workspaceRoot, { withFileTypes: true }) as import('node:fs').Dirent[];
    } catch (e) {
        blockingErrors.push(`Cannot read workspace: ${e instanceof Error ? e.message : e}`);
        return { newChapters, mp4Items, warnings, blockingErrors };
    }

    for (const ent of top) {
        const entName = String(ent.name);
        if (!ent.isDirectory() || entName.startsWith('.') || entName === '.edutube') continue;
        if (!TEACHER_DIR.test(entName)) {
            warnings.push(`Skipping top-level folder (not T<id>_… from pull): ${entName}`);
            continue;
        }
        const teacherDir = join(workspaceRoot, entName);
        const teacherSync = readSyncFileSync(teacherDir);
        if (!teacherSync || teacherSync.kind !== 'teacher') {
            warnings.push(`Skipping ${entName}: missing or invalid .edutube-sync (expected kind "teacher")`);
            continue;
        }

        let ciEntries: import('node:fs').Dirent[];
        try {
            ciEntries = readdirSync(teacherDir, { withFileTypes: true }) as import('node:fs').Dirent[];
        } catch {
            continue;
        }

        for (const ciEnt of ciEntries) {
            const ciName = String(ciEnt.name);
            if (!ciEnt.isDirectory() || ciName.startsWith('.')) continue;
            if (!CI_DIR.test(ciName)) {
                warnings.push(`Skipping under ${entName}: ${ciName} (expected CI<id>_…)`);
                continue;
            }
            const ciDir = join(teacherDir, ciName);
            const ciPayload = readSyncFileSync(ciDir);
            if (!ciPayload || ciPayload.kind !== 'course_instance') {
                warnings.push(`Skipping ${ciName}: missing kind "course_instance" in .edutube-sync`);
                continue;
            }
            const courseInstanceId = (ciPayload as CourseInstanceSyncFile).id;

            let chEntries: import('node:fs').Dirent[];
            try {
                chEntries = readdirSync(ciDir, { withFileTypes: true }) as import('node:fs').Dirent[];
            } catch {
                continue;
            }

            const newChapterNums = new Map<number, string>();

            for (const chEnt of chEntries) {
                const chName = String(chEnt.name);
                if (!chEnt.isDirectory() || chName.startsWith('.')) continue;
                if (chName.toLowerCase() === '_uploaded') continue;

                const chapterDir = join(ciDir, chName);
                const sync = readSyncFileSync(chapterDir);
                let chapterId: number | null = null;
                let isNew = false;

                if (sync && sync.kind === 'chapter' && typeof (sync as ChapterSyncFile).id === 'number') {
                    chapterId = (sync as ChapterSyncFile).id;
                } else {
                    isNew = true;
                    const { parsedNumber, nameForApi } = parseChapterFolderName(chName);
                    if (parsedNumber !== undefined) {
                        const prev = newChapterNums.get(parsedNumber);
                        if (prev !== undefined) {
                            blockingErrors.push(
                                `Duplicate new chapter number ${String(parsedNumber).padStart(2, '0')} under course instance ${courseInstanceId}: "${prev}" vs "${chapterDir}"`
                            );
                        } else {
                            newChapterNums.set(parsedNumber, chapterDir);
                        }
                    }
                    newChapters.push({
                        courseInstanceId,
                        ciDir,
                        chapterDir,
                        folderName: chName,
                        parsedNumber,
                        nameForApi
                    });
                }

                for (const filePath of listMp4FilesInChapterDir(chapterDir)) {
                    mp4Items.push({
                        filePath,
                        chapterDir,
                        chapterId: isNew ? null : chapterId,
                        courseInstanceId
                    });
                }
            }
        }
    }

    mp4Items.sort((a, b) => {
        const c = a.chapterDir.localeCompare(b.chapterDir);
        if (c !== 0) return c;
        return basename(a.filePath).localeCompare(basename(b.filePath), undefined, { sensitivity: 'base' });
    });

    newChapters.sort((a, b) => {
        const ci = a.courseInstanceId - b.courseInstanceId;
        if (ci !== 0) return ci;
        const an = a.parsedNumber ?? 9999;
        const bn = b.parsedNumber ?? 9999;
        if (an !== bn) return an - bn;
        return a.chapterDir.localeCompare(b.chapterDir);
    });

    return { newChapters, mp4Items, warnings, blockingErrors };
}
