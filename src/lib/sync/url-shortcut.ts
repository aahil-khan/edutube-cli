/** Windows Internet Shortcut (.url) — CRLF line endings per plan. */

export const URL_LINE_ENDING = '\r\n';

export function formatUrlShortcut(targetUrl: string): string {
    return `[InternetShortcut]${URL_LINE_ENDING}URL=${targetUrl}${URL_LINE_ENDING}`;
}
