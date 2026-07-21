import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { isAdmin } from "../../lib/roles.js";
import {
  assertCanEnrollInCourse,
  getCourseEnrollmentPolicy,
} from "../../lib/course-enrollment.js";
import {
  createNotification,
  listCourseInstructorIds,
  notifyUsers,
} from "../../lib/notifications.js";

const enrollSchema = z.object({
  course_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  enroll_code: z.string().min(4).max(32).optional(),
});

const updateEnrollmentSchema = z.object({
  progress_percent: z.number().int().min(0).max(100).optional(),
  completed: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  user_id: z.string().uuid().optional(),
  completed: z.enum(["true", "false"]).optional(),
  include: z.string().optional(),
});

const router = Router();

// GET /enrollments  (?user_id=... &completed=true&include=course)
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

    const where: string[] = ["e.user_id = $1"];
    const values: unknown[] = [targetUserId];
    let i = 2;
    if (filters.completed === "true") {
      where.push(`e.completed = $${i++}`);
      values.push(true);
    } else if (filters.completed === "false") {
      where.push(`e.completed = $${i++}`);
      values.push(false);
    }

    const includeCourse = filters.include?.includes("course");

    const sql = includeCourse
      ? `SELECT e.id, e.user_id, e.course_id, e.progress_percent, e.completed,
                e.completed_at, e.created_at, e.updated_at,
                row_to_json(c) AS course
           FROM enrollments e
           LEFT JOIN courses c ON c.id = e.course_id
           WHERE ${where.join(" AND ")}
           ORDER BY e.created_at DESC`
      : `SELECT id, user_id, course_id, progress_percent, completed,
                completed_at, created_at, updated_at
           FROM enrollments e
           WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC`;

    const result = await query(sql, values);
    res.json({ enrollments: result.rows });
  }),
);

// POST /enrollments
router.post(
  "/",
  requireAuth,
  validate(enrollSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { course_id, user_id, enroll_code } = enrollSchema.parse(req.body);
    const targetUserId = user_id ?? req.user!.sub;

    if (targetUserId !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }

    const enrollment = await withTransaction(async (client) => {
      const coursePolicy = await getCourseEnrollmentPolicy(course_id);
      if (!coursePolicy) throw HttpError.notFound("Course not found");

      if (!isAdmin(req.user!.role)) {
        await assertCanEnrollInCourse(targetUserId, coursePolicy, req.user!.role, {
          enroll_code,
        });
      }

      const result = await client.query(
        `INSERT INTO enrollments (user_id, course_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, course_id) DO NOTHING
         RETURNING *`,
        [targetUserId, course_id],
      );

      if (result.rowCount === 0) {
        const existing = await client.query(
          "SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2",
          [targetUserId, course_id],
        );
        return { enrollment: existing.rows[0], created: false as const };
      }

      await client.query(
        `UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = $1`,
        [course_id],
      );
      return { enrollment: result.rows[0], created: true as const };
    });

    if (enrollment.created) {
      const course = await query<{ title: string }>(
        `SELECT title FROM courses WHERE id = $1`,
        [course_id],
      );
      const title = course.rows[0]?.title ?? "a course";

      await createNotification({
        userId: targetUserId,
        type: "enrollment.created",
        title: "You're enrolled",
        body: `You are now enrolled in "${title}".`,
        link: "/courses",
        referenceId: enrollment.enrollment.id,
      });

      const instructorIds = await listCourseInstructorIds(course_id);
      const student = await query<{ full_name: string | null; email: string }>(
        `SELECT full_name, email FROM users WHERE id = $1`,
        [targetUserId],
      );
      const studentLabel =
        student.rows[0]?.full_name?.trim() || student.rows[0]?.email || "A learner";

      await notifyUsers(
        instructorIds.filter((id) => id !== targetUserId),
        {
          type: "enrollment.created",
          title: "New student enrolled",
          body: `${studentLabel} enrolled in "${title}".`,
          link: "/teacher",
          referenceId: enrollment.enrollment.id,
        },
      );
    }

    res.status(201).json({ enrollment: enrollment.enrollment });
  }),
);

// PATCH /enrollments/:id
router.patch(
  "/:id",
  requireAuth,
  validate(idParam, "params"),
  validate(updateEnrollmentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateEnrollmentSchema.parse(req.body);

    const existing = await query<{ user_id: string }>(
      "SELECT user_id FROM enrollments WHERE id = $1",
      [id],
    );
    const row = existing.rows[0];
    if (!row) throw HttpError.notFound("Enrollment not found");
    if (row.user_id !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (body.progress_percent !== undefined) {
      fields.push(`progress_percent = $${i++}`);
      values.push(body.progress_percent);
    }
    if (body.completed !== undefined) {
      fields.push(`completed = $${i++}`);
      values.push(body.completed);
      fields.push(`completed_at = $${i++}`);
      values.push(body.completed ? new Date() : null);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);

    const result = await query(
      `UPDATE enrollments SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ enrollment: result.rows[0] });
  }),
);

// DELETE /enrollments/:id  (admin only — users typically can't unenroll themselves silently)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    await withTransaction(async (client) => {
      const existing = await client.query<{ course_id: string }>(
        "SELECT course_id FROM enrollments WHERE id = $1",
        [id],
      );
      const row = existing.rows[0];
      if (!row) throw HttpError.notFound("Enrollment not found");

      await client.query("DELETE FROM enrollments WHERE id = $1", [id]);
      await client.query(
        `UPDATE courses SET enrolled_count = GREATEST(enrolled_count - 1, 0) WHERE id = $1`,
        [row.course_id],
      );
    });
    res.json({ ok: true });
  }),
);

export default router;
