import fs from "node:fs";
import path from "node:path";
import { getUploadsRoot } from "./org-uploads.js";

export const LESSON_UPLOADS_SEGMENT = "lessons";

const VIDEO_MIME_TO_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
};

export const LESSON_VIDEO_MIME_TYPES = new Set(Object.keys(VIDEO_MIME_TO_EXT));

export function getLessonUploadDir(courseId: string, lessonId: string): string {
  return path.join(getUploadsRoot(), LESSON_UPLOADS_SEGMENT, courseId, lessonId);
}

export function ensureLessonUploadDir(courseId: string, lessonId: string): string {
  const dir = getLessonUploadDir(courseId, lessonId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function extensionForVideoMime(mime: string): string {
  const ext = VIDEO_MIME_TO_EXT[mime];
  if (!ext) throw new Error(`Unsupported video type: ${mime}`);
  return ext;
}

export function lessonVideoPublicPath(courseId: string, lessonId: string, filename: string): string {
  return `/uploads/${LESSON_UPLOADS_SEGMENT}/${courseId}/${lessonId}/${filename}`;
}

export function clearLessonVideoFiles(courseId: string, lessonId: string): void {
  const dir = getLessonUploadDir(courseId, lessonId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("video.")) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

export function initLessonUploadsDirectory(): void {
  fs.mkdirSync(path.join(getUploadsRoot(), LESSON_UPLOADS_SEGMENT), { recursive: true });
}
