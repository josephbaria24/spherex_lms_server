import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";

export type LessonAccessRow = {
  id: string;
  completed: boolean;
  started?: boolean;
};

/** When SCORM data exists, only SCORM status counts — avoids false completes from legacy heuristics. */
export const LESSON_COMPLETED_CASE = `
  CASE
    WHEN sd.lesson_id IS NOT NULL THEN lower(COALESCE(sd.lesson_status, '')) IN ('completed', 'passed')
    WHEN COALESCE(lp.completed, false) THEN true
    ELSE false
  END`;

export const LESSON_STARTED_CASE = `
  CASE
    WHEN sd.lesson_id IS NOT NULL THEN
      CASE
        WHEN lower(COALESCE(sd.lesson_status, '')) IN ('completed', 'passed') THEN false
        WHEN lower(COALESCE(sd.lesson_status, '')) = 'incomplete' THEN true
        WHEN NULLIF(btrim(sd.suspend_data), '') IS NOT NULL THEN true
        WHEN NULLIF(btrim(sd.lesson_location), '') IS NOT NULL THEN true
        ELSE false
      END
    WHEN COALESCE(lp.completed, false) THEN false
    WHEN lower(COALESCE(sd.lesson_status, '')) IN ('completed', 'passed') THEN false
    WHEN lower(COALESCE(sd.lesson_status, '')) = 'incomplete' THEN true
    WHEN NULLIF(btrim(sd.suspend_data), '') IS NOT NULL THEN true
    WHEN NULLIF(btrim(sd.lesson_location), '') IS NOT NULL THEN true
    ELSE false
  END`;

/** Published lessons with per-learner completion (ordered). */
export const LESSON_PROGRESS_SQL = `
  SELECT l.id,
         ${LESSON_COMPLETED_CASE} AS completed,
         ${LESSON_STARTED_CASE} AS started
    FROM lessons l
    LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $2
    LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $2
   WHERE l.course_id = $1 AND l.status = 'published'
   ORDER BY l.sort_order, l.created_at
`;

export function applyLessonLocks<T extends { completed: boolean }>(
  lessons: T[],
  requireSequential: boolean,
): (T & { locked: boolean })[] {
  if (!requireSequential) {
    return lessons.map((lesson) => ({ ...lesson, locked: false }));
  }

  let priorLessonsComplete = true;
  return lessons.map((lesson) => {
    const locked = !priorLessonsComplete;
    if (!lesson.completed) {
      priorLessonsComplete = false;
    }
    return { ...lesson, locked };
  });
}

export async function getCourseRequiresSequential(courseId: string): Promise<boolean> {
  const result = await query<{ require_sequential_lessons: boolean }>(
    `SELECT COALESCE(require_sequential_lessons, false) AS require_sequential_lessons
       FROM courses WHERE id = $1`,
    [courseId],
  );
  return result.rows[0]?.require_sequential_lessons ?? false;
}

export async function assertLessonUnlocked(
  userId: string,
  courseId: string,
  lessonId: string,
  preview: boolean,
): Promise<void> {
  if (preview) return;

  const lessons = await query<LessonAccessRow>(LESSON_PROGRESS_SQL, [courseId, userId]);
  const withLocks = applyLessonLocks(lessons.rows, true);
  const target = withLocks.find((lesson) => lesson.id === lessonId);
  if (!target) throw HttpError.notFound("Lesson not found");
  if (target.locked) {
    throw HttpError.forbidden("Complete the previous lesson before accessing this one");
  }
}
