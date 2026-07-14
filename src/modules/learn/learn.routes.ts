import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { assertLearnAccess } from "../../lib/org-course-access.js";
import {
  applyLessonLocks,
  assertLessonUnlocked,
  LESSON_COMPLETED_CASE,
  LESSON_STARTED_CASE,
} from "../../lib/lesson-access.js";
import {
  getQuizByLessonId,
  markLessonComplete,
  scoreQuiz,
  updateEnrollmentProgress,
} from "../../lib/quiz-helpers.js";
import {
  getScormData,
  resetScormData,
  saveScormCmi,
  scormDataToCmiDefaults,
} from "../../lib/scorm-helpers.js";
import { getLearnDashboard } from "../../lib/learn-dashboard.js";
import { getLearnAchievements } from "../../lib/learn-achievements.js";

const router = Router();
router.use(requireAuth);

// GET /learn/dashboard — learner stats from real progress data
router.get(
  "/dashboard",
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await getLearnDashboard(req.user!.sub);
    res.json(dashboard);
  }),
);

// GET /learn/achievements — progress, certificates, and activity history
router.get(
  "/achievements",
  asyncHandler(async (req: Request, res: Response) => {
    const achievements = await getLearnAchievements(req.user!.sub);
    res.json(achievements);
  }),
);

const courseIdParam = z.object({ courseId: z.string().uuid() });
const lessonParams = z.object({
  courseId: z.string().uuid(),
  lessonId: z.string().uuid(),
});

const quizSubmitSchema = z.object({
  answers: z.record(z.string(), z.string()),
});

const scormCommitSchema = z.object({
  values: z.record(z.string(), z.string()),
});

function rejectPreviewWrites(access: { preview: boolean }) {
  if (access.preview) {
    throw HttpError.badRequest("Preview mode — progress is not saved");
  }
}

// GET /learn/courses/:courseId
router.get(
  "/courses/:courseId",
  validate(courseIdParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId } = courseIdParam.parse(req.params);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);

    const courseResult = await query(
      `SELECT id, title, description, category, level, duration, lessons, enrolled_count,
              COALESCE(require_sequential_lessons, false) AS require_sequential_lessons
         FROM courses WHERE id = $1`,
      [courseId],
    );
    const course = courseResult.rows[0];
    if (!course) throw HttpError.notFound("Course not found");

    const lessons = await query(
      `SELECT l.id, l.title, l.description, l.content_type, l.sort_order, l.duration_minutes, l.status,
              ${LESSON_COMPLETED_CASE} AS completed,
              ${LESSON_STARTED_CASE} AS started
         FROM lessons l
         LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $2
         LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $2
        WHERE l.course_id = $1 AND l.status = 'published'
        ORDER BY l.sort_order, l.created_at`,
      [courseId, req.user!.sub],
    );

    type OutlineLessonRow = {
      id: string;
      title: string;
      description: string | null;
      content_type: string;
      sort_order: number;
      duration_minutes: number;
      status: string;
      completed: boolean;
      started: boolean;
    };

    const lessonRows = access.preview
      ? lessons.rows.map((l) => ({
          ...(l as OutlineLessonRow),
          completed: false,
          started: false,
          locked: false,
        }))
      : applyLessonLocks(lessons.rows as OutlineLessonRow[], true);

    const progress = access.preview
      ? 0
      : (await updateEnrollmentProgress(req.user!.sub, courseId)).progress;

    res.json({
      course,
      lessons: lessonRows,
      progress,
      preview: access.preview,
    });
  }),
);

// GET /learn/courses/:courseId/lessons/:lessonId
router.get(
  "/courses/:courseId/lessons/:lessonId",
  validate(lessonParams, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lessonResult = await query(
      `SELECT id, course_id, title, description, content, content_type, video_url,
              articulate_url, articulate_launch_mode, sort_order, duration_minutes, status
         FROM lessons
        WHERE id = $1 AND course_id = $2 AND status = 'published'`,
      [lessonId, courseId],
    );
    const lesson = lessonResult.rows[0];
    if (!lesson) throw HttpError.notFound("Lesson not found");

    let completed = false;
    if (!access.preview) {
      const progressResult = await query<{ completed: boolean }>(
        `SELECT ${LESSON_COMPLETED_CASE} AS completed
           FROM lessons l
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
           LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $1
          WHERE l.id = $2`,
        [req.user!.sub, lessonId],
      );
      completed = progressResult.rows[0]?.completed === true;
    }

    let quiz = null;
    if (lesson.content_type === "quiz") {
      quiz = await getQuizByLessonId(lessonId, false);
    }

    res.json({
      lesson,
      quiz,
      completed,
      preview: access.preview,
    });
  }),
);

// POST /learn/courses/:courseId/lessons/:lessonId/complete
router.post(
  "/courses/:courseId/lessons/:lessonId/complete",
  validate(lessonParams, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    rejectPreviewWrites(access);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lesson = await query<{ id: string; content_type: string }>(
      "SELECT id, content_type FROM lessons WHERE id = $1 AND course_id = $2 AND status = 'published'",
      [lessonId, courseId],
    );
    if (!lesson.rows[0]) throw HttpError.notFound("Lesson not found");
    if (lesson.rows[0].content_type === "articulate") {
      throw HttpError.badRequest("Complete this lesson in the SCORM player");
    }

    await markLessonComplete(req.user!.sub, lessonId, courseId);
    const progress = await updateEnrollmentProgress(req.user!.sub, courseId);

    res.json({ ok: true, progress });
  }),
);

// POST /learn/courses/:courseId/lessons/:lessonId/quiz/submit
router.post(
  "/courses/:courseId/lessons/:lessonId/quiz/submit",
  validate(lessonParams, "params"),
  validate(quizSubmitSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const { answers } = quizSubmitSchema.parse(req.body);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    rejectPreviewWrites(access);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lesson = await query(
      `SELECT id FROM lessons WHERE id = $1 AND course_id = $2 AND status = 'published' AND content_type = 'quiz'`,
      [lessonId, courseId],
    );
    if (!lesson.rows[0]) throw HttpError.notFound("Quiz lesson not found");

    const quiz = await getQuizByLessonId(lessonId, true);
    if (!quiz) throw HttpError.notFound("Quiz not found");

    const questions = await query<{ id: string; correct_option_id: string }>(
      "SELECT id, correct_option_id FROM quiz_questions WHERE quiz_id = $1",
      [quiz.id],
    );

    const result = scoreQuiz(questions.rows, answers);
    result.passed = result.score >= quiz.passing_score;

    await query(
      `INSERT INTO quiz_attempts (quiz_id, user_id, score, passed, answers)
       VALUES ($1, $2, $3, $4, $5)`,
      [quiz.id, req.user!.sub, result.score, result.passed, JSON.stringify(answers)],
    );

    if (result.passed) {
      await markLessonComplete(req.user!.sub, lessonId, courseId);
    }

    const progress = await updateEnrollmentProgress(req.user!.sub, courseId);

    res.json({
      score: result.score,
      passed: result.passed,
      passing_score: quiz.passing_score,
      correct: result.correct,
      total: result.total,
      progress,
    });
  }),
);

// GET /learn/courses/:courseId/lessons/:lessonId/scorm
router.get(
  "/courses/:courseId/lessons/:lessonId/scorm",
  validate(lessonParams, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lesson = await query(
      `SELECT id FROM lessons
        WHERE id = $1 AND course_id = $2 AND status = 'published' AND content_type = 'articulate'`,
      [lessonId, courseId],
    );
    if (!lesson.rows[0]) throw HttpError.notFound("Articulate lesson not found");

    if (access.preview) {
      return res.json({
        cmi: scormDataToCmiDefaults(null),
        preview: true,
      });
    }

    const row = await getScormData(req.user!.sub, lessonId);
    res.json({
      cmi: scormDataToCmiDefaults(row),
      preview: false,
    });
  }),
);

// POST /learn/courses/:courseId/lessons/:lessonId/scorm/reset — clear saved attempt (start over)
router.post(
  "/courses/:courseId/lessons/:lessonId/scorm/reset",
  validate(lessonParams, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    rejectPreviewWrites(access);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lesson = await query(
      `SELECT id FROM lessons
        WHERE id = $1 AND course_id = $2 AND status = 'published' AND content_type = 'articulate'`,
      [lessonId, courseId],
    );
    if (!lesson.rows[0]) throw HttpError.notFound("Articulate lesson not found");

    await resetScormData(req.user!.sub, lessonId);
    res.json({ ok: true });
  }),
);

// POST /learn/courses/:courseId/lessons/:lessonId/scorm — persist SCORM 1.2 CMI (LMSCommit)
router.post(
  "/courses/:courseId/lessons/:lessonId/scorm",
  validate(lessonParams, "params"),
  validate(scormCommitSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { courseId, lessonId } = lessonParams.parse(req.params);
    const { values } = scormCommitSchema.parse(req.body);
    const access = await assertLearnAccess(req.user!.sub, courseId, req.user!.role);
    rejectPreviewWrites(access);
    await assertLessonUnlocked(req.user!.sub, courseId, lessonId, access.preview);

    const lesson = await query(
      `SELECT id FROM lessons
        WHERE id = $1 AND course_id = $2 AND status = 'published' AND content_type = 'articulate'`,
      [lessonId, courseId],
    );
    if (!lesson.rows[0]) throw HttpError.notFound("Articulate lesson not found");

    const result = await saveScormCmi(req.user!.sub, lessonId, courseId, values);

    res.json({
      ok: true,
      lesson_completed: result.completed,
      progress: result.progress,
    });
  }),
);

export default router;
