/**
 * Seeds the Petrosphere SCORM Library course with Hostinger articulate lessons (119–127).
 * Run: npm run db:seed:scorm
 */
import { pool, query } from "../src/config/db.js";
import {
  HOSTINGER_SCORM_PACKAGES,
  PETROSPHERE_SCORM_COURSE,
  scormStoryUrl,
} from "../src/lib/scorm-catalog.js";

async function main() {
  const org = await query<{ id: string }>(
    "SELECT id FROM organizations WHERE slug = 'petrosphere'",
  );
  const orgId = org.rows[0]?.id;
  if (!orgId) {
    throw new Error("Petrosphere organization not found — run db:seed first");
  }

  const teacher = await query<{ id: string }>(
    `SELECT u.id FROM users u
       JOIN organization_members om ON om.user_id = u.id
      WHERE om.organization_id = $1 AND om.role = 'teacher'
      LIMIT 1`,
    [orgId],
  );
  const teacherId = teacher.rows[0]?.id ?? null;

  await query(
    `INSERT INTO courses (title, description, category, level, duration, organization_id)
     SELECT $1, $2, $3, $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title = $1 AND organization_id = $6)`,
    [
      PETROSPHERE_SCORM_COURSE.title,
      PETROSPHERE_SCORM_COURSE.description,
      PETROSPHERE_SCORM_COURSE.category,
      PETROSPHERE_SCORM_COURSE.level,
      PETROSPHERE_SCORM_COURSE.duration,
      orgId,
    ],
  );

  await query(
    `UPDATE courses SET
       description = $2,
       category = $3,
       level = $4,
       duration = $5,
       organization_id = $6
     WHERE title = $1`,
    [
      PETROSPHERE_SCORM_COURSE.title,
      PETROSPHERE_SCORM_COURSE.description,
      PETROSPHERE_SCORM_COURSE.category,
      PETROSPHERE_SCORM_COURSE.level,
      PETROSPHERE_SCORM_COURSE.duration,
      orgId,
    ],
  );

  const course = await query<{ id: string }>(
    "SELECT id FROM courses WHERE title = $1 AND organization_id = $2",
    [PETROSPHERE_SCORM_COURSE.title, orgId],
  );
  const courseId = course.rows[0]?.id;
  if (!courseId) throw new Error("Could not create SCORM course");

  if (teacherId) {
    await query(
      `INSERT INTO course_instructors (course_id, teacher_id)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM course_instructors WHERE course_id = $1 AND teacher_id = $2
       )`,
      [courseId, teacherId],
    );
  }

  let sort = 1;
  for (const pkg of HOSTINGER_SCORM_PACKAGES) {
    const url = scormStoryUrl(pkg.packageId);
    await query(
      `INSERT INTO lessons (course_id, title, description, content_type, articulate_url,
                            sort_order, status, created_by, duration_minutes)
       SELECT $1, $2, $3, 'articulate', $4, $5, 'published', $6, 60
       WHERE NOT EXISTS (
         SELECT 1 FROM lessons WHERE course_id = $1 AND articulate_url = $4
       )`,
      [courseId, pkg.title, pkg.description ?? null, url, sort, teacherId],
    );
    await query(
      `UPDATE lessons SET
         title = $3,
         description = COALESCE($4, description),
         sort_order = $5,
         status = 'published',
         content_type = 'articulate'
       WHERE course_id = $1 AND articulate_url = $2`,
      [courseId, url, pkg.title, pkg.description ?? null, sort],
    );
    sort += 1;
  }

  await query(
    `UPDATE courses SET lessons = (SELECT COUNT(*)::int FROM lessons WHERE course_id = $1) WHERE id = $1`,
    [courseId],
  );

  // eslint-disable-next-line no-console
  console.log(
    `[seed:scorm] Petrosphere SCORM Library ready (${HOSTINGER_SCORM_PACKAGES.length} lessons, course ${courseId})`,
  );

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed:scorm] failed:", err);
  process.exit(1);
});
