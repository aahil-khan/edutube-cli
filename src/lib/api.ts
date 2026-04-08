import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type {
    CliCourseInstanceTreeData,
    CliCreateChapterData,
    CliHealthData,
    CliRegisterLectureData,
    CliTreeResponse
} from '../types/cli-api.js';

function getEnv(name: string, fallback?: string): string {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
}

export function getBackendUrl(): string {
    return getEnv('EDUTUBE_BACKEND_URL');
}

export function getCliApiKey(): string {
    return getEnv('EDUTUBE_API_KEY');
}

type HttpMethod = 'GET' | 'POST';

/** Plain http(s), `agent: false` — avoids undici/fetch and Agent lifecycle issues on Windows (libuv). */
function cliHttpRequest(
    method: HttpMethod,
    urlStr: string,
    headers: Record<string, string>,
    jsonBody?: Record<string, unknown>
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;

        const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
        const mergedHeaders: Record<string, string> = { ...headers };
        if (payload !== undefined) {
            mergedHeaders['Content-Type'] = 'application/json';
            mergedHeaders['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'));
        }

        const req = lib.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: `${u.pathname}${u.search}`,
                method,
                headers: mergedHeaders,
                agent: false
            },
            (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8')
                    });
                });
                res.on('error', reject);
            }
        );

        req.on('error', reject);
        req.setTimeout(120_000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        if (payload !== undefined) {
            req.write(payload, 'utf8');
        }
        req.end();
    });
}

function baseHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-CLI-API-Key': getCliApiKey()
    };
}

function parseEnvelope<T>(statusCode: number, body: string): { data: T; created?: boolean } {
    const ok = statusCode >= 200 && statusCode < 300;

    if (!ok && (!body || !body.trim())) {
        throw new Error(
            `HTTP ${statusCode} from ${getBackendUrl()} (empty body). Check URL, TLS, and reverse proxy auth.`
        );
    }

    let json: { data: T; created?: boolean } | { error: { code: string; message: string; details?: unknown } };
    try {
        json = JSON.parse(body) as typeof json;
    } catch {
        const snippet = body.replace(/\s+/g, ' ').slice(0, 240);
        throw new Error(`HTTP ${statusCode} from API (non-JSON): ${snippet}`);
    }

    if (!ok || 'error' in json) {
        const msg =
            'error' in json && json.error && typeof json.error === 'object' && 'message' in json.error
                ? `${(json.error as { code?: string }).code ?? 'ERROR'}: ${(json.error as { message: string }).message}`
                : `HTTP ${statusCode}`;
        throw new Error(`EduTube API ${msg}`);
    }

    return json as { data: T; created?: boolean };
}

async function cliGet<T>(path: string): Promise<{ data: T; created?: boolean }> {
    const url = `${getBackendUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const { statusCode, body } = await cliHttpRequest('GET', url, baseHeaders());
    return parseEnvelope<T>(statusCode, body);
}

async function cliPost<T>(path: string, jsonBody: Record<string, unknown>): Promise<{ data: T; created?: boolean }> {
    const url = `${getBackendUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const { statusCode, body } = await cliHttpRequest('POST', url, baseHeaders(), jsonBody);
    return parseEnvelope<T>(statusCode, body);
}

export async function fetchCliHealth(): Promise<{ data: CliHealthData; created?: boolean }> {
    return cliGet<CliHealthData>('/api/cli/health');
}

export async function fetchCliTree(): Promise<{ data: CliTreeResponse; created?: boolean }> {
    return cliGet<CliTreeResponse>('/api/cli/tree');
}

export async function fetchCliCourseInstanceTree(
    courseInstanceId: number
): Promise<{ data: CliCourseInstanceTreeData; created?: boolean }> {
    const id = encodeURIComponent(String(courseInstanceId));
    return cliGet<CliCourseInstanceTreeData>(`/api/cli/course-instances/${id}/tree`);
}

export async function cliCreateChapter(body: {
    course_instance_id: number;
    name: string;
    description?: string;
    number?: number;
}): Promise<{ data: CliCreateChapterData; created?: boolean }> {
    return cliPost<CliCreateChapterData>('/api/cli/chapters', body as Record<string, unknown>);
}

export async function cliRegisterLecture(body: {
    chapter_id: number;
    title: string;
    youtube_url: string;
    youtube_video_id: string;
    duration_seconds: number;
    lecture_number?: number;
    description?: string;
    idempotency_key?: string;
}): Promise<{ data: CliRegisterLectureData; created?: boolean }> {
    const payload: Record<string, unknown> = {
        chapter_id: body.chapter_id,
        title: body.title,
        youtube_url: body.youtube_url,
        youtube_video_id: body.youtube_video_id,
        duration_seconds: body.duration_seconds
    };
    if (body.lecture_number !== undefined) payload.lecture_number = body.lecture_number;
    if (body.description !== undefined) payload.description = body.description;
    if (body.idempotency_key !== undefined) payload.idempotency_key = body.idempotency_key;
    return cliPost<CliRegisterLectureData>('/api/cli/lectures/register', payload);
}

export async function fetchCliLectureByVideo(
    videoId: string
): Promise<{ data: CliRegisterLectureData; created?: boolean }> {
    const id = encodeURIComponent(videoId);
    return cliGet<CliRegisterLectureData>(`/api/cli/lectures/by-video/${id}`);
}
