import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { getUserActivity, resetUserProgress } from "../../lib/user-progress.js";

interface UserListRow {
  id: string;
  email: string;
  full_name: string | null;
  name: string | null;
  role: "admin" | "teacher" | "student" | "user";
  status: "active" | "inactive" | "suspended";
  created_at: Date;
  enrollment_count: string;
}

const router = Router();

const updateUserSchema = z.object({
  full_name: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).optional().nullable(),
  notify_email: z.boolean().optional(),
  notify_training: z.boolean().optional(),
  notify_course_updates: z.boolean().optional(),
  role: z.enum(["admin", "teacher", "student", "user"]).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const progressQuery = z.object({
  course_id: z.string().uuid().optional(),
});

// GET /users/:id/activity  (admin)
router.get(
  "/:id/activity",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const activity = await getUserActivity(id);
    res.json(activity);
  }),
);

// DELETE /users/:id/progress  (admin) — reset lesson/scorm/quiz progress (?course_id=...)
router.delete(
  "/:id/progress",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(progressQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const { course_id: courseId } = progressQuery.parse(req.query);
    const result = await resetUserProgress(id, courseId);
    res.json({ ok: true, ...result });
  }),
);

// GET /users  (admin) — list all users with enrollment count
router.get(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<UserListRow>(
      `SELECT
         u.id, u.email, u.full_name, u.name, u.role, u.status, u.created_at,
         COALESCE(e.cnt, 0)::text AS enrollment_count
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS cnt
         FROM enrollments
         GROUP BY user_id
       ) e ON e.user_id = u.id
       ORDER BY u.created_at DESC`,
    );
    res.json({
      users: result.rows.map((r) => ({
        ...r,
        enrollment_count: Number(r.enrollment_count),
      })),
    });
  }),
);

// GET /users/:id  (self or admin)
router.get(
  "/:id",
  requireAuth,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    if (req.user!.sub !== id && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }
    const result = await query(
      `SELECT id, email, full_name, name, role, status, phone,
              notify_email, notify_training, notify_course_updates, created_at
         FROM users WHERE id = $1`,
      [id],
    );
    const user = result.rows[0];
    if (!user) throw HttpError.notFound("User not found");
    res.json({ user });
  }),
);

// PATCH /users/:id  (self for profile fields, admin for role/status)
router.patch(
  "/:id",
  requireAuth,
  validate(idParam, "params"),
  validate(updateUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateUserSchema.parse(req.body);

    const isSelf = req.user!.sub === id;
    const isAdmin = req.user!.role === "admin";
    if (!isSelf && !isAdmin) throw HttpError.forbidden();

    if ((body.role || body.status) && !isAdmin) {
      throw HttpError.forbidden("Only admins can change role or status");
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      if (k === "phone" && v === "") {
        values.push(null);
      } else {
        values.push(v);
      }
    }
    if (fields.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }
    values.push(id);

    const result = await query(
      `UPDATE users SET ${fields.join(", ")}, updated_at = now()
         WHERE id = $${i}
         RETURNING id, email, full_name, name, role, status, phone,
                   notify_email, notify_training, notify_course_updates, created_at`,
      values,
    );
    const user = result.rows[0];
    if (!user) throw HttpError.notFound("User not found");
    res.json({ user });
  }),
);

// DELETE /users/:id  (admin)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM users WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("User not found");
    res.json({ ok: true });
  }),
);

export default router;
