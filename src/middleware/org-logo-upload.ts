import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  clearOrgLogoFiles,
  ensureOrgUploadDir,
  extensionForMime,
  ORG_LOGO_MIME_TYPES,
} from "../lib/org-uploads.js";
import { HttpError } from "../utils/httpError.js";

function orgLogoMulter(organizationId: string) {
  const dir = ensureOrgUploadDir(organizationId);
  clearOrgLogoFiles(organizationId);

  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => {
        try {
          cb(null, `logo${extensionForMime(file.mimetype)}`);
        } catch (err) {
          cb(err as Error, "");
        }
      },
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ORG_LOGO_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Logo must be JPEG, PNG, WebP, GIF, or SVG"));
      }
    },
  }).single("logo");
}

export function handleOrgLogoUpload(organizationId: string) {
  const upload = orgLogoMulter(organizationId);

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(HttpError.badRequest("Logo must be 2 MB or smaller"));
        }
        return next(HttpError.badRequest(err.message));
      }
      if (err) return next(err);
      if (!req.file) {
        return next(HttpError.badRequest("No logo file provided"));
      }
      next();
    });
  };
}
