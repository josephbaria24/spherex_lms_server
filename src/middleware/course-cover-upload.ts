import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  clearCourseCoverFiles,
  COURSE_COVER_MIME_TYPES,
  ensureCourseUploadDir,
  extensionForMime,
} from "../lib/course-uploads.js";
import { HttpError } from "../utils/httpError.js";

function courseCoverMulter(courseId: string) {
  const dir = ensureCourseUploadDir(courseId);
  clearCourseCoverFiles(courseId);

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
      if (COURSE_COVER_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Cover must be JPEG, PNG, WebP, or GIF"));
      }
    },
  }).single("cover");
}

export function handleCourseCoverUpload(courseId: string) {
  const upload = courseCoverMulter(courseId);

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
