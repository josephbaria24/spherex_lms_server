import { query } from "../config/db.js";
import { getLearnDashboard } from "./learn-dashboard.js";

export async function getLearnAchievements(userId: string) {
  const [dashboard, certificatesRes, historyRes] = await Promise.all([
    getLearnDashboard(userId),
    query<{
      id: string;
      course_id: string | null;
      certificate_url: string | null;
      issued_at: Date;
      course_title: string | null;
    }>(
      `SELECT cert.id, cert.course_id, cert.certificate_url, cert.issued_at,
              c.title AS course_title
         FROM certificates cert
         LEFT JOIN courses c ON c.id = cert.course_id
        WHERE cert.user_id = $1
        ORDER BY cert.issued_at DESC`,
      [userId],
    ),
    query<{
      kind: string;
      occurred_at: Date;
      label: string;
      course_title: string | null;
      detail: string;
    }>(
      `SELECT * FROM (
         SELECT 'lesson_completed' AS kind, lp.completed_at AS occurred_at,
                l.title AS label, c.title AS course_title, 'Completed lesson' AS detail
           FROM lesson_progress lp
           JOIN lessons l ON l.id = lp.lesson_id
           JOIN courses c ON c.id = lp.course_id
          WHERE lp.user_id = $1 AND lp.completed AND lp.completed_at IS NOT NULL
         UNION ALL
         SELECT 'quiz_attempt', qa.created_at, q.title, c.title,
                'Quiz score ' || qa.score::text || '%'
           FROM quiz_attempts qa
           JOIN quizzes q ON q.id = qa.quiz_id
           JOIN lessons l ON l.id = q.lesson_id
           JOIN courses c ON c.id = l.course_id
          WHERE qa.user_id = $1
         UNION ALL
         SELECT 'course_completed', e.completed_at, c.title, c.title, 'Completed course'
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
          WHERE e.user_id = $1 AND e.completed AND e.completed_at IS NOT NULL
         UNION ALL
         SELECT 'enrolled', e.created_at, c.title, c.title, 'Enrolled in course'
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
          WHERE e.user_id = $1
       ) timeline
       WHERE occurred_at IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT 50`,
      [userId],
    ),
  ]);

  return {
    summary: dashboard.summary,
    enrollments: dashboard.enrollments,
    certificates: certificatesRes.rows.map((row) => ({
      id: row.id,
      course_id: row.course_id,
      course_title: row.course_title,
      certificate_url: row.certificate_url,
      issued_at: row.issued_at.toISOString(),
    })),
    activity_history: historyRes.rows.map((row) => ({
      kind: row.kind,
      occurred_at: row.occurred_at.toISOString(),
      label: row.label,
      course_title: row.course_title,
      detail: row.detail,
    })),
  };
}
