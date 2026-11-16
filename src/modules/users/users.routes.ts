import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  forceCompleteLessons,
  getUserActivity,
  getUserCourseLessonOutline,
  resetUserProgress,
} from "../../lib/user-progress.js";
import {
  getPresenceSupport,
  isUserOnline,
  touchUserPresence,
} from "../../lib/user-presence.js";
import { hashPassword } from "../../utils/password.js";
import {
  ensureTeachingFieldColumn,
  normalizeTeachingField,
} from "../../lib/teaching-field.js";

interface UserListRow {
  id: string;
  email: string;
  full_name: string | null;
  name: string | null;
  role: "admin" | "teacher" | "student" | "user";
  status: "active" | "inactive" | "suspended";
  teaching_field: "ielts" | "courses" | null;
  created_at: Date;
  enrollment_count: string;
  last_login_at: Date | null;
  last_seen_at: Date | null;
  active_course_id: string | null;
  active_course_title: string | null;
}

const router = Router();

const ROLES = ["admin", "teacher", "student", "user"] as const;
const STATUSES = ["active", "inactive", "suspended"] as const;

const updateUserSchema = z.object({
  full_name: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).optional().nullable(),
  notify_email: z.boolean().optional(),
  notify_training: z.boolean().optional(),
  notify_course_updates: z.boolean().optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(STATUSES).optional(),
  teaching_field: z.enum(["ielts", "courses"]).nullable().optional(),
});

const createUserSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(128),
  full_name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).default("student"),
  status: z.enum(STATUSES).default("active"),
  teaching_field: z.enum(["ielts", "courses"]).optional(),
  must_change_password: z.boolean().optional(),
});

const setPasswordSchema = z.object({
  password: z.string().min(8).max(128),
  must_change_password: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const progressQuery = z.object({
  course_id: z.string().uuid().optional(),
});

const courseIdParam = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
});

const forceCompleteSchema = z.object({
  course_id: z.string().uuid(),
  lesson_ids: z.array(z.string().uuid()).min(1).max(200),
  include_prior: z.boolean().optional(),
});

const presenceSchema = z.object({
  course_id: z.string().uuid().nullable().optional(),
  clear_course: z.boolean().optional(),
});

// POST /users/presence — heartbeat (online + optional active course)
router.post(
  "/presence",
  requireAuth,
  validate(presenceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = presenceSchema.parse(req.body ?? {});
    await touchUserPresence(req.user!.sub, {
      courseId: body.course_id ?? undefined,
      clearCourse: body.clear_course === true || body.course_id === null,
    });
    res.json({ ok: true });
  }),
);

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

// GET /users/:id/courses/:courseId/lessons — outline + completion for progress adjuster
router.get(
  "/:id/courses/:courseId/lessons",
  requireAuth,
  requireAdmin,
  validate(courseIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, courseId } = courseIdParam.parse(req.params);
    const outline = await getUserCourseLessonOutline(id, courseId);
    res.json(outline);
  }),
);

// POST /users/:id/progress/complete — force-complete lessons/modules for unlock + %
router.post(
  "/:id/progress/complete",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(forceCompleteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = forceCompleteSchema.parse(req.body);
    const result = await forceCompleteLessons(id, body.course_id, body.lesson_ids, {
      include_prior: body.include_prior,
    });
    res.json({ ok: true, ...result });
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

// POST /users  (admin) — create user with role + password
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await ensureTeachingFieldColumn();
    const body = createUserSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
    if (existing.rows[0]) throw HttpError.conflict("A user with that email already exists");

    const fullName = body.full_name?.trim() || email.split("@")[0] || "User";
    const password_hash = await hashPassword(body.password);
    const mustChange = body.must_change_password !== false;
    const teachingField = normalizeTeachingField(body.role, body.teaching_field);

    const result = await query<{
      id: string;
      email: string;
      full_name: string | null;
      name: string | null;
      role: string;
      status: string;
      teaching_field: string | null;
      created_at: Date;
    }>(
      `INSERT INTO users (
         email, password_hash, full_name, name, role, status,
         email_verified, must_change_password, teaching_field
       )
       VALUES ($1, $2, $3, $3, $4, $5, true, $6, $7)
       RETURNING id, email, full_name, name, role, status, teaching_field, created_at`,
      [email, password_hash, fullName, body.role, body.status, mustChange, teachingField],
    );

    const user = result.rows[0];
    res.status(201).json({
      user: {
        ...user,
        enrollment_count: 0,
        last_login_at: null,
        last_seen_at: null,
        is_online: false,
        active_course: null,
      },
    });
  }),
);

// GET /users  (admin) — list all users with enrollment count + presence
router.get(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    await ensureTeachingFieldColumn();
    const presence = await getPresenceSupport();
    const result = await query<UserListRow>(
      `SELECT
         u.id, u.email, u.full_name, u.name, u.role, u.status, u.teaching_field, u.created_at,
         ${presence.lastLogin ? "u.last_login_at" : "NULL::timestamptz AS last_login_at"},
         ${presence.lastSeen ? "u.last_seen_at" : "NULL::timestamptz AS last_seen_at"},
         ${presence.activeCourse ? "u.active_course_id" : "NULL::uuid AS active_course_id"},
         ${presence.activeCourse ? "c.title" : "NULL::text"} AS active_course_title,
         COALESCE(e.cnt, 0)::text AS enrollment_count
       FROM users u
       ${presence.activeCourse ? "LEFT JOIN courses c ON c.id = u.active_course_id" : ""}
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS cnt
         FROM enrollments
         GROUP BY user_id
       ) e ON e.user_id = u.id
       ORDER BY u.created_at DESC`,
    );
    res.json({
      users: result.rows.map((r) => {
        const online = isUserOnline(r.last_seen_at);
        return {
          id: r.id,
          email: r.email,
          full_name: r.full_name,
          name: r.name,
          role: r.role,
          status: r.status,
          teaching_field:
            r.role === "teacher"
              ? r.teaching_field === "ielts" || r.teaching_field === "courses"
                ? r.teaching_field
                : "courses"
              : null,
          created_at: r.created_at,
          enrollment_count: Number(r.enrollment_count),
          last_login_at: r.last_login_at,
          last_seen_at: r.last_seen_at,
          is_online: online,
          active_course:
            online && r.active_course_id
              ? { id: r.active_course_id, title: r.active_course_title }
              : null,
        };
      }),
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

    if ((body.role || body.status || body.teaching_field !== undefined) && !isAdmin) {
      throw HttpError.forbidden("Only admins can change role, status, or teaching field");
    }

    await ensureTeachingFieldColumn();

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const nextRole = body.role;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "teaching_field") continue;
      fields.push(`${k} = $${i++}`);
      if (k === "phone" && v === "") {
        values.push(null);
      } else {
        values.push(v);
      }
    }
    if (isAdmin && (body.teaching_field !== undefined || nextRole)) {
      const roleForField = nextRole ?? (
        await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id])
      ).rows[0]?.role;
      const teachingField =
        roleForField === "teacher"
          ? normalizeTeachingField(roleForField, body.teaching_field ?? undefined)
          : null;
      fields.push(`teaching_field = $${i++}`);
      values.push(teachingField);
    }
    if (fields.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }
    values.push(id);

    const result = await query(
      `UPDATE users SET ${fields.join(", ")}, updated_at = now()
         WHERE id = $${i}
         RETURNING id, email, full_name, name, role, status, phone, teaching_field,
                   notify_email, notify_training, notify_course_updates, created_at`,
      values,
    );
    const user = result.rows[0];
    if (!user) throw HttpError.notFound("User not found");
    res.json({ user });
  }),
);

// PATCH /users/:id/password  (admin) — set a new password
router.patch(
  "/:id/password",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(setPasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = setPasswordSchema.parse(req.body);
    const password_hash = await hashPassword(body.password);
    const mustChange = body.must_change_password === true;
    const result = await query(
      `UPDATE users
          SET password_hash = $1,
              must_change_password = $2,
              updated_at = now()
        WHERE id = $3
        RETURNING id, email`,
      [password_hash, mustChange, id],
    );
    if (!result.rows[0]) throw HttpError.notFound("User not found");
    res.json({ ok: true, user: result.rows[0] });
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
    if (id === req.user!.sub) {
      throw HttpError.badRequest("You cannot delete your own account");
    }
    const result = await query("DELETE FROM users WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("User not found");
    res.json({ ok: true });
  }),
);

export default router;
