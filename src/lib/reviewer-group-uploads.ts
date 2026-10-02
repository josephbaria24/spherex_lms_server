import fs from "node:fs";
import path from "node:path";
import { getUploadsRoot } from "./org-uploads.js";
import { extensionForMime, ORG_LOGO_MIME_TYPES } from "./org-uploads.js";

export const REVIEWER_GROUP_UPLOADS_SEGMENT = "reviewer-groups";

export { ORG_LOGO_MIME_TYPES as REVIEWER_GROUP_COVER_MIME_TYPES, extensionForMime };

export function getReviewerGroupUploadDir(groupId: string): string {
  return path.join(getUploadsRoot(), REVIEWER_GROUP_UPLOADS_SEGMENT, groupId);
}

export function ensureReviewerGroupUploadDir(groupId: string): string {
  const dir = getReviewerGroupUploadDir(groupId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function reviewerGroupCoverPublicPath(groupId: string, filename: string): string {
  return `/uploads/${REVIEWER_GROUP_UPLOADS_SEGMENT}/${groupId}/${filename}`;
}

export function clearReviewerGroupCoverFiles(groupId: string): void {
  const dir = getReviewerGroupUploadDir(groupId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("cover.")) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

export function initReviewerGroupUploadsDirectory(): void {
  fs.mkdirSync(path.join(getUploadsRoot(), REVIEWER_GROUP_UPLOADS_SEGMENT), {
    recursive: true,
  });
}
