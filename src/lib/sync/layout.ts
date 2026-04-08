import { join } from 'node:path';
import type { CliLecture, CliTreeChapter, CliTreeCourseInstance, CliTreeTeacher } from '../../types/cli-api.js';
import { pad2, sanitizePathSegment, slugForFilename } from '../fs/sanitize.js';

export function teacherDirName(teacher: CliTreeTeacher): string {
    return `T${teacher.id}_${sanitizePathSegment(teacher.display_name)}`;
}

export function courseInstanceDirName(ci: CliTreeCourseInstance): string {
    const label =
        (ci.instance_name && ci.instance_name.trim()) ||
        `${ci.course_template.course_code}_${ci.course_template.name}`;
    return `CI${ci.id}_${sanitizePathSegment(label)}`;
}

export function chapterDirName(ch: CliTreeChapter): string {
    return `${pad2(ch.number)}_${sanitizePathSegment(ch.name)}`;
}

/** Plan: `L03_<lectureId>_<slug>.url` — we include padded lecture_number for sort. */
export function lectureUrlFileName(lec: CliLecture): string {
    const slug = slugForFilename(lec.title);
    return `L${pad2(lec.lecture_number)}_${lec.id}_${slug}.url`;
}

export function pathsForTeacher(workspaceRoot: string, teacher: CliTreeTeacher): string {
    return join(workspaceRoot, teacherDirName(teacher));
}

export function pathsForCourseInstance(workspaceRoot: string, teacher: CliTreeTeacher, ci: CliTreeCourseInstance): string {
    return join(pathsForTeacher(workspaceRoot, teacher), courseInstanceDirName(ci));
}

export function pathsForChapter(
    workspaceRoot: string,
    teacher: CliTreeTeacher,
    ci: CliTreeCourseInstance,
    ch: CliTreeChapter
): string {
    return join(pathsForCourseInstance(workspaceRoot, teacher, ci), chapterDirName(ch));
}
