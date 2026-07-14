import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  clearLessonVideoFiles,
  ensureLessonUploadDir,
  extensionForVideoMime,
  LESSON_VIDEO_MIME_TYPES,
} from "../lib/lesson-uploads.js";
import { HttpError } from "../utils/httpError.js";

export function handleLessonVideoUpload(courseId: string, lessonId: string) {
  const dir = ensureLessonUploadDir(courseId, lessonId);
  clearLessonVideoFiles(courseId, lessonId);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => {
        try {
          cb(null, `video${extensionForVideoMime(file.mimetype)}`);
        } catch (err) {
          cb(err as Error, "");
        }
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (LESSON_VIDEO_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Video must be MP4, WebM, or Ogg"));
      }
    },
  }).single("video");

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(HttpError.badRequest("Video must be 200 MB or smaller"));
        }
        return next(HttpError.badRequest(err.message));
      }
      if (err) return next(err);
      if (!req.file) {
        return next(HttpError.badRequest("No video file provided"));
      }
      next();
    });
  };
}
