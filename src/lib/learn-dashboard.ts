import { query } from "../config/db.js";

type ActivityRow = { occurred_at: Date };

function computeStreakFromDays(activeDayKeys: Set<string>): number {
  if (activeDayKeys.size === 0) return 0

  let streak = 0
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)

  while (activeDayKeys.has(cursor.toDateString())) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  return streak
}

function parseDurationHours(duration: string | null | undefined): number {
  const n = parseInt((duration ?? "").replace(/\D/g, "") || "0", 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function startOfWeek(date: Date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function inRange(date: Date, range: "1D" | "1W" | "1M" | "1Y", now = new Date()) {
  const ms = date.getTime()
  const start = new Date(now)
  if (range === "1D") {
    start.setHours(0, 0, 0, 0)
    return ms >= start.getTime()
  }
  if (range === "1W") {
    return ms >= startOfWeek(now).getTime()
  }
  if (range === "1M") {
    start.setDate(start.getDate() - 30)
    return ms >= start.getTime()
  }
  start.setFullYear(start.getFullYear() - 1)
  return ms >= start.getTime()
}

export async function getLearnDashboard(userId: string) {
  const [
    enrollmentsRes,
    certificatesRes,
    activityRes,
    lessonCompletionsRes,
    weeklyActivityRes,
    peersRes,
    timelineRes,
  ] = await Promise.all([
    query<{
      id: string
      course_id: string
      progress_percent: number
      completed: boolean
      completed_at: Date | null
      created_at: Date
      updated_at: Date
      course_title: string
      course_duration: string | null
      lessons_total: number
      lessons_completed: number
    }>(
      `SELECT e.id, e.course_id, e.progress_percent, e.completed, e.completed_at,
              e.created_at, e.updated_at,
              c.title AS course_title, c.duration AS course_duration,
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
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM certificates WHERE user_id = $1`,
      [userId],
    ),
    query<ActivityRow>(
      `SELECT occurred_at FROM (
         SELECT completed_at AS occurred_at
           FROM lesson_progress
          WHERE user_id = $1 AND completed AND completed_at IS NOT NULL
         UNION ALL
         SELECT updated_at AS occurred_at
           FROM lesson_progress
          WHERE user_id = $1
         UNION ALL
         SELECT created_at AS occurred_at
           FROM quiz_attempts
          WHERE user_id = $1
         UNION ALL
         SELECT updated_at AS occurred_at
           FROM scorm_data
          WHERE user_id = $1
         UNION ALL
         SELECT updated_at AS occurred_at
           FROM enrollments
          WHERE user_id = $1 AND progress_percent > 0
       ) activity
       WHERE occurred_at IS NOT NULL`,
      [userId],
    ),
    query<{ completed_at: Date }>(
      `SELECT completed_at
         FROM lesson_progress
        WHERE user_id = $1 AND completed AND completed_at IS NOT NULL
        ORDER BY completed_at ASC`,
      [userId],
    ),
    query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM (
         SELECT completed_at AS occurred_at
           FROM lesson_progress
          WHERE user_id = $1 AND completed AND completed_at IS NOT NULL
         UNION ALL
         SELECT created_at AS occurred_at FROM quiz_attempts WHERE user_id = $1
         UNION ALL
         SELECT updated_at AS occurred_at FROM scorm_data WHERE user_id = $1
         UNION ALL
         SELECT updated_at AS occurred_at
           FROM lesson_progress
          WHERE user_id = $1
       ) activity
       WHERE occurred_at >= date_trunc('week', now()::timestamp)`,
      [userId],
    ),
    query<{ id: string; name: string; course_title: string }>(
      `SELECT DISTINCT ON (u.id, c.title)
              u.id,
              COALESCE(u.full_name, u.name, split_part(u.email, '@', 1)) AS name,
              c.title AS course_title
         FROM enrollments mine
         JOIN enrollments peer ON peer.course_id = mine.course_id AND peer.user_id <> mine.user_id
         JOIN users u ON u.id = peer.user_id
         JOIN courses c ON c.id = mine.course_id
        WHERE mine.user_id = $1
        ORDER BY u.id, c.title, peer.updated_at DESC
        LIMIT 6`,
      [userId],
    ),
    query<{
      kind: string
      occurred_at: Date
      label: string
      course_title: string | null
      detail: string
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
       ) timeline
       WHERE occurred_at IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT 12`,
      [userId],
    ),
  ])

  const enrollments = enrollmentsRes.rows
  const certificatesCount = Number(certificatesRes.rows[0]?.count ?? 0)

  const activeDayKeys = new Set(
    activityRes.rows.map((row) => new Date(row.occurred_at).toDateString()),
  )
  const streakDays = computeStreakFromDays(activeDayKeys)

  const lessonsCompleted = lessonCompletionsRes.rows.length
  const quizAttempts = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM quiz_attempts WHERE user_id = $1`,
    [userId],
  )
  const quizAttemptCount = Number(quizAttempts.rows[0]?.count ?? 0)

  const hoursGoal = Math.max(
    1,
    enrollments.reduce((sum, e) => sum + parseDurationHours(e.course_duration), 0),
  )
  const hoursCompleted =
    Math.round(
      enrollments.reduce(
        (sum, e) => sum + parseDurationHours(e.course_duration) * (e.progress_percent / 100),
        0,
      ) * 10,
    ) / 10
  const weeklyGoalPercent = Math.min(
    100,
    hoursGoal > 0 ? Math.round((hoursCompleted / hoursGoal) * 100) : 0,
  )

  const now = new Date()
  const lessonsThisWeek = lessonCompletionsRes.rows.filter((row) =>
    inRange(new Date(row.completed_at), "1W", now),
  ).length
  const lessonsPriorWeek = lessonCompletionsRes.rows.filter((row) => {
    const d = new Date(row.completed_at)
    const weekStart = startOfWeek(now)
    const priorWeekStart = new Date(weekStart)
    priorWeekStart.setDate(priorWeekStart.getDate() - 7)
    return d >= priorWeekStart && d < weekStart
  }).length
  const growthPercent =
    lessonsPriorWeek > 0
      ? Math.round(((lessonsThisWeek - lessonsPriorWeek) / lessonsPriorWeek) * 100)
      : lessonsThisWeek > 0
        ? 100
        : 0

  const knowledgeTimeline = lessonCompletionsRes.rows.map((row) => ({
    occurred_at: row.completed_at.toISOString(),
  }))

  const dayLabels = ["M", "T", "W", "T", "F", "S", "S"]
  const weekStart = startOfWeek(now)
  const activityByDay = [0, 0, 0, 0, 0, 0, 0]
  for (const row of weeklyActivityRes.rows) {
    const d = new Date(row.occurred_at)
    if (d < weekStart) continue
    const jsDay = d.getDay()
    const idx = jsDay === 0 ? 6 : jsDay - 1
    activityByDay[idx] = (activityByDay[idx] ?? 0) + 1
  }
  const peakIdx = activityByDay.indexOf(Math.max(...activityByDay))
  const focusByDay = dayLabels.map((day, i) => {
    const activities = activityByDay[i] ?? 0
    return {
      day,
      activities,
      peak: activities > 0 && i === peakIdx,
    }
  })

  return {
    summary: {
      streak_days: streakDays,
      lessons_completed: lessonsCompleted,
      quiz_attempts: quizAttemptCount,
      certificates: certificatesCount,
      courses_enrolled: enrollments.length,
      courses_completed: enrollments.filter((e) => e.completed).length,
      hours_completed: hoursCompleted,
      hours_goal: hoursGoal,
      weekly_goal_percent: weeklyGoalPercent,
      knowledge_growth_percent: growthPercent,
    },
    enrollments: enrollments.map((e) => ({
      id: e.id,
      course_id: e.course_id,
      progress_percent: e.progress_percent,
      completed: e.completed,
      updated_at: e.updated_at.toISOString(),
      lessons_total: e.lessons_total,
      lessons_completed: e.lessons_completed,
      course: {
        id: e.course_id,
        title: e.course_title,
        duration: e.course_duration,
      },
    })),
    knowledge_timeline: knowledgeTimeline,
    focus_by_day: focusByDay,
    course_peers: peersRes.rows,
    recent_activity: timelineRes.rows.map((row) => ({
      kind: row.kind,
      occurred_at: row.occurred_at.toISOString(),
      label: row.label,
      course_title: row.course_title,
      detail: row.detail,
    })),
  }
}
