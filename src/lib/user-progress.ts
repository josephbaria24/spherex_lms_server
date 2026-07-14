import { query, withTransaction } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";

export async function assertUserExists(userId: string) {
  const result = await query(
    `SELECT id, email, full_name, name, role, status, created_at FROM users WHERE id = $1`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) throw HttpError.notFound("User not found");
  return user;
}

export async function getUserActivity(userId: string) {
  const user = await assertUserExists(userId);

  const [
    enrollments,
    lessonProgress,
    scormRecords,
    quizAttempts,
    organizations,
    teaching,
    materialsUploaded,
    lessonsCreated,
    evaluationsGiven,
    certificates,
    recentTimeline,
  ] = await Promise.all([
    query(
      `SELECT e.id, e.course_id, c.title AS course_title, e.progress_percent, e.completed,
              e.completed_at, e.created_at, e.updated_at,
              (SELECT COUNT(*)::int FROM lessons l
                WHERE l.course_id = e.course_id AND l.status = 'published') AS lessons_total,
              (SELECT COUNT(*)::int FROM lesson_progress lp
                JOIN lessons l ON l.id = lp.lesson_id
               WHERE lp.user_id = e.user_id AND l.course_id = e.course_id
                 AND lp.completed AND l.status = 'published') AS lessons_completed
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
        WHERE e.user_id = $1
        ORDER BY e.updated_at DESC`,
      [userId],
    ),
    query(
      `SELECT lp.id, lp.lesson_id, lp.course_id, l.title AS lesson_title, c.title AS course_title,
              lp.completed, lp.completed_at, lp.updated_at
         FROM lesson_progress lp
         JOIN lessons l ON l.id = lp.lesson_id
         JOIN courses c ON c.id = lp.course_id
        WHERE lp.user_id = $1
        ORDER BY lp.updated_at DESC
        LIMIT 100`,
      [userId],
    ),
    query(
      `SELECT sd.lesson_id, sd.course_id, l.title AS lesson_title, c.title AS course_title,
              sd.lesson_status, sd.score_raw, sd.updated_at
         FROM scorm_data sd
         JOIN lessons l ON l.id = sd.lesson_id
         JOIN courses c ON c.id = sd.course_id
        WHERE sd.user_id = $1
        ORDER BY sd.updated_at DESC
        LIMIT 100`,
      [userId],
    ),
    query(
      `SELECT qa.id, qa.score, qa.passed, qa.created_at,
              q.title AS quiz_title, l.title AS lesson_title, c.title AS course_title
         FROM quiz_attempts qa
         JOIN quizzes q ON q.id = qa.quiz_id
         JOIN lessons l ON l.id = q.lesson_id
         JOIN courses c ON c.id = l.course_id
        WHERE qa.user_id = $1
        ORDER BY qa.created_at DESC
        LIMIT 50`,
      [userId],
    ),
    query(
      `SELECT om.id, om.role, om.joined_at, o.name AS organization_name, o.slug AS organization_slug
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
        WHERE om.user_id = $1
        ORDER BY om.joined_at DESC`,
      [userId],
    ),
    query(
      `SELECT ci.id, ci.course_id, c.title AS course_title, ci.created_at
         FROM course_instructors ci
         JOIN courses c ON c.id = ci.course_id
        WHERE ci.teacher_id = $1
        ORDER BY ci.created_at DESC`,
      [userId],
    ),
    query(
      `SELECT id, title, type, created_at, updated_at
         FROM materials
        WHERE uploaded_by = $1
        ORDER BY updated_at DESC
        LIMIT 30`,
      [userId],
    ),
    query(
      `SELECT l.id, l.title, l.status, l.content_type, c.title AS course_title, l.created_at, l.updated_at
         FROM lessons l
         JOIN courses c ON c.id = l.course_id
        WHERE l.created_by = $1
        ORDER BY l.updated_at DESC
        LIMIT 30`,
      [userId],
    ),
    query(
      `SELECT ev.id, ev.status, ev.score, ev.evaluated_at, ev.created_at,
              c.title AS course_title,
              COALESCE(u.full_name, u.name, u.email) AS student_name
         FROM evaluations ev
         JOIN enrollments en ON en.id = ev.enrollment_id
         JOIN courses c ON c.id = en.course_id
         JOIN users u ON u.id = en.user_id
        WHERE ev.teacher_id = $1
        ORDER BY ev.updated_at DESC
        LIMIT 30`,
      [userId],
    ),
    query(
      `SELECT cert.id, cert.issued_at, cert.certificate_url, c.title AS course_title
         FROM certificates cert
         LEFT JOIN courses c ON c.id = cert.course_id
        WHERE cert.user_id = $1
        ORDER BY cert.issued_at DESC`,
      [userId],
    ),
    query(
      `SELECT * FROM (
         SELECT 'enrollment' AS kind, e.created_at AS occurred_at,
                c.title AS label, c.title AS course_title,
                'Enrolled in course' AS detail
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
          WHERE e.user_id = $1
         UNION ALL
         SELECT 'course_completed', e.completed_at, c.title, c.title, 'Completed course'
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
          WHERE e.user_id = $1 AND e.completed AND e.completed_at IS NOT NULL
         UNION ALL
         SELECT 'lesson_completed', lp.completed_at, l.title, c.title, 'Completed lesson'
           FROM lesson_progress lp
           JOIN lessons l ON l.id = lp.lesson_id
           JOIN courses c ON c.id = lp.course_id
          WHERE lp.user_id = $1 AND lp.completed AND lp.completed_at IS NOT NULL
         UNION ALL
         SELECT 'scorm_activity', sd.updated_at, l.title, c.title,
                'SCORM: ' || sd.lesson_status
           FROM scorm_data sd
           JOIN lessons l ON l.id = sd.lesson_id
           JOIN courses c ON c.id = sd.course_id
          WHERE sd.user_id = $1
         UNION ALL
         SELECT 'quiz_attempt', qa.created_at, q.title, c.title,
                'Quiz score ' || qa.score::text || '%' || CASE WHEN qa.passed THEN ' (passed)' ELSE '' END
           FROM quiz_attempts qa
           JOIN quizzes q ON q.id = qa.quiz_id
           JOIN lessons l ON l.id = q.lesson_id
           JOIN courses c ON c.id = l.course_id
          WHERE qa.user_id = $1
         UNION ALL
         SELECT 'material_upload', m.created_at, m.title, NULL, 'Uploaded material'
           FROM materials m
          WHERE m.uploaded_by = $1
         UNION ALL
         SELECT 'lesson_created', l.created_at, l.title, c.title, 'Created lesson'
           FROM lessons l
           JOIN courses c ON c.id = l.course_id
          WHERE l.created_by = $1
         UNION ALL
         SELECT 'evaluation', ev.evaluated_at, c.title, c.title,
                'Graded ' || COALESCE(u.full_name, u.name, u.email)
           FROM evaluations ev
           JOIN enrollments en ON en.id = ev.enrollment_id
           JOIN courses c ON c.id = en.course_id
           JOIN users u ON u.id = en.user_id
          WHERE ev.teacher_id = $1 AND ev.evaluated_at IS NOT NULL
       ) timeline
       WHERE occurred_at IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT 40`,
      [userId],
    ),
  ]);

  const completedCourses = enrollments.rows.filter((e) => e.completed).length;

  return {
    user,
    summary: {
      enrollments: enrollments.rows.length,
      completed_courses: completedCourses,
      lesson_progress_records: lessonProgress.rows.length,
      lesson_completions: lessonProgress.rows.filter((r) => r.completed).length,
      scorm_sessions: scormRecords.rows.length,
      quiz_attempts: quizAttempts.rows.length,
      certificates: certificates.rows.length,
      organizations: organizations.rows.length,
      courses_teaching: teaching.rows.length,
      materials_uploaded: materialsUploaded.rows.length,
      lessons_created: lessonsCreated.rows.length,
      evaluations_given: evaluationsGiven.rows.length,
    },
    enrollments: enrollments.rows,
    lesson_progress: lessonProgress.rows,
    scorm_records: scormRecords.rows,
    quiz_attempts: quizAttempts.rows,
    organizations: organizations.rows,
    teaching: teaching.rows,
    materials_uploaded: materialsUploaded.rows,
    lessons_created: lessonsCreated.rows,
    evaluations_given: evaluationsGiven.rows,
    certificates: certificates.rows,
    recent_timeline: recentTimeline.rows,
  };
}

export async function resetUserProgress(userId: string, courseId?: string) {
  await assertUserExists(userId);

  if (courseId) {
    const course = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
  }

  return withTransaction(async (client) => {
    if (courseId) {
      const lp = await client.query(
        `DELETE FROM lesson_progress WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      const scorm = await client.query(
        `DELETE FROM scorm_data WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      const quiz = await client.query(
        `DELETE FROM quiz_attempts qa
           USING quizzes q, lessons l
          WHERE qa.quiz_id = q.id AND q.lesson_id = l.id
            AND l.course_id = $2 AND qa.user_id = $1`,
        [userId, courseId],
      );
      await client.query(
        `UPDATE enrollments
            SET progress_percent = 0, completed = false, completed_at = NULL, updated_at = now()
          WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      await client.query(`DELETE FROM certificates WHERE user_id = $1 AND course_id = $2`, [
        userId,
        courseId,
      ]);

      return {
        course_id: courseId,
        deleted: {
          lesson_progress: lp.rowCount ?? 0,
          scorm_data: scorm.rowCount ?? 0,
          quiz_attempts: quiz.rowCount ?? 0,
        },
      };
    }

    const lp = await client.query(`DELETE FROM lesson_progress WHERE user_id = $1`, [userId]);
    const scorm = await client.query(`DELETE FROM scorm_data WHERE user_id = $1`, [userId]);
    const quiz = await client.query(`DELETE FROM quiz_attempts WHERE user_id = $1`, [userId]);
    await client.query(
      `UPDATE enrollments
          SET progress_percent = 0, completed = false, completed_at = NULL, updated_at = now()
        WHERE user_id = $1`,
      [userId],
    );
    await client.query(`DELETE FROM certificates WHERE user_id = $1`, [userId]);

    return {
      course_id: null,
      deleted: {
        lesson_progress: lp.rowCount ?? 0,
        scorm_data: scorm.rowCount ?? 0,
        quiz_attempts: quiz.rowCount ?? 0,
      },
    };
  });
}
