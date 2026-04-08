/** Windows + cross-platform safe single path segment (folder name). */
const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizePathSegment(name: string, maxLen = 80): string {
    const s = name
        .replace(INVALID, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');
    const base = s.length > 0 ? s : 'untitled';
    return base.length > maxLen ? base.slice(0, maxLen).replace(/[. ]+$/g, '') : base;
}

/** Slug for lecture filename suffix (ASCII-ish). */
export function slugForFilename(title: string, maxLen = 48): string {
    return sanitizePathSegment(
        title
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9._\- ]/g, '_')
            .replace(/_+/g, '_'),
        maxLen
    ).replace(/ /g, '_');
}

export function pad2(n: number): string {
    return String(n).padStart(2, '0');
}
