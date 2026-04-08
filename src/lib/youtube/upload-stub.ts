/**
 * Resumable YouTube Data API v3 upload — next milestone (OAuth + googleapis).
 * Callers should check for implementation before scheduling uploads.
 */
export function youtubeUploadNotImplemented(): never {
    throw new Error(
        'YouTube resumable upload is not wired yet. Next: `edutube auth google` + googleapis upload with privacy unlisted.'
    );
}
