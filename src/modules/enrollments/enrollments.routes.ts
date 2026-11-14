import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { requireVerifiedEmail } from "../../middleware/require-email-verified.js";
import { validate } from "../../middleware/validate.js";
import { isAdmin } from "../../lib/roles.js";
import {
  assertCanEnrollInCourse,
  getCourseEnrollmentPolicy,
  recordEnrollCodeUse,
} from "../../lib/course-enrollment.js";
import { ensureCertificateTemplatesTable } from "../../lib/certificate-template.js";
import { ensureQuizAttemptCyclesTable } from "../../lib/quiz-attempt-policy.js";
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

const redeemCodeSchema = z.object({
  code: z.string().min(4).max(32),
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
    await ensureCertificateTemplatesTable();

    const certificateReady = `EXISTS (
              SELECT 1 FROM certificate_templates ct
               WHERE ct.course_id = e.course_id
                 AND (
                   COALESCE(ct.image_path, '') <> ''
                   OR jsonb_array_length(COALESCE(ct.fields, '[]'::jsonb)) > 0
                 )
            ) AS certificate_ready`;
    const sql = includeCourse
      ? `SELECT e.id, e.user_id, e.course_id, e.progress_percent, e.completed,
                e.completed_at, e.created_at, e.updated_at,
                ${certificateReady},
                row_to_json(c) AS course
           FROM enrollments e
           LEFT JOIN courses c ON c.id = e.course_id
           WHERE ${where.join(" AND ")}
           ORDER BY e.created_at DESC`
      : `SELECT e.id, e.user_id, e.course_id, e.progress_percent, e.completed,
                e.completed_at, e.created_at, e.updated_at,
                ${certificateReady}
           FROM enrollments e
           WHERE ${where.join(" AND ")}
           ORDER BY e.created_at DESC`;

    const result = await query<{
      id: string;
      user_id: string;
      course_id: string;
      completed: boolean;
      certificate_ready: boolean;
    }>(sql, values);
    if (filters.completed === "true") {
      const { notifyAdminsMissingCertificate } = await import("../../lib/certificates.js");
      for (const row of result.rows) {
        if (!row.completed || row.certificate_ready) continue;
        notifyAdminsMissingCertificate(row.user_id, row.course_id, row.id).catch(() => {});
      }
    }
    res.json({ enrollments: result.rows });
  }),
);

// POST /enrollments
router.post(
  "/",
  requireAuth,
  requireVerifiedEmail,
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
      if (enroll_code) {
        await recordEnrollCodeUse(course_id, enroll_code);
      }
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

// POST /enrollments/redeem-code — enroll via course access / enrollment code
router.post(
  "/redeem-code",
  requireAuth,
  requireVerifiedEmail,
  validate(redeemCodeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = redeemCodeSchema.parse(req.body);
    const normalized = code.trim().toUpperCase();
    const targetUserId = req.user!.sub;

    const courseResult = await query<{
      id: string;
      title: string;
      organization_id: string | null;
      price_cents: number;
      enroll_code: string | null;
      enroll_code_max_uses: number | null;
      enroll_code_uses: number;
      enroll_code_expires_at: string | null;
    }>(
      `SELECT id, title, organization_id, COALESCE(price_cents, 0) AS price_cents, enroll_code,
              enroll_code_max_uses,
              COALESCE(enroll_code_uses, 0) AS enroll_code_uses,
              enroll_code_expires_at
         FROM courses
        WHERE enroll_code IS NOT NULL
          AND btrim(enroll_code) <> ''
          AND upper(enroll_code) = $1
        LIMIT 1`,
      [normalized],
    );
    const course = courseResult.rows[0];
    if (!course) throw HttpError.notFound("Invalid course code");

    if (!isAdmin(req.user!.role)) {
      await assertCanEnrollInCourse(
        targetUserId,
        {
          id: course.id,
          organization_id: course.organization_id,
          price_cents: course.price_cents,
          enroll_code: course.enroll_code,
          enroll_code_max_uses: course.enroll_code_max_uses,
          enroll_code_uses: course.enroll_code_uses,
          enroll_code_expires_at: course.enroll_code_expires_at,
        },
        req.user!.role,
        { enroll_code: normalized },
      );
    }

    const enrollment = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO enrollments (user_id, course_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, course_id) DO NOTHING
         RETURNING *`,
        [targetUserId, course.id],
      );

      if (result.rowCount === 0) {
        const existing = await client.query(
          "SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2",
          [targetUserId, course.id],
        );
        return { enrollment: existing.rows[0], created: false as const };
      }

      await client.query(
        `UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = $1`,
        [course.id],
      );
      return { enrollment: result.rows[0], created: true as const };
    });

    if (enrollment.created) {
      await recordEnrollCodeUse(course.id, normalized);
      await createNotification({
        userId: targetUserId,
        type: "enrollment.created",
        title: "You're enrolled",
        body: `You are now enrolled in "${course.title}".`,
        link: `/courses/${course.id}/learn`,
        referenceId: enrollment.enrollment.id,
      });

      const instructorIds = await listCourseInstructorIds(course.id);
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
          body: `${studentLabel} enrolled in "${course.title}" with an access code.`,
          link: "/teacher",
          referenceId: enrollment.enrollment.id,
        },
      );
    }

    res.status(enrollment.created ? 201 : 200).json({
      kind: "course",
      created: enrollment.created,
      enrollment: enrollment.enrollment,
      course: { id: course.id, title: course.title },
    });
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

    const existing = await query<{ user_id: string; completed: boolean }>(
      "SELECT user_id, completed FROM enrollments WHERE id = $1",
      [id],
    );
    const row = existing.rows[0];
    if (!row) throw HttpError.notFound("Enrollment not found");
    if (row.user_id !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }
    const wasCompleted = row.completed;

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

    const result = await query<{
      user_id: string;
      course_id: string;
      completed: boolean;
    }>(
      `UPDATE enrollments SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    const enrollment = result.rows[0]!;

    if (enrollment.completed) {
      try {
        const { issueCertificateIfNeeded, notifyAdminsMissingCertificate } = await import(
          "../../lib/certificates.js"
        );
        await issueCertificateIfNeeded(enrollment.user_id, enrollment.course_id);
        if (!wasCompleted) {
          await notifyAdminsMissingCertificate(enrollment.user_id, enrollment.course_id, id);
          const { notifyStaffCourseCompleted } = await import("../../lib/completion-alerts.js");
          await notifyStaffCourseCompleted(enrollment.user_id, enrollment.course_id);
        }
      } catch {
        // ignore certificate side-effects
      }
    }

    res.json({ enrollment });
  }),
);

const deleteEnrollmentSchema = z.object({
  delete_history: z.boolean().optional(),
});

// DELETE /enrollments/:id  (admin only — optional wipe of course history/progress)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const queryFlag =
      typeof req.query.delete_history === "string"
        ? req.query.delete_history === "true" || req.query.delete_history === "1"
        : undefined;
    const { delete_history: deleteHistoryBody } = deleteEnrollmentSchema.parse(body);
    const deleteHistory = deleteHistoryBody ?? queryFlag ?? false;
    if (deleteHistory) {
      await ensureQuizAttemptCyclesTable();
    }

    const result = await withTransaction(async (client) => {
      const existing = await client.query<{ user_id: string; course_id: string }>(
        "SELECT user_id, course_id FROM enrollments WHERE id = $1",
        [id],
      );
      const row = existing.rows[0];
      if (!row) throw HttpError.notFound("Enrollment not found");

      let deleted = {
        lesson_progress: 0,
        scorm_data: 0,
        quiz_attempts: 0,
        quiz_attempt_cycles: 0,
        certificates: 0,
      };

      if (deleteHistory) {
        const lp = await client.query(
          `DELETE FROM lesson_progress WHERE user_id = $1 AND course_id = $2`,
          [row.user_id, row.course_id],
        );
        const scorm = await client.query(
          `DELETE FROM scorm_data WHERE user_id = $1 AND course_id = $2`,
          [row.user_id, row.course_id],
        );
        const quiz = await client.query(
          `DELETE FROM quiz_attempts qa
             USING quizzes q, lessons l
            WHERE qa.quiz_id = q.id AND q.lesson_id = l.id
              AND l.course_id = $2 AND qa.user_id = $1`,
          [row.user_id, row.course_id],
        );
        const cycles = await client.query(
          `DELETE FROM quiz_attempt_cycles qac
             USING quizzes q, lessons l
            WHERE qac.quiz_id = q.id AND q.lesson_id = l.id
              AND l.course_id = $2 AND qac.user_id = $1`,
          [row.user_id, row.course_id],
        );
        const certs = await client.query(
          `DELETE FROM certificates WHERE user_id = $1 AND course_id = $2`,
          [row.user_id, row.course_id],
        );
        deleted = {
          lesson_progress: lp.rowCount ?? 0,
          scorm_data: scorm.rowCount ?? 0,
          quiz_attempts: quiz.rowCount ?? 0,
          quiz_attempt_cycles: cycles.rowCount ?? 0,
          certificates: certs.rowCount ?? 0,
        };
      }

      await client.query("DELETE FROM enrollments WHERE id = $1", [id]);
      await client.query(
        `UPDATE courses SET enrolled_count = GREATEST(enrolled_count - 1, 0) WHERE id = $1`,
        [row.course_id],
      );

      return {
        user_id: row.user_id,
        course_id: row.course_id,
        delete_history: deleteHistory,
        deleted,
      };
    });

    res.json({ ok: true, ...result });
  }),
);

export default router;
