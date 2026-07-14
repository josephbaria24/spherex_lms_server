import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../utils/httpError.js";

const SCORM_ZIP_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

export function handleScormZipUpload() {
  const tmpDir = path.join(os.tmpdir(), "spherex-scorm-uploads");
  fs.mkdirSync(tmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, tmpDir),
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === ".zip" || SCORM_ZIP_MIMES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("SCORM package must be a .zip file"));
      }
    },
  }).single("scorm");

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(HttpError.badRequest("SCORM package must be 500 MB or smaller"));
        }
        return next(HttpError.badRequest(err.message));
      }
      if (err) return next(err);
      if (!req.file) {
        return next(HttpError.badRequest("No SCORM zip file provided"));
      }
      next();
    });
  };
}
