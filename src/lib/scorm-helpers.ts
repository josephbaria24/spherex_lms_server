import { query } from "../config/db.js";
import {
  markLessonComplete,
  touchLessonStarted,
  updateEnrollmentProgress,
} from "./quiz-helpers.js";

const COMPLETED_STATUSES = new Set(["completed", "passed"]);

export type ScormDataRow = {
  user_id: string;
  lesson_id: string;
  course_id: string;
  cmi: Record<string, string>;
  lesson_status: string;
  score_raw: string | null;
  lesson_location: string | null;
  suspend_data: string | null;
};

export function isScormLessonComplete(status: string): boolean {
  return COMPLETED_STATUSES.has(status.toLowerCase());
}

export async function getScormData(
  userId: string,
  lessonId: string,
): Promise<ScormDataRow | null> {
  const result = await query<{
    user_id: string;
    lesson_id: string;
    course_id: string;
    cmi: Record<string, string>;
    lesson_status: string;
    score_raw: string | null;
    lesson_location: string | null;
    suspend_data: string | null;
  }>(
    `SELECT user_id, lesson_id, course_id, cmi, lesson_status, score_raw, lesson_location, suspend_data
       FROM scorm_data WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId],
  );
  return result.rows[0] ?? null;
}

export async function saveScormCmi(
  userId: string,
  lessonId: string,
  courseId: string,
  updates: Record<string, string>,
): Promise<{ completed: boolean; progress: Awaited<ReturnType<typeof updateEnrollmentProgress>> | null }> {
  const existing = await getScormData(userId, lessonId);
  const cmi: Record<string, string> = { ...(existing?.cmi ?? {}), ...updates };

  const lessonStatus =
    updates["cmi.core.lesson_status"] ??
    updates["cmi.completion_status"] ??
    cmi["cmi.core.lesson_status"] ??
    existing?.lesson_status ??
    "not attempted";

  const scoreRaw = updates["cmi.core.score.raw"] ?? cmi["cmi.core.score.raw"] ?? existing?.score_raw ?? null;
  const lessonLocation =
    updates["cmi.core.lesson_location"] ?? cmi["cmi.core.lesson_location"] ?? existing?.lesson_location ?? null;
  const suspendData =
    updates["cmi.suspend_data"] ?? cmi["cmi.suspend_data"] ?? existing?.suspend_data ?? null;

  await query(
    `INSERT INTO scorm_data (user_id, lesson_id, course_id, cmi, lesson_status, score_raw, lesson_location, suspend_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET
       cmi = EXCLUDED.cmi,
       lesson_status = EXCLUDED.lesson_status,
       score_raw = EXCLUDED.score_raw,
       lesson_location = EXCLUDED.lesson_location,
       suspend_data = EXCLUDED.suspend_data,
       updated_at = now()`,
    [
      userId,
      lessonId,
      courseId,
      JSON.stringify(cmi),
      lessonStatus,
      scoreRaw,
      lessonLocation,
      suspendData,
    ],
  );

  let progress = null;
  let completed = false;

  if (isScormLessonComplete(lessonStatus)) {
    await markLessonComplete(userId, lessonId, courseId);
    completed = true;
  } else {
    if (existing) {
      await query(
        `UPDATE lesson_progress
            SET completed = false, completed_at = NULL, updated_at = now()
          WHERE user_id = $1 AND lesson_id = $2 AND completed = true`,
        [userId, lessonId],
      );
    }
    const hasActivity =
      lessonStatus.toLowerCase() === "incomplete" ||
      Boolean(suspendData?.trim()) ||
      Boolean(lessonLocation?.trim());
    if (hasActivity) {
      await touchLessonStarted(userId, lessonId, courseId);
    }
  }

  progress = await updateEnrollmentProgress(userId, courseId);

  return { completed, progress };
}

export async function resetScormData(userId: string, lessonId: string): Promise<void> {
  await query(`DELETE FROM scorm_data WHERE user_id = $1 AND lesson_id = $2`, [userId, lessonId]);
  await query(
    `UPDATE lesson_progress
        SET completed = false, completed_at = NULL, updated_at = now()
      WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId],
  );
}

export function scormDataToCmiDefaults(row: ScormDataRow | null): Record<string, string> {
  const base = {
    "cmi.core.lesson_status": "not attempted",
    "cmi.core.lesson_location": "",
    "cmi.core.score.raw": "",
    "cmi.core.score.min": "0",
    "cmi.core.score.max": "100",
    "cmi.suspend_data": "",
    "cmi.core.student_id": "learner",
    "cmi.core.student_name": "Learner",
    "cmi.core.lesson_mode": "normal",
    "cmi.core.credit": "credit",
    "cmi.core.entry": "ab-initio",
    "cmi.core.exit": "",
    "cmi.core.total_time": "00:00:00",
    "cmi.core.session_time": "00:00:00",
    "cmi.launch_data": "",
  };
  if (!row) return base;

  const cmi = row.cmi ?? {};
  const suspendData =
    (row.suspend_data && row.suspend_data.trim()) ||
    (typeof cmi["cmi.suspend_data"] === "string" ? cmi["cmi.suspend_data"] : "") ||
    "";
  const lessonLocation =
    (row.lesson_location && row.lesson_location.trim()) ||
    (typeof cmi["cmi.core.lesson_location"] === "string" ? cmi["cmi.core.lesson_location"] : "") ||
    "";

  return {
    ...base,
    ...cmi,
    "cmi.core.lesson_status": row.lesson_status || cmi["cmi.core.lesson_status"] || "not attempted",
    "cmi.core.lesson_location": lessonLocation,
    "cmi.core.score.raw": row.score_raw ?? cmi["cmi.core.score.raw"] ?? "",
    "cmi.suspend_data": suspendData,
  };
}
