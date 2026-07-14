import { Router, type Request, type Response } from "express";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";

interface ActivityRow {
  id: string;
  user_name: string;
  action: string;
  target: string;
  occurred_at: Date;
}

const router = Router();

router.use(requireAuth, requireAdmin);

// GET /admin/dashboard
router.get(
  "/dashboard",
  asyncHandler(async (_req: Request, res: Response) => {
    const [userStats, courseStats, materialStats, enrollmentStats, recentActivity] =
      await Promise.all([
        query<{ total: string; new_month: string }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::text AS new_month
           FROM users`,
        ),
        query<{ total: string; new_week: string }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::text AS new_week
           FROM courses`,
        ),
        query<{ total: string; new_week: string }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::text AS new_week
           FROM materials`,
        ),
        query<{
          total: string;
          completed: string;
          rate_now: string | null;
          rate_prior: string | null;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE completed)::text AS completed,
             CASE
               WHEN COUNT(*) = 0 THEN NULL
               ELSE ROUND(
                 100.0 * COUNT(*) FILTER (WHERE completed) / COUNT(*),
                 1
               )::text
             END AS rate_now,
             CASE
               WHEN COUNT(*) FILTER (WHERE created_at < now() - interval '30 days') = 0 THEN NULL
               ELSE ROUND(
                 100.0 * COUNT(*) FILTER (
                   WHERE completed AND created_at < now() - interval '30 days'
                 ) / COUNT(*) FILTER (WHERE created_at < now() - interval '30 days'),
                 1
               )::text
             END AS rate_prior
           FROM enrollments`,
        ),
        query<ActivityRow>(
          `SELECT * FROM (
             SELECT
               e.id::text AS id,
               COALESCE(u.full_name, u.name, u.email) AS user_name,
               'enrolled in' AS action,
               c.title AS target,
               e.created_at AS occurred_at
             FROM enrollments e
             JOIN users u ON u.id = e.user_id
             JOIN courses c ON c.id = e.course_id
             UNION ALL
             SELECT
               e.id::text || '-completed' AS id,
               COALESCE(u.full_name, u.name, u.email) AS user_name,
               'completed' AS action,
               c.title AS target,
               e.completed_at AS occurred_at
             FROM enrollments e
             JOIN users u ON u.id = e.user_id
             JOIN courses c ON c.id = e.course_id
             WHERE e.completed AND e.completed_at IS NOT NULL
             UNION ALL
             SELECT
               m.id::text AS id,
               COALESCE(u.full_name, u.name, u.email, 'Someone') AS user_name,
               'uploaded' AS action,
               m.title AS target,
               m.created_at AS occurred_at
             FROM materials m
             LEFT JOIN users u ON u.id = m.uploaded_by
           ) activity
           ORDER BY occurred_at DESC
           LIMIT 8`,
        ),
      ]);

    const totalUsers = Number(userStats.rows[0]?.total ?? 0);
    const newUsersMonth = Number(userStats.rows[0]?.new_month ?? 0);
    const totalCourses = Number(courseStats.rows[0]?.total ?? 0);
    const newCoursesWeek = Number(courseStats.rows[0]?.new_week ?? 0);
    const totalMaterials = Number(materialStats.rows[0]?.total ?? 0);
    const newMaterialsWeek = Number(materialStats.rows[0]?.new_week ?? 0);
    const completionRate = Number(enrollmentStats.rows[0]?.rate_now ?? 0);
    const priorCompletionRate = enrollmentStats.rows[0]?.rate_prior
      ? Number(enrollmentStats.rows[0].rate_prior)
      : null;
    const completionDelta =
      priorCompletionRate !== null ? completionRate - priorCompletionRate : null;

    const formatUserChange = () => {
      if (newUsersMonth === 0) return "No new users this month";
      const prior = totalUsers - newUsersMonth;
      if (prior <= 0) return `+${newUsersMonth} this month`;
      const pct = ((newUsersMonth / prior) * 100).toFixed(1);
      return `+${pct}%`;
    };

    const formatCompletionChange = () => {
      if (completionDelta === null) return "No prior data";
      if (completionDelta === 0) return "Unchanged vs last month";
      const sign = completionDelta > 0 ? "+" : "";
      return `${sign}${completionDelta.toFixed(1)}%`;
    };

    res.json({
      stats: {
        total_users: totalUsers,
        active_courses: totalCourses,
        materials: totalMaterials,
        completion_rate: completionRate,
      },
      changes: {
        users: formatUserChange(),
        courses: newCoursesWeek > 0 ? `+${newCoursesWeek} new` : "No new courses this week",
        materials:
          newMaterialsWeek > 0 ? `+${newMaterialsWeek} this week` : "No uploads this week",
        completion_rate: formatCompletionChange(),
      },
      recent_activity: recentActivity.rows.map((row) => ({
        id: row.id,
        user: row.user_name,
        action: row.action,
        target: row.target,
        occurred_at: row.occurred_at,
      })),
    });
  }),
);

export default router;
