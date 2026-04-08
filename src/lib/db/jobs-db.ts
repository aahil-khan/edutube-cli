import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { JobRow, JobState } from '../../types/job.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  duration_seconds INTEGER,
  file_size_bytes INTEGER,
  chapter_id INTEGER,
  title TEXT,
  youtube_video_id TEXT,
  lecture_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  upload_session_uri TEXT,
  ffprobe_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pull_revision TEXT
);
`;

export interface NewJobInsert {
    path: string;
    state: JobState;
    duration_seconds?: number | null;
    file_size_bytes?: number | null;
    chapter_id?: number | null;
    title?: string | null;
    youtube_video_id?: string | null;
    lecture_id?: number | null;
    error?: string | null;
    ffprobe_json?: string | null;
    upload_session_uri?: string | null;
    bytes_uploaded?: number;
}

export function getJobsDbPath(workspaceRoot: string): string {
    return join(workspaceRoot, '.edutube', 'jobs.sqlite');
}

export function openJobsDb(workspaceRoot: string): Database.Database {
    const dir = join(workspaceRoot, '.edutube');
    mkdirSync(dir, { recursive: true });
    const dbPath = getJobsDbPath(workspaceRoot);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
}

export function listJobs(db: Database.Database): JobRow[] {
    return db.prepare('SELECT * FROM jobs ORDER BY id DESC').all() as JobRow[];
}

export function getJobByPath(db: Database.Database, absolutePath: string): JobRow | undefined {
    return db.prepare('SELECT * FROM jobs WHERE path = ?').get(absolutePath) as JobRow | undefined;
}

export function getJobById(db: Database.Database, id: number): JobRow | undefined {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function insertJob(db: Database.Database, row: NewJobInsert): number {
    const now = new Date().toISOString();
    const info = db
        .prepare(
            `INSERT INTO jobs (
        path, state, duration_seconds, file_size_bytes, chapter_id, title,
        youtube_video_id, lecture_id, error, created_at, updated_at, bytes_uploaded, upload_session_uri, ffprobe_json
      ) VALUES (
        @path, @state, @duration_seconds, @file_size_bytes, @chapter_id, @title,
        @youtube_video_id, @lecture_id, @error, @created_at, @updated_at, @bytes_uploaded, @upload_session_uri, @ffprobe_json
      )`
        )
        .run({
            path: row.path,
            state: row.state,
            duration_seconds: row.duration_seconds ?? null,
            file_size_bytes: row.file_size_bytes ?? null,
            chapter_id: row.chapter_id ?? null,
            title: row.title ?? null,
            youtube_video_id: row.youtube_video_id ?? null,
            lecture_id: row.lecture_id ?? null,
            error: row.error ?? null,
            created_at: now,
            updated_at: now,
            bytes_uploaded: row.bytes_uploaded ?? 0,
            upload_session_uri: row.upload_session_uri ?? null,
            ffprobe_json: row.ffprobe_json ?? null
        });
    return Number(info.lastInsertRowid);
}

export function updateJobState(
    db: Database.Database,
    id: number,
    patch: Partial<
        Pick<
            JobRow,
            | 'state'
            | 'duration_seconds'
            | 'file_size_bytes'
            | 'chapter_id'
            | 'title'
            | 'youtube_video_id'
            | 'lecture_id'
            | 'error'
            | 'bytes_uploaded'
            | 'upload_session_uri'
            | 'ffprobe_json'
        >
    >
): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE jobs SET ${sets}, updated_at = @updated_at WHERE id = @id`);
    stmt.run({
        ...patch,
        id,
        updated_at: new Date().toISOString()
    });
}

export function jobIdempotencyKey(jobId: number): string {
    return `job_${jobId}`;
}

/** After a failed upload (e.g. before `auth google`), put the job back to pending_upload. */
export function resetJobForUploadRetry(db: Database.Database, id: number): JobRow {
    const job = getJobById(db, id);
    if (!job) {
        throw new Error(`Job ${id} not found`);
    }
    if (job.state !== 'failed_upload' && job.state !== 'quota_exceeded') {
        throw new Error(
            `Job ${id} is "${job.state}". Only failed_upload or quota_exceeded can be reset to retry upload (use a new job if stuck in failed_register).`
        );
    }
    updateJobState(db, id, {
        state: 'pending_upload',
        error: null
    });
    return getJobById(db, id)!;
}
