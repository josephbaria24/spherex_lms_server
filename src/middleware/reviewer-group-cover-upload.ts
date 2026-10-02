import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  clearReviewerGroupCoverFiles,
  REVIEWER_GROUP_COVER_MIME_TYPES,
  ensureReviewerGroupUploadDir,
  extensionForMime,
} from "../lib/reviewer-group-uploads.js";
import { HttpError } from "../utils/httpError.js";

function reviewerGroupCoverMulter(groupId: string) {
  const dir = ensureReviewerGroupUploadDir(groupId);
  clearReviewerGroupCoverFiles(groupId);

  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => {
        try {
          cb(null, `cover${extensionForMime(file.mimetype)}`);
        } catch (err) {
          cb(err as Error, "");
        }
      },
    }),
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (REVIEWER_GROUP_COVER_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Cover must be JPEG, PNG, WebP, or GIF"));
      }
    },
  }).single("cover");
}

export function handleReviewerGroupCoverUpload(groupId: string) {
  const upload = reviewerGroupCoverMulter(groupId);

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(HttpError.badRequest("Cover image must be 4 MB or smaller"));
        }
        return next(HttpError.badRequest(err.message));
      }
      if (err) return next(err);
      if (!req.file) {
        return next(HttpError.badRequest("No cover image provided"));
      }
      next();
    });
  };
}
