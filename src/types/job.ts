/** Local SQLite `jobs` row (upload pipeline). */

export type JobState =
    | 'pending_probe'
    | 'probing'
    | 'pending_upload'
    | 'uploading'
    | 'pending_register'
    | 'completed'
    | 'failed_validation'
    | 'failed_upload'
    | 'failed_register'
    | 'quota_exceeded'
    | 'needs_resolution';

export interface JobRow {
    id: number;
    path: string;
    state: JobState;
    duration_seconds: number | null;
    file_size_bytes: number | null;
    chapter_id: number | null;
    title: string | null;
    youtube_video_id: string | null;
    lecture_id: number | null;
    error: string | null;
    created_at: string;
    updated_at: string;
    bytes_uploaded: number;
    upload_session_uri: string | null;
    ffprobe_json: string | null;
}
