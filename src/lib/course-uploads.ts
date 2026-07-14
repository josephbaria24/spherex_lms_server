import fs from "node:fs";
import path from "node:path";
import { getUploadsRoot } from "./org-uploads.js";
import { extensionForMime, ORG_LOGO_MIME_TYPES } from "./org-uploads.js";

export const COURSE_UPLOADS_SEGMENT = "courses";

export { ORG_LOGO_MIME_TYPES as COURSE_COVER_MIME_TYPES, extensionForMime };

export function getCourseUploadDir(courseId: string): string {
  return path.join(getUploadsRoot(), COURSE_UPLOADS_SEGMENT, courseId);
}

export function ensureCourseUploadDir(courseId: string): string {
  const dir = getCourseUploadDir(courseId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function courseCoverPublicPath(courseId: string, filename: string): string {
  return `/uploads/${COURSE_UPLOADS_SEGMENT}/${courseId}/${filename}`;
}

export function clearCourseCoverFiles(courseId: string): void {
  const dir = getCourseUploadDir(courseId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("cover.")) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

export function initCourseUploadsDirectory(): void {
  fs.mkdirSync(path.join(getUploadsRoot(), COURSE_UPLOADS_SEGMENT), { recursive: true });
}
