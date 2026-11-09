import { query } from "../config/db.js";
import { ensureCertificateTemplatesTable } from "./certificate-template.js";
import { issueCertificateIfNeeded } from "./certificates.js";
import { HttpError } from "../utils/httpError.js";

function parseScormTimeToSeconds(value: string | null | undefined): number {
  if (!value?.trim()) return 0;
  const raw = value.trim();
  const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (match) {
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    if ([hours, minutes, seconds].every((n) => Number.isFinite(n))) {
      return hours * 3600 + minutes * 60 + seconds;
    }
  }
  return 0;
}

function countInteractions(cmi: unknown): { total: number; correct: number } {
  if (!cmi || typeof cmi !== "object" || Array.isArray(cmi)) {
    return { total: 0, correct: 0 };
  }
  const record = cmi as Record<string, unknown>;
  const indexes = new Set<number>();
  for (const key of Object.keys(record)) {
    const match = key.match(/^cmi\.interactions\.(\d+)\./);
    if (match) indexes.add(Number(match[1]));
  }
  let correct = 0;
  for (const index of indexes) {
    const result = String(record[`cmi.interactions.${index}.result`] ?? "")
      .toLowerCase()
      .trim();
    if (result === "correct" || result === "passed") correct += 1;
  }
  return { total: indexes.size, correct };
}

export async function getCourseCompletionSummary(userId: string, courseId: string) {
  await ensureCertificateTemplatesTable();

  const enrollment = await query<{
    id: string;
    completed: boolean;
    progress_percent: number;
    created_at: Date;
    completed_at: Date | null;
    course_title: string;
    course_image: string | null;
  }>(
    `SELECT e.id, e.completed, e.progress_percent, e.created_at, e.completed_at,
            c.title AS course_title, c.image AS course_image
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1 AND e.course_id = $2`,
    [userId, courseId],
  );
  const row = enrollment.rows[0];
  if (!row) throw HttpError.notFound("Enrollment not found");

  if (row.completed) {
    try {
      await issueCertificateIfNeeded(userId, courseId);
    } catch {
      /* certificate optional */
    }
  }

  const [lessonStats, quizStats, scormRows, certificate] = await Promise.all([
    query<{ total: string; done: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM lessons WHERE course_id = $1 AND status = 'published') AS total,
         (SELECT COUNT(*)::text
            FROM lessons l
            LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $2
            LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $2
           WHERE l.course_id = $1
             AND l.status = 'published'
             AND (
               (sd.lesson_id IS NOT NULL AND lower(sd.lesson_status) IN ('completed', 'passed'))
               OR (sd.lesson_id IS NULL AND COALESCE(lp.completed, false))
             )) AS done`,
      [courseId, userId],
    ),
    query<{
      attempts: string;
      quizzes_attempted: string;
      quizzes_passed: string;
      avg_score: string | null;
      best_score: string | null;
      failed_attempts: string;
    }>(
      `SELECT COUNT(*)::text AS attempts,
              COUNT(DISTINCT qa.quiz_id)::text AS quizzes_attempted,
              COUNT(DISTINCT qa.quiz_id) FILTER (WHERE qa.passed)::text AS quizzes_passed,
              ROUND(AVG(qa.score))::text AS avg_score,
              MAX(qa.score)::text AS best_score,
              COUNT(*) FILTER (WHERE NOT qa.passed)::text AS failed_attempts
         FROM quiz_attempts qa
         JOIN quizzes q ON q.id = qa.quiz_id
         JOIN lessons l ON l.id = q.lesson_id
        WHERE qa.user_id = $1 AND l.course_id = $2`,
      [userId, courseId],
    ),
    query<{ cmi: Record<string, string> | null }>(
      `SELECT cmi
         FROM scorm_data
        WHERE user_id = $1 AND course_id = $2`,
      [userId, courseId],
    ),
    query<{
      id: string;
      serial_number: string | null;
      issued_at: Date;
      has_template: boolean;
    }>(
      `SELECT cert.id, cert.serial_number, cert.issued_at,
              EXISTS (
                SELECT 1 FROM certificate_templates ct
                 WHERE ct.course_id = cert.course_id
                   AND (
                     COALESCE(ct.image_path, '') <> ''
                     OR jsonb_array_length(COALESCE(ct.fields, '[]'::jsonb)) > 0
                   )
              ) AS has_template
         FROM certificates cert
        WHERE cert.user_id = $1 AND cert.course_id = $2
        ORDER BY cert.issued_at DESC
        LIMIT 1`,
      [userId, courseId],
    ),
  ]);

  let scormSeconds = 0;
  let interactionsTotal = 0;
  let interactionsCorrect = 0;
  for (const scorm of scormRows.rows) {
    const cmi = scorm.cmi ?? {};
    scormSeconds += parseScormTimeToSeconds(cmi["cmi.core.total_time"]);
    scormSeconds += parseScormTimeToSeconds(cmi["cmi.core.session_time"]);
    const counts = countInteractions(cmi);
    interactionsTotal += counts.total;
    interactionsCorrect += counts.correct;
  }

  const enrolledAt = row.created_at.getTime();
  const finishedAt = (row.completed_at ?? new Date()).getTime();
  const calendarSeconds = Math.max(0, Math.round((finishedAt - enrolledAt) / 1000));
  const studySeconds = scormSeconds > 0 ? Math.round(scormSeconds) : calendarSeconds;

  const attempts = Number(quizStats.rows[0]?.attempts ?? 0);
  const quizzesAttempted = Number(quizStats.rows[0]?.quizzes_attempted ?? 0);
  const quizRepeats = Math.max(0, attempts - quizzesAttempted);
  const cert = certificate.rows[0] ?? null;

  return {
    course: {
      id: courseId,
      title: row.course_title,
      image: row.course_image,
    },
    completed: row.completed,
    progress_percent: row.progress_percent,
    lessons_total: Number(lessonStats.rows[0]?.total ?? 0),
    lessons_completed: Number(lessonStats.rows[0]?.done ?? 0),
    study_seconds: studySeconds,
    quiz_attempts: attempts,
    quizzes_attempted: quizzesAttempted,
    quizzes_passed: Number(quizStats.rows[0]?.quizzes_passed ?? 0),
    quiz_repeats: quizRepeats,
    quiz_failed_attempts: Number(quizStats.rows[0]?.failed_attempts ?? 0),
    quiz_avg_score:
      quizStats.rows[0]?.avg_score != null ? Number(quizStats.rows[0].avg_score) : null,
    quiz_best_score:
      quizStats.rows[0]?.best_score != null ? Number(quizStats.rows[0].best_score) : null,
    interactions_total: interactionsTotal,
    interactions_correct: interactionsCorrect,
    enrolled_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    certificate: cert
      ? {
          id: cert.id,
          serial_number: cert.serial_number,
          issued_at: cert.issued_at.toISOString(),
          has_template: cert.has_template,
          pdf_url: `/api/lms/certificates/${cert.id}/pdf`,
        }
      : null,
  };
}
