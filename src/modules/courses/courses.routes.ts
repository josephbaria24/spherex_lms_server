import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { isAdmin } from "../../lib/roles.js";
import { assertOrgAccessForCourse } from "../../lib/org-course-access.js";
import { COURSE_CARD_THEMES } from "../../lib/course-card-themes.js";
import { courseCoverPublicPath } from "../../lib/course-uploads.js";
import { handleCourseCoverUpload } from "../../middleware/course-cover-upload.js";
import { assertUserPassword } from "../../lib/assert-user-password.js";
import { ensureUniqueEnrollCode } from "../../lib/course-enrollment.js";

const storedAssetSchema = z.string().url().optional().or(z.literal(""));

const courseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  category: z.string().optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  duration: z.string().optional(),
  lessons: z.number().int().nonnegative().optional(),
  thumbnail: storedAssetSchema,
  image: storedAssetSchema,
  card_theme: z.enum(COURSE_CARD_THEMES).optional(),
  require_sequential_lessons: z.boolean().optional(),
  organization_id: z.string().uuid(),
  price_cents: z.number().int().min(0).optional(),
  enroll_code: z.string().min(4).max(32).nullable().optional(),
});

const courseUpdateSchema = courseSchema.omit({ organization_id: true }).partial().extend({
  organization_id: z.string().uuid().optional(),
});
const deleteCourseSchema = z.object({
  password: z.string().min(1).max(128),
});
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  category: z.string().optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  search: z.string().optional(),
  organization_id: z.string().uuid().optional(),
  unassigned: z.enum(["true", "false"]).optional(),
});

const router = Router();

// GET /courses  (any authenticated user)
router.get(
  "/",
  requireAuth,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [req.user!.sub];
    let i = 2;

    if (filters.category) {
      where.push(`c.category = $${i++}`);
      values.push(filters.category);
    }
    if (filters.level) {
      where.push(`c.level = $${i++}`);
      values.push(filters.level);
    }
    if (filters.search) {
      where.push(`(c.title ILIKE $${i} OR c.description ILIKE $${i})`);
      values.push(`%${filters.search}%`);
      i++;
    }
    if (filters.organization_id) {
      where.push(`c.organization_id = $${i++}`);
      values.push(filters.organization_id);
    }
    if (filters.unassigned === "true") {
      where.push(`c.organization_id IS NULL`);
    }

    const sql = `
      SELECT c.id, c.title, c.description, c.category, c.level, c.duration,
             c.enrolled_count, c.lessons, c.thumbnail, c.image, c.card_theme, c.organization_id,
             c.require_sequential_lessons,
             COALESCE(c.price_cents, 0) AS price_cents,
             (c.enroll_code IS NOT NULL AND btrim(c.enroll_code) <> '') AS requires_enroll_code,
             o.name AS organization_name,
             o.slug AS organization_slug,
             (SELECT COUNT(*)::int FROM lessons l WHERE l.course_id = c.id) AS lesson_count,
             EXISTS (
               SELECT 1 FROM enrollments e
                WHERE e.course_id = c.id AND e.user_id = $1
             ) AS is_enrolled,
             c.created_at, c.updated_at
        FROM courses c
        LEFT JOIN organizations o ON o.id = c.organization_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY c.created_at DESC`;

    const result = await query(sql, values);
    res.json({ courses: result.rows });
  }),
);

// GET /courses/:id
router.get(
  "/:id",
  requireAuth,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query(
      `SELECT c.id, c.title, c.description, c.category, c.level, c.duration,
             c.enrolled_count, c.lessons, c.thumbnail, c.image, c.card_theme, c.organization_id,
             c.require_sequential_lessons,
             COALESCE(c.price_cents, 0) AS price_cents,
             c.enroll_code,
             (c.enroll_code IS NOT NULL AND btrim(c.enroll_code) <> '') AS requires_enroll_code,
              o.name AS organization_name,
              o.slug AS organization_slug,
              (SELECT COUNT(*)::int FROM lessons l WHERE l.course_id = c.id) AS lesson_count,
              c.created_at, c.updated_at
         FROM courses c
         LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE c.id = $1`,
      [id],
    );
    const course = result.rows[0];
    if (!course) throw HttpError.notFound("Course not found");

    if (!isAdmin(req.user!.role)) {
      await assertOrgAccessForCourse(req.user!.sub, id, req.user!.role);
    }

    res.json({ course });
  }),
);

// POST /courses  (admin)
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(courseSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = courseSchema.parse(req.body);

    const org = await query("SELECT id FROM organizations WHERE id = $1", [body.organization_id]);
    if (!org.rows[0]) throw HttpError.badRequest("Organization not found");

    const result = await query(
      `INSERT INTO courses (title, description, category, level, duration, lessons, thumbnail, image, card_theme, organization_id, price_cents, enroll_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        body.title,
        body.description ?? null,
        body.category ?? null,
        body.level ?? null,
        body.duration ?? null,
        body.lessons ?? 0,
        body.thumbnail || null,
        body.image || null,
        body.card_theme ?? "sage",
        body.organization_id,
        body.price_cents ?? 0,
        body.enroll_code?.trim().toUpperCase() ?? null,
      ],
    );
    res.status(201).json({ course: result.rows[0] });
  }),
);

// PATCH /courses/:id  (admin)
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(courseUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = courseUpdateSchema.parse(req.body);

    if (body.organization_id) {
      const org = await query("SELECT id FROM organizations WHERE id = $1", [body.organization_id]);
      if (!org.rows[0]) throw HttpError.badRequest("Organization not found");
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "enroll_code") {
        fields.push(`${k} = $${i++}`);
        values.push(v === null || v === "" ? null : String(v).trim().toUpperCase());
        continue;
      }
      fields.push(`${k} = $${i++}`);
      values.push(v === "" ? null : v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);
    const result = await query(
      `UPDATE courses SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    const course = result.rows[0];
    if (!course) throw HttpError.notFound("Course not found");
    res.json({ course });
  }),
);

// POST /courses/:id/regenerate-enroll-code (admin)
router.post(
  "/:id/regenerate-enroll-code",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const exists = await query("SELECT id FROM courses WHERE id = $1", [id]);
    if (!exists.rows[0]) throw HttpError.notFound("Course not found");

    const enroll_code = await ensureUniqueEnrollCode(id);
    const updated = await query(
      "UPDATE courses SET enroll_code = $1 WHERE id = $2 RETURNING enroll_code",
      [enroll_code, id],
    );
    res.json({ enroll_code: updated.rows[0]?.enroll_code });
  }),
);

// POST /courses/:id/cover  (admin) — upload card background image
router.post(
  "/:id/cover",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response, next) => {
    const { id } = idParam.parse(req.params);
    const exists = await query("SELECT id FROM courses WHERE id = $1", [id]);
    if (!exists.rows[0]) throw HttpError.notFound("Course not found");

    handleCourseCoverUpload(id)(req, res, async (err) => {
      if (err) return next(err);
      try {
        const image = courseCoverPublicPath(id, req.file!.filename);
        const updated = await query(
          "UPDATE courses SET image = $1 WHERE id = $2 RETURNING image",
          [image, id],
        );
        res.json({ image: updated.rows[0]?.image });
      } catch (e) {
        next(e);
      }
    });
  }),
);

// DELETE /courses/:id  (admin) — requires account password
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(deleteCourseSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const { password } = deleteCourseSchema.parse(req.body);

    await assertUserPassword(req.user!.sub, password);

    const result = await query("DELETE FROM courses WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Course not found");
    res.json({ ok: true });
  }),
);

export default router;
