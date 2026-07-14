import { query, withTransaction } from "../config/db.js";

export type QuizQuestionInput = {
  id?: string;
  prompt: string;
  question_type: "multiple_choice" | "true_false";
  options: { id: string; text: string }[];
  correct_option_id: string;
  sort_order?: number;
};

export type QuizInput = {
  title: string;
  passing_score?: number;
  questions: QuizQuestionInput[];
};

export async function getQuizByLessonId(lessonId: string, includeAnswers: boolean) {
  const quizResult = await query<{
    id: string;
    lesson_id: string;
    title: string;
    passing_score: number;
  }>("SELECT id, lesson_id, title, passing_score FROM quizzes WHERE lesson_id = $1", [lessonId]);
  const quiz = quizResult.rows[0];
  if (!quiz) return null;

  const questions = await query<{
    id: string;
    sort_order: number;
    prompt: string;
    question_type: string;
    options: { id: string; text: string }[];
    correct_option_id: string;
  }>(
    `SELECT id, sort_order, prompt, question_type, options, correct_option_id
       FROM quiz_questions WHERE quiz_id = $1 ORDER BY sort_order, created_at`,
    [quiz.id],
  );

  return {
    ...quiz,
    questions: questions.rows.map((q) => {
      const base = {
        id: q.id,
        sort_order: q.sort_order,
        prompt: q.prompt,
        question_type: q.question_type,
        options: q.options,
      };
      if (includeAnswers) {
        return { ...base, correct_option_id: q.correct_option_id };
      }
      return base;
    }),
  };
}

export async function upsertLessonQuiz(lessonId: string, input: QuizInput) {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM quizzes WHERE lesson_id = $1",
      [lessonId],
    );

    let quizId: string;
    if (existing.rows[0]) {
      quizId = existing.rows[0].id;
      await client.query(
        `UPDATE quizzes SET title = $1, passing_score = $2 WHERE id = $3`,
        [input.title, input.passing_score ?? 70, quizId],
      );
      await client.query("DELETE FROM quiz_questions WHERE quiz_id = $1", [quizId]);
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO quizzes (lesson_id, title, passing_score) VALUES ($1, $2, $3) RETURNING id`,
        [lessonId, input.title, input.passing_score ?? 70],
      );
      quizId = inserted.rows[0]!.id;
    }

    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i]!;
      await client.query(
        `INSERT INTO quiz_questions (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          quizId,
          q.sort_order ?? i,
          q.prompt,
          q.question_type,
          JSON.stringify(q.options),
          q.correct_option_id,
        ],
      );
    }

    return quizId;
  });
}

export function scoreQuiz(
  questions: { id: string; correct_option_id: string }[],
  answers: Record<string, string>,
): { score: number; passed: boolean; correct: number; total: number } {
  const total = questions.length;
  if (total === 0) return { score: 100, passed: true, correct: 0, total: 0 };

  let correct = 0;
  for (const q of questions) {
    if (answers[q.id] === q.correct_option_id) correct += 1;
  }
  const score = Math.round((correct / total) * 100);
  return { score, passed: false, correct, total };
}

export async function markLessonComplete(userId: string, lessonId: string, courseId: string) {
  await query(
    `INSERT INTO lesson_progress (user_id, lesson_id, course_id, completed, completed_at)
     VALUES ($1, $2, $3, true, now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET
       completed = true,
       completed_at = COALESCE(lesson_progress.completed_at, now()),
       updated_at = now()`,
    [userId, lessonId, courseId],
  );
}

/** Record that a learner has begun a lesson (SCORM bookmark, incomplete status, etc.). */
export async function touchLessonStarted(userId: string, lessonId: string, courseId: string) {
  await query(
    `INSERT INTO lesson_progress (user_id, lesson_id, course_id, completed)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET
       updated_at = now()
     WHERE lesson_progress.completed = false`,
    [userId, lessonId, courseId],
  );
}

export type EnrollmentProgress = {
  progress: number;
  completed: boolean;
  total: number;
  done: number;
  started: number;
};

export async function updateEnrollmentProgress(
  userId: string,
  courseId: string,
): Promise<EnrollmentProgress> {
  const stats = await query<{ total: string; done: string; started: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM lessons WHERE course_id = $2 AND status = 'published') AS total,
       (SELECT COUNT(*)::text FROM lessons l
         LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
         LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $1
        WHERE l.course_id = $2
          AND l.status = 'published'
          AND (
            (sd.lesson_id IS NOT NULL AND lower(sd.lesson_status) IN ('completed', 'passed'))
            OR (sd.lesson_id IS NULL AND COALESCE(lp.completed, false))
          )) AS done,
       (SELECT COUNT(DISTINCT l.id)::text
          FROM lessons l
          LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $1
         WHERE l.course_id = $2
           AND l.status = 'published'
           AND NOT COALESCE(lp.completed, false)
           AND (
             (sd.lesson_id IS NOT NULL AND lower(sd.lesson_status) NOT IN ('not attempted', ''))
             OR NULLIF(btrim(sd.suspend_data), '') IS NOT NULL
             OR NULLIF(btrim(sd.lesson_location), '') IS NOT NULL
           )) AS started`,
    [userId, courseId],
  );
  const total = Number(stats.rows[0]?.total ?? 0);
  const done = Number(stats.rows[0]?.done ?? 0);
  const started = Number(stats.rows[0]?.started ?? 0);
  const progress =
    total > 0 ? Math.min(100, Math.round(((done + started * 0.5) / total) * 100)) : 0;
  const completed = total > 0 && done >= total;

  await query(
    `UPDATE enrollments SET
       progress_percent = $3,
       completed = $4,
       completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END,
       updated_at = now()
     WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId, progress, completed],
  );

  return { progress, completed, total, done, started };
}
