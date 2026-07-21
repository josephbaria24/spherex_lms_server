import multer from "multer";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { initReceiptUploadsDirectory } from "../lib/payment-requests.js";
import { HttpError } from "../utils/httpError.js";

const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, initReceiptUploadsDirectory());
  },
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase() || ".bin";
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const receiptUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(HttpError.badRequest("Receipt must be JPEG, PNG, WebP, or PDF"));
      return;
    }
    cb(null, true);
  },
});
