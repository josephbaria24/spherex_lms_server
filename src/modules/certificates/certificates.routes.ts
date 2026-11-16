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
import { lookupCertificateBySerial } from "../../lib/ielts-certificate.js";
import {
  certificateTemplateDir,
  certificateTemplatePublicPath,
  clearCertificateTemplateImages,
  certificateTemplateIsReady,
  loadCertificateTemplate,
  saveCertificateTemplate,
  saveCertificateTemplateSchema,
  setCertificateTemplateImage,
} from "../../lib/certificate-template.js";
import { extensionForMime, ORG_LOGO_MIME_TYPES } from "../../lib/org-uploads.js";
import {
  ensureCertificateRegistryTables,
  getSerialSettings,
  importLegacyCertificateCsv,
  listAdminCertificateCourses,
  searchCertificateRegistry,
  updateRegistrySerial,
  upsertSerialSettings,
} from "../../lib/certificate-registry.js";
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

const registryQuery = z.object({
  search: z.string().optional(),
  source: z.enum(["lms", "legacy", "ielts", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const serialSettingsSchema = z.object({
  prefix: z.string().min(2).max(40),
  digits: z.number().int().min(3).max(12),
  next_number: z.number().int().min(1).max(999999999),
});

const registryIdParam = z.object({ id: z.string().uuid() });
const registrySerialBody = z.object({
  serial_number: z
    .string()
    .trim()
    .min(6)
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, "Serial may only contain letters, numbers, and hyphens"),
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

const serialParam = z.object({
  serial: z
    .string()
    .trim()
    .min(6)
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/),
});

// GET /certificates/verify/:serial — public lookup
router.get(
  "/verify/:serial",
  validate(serialParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { serial } = serialParam.parse(req.params);
    const certificate = await lookupCertificateBySerial(serial);
    if (!certificate) throw HttpError.notFound("No certificate matches that serial number.");
    res.json({ certificate });
  }),
);

// GET /certificates/registry — public lookup only when searching (privacy)
router.get(
  "/registry",
  validate(registryQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = registryQuery.parse(req.query);
    const search = filters.search?.trim() ?? "";
    if (search.length < 2) {
      res.json({ certificates: [], requires_search: true });
      return;
    }
    await ensureCertificateRegistryTables();
    const rows = await searchCertificateRegistry({
      search,
      source: filters.source ?? "all",
      limit: Math.min(50, filters.limit ?? 50),
    });
    res.json({
      certificates: rows.map((row) => ({
        serial_number: row.serial_number,
        course_title: row.course_title,
        learner_name: row.learner_name,
        issued_at: row.issued_at,
        source: row.source,
        // email hidden on public tracker
      })),
    });
  }),
);

// GET /certificates/admin/overview — admin hub
router.get(
  "/admin/overview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const data = await listAdminCertificateCourses();
    res.json(data);
  }),
);

// GET /certificates/admin/registry — admin full registry (includes email)
router.get(
  "/admin/registry",
  requireAuth,
  requireAdmin,
  validate(registryQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = registryQuery.parse(req.query);
    const rows = await searchCertificateRegistry({
      search: filters.search,
      source: filters.source ?? "all",
      limit: filters.limit ?? 200,
    });
    res.json({ certificates: rows });
  }),
);

// GET /certificates/admin/serial/:courseId
router.get(
  "/admin/serial/:courseId",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const settings = await getSerialSettings(courseId);
    res.json({ settings });
  }),
);

// PUT /certificates/admin/serial/:courseId
router.put(
  "/admin/serial/:courseId",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  validate(serialSettingsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const body = serialSettingsSchema.parse(req.body);
    const course = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
    const settings = await upsertSerialSettings({
      course_id: courseId,
      prefix: body.prefix,
      digits: body.digits,
      next_number: body.next_number,
    });
    res.json({
      settings,
      sample: `${settings.prefix}-${String(settings.next_number).padStart(settings.digits, "0")}`,
    });
  }),
);

// PUT /certificates/admin/registry/:id/serial — edit a finished learner's serial
router.put(
  "/admin/registry/:id/serial",
  requireAuth,
  requireAdmin,
  validate(registryIdParam, "params"),
  validate(registrySerialBody),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = registryIdParam.parse(req.params);
    const body = registrySerialBody.parse(req.body);
    try {
      const entry = await updateRegistrySerial({
        registryId: id,
        serial_number: body.serial_number,
      });
      res.json({ certificate: entry });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not update serial";
      if (/not found/i.test(message)) throw HttpError.notFound(message);
      if (/already/i.test(message)) throw HttpError.conflict(message);
      if (/must be|may only/i.test(message)) throw HttpError.badRequest(message);
      throw err;
    }
  }),
);

// POST /certificates/admin/import-legacy — import PSI-ELA CSV into registry
router.post(
  "/admin/import-legacy",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await importLegacyCertificateCsv();
    res.json(result);
  }),
);

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
  // High-res print artwork (e.g. A4/Letter @ 300 DPI) can exceed 8 MB — store bytes as-is.
  limits: { fileSize: 50 * 1024 * 1024 },
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
    // Keep original format and bytes — do not re-encode or resize (preserves print resolution).
    const ext = extensionForMime(file.mimetype);
    const filename = `background${ext}`;
    clearCertificateTemplateImages(courseId);
    const dir = certificateTemplateDir(courseId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, filename), file.buffer, { flag: "w" });
    const imagePath = certificateTemplatePublicPath(courseId, filename);
    await setCertificateTemplateImage(courseId, imagePath);
    res.json({
      image_path: imagePath,
      bytes: file.buffer.byteLength,
      mime: file.mimetype,
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
    const template = data.course_id ? await loadCertificateTemplate(data.course_id) : null;
    if (!certificateTemplateIsReady(template)) {
      throw HttpError.badRequest(
        "This course does not have a certificate design yet. Your completion is saved. Contact support and we will send your certificate once the design is ready.",
      );
    }

    const pdf = await buildCertificatePdfBuffer(data, template);
    const filename = `${data.serial_number ?? id}.pdf`;
    const inline = String(req.query.view ?? "") === "1" || String(req.query.inline ?? "") === "1";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    );
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
