import { query } from "../config/db.js";
import { resetScormData } from "./scorm-helpers.js";
import { updateEnrollmentProgress } from "./quiz-helpers.js";

export const MAX_QUIZ_ATTEMPTS_PER_CYCLE = 2;

export type QuizAttemptState = {
  max_attempts: number;
  attempts_used: number;
  attempts_remaining: number;
  module_retake_required: boolean;
  already_passed: boolean;
};

export type QuizAttemptResult = {
  score: number;
  passed: boolean;
  passing_score: number;
  correct: number;
  total: number;
};

let cyclesTableReady: Promise<void> | null = null;

export async function ensureQuizAttemptCyclesTable(): Promise<void> {
  if (!cyclesTableReady) {
    cyclesTableReady = query(
      `CREATE TABLE IF NOT EXISTS quiz_attempt_cycles (
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
         cycle_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, quiz_id)
       )`,
    ).then(() => undefined);
  }
  await cyclesTableReady;
}

async function getOrCreateCycleStartedAt(userId: string, quizId: string): Promise<string> {
  await ensureQuizAttemptCyclesTable();
  // Anchor a first cycle to existing attempts so a deploy does not wipe prior passes.
  await query(
    `INSERT INTO quiz_attempt_cycles (user_id, quiz_id, cycle_started_at)
     SELECT $1, $2,
            COALESCE(
              (SELECT MIN(created_at) FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2),
              now()
            )
     ON CONFLICT (user_id, quiz_id) DO NOTHING`,
    [userId, quizId],
  );
  const row = await query<{ cycle_started_at: string }>(
    `SELECT cycle_started_at FROM quiz_attempt_cycles WHERE user_id = $1 AND quiz_id = $2`,
    [userId, quizId],
  );
  return row.rows[0]!.cycle_started_at;
}

export async function getQuizAttemptState(
  userId: string,
  quizId: string,
): Promise<QuizAttemptState> {
  const cycleStartedAt = await getOrCreateCycleStartedAt(userId, quizId);
  const stats = await query<{ n: string; passed: string }>(
    `SELECT COUNT(*)::text AS n,
            COALESCE(BOOL_OR(passed), false)::text AS passed
       FROM quiz_attempts
      WHERE user_id = $1
        AND quiz_id = $2
        AND created_at >= $3`,
    [userId, quizId, cycleStartedAt],
  );
  const attemptsUsed = Number(stats.rows[0]?.n ?? 0);
  const passedInCycle = stats.rows[0]?.passed === "true";
  const attemptsRemaining = passedInCycle
    ? 0
    : Math.max(0, MAX_QUIZ_ATTEMPTS_PER_CYCLE - attemptsUsed);
  return {
    max_attempts: MAX_QUIZ_ATTEMPTS_PER_CYCLE,
    attempts_used: attemptsUsed,
    attempts_remaining: attemptsRemaining,
    module_retake_required: attemptsUsed >= MAX_QUIZ_ATTEMPTS_PER_CYCLE && !passedInCycle,
    already_passed: passedInCycle,
  };
}

/** Latest attempt to show after refresh — prefer a pass, else newest fail. */
export async function getLatestQuizAttemptResult(
  userId: string,
  quizId: string,
  passingScore: number,
): Promise<QuizAttemptResult | null> {
  const row = await query<{
    score: number;
    passed: boolean;
  }>(
    `SELECT score, passed
       FROM quiz_attempts
      WHERE user_id = $1 AND quiz_id = $2
      ORDER BY passed DESC, created_at DESC
      LIMIT 1`,
    [userId, quizId],
  );
  const attempt = row.rows[0];
  if (!attempt) return null;

  const questions = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM quiz_questions WHERE quiz_id = $1`,
    [quizId],
  );
  const total = Number(questions.rows[0]?.n ?? 0);
  const correct = total > 0 ? Math.round((attempt.score / 100) * total) : 0;

  return {
    score: attempt.score,
    passed: attempt.passed,
    passing_score: passingScore,
    correct,
    total,
  };
}

/** Lessons the learner must redo before another quiz cycle (content before this quiz). */
export async function resolveModuleRetakeLessonIds(
  courseId: string,
  quizLessonId: string,
): Promise<{ lessonIds: string[]; firstLessonId: string | null }> {
  const quizLesson = await query<{
    id: string;
    parent_lesson_id: string | null;
    sort_order: number;
  }>(
    `SELECT id, parent_lesson_id, sort_order
       FROM lessons
      WHERE id = $1 AND course_id = $2 AND status = 'published'`,
    [quizLessonId, courseId],
  );
  const quiz = quizLesson.rows[0];
  if (!quiz) return { lessonIds: [], firstLessonId: null };

  let rows: { id: string; sort_order: number }[];

  if (quiz.parent_lesson_id) {
    const group = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order
         FROM lessons
        WHERE course_id = $1
          AND status = 'published'
          AND (id = $2 OR parent_lesson_id = $2 OR id = $3)
        ORDER BY sort_order, created_at`,
      [courseId, quiz.parent_lesson_id, quizLessonId],
    );
    rows = group.rows;
  } else {
    const prior = await query<{ id: string; sort_order: number }>(
      `WITH prior_roots AS (
         SELECT id
           FROM lessons
          WHERE course_id = $1
            AND status = 'published'
            AND parent_lesson_id IS NULL
            AND sort_order < $2
       )
       SELECT l.id, l.sort_order
         FROM lessons l
        WHERE l.course_id = $1
          AND l.status = 'published'
          AND (
            l.id IN (SELECT id FROM prior_roots)
            OR l.parent_lesson_id IN (SELECT id FROM prior_roots)
            OR l.id = $3
          )
        ORDER BY l.sort_order, l.created_at`,
      [courseId, quiz.sort_order, quizLessonId],
    );
    rows = prior.rows;
  }

  const lessonIds = rows.map((r) => r.id);
  const firstLessonId = lessonIds.find((id) => id !== quizLessonId) ?? lessonIds[0] ?? null;
  return { lessonIds, firstLessonId };
}

export async function resetModulesForQuizRetake(
  userId: string,
  courseId: string,
  quizLessonId: string,
  quizId: string,
): Promise<{
  progress: Awaited<ReturnType<typeof updateEnrollmentProgress>>;
  first_lesson_id: string | null;
  reset_lesson_ids: string[];
  attempt_state: QuizAttemptState;
}> {
  const { lessonIds, firstLessonId } = await resolveModuleRetakeLessonIds(courseId, quizLessonId);
  if (lessonIds.length === 0) {
    throw new Error("No modules found to reset");
  }

  const articulate = await query<{ id: string }>(
    `SELECT id FROM lessons
      WHERE id = ANY($1::uuid[])
        AND content_type = 'articulate'`,
    [lessonIds],
  );
  for (const row of articulate.rows) {
    await resetScormData(userId, row.id);
  }

  await query(
    `UPDATE lesson_progress
        SET completed = false, completed_at = NULL, updated_at = now()
      WHERE user_id = $1 AND lesson_id = ANY($2::uuid[])`,
    [userId, lessonIds],
  );

  await ensureQuizAttemptCyclesTable();
  await query(
    `INSERT INTO quiz_attempt_cycles (user_id, quiz_id, cycle_started_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id, quiz_id)
     DO UPDATE SET cycle_started_at = now()`,
    [userId, quizId],
  );

  const progress = await updateEnrollmentProgress(userId, courseId);
  const attempt_state = await getQuizAttemptState(userId, quizId);

  return {
    progress,
    first_lesson_id: firstLessonId,
    reset_lesson_ids: lessonIds,
    attempt_state,
  };
}
