/** Mirrors /api/cli/* JSON (snake_case in payloads). */

export interface CliErrorBody {
    error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
    };
}

export interface CliHealthData {
    ok: boolean;
    key_name: string;
}

export interface CliLecture {
    id: number;
    chapter_id: number;
    lecture_number: number;
    title: string;
    description?: string | null;
    youtube_url: string;
    youtube_video_id: string | null;
    duration: number;
    source: string;
}

export interface CliTreeResponse {
    teachers: CliTreeTeacher[];
}

export interface CliTreeTeacher {
    id: number;
    display_name: string;
    course_instances: CliTreeCourseInstance[];
}

export interface CliTreeCourseInstance {
    id: number;
    instance_name: string | null;
    is_active: boolean;
    course_template: {
        id: number;
        course_code: string;
        name: string;
        description: string | null;
    };
    chapters: CliTreeChapter[];
}

export interface CliTreeChapter {
    id: number;
    number: number;
    name: string;
    description: string | null;
    lectures: CliLecture[];
}

export interface CliCourseInstanceTreeData {
    course_instance: {
        id: number;
        instance_name: string | null;
        is_active: boolean;
        teacher: { id: number; display_name: string };
        course_template: {
            id: number;
            course_code: string;
            name: string;
            description: string | null;
        };
        chapters: CliTreeChapter[];
    };
}

export interface CliCreateChapterData {
    chapter: {
        id: number;
        course_instance_id: number;
        number: number;
        name: string;
        description: string | null;
    };
}

export interface CliRegisterLectureData {
    lecture: CliLecture;
}
