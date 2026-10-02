import { Router, type Request, type Response } from "express";
import { z } from "zod";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { createNotification } from "../../lib/notifications.js";
import {
  buildCertificatePdfBuffer,
  certificatePhotoPublicPath,
  initCertificatePhotoUploadsDirectory,
  issueCertificateIfNeeded,
  loadCertificatePdfData,
} from "../../lib/certificates.js";

const createSchema = z.object({
  user_id: z.string().uuid(),
  course_id: z.string().uuid().optional(),
  certificate_url: z.string().url().optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  user_id: z.string().uuid().optional(),
});

const photoDir = initCertificatePhotoUploadsDirectory();

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, photoDir),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase() || ".jpg";
      const safe = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
      cb(null, `${randomUUID()}${safe}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed for the 2x2 photo"));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

// GET /certificates  (?user_id=)
router.get(
  "/",
  requireAuth,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const targetUserId = filters.user_id ?? req.user!.sub;
    if (targetUserId !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }
    const result = await query(
      `SELECT id, user_id, course_id, certificate_url, serial_number, issued_at
         FROM certificates
        WHERE user_id = $1
        ORDER BY issued_at DESC`,
      [targetUserId],
    );
    res.json({ certificates: result.rows });
  }),
);

// POST /certificates/photo — upload 2x2 ID photo for certificate PDFs
router.post(
  "/photo",
  requireAuth,
  (req, res, next) => {
    photoUpload.single("photo")(req, res, (err) => {
      if (err) {
        next(HttpError.badRequest(err instanceof Error ? err.message : "Upload failed"));
        return;
      }
      next();
    });
  },
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw HttpError.badRequest("Photo file is required");
    const path = certificatePhotoPublicPath(req.file.filename);
    await query(`UPDATE users SET certificate_photo_path = $1 WHERE id = $2`, [
      path,
      req.user!.sub,
    ]);
    res.json({ certificate_photo_path: path });
  }),
);

// GET /certificates/photo — current user's photo path
router.get(
  "/photo",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await query<{ certificate_photo_path: string | null }>(
      `SELECT certificate_photo_path FROM users WHERE id = $1`,
      [req.user!.sub],
    );
    res.json({
      certificate_photo_path: result.rows[0]?.certificate_photo_path ?? null,
    });
  }),
);

// GET /certificates/:id/pdf — download PDF
router.get(
  "/:id/pdf",
  requireAuth,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const owner = await query<{ user_id: string }>(
      `SELECT user_id FROM certificates WHERE id = $1`,
      [id],
    );
    const row = owner.rows[0];
    if (!row) throw HttpError.notFound("Certificate not found");
    if (row.user_id !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }

    const data = await loadCertificatePdfData(id);
    if (!data) throw HttpError.notFound("Certificate not found");

    const pdf = await buildCertificatePdfBuffer(data);
    const filename = `${data.serial_number ?? id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  }),
);

// POST /certificates  (admin)
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);

    if (body.course_id) {
      const issued = await issueCertificateIfNeeded(body.user_id, body.course_id);
      if (issued) {
        if (body.certificate_url) {
          await query(`UPDATE certificates SET certificate_url = $1 WHERE id = $2`, [
            body.certificate_url,
            issued.id,
          ]);
          issued.certificate_url = body.certificate_url;
        }
        res.status(issued.created ? 201 : 200).json({ certificate: issued });
        return;
      }
    }

    const result = await query(
      `INSERT INTO certificates (user_id, course_id, certificate_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [body.user_id, body.course_id ?? null, body.certificate_url ?? null],
    );

    let courseTitle = "a course";
    if (body.course_id) {
      const course = await query<{ title: string }>(
        `SELECT title FROM courses WHERE id = $1`,
        [body.course_id],
      );
      if (course.rows[0]?.title) courseTitle = course.rows[0].title;
    }

    await createNotification({
      userId: body.user_id,
      type: "certificate.issued",
      title: "Certificate issued",
      body: `You earned a certificate for "${courseTitle}".`,
      link: "/achievements",
      referenceId: result.rows[0]!.id,
    });

    res.status(201).json({ certificate: result.rows[0] });
  }),
);

// DELETE /certificates/:id  (admin)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM certificates WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Certificate not found");
    res.json({ ok: true });
  }),
);

export default router;
