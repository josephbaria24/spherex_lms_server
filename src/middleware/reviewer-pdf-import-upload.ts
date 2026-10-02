import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (ok) cb(null, true);
    else cb(new Error("Only PDF files are supported"));
  },
}).single("pdf");

export function handleReviewerPdfImportUpload(req: Request, res: Response, next: NextFunction) {
  upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(HttpError.badRequest("PDF must be 80 MB or smaller"));
      }
      return next(HttpError.badRequest(err.message));
    }
    if (err) return next(err);
    if (!req.file) return next(HttpError.badRequest("No PDF file provided"));
    next();
  });
}
