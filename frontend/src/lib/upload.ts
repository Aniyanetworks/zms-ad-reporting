"use client";

import { ApiError, getAccessToken, type Asset } from "@/lib/api";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Client-side mirror of the server's asset rules; returns a reason or null when acceptable. */
export function rejectReason(file: File): string | null {
  if (IMAGE_TYPES.includes(file.type)) {
    return file.size > MAX_IMAGE_BYTES ? "Images must be 30 MB or smaller" : null;
  }
  if (VIDEO_TYPES.includes(file.type)) {
    return file.size > MAX_VIDEO_BYTES ? "Videos must be 200 MB or smaller" : null;
  }
  return "Only JPEG, PNG, WebP, MP4 or QuickTime files";
}

/**
 * Upload one file to POST /api/builds/{id}/assets (multipart field `files`)
 * with XMLHttpRequest so upload progress is observable. Resolves with the
 * server's response: every asset on the build after the upload.
 */
export async function uploadAsset(
  buildId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Asset[]> {
  const token = await getAccessToken();
  return new Promise<Asset[]>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/builds/${encodeURIComponent(buildId)}/assets`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.total ? e.loaded / e.total : 0);
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Asset[]);
        } catch {
          reject(new Error("Upload succeeded but the response was not JSON"));
        }
        return;
      }
      let detail: unknown = xhr.responseText;
      try {
        detail = JSON.parse(xhr.responseText).detail ?? xhr.responseText;
      } catch {}
      reject(new ApiError(xhr.status, detail));
    };
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    const fd = new FormData();
    fd.append("files", file, file.name);
    xhr.send(fd);
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
