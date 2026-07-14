import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ORG_UPLOADS_SEGMENT = "organizations";

export function getUploadsRoot(): string {
  return path.isAbsolute(env.uploadsDir)
    ? env.uploadsDir
    : path.resolve(serverRoot, env.uploadsDir);
}

export function getOrgUploadDir(organizationId: string): string {
  return path.join(getUploadsRoot(), ORG_UPLOADS_SEGMENT, organizationId);
}

export function ensureOrgUploadDir(organizationId: string): string {
  const dir = getOrgUploadDir(organizationId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

export const ORG_LOGO_MIME_TYPES = new Set(Object.keys(MIME_TO_EXT));

export function extensionForMime(mime: string): string {
  const ext = MIME_TO_EXT[mime];
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);
  return ext;
}

/** Public URL path stored in DB and served under /api/uploads */
export function orgLogoPublicPath(organizationId: string, filename: string): string {
  return `/uploads/${ORG_UPLOADS_SEGMENT}/${organizationId}/${filename}`;
}

export function clearOrgLogoFiles(organizationId: string): void {
  const dir = getOrgUploadDir(organizationId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("logo.")) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

export function initUploadsDirectory(): void {
  const root = getUploadsRoot();
  fs.mkdirSync(path.join(root, ORG_UPLOADS_SEGMENT), { recursive: true });
}
