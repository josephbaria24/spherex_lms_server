import { Router, type Request, type Response } from "express";
import { z } from "zod";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
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
import {
  certificateTemplateDir,
  certificateTemplatePublicPath,
  clearCertificateTemplateImages,
  loadCertificateTemplate,
  saveCertificateTemplate,
  saveCertificateTemplateSchema,
  setCertificateTemplateImage,
} from "../../lib/certificate-template.js";
import { extensionForMime, ORG_LOGO_MIME_TYPES } from "../../lib/org-uploads.js";
import fs from "node:fs";

const createSchema = z.object({
  user_id: z.string().uuid(),
  course_id: z.string().uuid().optional(),
  certificate_url: z.string().url().optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const courseIdParam = z.object({ courseId: z.string().uuid() });
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

const templateImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ORG_LOGO_MIME_TYPES.has(file.mimetype) || file.mimetype === "image/svg+xml" || file.mimetype === "image/gif") {
      cb(new Error("Upload a PNG, JPG, or WebP certificate background"));
      return;
    }
    cb(null, true);
  },
});

// GET /certificates/templates/:courseId
router.get(
  "/templates/:courseId",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const course = await query<{ id: string; title: string }>(
      `SELECT id, title FROM courses WHERE id = $1`,
      [courseId],
    );
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
    const template = await loadCertificateTemplate(courseId);
    res.json({ course: course.rows[0], template });
  }),
);

// PUT /certificates/templates/:courseId
router.put(
  "/templates/:courseId",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  validate(saveCertificateTemplateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const course = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
    const body = saveCertificateTemplateSchema.parse(req.body);
    const template = await saveCertificateTemplate(courseId, body);
    res.json({ template });
  }),
);

// POST /certificates/templates/:courseId/image
router.post(
  "/templates/:courseId/image",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  (req: Request, res: Response, next) => {
    templateImageUpload.single("image")(req, res, (err: unknown) => {
      if (err) {
        next(HttpError.badRequest(err instanceof Error ? err.message : "Upload failed"));
        return;
      }
      next();
    });
  },
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const course = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
    const file = req.file;
    if (!file) throw HttpError.badRequest("Choose a background image");
    const ext = extensionForMime(file.mimetype);
    const filename = `background${ext}`;
    clearCertificateTemplateImages(courseId);
    const dir = certificateTemplateDir(courseId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, filename), file.buffer);
    const imagePath = certificateTemplatePublicPath(courseId, filename);
    await setCertificateTemplateImage(courseId, imagePath);
    res.json({ image_path: imagePath });
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
    const template = data.course_id ? await loadCertificateTemplate(data.course_id) : null;

    const pdf = await buildCertificatePdfBuffer(data, template);
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
