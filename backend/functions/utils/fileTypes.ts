// utils/fileTypes.ts — Single source of truth for accepted upload types

/** Accepted MIME types and the extension each one is stored under. */
export const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const ALLOWED_MIME = Object.keys(MIME_TO_EXT);

/** Extensions to probe when looking up a stored upload (includes legacy "jpeg"). */
export const STORED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp"];

/** Storage key for a job's upload; the extension comes from the validated MIME type, never the client filename. */
export function objectNameFor(job_id: string, mimeType: string): string {
  return `uploads/${job_id}/file.${MIME_TO_EXT[mimeType] ?? "bin"}`;
}

/** Infer the MIME type from a stored object's URL (signed URLs carry a query string). */
export function mimeFromUrl(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0];
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":  return "application/pdf";
    case "png":  return "image/png";
    case "webp": return "image/webp";
    default:     return "image/jpeg";
  }
}
