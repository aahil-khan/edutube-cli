/** Local `.edutube-sync` JSON (camelCase in files — separate from API snake_case). */

export interface SyncFileBase {
    version: 1;
}

export interface WorkspaceSyncFile extends SyncFileBase {
    kind: 'workspace';
    pulled_at: string;
}

export interface TeacherSyncFile extends SyncFileBase {
    kind: 'teacher';
    id: number;
    displayName: string;
}

export interface CourseInstanceSyncFile extends SyncFileBase {
    kind: 'course_instance';
    id: number;
    displayName: string;
}

export interface ChapterSyncFile extends SyncFileBase {
    kind: 'chapter';
    id: number;
    number: number;
    name: string;
    description?: string;
}

export type EdutubeSyncPayload = WorkspaceSyncFile | TeacherSyncFile | CourseInstanceSyncFile | ChapterSyncFile;
