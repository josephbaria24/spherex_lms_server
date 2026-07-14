import { Router, type Request, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

function cleanPath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\.\.+/g, "");
}

// POST /bunny/upload  (admin) — multipart form: file + path
router.post(
  "/upload",
  requireAuth,
  requireAdmin,
  upload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const file = req.file;
    const path = typeof req.body?.path === "string" ? req.body.path : "";
    if (!file) throw HttpError.badRequest("Missing file");
    if (!path) throw HttpError.badRequest("Missing path");

    if (!env.bunny.storageZone || !env.bunny.storagePassword) {
      throw HttpError.badRequest("Bunny storage is not configured");
    }

    const safePath = cleanPath(path);
    const url = `https://${env.bunny.storageRegion}.storage.bunnycdn.com/${env.bunny.storageZone}/${safePath}`;

    const bunnyResponse = await fetch(url, {
      method: "PUT",
      headers: {
        AccessKey: env.bunny.storagePassword,
        "Content-Type": file.mimetype || "application/octet-stream",
      },
      body: file.buffer,
    });

    if (!bunnyResponse.ok) {
      const text = await bunnyResponse.text().catch(() => "");
      throw new HttpError(
        bunnyResponse.status,
        `Bunny upload failed: ${bunnyResponse.statusText}`,
        text || undefined,
      );
    }

    res.json({ success: true, path: safePath, message: "Upload successful" });
  }),
);

const signedUrlSchema = z.object({
  filePath: z.string().min(1),
  materialId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
});

// POST /bunny/signed-url
router.post(
  "/signed-url",
  requireAuth,
  validate(signedUrlSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { filePath, courseId } = signedUrlSchema.parse(req.body);

    if (!env.bunny.pullZone || !env.bunny.securityKey) {
      throw HttpError.badRequest("Bunny pull zone is not configured");
    }

    if (req.user!.role !== "admin" && courseId) {
      const enrollment = await query(
        `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2 LIMIT 1`,
        [req.user!.sub, courseId],
      );
      if (enrollment.rowCount === 0) {
        throw HttpError.forbidden("Not enrolled in this course");
      }
    }

    const safePath = cleanPath(filePath);
    const expires = Math.floor(Date.now() / 1000) + 300;
    const token = crypto
      .createHash("md5")
      .update(env.bunny.securityKey + safePath + expires)
      .digest("hex");

    const pullZone = env.bunny.pullZone.replace(/\/$/, "");
    const url = `${pullZone}/${safePath}?token=${token}&expires=${expires}`;

    res.json({ url });
  }),
);

export default router;
