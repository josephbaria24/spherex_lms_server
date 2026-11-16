import { query, withTransaction } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { getIeltsUserMonitor } from "./ielts-certificate.js";
import { LESSON_COMPLETED_CASE } from "./lesson-access.js";
import { ensureQuizAttemptCyclesTable } from "./quiz-attempt-policy.js";
import { markLessonComplete, updateEnrollmentProgress } from "./quiz-helpers.js";
import { meshNameFromSuspendData } from "./storyline-resume.js";

type ScormInteraction = {
  id: string | null;
  description: string | null;
  type: string | null;
  student_response: string | null;
  result: string | null;
  latency: string | null;
};

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractScormInteractions(cmi: unknown): ScormInteraction[] {
  if (!cmi || typeof cmi !== "object" || Array.isArray(cmi)) return [];
  const record = cmi as Record<string, unknown>;
  const grouped = new Map<number, Partial<ScormInteraction>>();
  const pattern = /^cmi\.interactions\.(\d+)\.(id|description|type|student_response|result|latency)$/;

  for (const [key, value] of Object.entries(record)) {
    const match = key.match(pattern);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2] as keyof ScormInteraction;
    const next = grouped.get(index) ?? {};
    next[field] = toNullableString(value);
    grouped.set(index, next);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({
      id: value.id ?? null,
      description: value.description ?? null,
      type: value.type ?? null,
      student_response: value.student_response ?? null,
      result: value.result ?? null,
      latency: value.latency ?? null,
    }))
    .filter((item) => item.student_response || item.description || item.id);
}

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
    ielts,
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
              lp.completed, lp.completed_at, lp.updated_at,
              (
                SELECT ranked.lesson_number
                FROM (
                  SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at)::int AS lesson_number
                  FROM lessons
                  WHERE course_id = l.course_id AND status = 'published'
                ) ranked
                WHERE ranked.id = l.id
              ) AS lesson_number,
              (
                SELECT COUNT(*)::int FROM lessons
                WHERE course_id = l.course_id AND status = 'published'
              ) AS lessons_total
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
              sd.lesson_status, sd.score_raw, sd.suspend_data, sd.cmi, sd.updated_at,
              (
                SELECT ranked.lesson_number
                FROM (
                  SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at)::int AS lesson_number
                  FROM lessons
                  WHERE course_id = l.course_id AND status = 'published'
                ) ranked
                WHERE ranked.id = l.id
              ) AS lesson_number,
              (
                SELECT COUNT(*)::int FROM lessons
                WHERE course_id = l.course_id AND status = 'published'
              ) AS lessons_total
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
    getIeltsUserMonitor(userId).catch((err) => {
      console.error("[user-progress] IELTS monitor failed:", err);
      return null;
    }),
  ]);

  const ieltsSafe = ielts ?? {
    total_sets: 0,
    passed_sets: 0,
    completion_pct: 0,
    attempts: 0,
    avg_band: null,
    pending_speaking: 0,
    last_activity: null,
    certificate: null,
    skills: [],
    tests: [],
    recent_attempts: [],
  };

  const completedCourses = enrollments.rows.filter((e) => e.completed).length;
  const scormWithResponses = scormRecords.rows.map((row) => {
    const interactions = extractScormInteractions(row.cmi);
    const suspendData = toNullableString(row.suspend_data);
    const meshName = meshNameFromSuspendData(
      suspendData,
      String(row.lesson_title ?? ""),
      String(row.course_title ?? ""),
    );
    if (meshName) {
      interactions.push({
        id: "mesh-name",
        description: "Enter your name",
        type: "fill-in",
        student_response: meshName,
        result: null,
        latency: null,
      });
    }
    return {
      ...row,
      interactions,
      suspend_data: suspendData,
    };
  });

  return {
    user,
    summary: {
      enrollments: enrollments.rows.length,
      completed_courses: completedCourses,
      lesson_progress_records: lessonProgress.rows.length,
      lesson_completions: lessonProgress.rows.filter((r) => r.completed).length,
      scorm_sessions: scormRecords.rows.length,
      quiz_attempts: quizAttempts.rows.length,
      certificates: certificates.rows.length + (ieltsSafe.certificate ? 1 : 0),
      organizations: organizations.rows.length,
      courses_teaching: teaching.rows.length,
      materials_uploaded: materialsUploaded.rows.length,
      lessons_created: lessonsCreated.rows.length,
      evaluations_given: evaluationsGiven.rows.length,
      ielts_attempts: ieltsSafe.attempts,
      ielts_passed_sets: ieltsSafe.passed_sets,
      ielts_total_sets: ieltsSafe.total_sets,
      ielts_pending_speaking: ieltsSafe.pending_speaking,
    },
    enrollments: enrollments.rows,
    lesson_progress: lessonProgress.rows,
    scorm_records: scormWithResponses,
    quiz_attempts: quizAttempts.rows,
    organizations: organizations.rows,
    teaching: teaching.rows,
    materials_uploaded: materialsUploaded.rows,
    lessons_created: lessonsCreated.rows,
    evaluations_given: evaluationsGiven.rows,
    certificates: certificates.rows,
    recent_timeline: recentTimeline.rows,
    ielts: ieltsSafe,
  };
}

type CourseLessonOutlineRow = {
  id: string;
  title: string;
  content_type: string;
  parent_lesson_id: string | null;
  parent_title: string | null;
  sort_order: number;
  completed: boolean;
  completed_at: Date | null;
};

/** Published lessons for a user+course with completion flags (admin progress adjuster). */
export async function getUserCourseLessonOutline(userId: string, courseId: string) {
  await assertUserExists(userId);
  const enrollment = await query(
    `SELECT e.id, e.progress_percent, e.completed, c.title AS course_title,
            c.require_sequential_lessons
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1 AND e.course_id = $2`,
    [userId, courseId],
  );
  if (!enrollment.rows[0]) throw HttpError.notFound("Enrollment not found");

  const lessons = await query<CourseLessonOutlineRow>(
    `SELECT l.id, l.title, l.content_type, l.parent_lesson_id, l.sort_order,
            p.title AS parent_title,
            (${LESSON_COMPLETED_CASE}) AS completed,
            COALESCE(lp.completed_at, CASE
              WHEN lower(COALESCE(sd.lesson_status, '')) IN ('completed', 'passed')
              THEN sd.updated_at ELSE NULL END) AS completed_at
       FROM lessons l
       LEFT JOIN lessons p ON p.id = l.parent_lesson_id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
       LEFT JOIN scorm_data sd ON sd.lesson_id = l.id AND sd.user_id = $1
      WHERE l.course_id = $2 AND l.status = 'published'
      ORDER BY l.sort_order, l.created_at`,
    [userId, courseId],
  );

  const modules: Array<{
    id: string;
    title: string;
    lesson_ids: string[];
    completed_count: number;
    total_count: number;
    completed: boolean;
  }> = [];
  const moduleIndex = new Map<string, number>();

  for (const lesson of lessons.rows) {
    const moduleId = lesson.parent_lesson_id ?? lesson.id;
    const moduleTitle = lesson.parent_lesson_id
      ? (lesson.parent_title ?? "Module")
      : lesson.title;
    let idx = moduleIndex.get(moduleId);
    if (idx == null) {
      idx = modules.length;
      moduleIndex.set(moduleId, idx);
      modules.push({
        id: moduleId,
        title: moduleTitle,
        lesson_ids: [],
        completed_count: 0,
        total_count: 0,
        completed: false,
      });
    }
    const mod = modules[idx]!;
    if (!mod.lesson_ids.includes(lesson.id)) {
      mod.lesson_ids.push(lesson.id);
      mod.total_count += 1;
      if (lesson.completed) mod.completed_count += 1;
    }
    // Parent root lesson itself may also appear as a row.
    if (lesson.parent_lesson_id == null && lesson.id === moduleId) {
      // already counted
    }
  }

  for (const mod of modules) {
    mod.completed = mod.total_count > 0 && mod.completed_count >= mod.total_count;
  }

  return {
    course: {
      id: courseId,
      title: enrollment.rows[0].course_title as string,
      require_sequential_lessons: Boolean(enrollment.rows[0].require_sequential_lessons),
      progress_percent: Number(enrollment.rows[0].progress_percent ?? 0),
      completed: Boolean(enrollment.rows[0].completed),
    },
    lessons: lessons.rows.map((row) => ({
      id: row.id,
      title: row.title,
      content_type: row.content_type,
      parent_lesson_id: row.parent_lesson_id,
      parent_title: row.parent_title,
      sort_order: row.sort_order,
      completed: Boolean(row.completed),
      completed_at: row.completed_at,
    })),
    modules,
  };
}

async function forceCompleteScormRow(
  userId: string,
  lessonId: string,
  courseId: string,
  contentType: string,
) {
  const existing = await query(
    `SELECT lesson_id FROM scorm_data WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId],
  );
  if (contentType !== "articulate" && !existing.rows[0]) return;

  const cmi = {
    "cmi.core.lesson_status": "completed",
    "cmi.completion_status": "completed",
  };
  await query(
    `INSERT INTO scorm_data (user_id, lesson_id, course_id, cmi, lesson_status, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'completed', now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET
       lesson_status = 'completed',
       cmi = COALESCE(scorm_data.cmi, '{}'::jsonb) || EXCLUDED.cmi,
       updated_at = now()`,
    [userId, lessonId, courseId, JSON.stringify(cmi)],
  );
}

/**
 * Admin force-complete selected lessons (and optionally all earlier ones) so sequential
 * unlock and enrollment % stay consistent after a skip.
 */
export async function forceCompleteLessons(
  userId: string,
  courseId: string,
  lessonIds: string[],
  options?: { include_prior?: boolean },
) {
  await assertUserExists(userId);
  const enrollment = await query(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  if (!enrollment.rows[0]) throw HttpError.notFound("Enrollment not found");

  const uniqueRequested = [...new Set(lessonIds.filter(Boolean))];
  if (uniqueRequested.length === 0) {
    throw HttpError.badRequest("Select at least one lesson or module");
  }

  const published = await query<{
    id: string;
    content_type: string;
    parent_lesson_id: string | null;
    sort_order: number;
  }>(
    `SELECT id, content_type, parent_lesson_id, sort_order
       FROM lessons
      WHERE course_id = $1 AND status = 'published'
      ORDER BY sort_order, created_at`,
    [courseId],
  );
  if (published.rows.length === 0) throw HttpError.badRequest("Course has no published lessons");

  const byId = new Map(published.rows.map((row) => [row.id, row]));
  const target = new Set<string>();

  for (const id of uniqueRequested) {
    // Module roots may be unpublished parents; still expand to published children.
    const matched = published.rows.filter(
      (lesson) => lesson.id === id || lesson.parent_lesson_id === id,
    );
    if (matched.length === 0) {
      throw HttpError.badRequest("One or more lessons are not in this course");
    }
    for (const lesson of matched) target.add(lesson.id);
  }

  const includePrior = options?.include_prior !== false;
  if (includePrior) {
    let maxSort = -Infinity;
    for (const id of target) {
      const row = byId.get(id);
      if (row) maxSort = Math.max(maxSort, row.sort_order);
    }
    for (const lesson of published.rows) {
      if (lesson.sort_order <= maxSort) target.add(lesson.id);
    }
  }

  const completedIds: string[] = [];
  for (const lesson of published.rows) {
    if (!target.has(lesson.id)) continue;
    await markLessonComplete(userId, lesson.id, courseId);
    await forceCompleteScormRow(userId, lesson.id, courseId, lesson.content_type);
    completedIds.push(lesson.id);
  }

  const progress = await updateEnrollmentProgress(userId, courseId);
  return {
    course_id: courseId,
    completed_lesson_ids: completedIds,
    include_prior: includePrior,
    progress,
  };
}

export async function resetUserProgress(userId: string, courseId?: string) {
  await assertUserExists(userId);

  if (courseId) {
    const course = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw HttpError.notFound("Course not found");
  }

  await ensureQuizAttemptCyclesTable();

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
      const cycles = await client.query(
        `DELETE FROM quiz_attempt_cycles qac
           USING quizzes q, lessons l
          WHERE qac.quiz_id = q.id AND q.lesson_id = l.id
            AND l.course_id = $2 AND qac.user_id = $1`,
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
          quiz_attempt_cycles: cycles.rowCount ?? 0,
        },
      };
    }

    const lp = await client.query(`DELETE FROM lesson_progress WHERE user_id = $1`, [userId]);
    const scorm = await client.query(`DELETE FROM scorm_data WHERE user_id = $1`, [userId]);
    const quiz = await client.query(`DELETE FROM quiz_attempts WHERE user_id = $1`, [userId]);
    const cycles = await client.query(`DELETE FROM quiz_attempt_cycles WHERE user_id = $1`, [
      userId,
    ]);
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
        quiz_attempt_cycles: cycles.rowCount ?? 0,
      },
    };
  });
}
