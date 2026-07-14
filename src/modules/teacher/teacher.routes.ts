import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireTeacher } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  assertTeacherCourseAccess,
  assertTeacherEnrollmentAccess,
  assertTeacherOrgAccess,
  getTeacherCourseIds,
} from "./teacher.helpers.js";
import { getQuizByLessonId, upsertLessonQuiz } from "../../lib/quiz-helpers.js";
import { lessonVideoPublicPath } from "../../lib/lesson-uploads.js";
import { handleLessonVideoUpload } from "../../middleware/lesson-video-upload.js";
import { handleScormZipUpload } from "../../middleware/scorm-upload.js";
import { extractScormZip, clearScormPackage } from "../../lib/scorm-uploads.js";
import fs from "node:fs";

const router = Router();
router.use(requireTeacher);

const orgIdParam = z.object({ orgId: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });
const courseIdQuery = z.object({ course_id: z.string().uuid().optional() });

const lessonSchema = z.object({
  course_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  content: z.string().optional(),
  content_type: z.enum(["text", "video", "articulate", "quiz"]).optional(),
  video_url: z.string().optional(),
  articulate_url: z.string().url().optional().or(z.literal("")),
  articulate_launch_mode: z.enum(["story", "scorm"]).optional(),
  sort_order: z.number().int().nonnegative().optional(),
  duration_minutes: z.number().int().positive().optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const lessonUpdateSchema = lessonSchema.omit({ course_id: true }).partial();

const quizQuestionSchema = z.object({
  prompt: z.string().min(1),
  question_type: z.enum(["multiple_choice", "true_false"]),
  options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  correct_option_id: z.string(),
  sort_order: z.number().int().nonnegative().optional(),
});

const quizUpsertSchema = z.object({
  title: z.string().min(1).max(200),
  passing_score: z.number().int().min(0).max(100).optional(),
  questions: z.array(quizQuestionSchema).min(1),
});

const courseSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  category: z.string().optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  duration: z.string().optional(),
});

const evaluationSchema = z.object({
  enrollment_id: z.string().uuid(),
  score: z.number().int().min(0).max(100).optional(),
  feedback: z.string().optional(),
  status: z.enum(["pending", "graded", "returned"]).optional(),
});

function getOrgId(req: Request): string {
  return orgIdParam.parse(req.params).orgId;
}

const orgRouter = Router({ mergeParams: true });

orgRouter.use(
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const { orgId } = orgIdParam.parse(req.params);
    await assertTeacherOrgAccess(req, orgId);
    next();
  }),
);

// GET /teacher/:orgId/dashboard
orgRouter.get(
  "/dashboard",
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (courseIds.length === 0) {
      return res.json({
        stats: {
          courses: 0,
          students: 0,
          lessons: 0,
          pending_evaluations: 0,
          upcoming_sessions: 0,
        },
        recent_evaluations: [],
      });
    }

    const placeholders = courseIds.map((_, i) => `$${i + 1}`).join(", ");
    const baseParams = [...courseIds];

    const [students, lessons, pending, sessions, recent] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(DISTINCT user_id)::text AS count FROM enrollments WHERE course_id IN (${placeholders})`,
        baseParams,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM lessons WHERE course_id IN (${placeholders})`,
        baseParams,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM evaluations e
         JOIN enrollments en ON en.id = e.enrollment_id
         WHERE e.status = 'pending' AND en.course_id IN (${placeholders})
         ${req.user!.role === "teacher" ? `AND e.teacher_id = $${courseIds.length + 1}` : ""}`,
        req.user!.role === "teacher" ? [...baseParams, req.user!.sub] : baseParams,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM training_sessions
         WHERE course_id IN (${placeholders}) AND status = 'upcoming' AND scheduled_date > now()`,
        baseParams,
      ),
      query(
        `SELECT e.id, e.score, e.status, e.updated_at,
                u.full_name, u.email, c.title AS course_title
           FROM evaluations e
           JOIN enrollments en ON en.id = e.enrollment_id
           JOIN users u ON u.id = en.user_id
           JOIN courses c ON c.id = en.course_id
          WHERE en.course_id IN (${placeholders})
          ORDER BY e.updated_at DESC LIMIT 5`,
        baseParams,
      ),
    ]);

    res.json({
      stats: {
        courses: courseIds.length,
        students: Number(students.rows[0]?.count ?? 0),
        lessons: Number(lessons.rows[0]?.count ?? 0),
        pending_evaluations: Number(pending.rows[0]?.count ?? 0),
        upcoming_sessions: Number(sessions.rows[0]?.count ?? 0),
      },
      recent_evaluations: recent.rows,
    });
  }),
);

// GET /teacher/:orgId/courses
orgRouter.get(
  "/courses",
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (courseIds.length === 0) return res.json({ courses: [] });

    const placeholders = courseIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = c.id) AS student_count,
              (SELECT COUNT(*)::int FROM lessons l WHERE l.course_id = c.id) AS lesson_count
         FROM courses c
        WHERE c.id IN (${placeholders}) AND c.organization_id = $${courseIds.length + 1}
        ORDER BY c.created_at DESC`,
      [...courseIds, orgId],
    );
    res.json({ courses: result.rows });
  }),
);

// POST /teacher/:orgId/courses
orgRouter.post(
  "/courses",
  validate(courseSchema),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.user!.role !== "teacher" && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }
    const orgId = getOrgId(req);
    const body = courseSchema.parse(req.body);

    const course = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO courses (title, description, category, level, duration, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          body.title,
          body.description ?? null,
          body.category ?? null,
          body.level ?? null,
          body.duration ?? null,
          orgId,
        ],
      );
      const row = inserted.rows[0];
      if (req.user!.role === "teacher") {
        await client.query(
          `INSERT INTO course_instructors (course_id, teacher_id) VALUES ($1, $2)`,
          [row.id, req.user!.sub],
        );
      }
      return row;
    });

    res.status(201).json({ course });
  }),
);

// GET /teacher/:orgId/lessons
orgRouter.get(
  "/lessons",
  validate(courseIdQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { course_id } = courseIdQuery.parse(req.query);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);

    if (course_id) {
      await assertTeacherCourseAccess(req, course_id, orgId);
    }

    const targetIds = course_id ? [course_id] : courseIds;
    if (targetIds.length === 0) return res.json({ lessons: [] });

    const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `SELECT l.*, c.title AS course_title,
              q.passing_score AS quiz_passing_score,
              (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS quiz_question_count
         FROM lessons l
         JOIN courses c ON c.id = l.course_id
         LEFT JOIN quizzes q ON q.lesson_id = l.id
        WHERE l.course_id IN (${placeholders}) AND c.organization_id = $${targetIds.length + 1}
        ORDER BY l.course_id, l.sort_order, l.created_at`,
      [...targetIds, orgId],
    );
    res.json({ lessons: result.rows });
  }),
);

// POST /teacher/:orgId/lessons
orgRouter.post(
  "/lessons",
  validate(lessonSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const body = lessonSchema.parse(req.body);
    await assertTeacherCourseAccess(req, body.course_id, orgId);

    const result = await query(
      `INSERT INTO lessons (course_id, title, description, content, content_type, video_url,
                            articulate_url, articulate_launch_mode, sort_order, duration_minutes, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        body.course_id,
        body.title,
        body.description ?? null,
        body.content ?? null,
        body.content_type ?? "text",
        body.video_url || null,
        body.articulate_url || null,
        body.articulate_launch_mode ?? "story",
        body.sort_order ?? 0,
        body.duration_minutes ?? 30,
        body.status ?? "draft",
        req.user!.sub,
      ],
    );

    await query(
      `UPDATE courses SET lessons = (SELECT COUNT(*)::int FROM lessons WHERE course_id = $1) WHERE id = $1`,
      [body.course_id],
    );

    res.status(201).json({ lesson: result.rows[0] });
  }),
);

// PATCH /teacher/:orgId/lessons/:id
orgRouter.patch(
  "/lessons/:id",
  validate(idParam, "params"),
  validate(lessonUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const existing = await query<{ course_id: string }>(
      "SELECT course_id FROM lessons WHERE id = $1",
      [id],
    );
    const lesson = existing.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    const body = lessonUpdateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v === "" ? null : v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);

    const result = await query(
      `UPDATE lessons SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ lesson: result.rows[0] });
  }),
);

// GET /teacher/:orgId/lessons/:id
orgRouter.get(
  "/lessons/:id",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const result = await query(
      `SELECT l.*, c.title AS course_title
         FROM lessons l
         JOIN courses c ON c.id = l.course_id
        WHERE l.id = $1 AND c.organization_id = $2`,
      [id, orgId],
    );
    const lesson = result.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    const quiz =
      lesson.content_type === "quiz" ? await getQuizByLessonId(id, true) : null;

    res.json({ lesson, quiz });
  }),
);

// PUT /teacher/:orgId/lessons/:id/quiz
orgRouter.put(
  "/lessons/:id/quiz",
  validate(idParam, "params"),
  validate(quizUpsertSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const existing = await query<{ course_id: string; content_type: string }>(
      "SELECT course_id, content_type FROM lessons WHERE id = $1",
      [id],
    );
    const lesson = existing.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    const body = quizUpsertSchema.parse(req.body);
    await upsertLessonQuiz(id, body);

    if (lesson.content_type !== "quiz") {
      await query("UPDATE lessons SET content_type = 'quiz' WHERE id = $1", [id]);
    }

    const quiz = await getQuizByLessonId(id, true);
    res.json({ quiz });
  }),
);

// POST /teacher/:orgId/lessons/:id/video
orgRouter.post(
  "/lessons/:id/video",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const existing = await query<{ course_id: string }>(
      "SELECT course_id FROM lessons WHERE id = $1",
      [id],
    );
    const lesson = existing.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    handleLessonVideoUpload(lesson.course_id, id)(req, res, async (err) => {
      if (err) return next(err);
      try {
        const videoUrl = lessonVideoPublicPath(
          lesson.course_id,
          id,
          req.file!.filename,
        );
        const updated = await query(
          `UPDATE lessons SET video_url = $1, content_type = 'video' WHERE id = $2 RETURNING *`,
          [videoUrl, id],
        );
        res.json({ lesson: updated.rows[0], video_url: videoUrl });
      } catch (e) {
        next(e);
      }
    });
  }),
);

// POST /teacher/:orgId/lessons/:id/scorm — upload Storyline / SCORM zip package
orgRouter.post(
  "/lessons/:id/scorm",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const existing = await query<{ course_id: string }>(
      "SELECT course_id FROM lessons WHERE id = $1",
      [id],
    );
    const lesson = existing.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    handleScormZipUpload()(req, res, async (err) => {
      if (err) return next(err);
      const zipPath = req.file!.path;
      try {
        const { publicUrl, sanitization } = extractScormZip(zipPath, lesson.course_id, id);
        const updated = await query(
          `UPDATE lessons
             SET articulate_url = $1,
                 content_type = 'articulate',
                 articulate_launch_mode = COALESCE(articulate_launch_mode, 'story')
           WHERE id = $2
           RETURNING *`,
          [publicUrl, id],
        );
        res.json({ lesson: updated.rows[0], articulate_url: publicUrl, sanitization });
      } catch (e) {
        clearScormPackage(lesson.course_id, id);
        next(e);
      } finally {
        fs.unlink(zipPath, () => {});
      }
    });
  }),
);

// DELETE /teacher/:orgId/lessons/:id
orgRouter.delete(
  "/lessons/:id",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { id } = idParam.parse(req.params);
    const existing = await query<{ course_id: string }>(
      "SELECT course_id FROM lessons WHERE id = $1",
      [id],
    );
    const lesson = existing.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");
    await assertTeacherCourseAccess(req, lesson.course_id, orgId);

    await query("DELETE FROM lessons WHERE id = $1", [id]);
    await query(
      `UPDATE courses SET lessons = (SELECT COUNT(*)::int FROM lessons WHERE course_id = $1) WHERE id = $1`,
      [lesson.course_id],
    );
    res.json({ ok: true });
  }),
);

// GET /teacher/:orgId/students
orgRouter.get(
  "/students",
  validate(courseIdQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const { course_id } = courseIdQuery.parse(req.query);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (course_id) await assertTeacherCourseAccess(req, course_id, orgId);

    const targetIds = course_id ? [course_id] : courseIds;
    if (targetIds.length === 0) return res.json({ students: [] });

    const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `SELECT en.id AS enrollment_id, en.progress_percent, en.completed, en.created_at AS enrolled_at,
              u.id AS user_id, u.email, u.full_name, u.name,
              c.id AS course_id, c.title AS course_title
         FROM enrollments en
         JOIN users u ON u.id = en.user_id
         JOIN courses c ON c.id = en.course_id
        WHERE en.course_id IN (${placeholders}) AND c.organization_id = $${targetIds.length + 1}
        ORDER BY c.title, u.full_name, u.email`,
      [...targetIds, orgId],
    );
    res.json({ students: result.rows });
  }),
);

// GET /teacher/:orgId/evaluations
orgRouter.get(
  "/evaluations",
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (courseIds.length === 0) return res.json({ evaluations: [] });

    const placeholders = courseIds.map((_, i) => `$${i + 1}`).join(", ");
    const params: unknown[] = [...courseIds];
    let statusClause = "";
    if (status) {
      params.push(status);
      statusClause = `AND e.status = $${params.length}`;
    }

    const teacherClause =
      req.user!.role === "teacher"
        ? `AND e.teacher_id = $${params.length + 1}`
        : "";
    if (req.user!.role === "teacher") params.push(req.user!.sub);

    params.push(orgId);
    const orgParam = `$${params.length}`;

    const result = await query(
      `SELECT e.*, en.progress_percent, en.completed,
              u.full_name, u.name, u.email,
              c.title AS course_title, c.id AS course_id
         FROM evaluations e
         JOIN enrollments en ON en.id = e.enrollment_id
         JOIN users u ON u.id = en.user_id
         JOIN courses c ON c.id = en.course_id
        WHERE en.course_id IN (${placeholders}) AND c.organization_id = ${orgParam}
          ${statusClause} ${teacherClause}
        ORDER BY e.updated_at DESC`,
      params,
    );
    res.json({ evaluations: result.rows });
  }),
);

// POST /teacher/:orgId/evaluations
orgRouter.post(
  "/evaluations",
  validate(evaluationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const body = evaluationSchema.parse(req.body);
    await assertTeacherEnrollmentAccess(req, body.enrollment_id, orgId);

    const result = await query(
      `INSERT INTO evaluations (enrollment_id, teacher_id, score, feedback, status, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'graded' THEN now() ELSE NULL END)
       ON CONFLICT (enrollment_id, teacher_id) DO UPDATE SET
         score = EXCLUDED.score,
         feedback = EXCLUDED.feedback,
         status = EXCLUDED.status,
         evaluated_at = CASE WHEN EXCLUDED.status = 'graded' THEN now() ELSE evaluations.evaluated_at END
       RETURNING *`,
      [
        body.enrollment_id,
        req.user!.sub,
        body.score ?? null,
        body.feedback ?? null,
        body.status ?? (body.score !== undefined ? "graded" : "pending"),
      ],
    );

    if (body.score !== undefined) {
      await query(
        `UPDATE enrollments SET progress_percent = $1 WHERE id = $2`,
        [body.score, body.enrollment_id],
      );
    }

    res.status(201).json({ evaluation: result.rows[0] });
  }),
);

// GET /teacher/:orgId/sessions
orgRouter.get(
  "/sessions",
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (courseIds.length === 0) return res.json({ sessions: [] });

    const placeholders = courseIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `SELECT ts.*, c.title AS course_title
         FROM training_sessions ts
         LEFT JOIN courses c ON c.id = ts.course_id
        WHERE ts.course_id IN (${placeholders}) AND c.organization_id = $${courseIds.length + 1}
        ORDER BY ts.scheduled_date DESC`,
      [...courseIds, orgId],
    );
    res.json({ sessions: result.rows });
  }),
);

// GET /teacher/:orgId/materials
orgRouter.get(
  "/materials",
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = getOrgId(req);
    const courseIds = await getTeacherCourseIds(req.user!.sub, req.user!.role, orgId);
    if (courseIds.length === 0) return res.json({ materials: [] });

    const placeholders = courseIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `SELECT m.*, c.title AS course_title
         FROM materials m
         LEFT JOIN courses c ON c.id = m.course_id
        WHERE m.course_id IN (${placeholders}) AND c.organization_id = $${courseIds.length + 1}
        ORDER BY m.updated_at DESC`,
      [...courseIds, orgId],
    );
    res.json({ materials: result.rows });
  }),
);

router.use("/:orgId", orgRouter);

export default router;
