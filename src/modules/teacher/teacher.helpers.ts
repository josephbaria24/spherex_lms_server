import type { Request } from "express";
import { query } from "../../config/db.js";
import { assertOrgRoleFromRequest } from "../../lib/org-helpers.js";
import { ORG_MEMBER_ROLES } from "../../lib/org-types.js";
import type { OrgMemberRole } from "../../lib/org-types.js";
import { HttpError } from "../../utils/httpError.js";

const TEACHING_ORG_ROLES: OrgMemberRole[] = [
  ORG_MEMBER_ROLES.OWNER,
  ORG_MEMBER_ROLES.ADMIN,
  ORG_MEMBER_ROLES.TEACHER,
];

export async function assertTeacherOrgAccess(req: Request, organizationId: string) {
  return assertOrgRoleFromRequest(req, organizationId, TEACHING_ORG_ROLES);
}

export async function getTeacherCourseIds(
  userId: string,
  role: string,
  organizationId: string,
): Promise<string[]> {
  if (role === "admin") {
    const result = await query<{ id: string }>(
      "SELECT id FROM courses WHERE organization_id = $1",
      [organizationId],
    );
    return result.rows.map((r) => r.id);
  }

  const result = await query<{ course_id: string }>(
    `SELECT ci.course_id
       FROM course_instructors ci
       JOIN courses c ON c.id = ci.course_id
      WHERE ci.teacher_id = $1 AND c.organization_id = $2`,
    [userId, organizationId],
  );
  return result.rows.map((r) => r.course_id);
}

export async function assertTeacherCourseAccess(
  req: Request,
  courseId: string,
  organizationId: string,
): Promise<void> {
  if (!req.user) throw HttpError.unauthorized();

  const courseCheck = await query<{ organization_id: string | null }>(
    "SELECT organization_id FROM courses WHERE id = $1",
    [courseId],
  );
  const course = courseCheck.rows[0];
  if (!course) throw HttpError.notFound("Course not found");
  if (course.organization_id !== organizationId) {
    throw HttpError.forbidden("Course does not belong to this organization");
  }

  const ids = await getTeacherCourseIds(req.user.sub, req.user.role, organizationId);
  if (!ids.includes(courseId)) {
    throw HttpError.forbidden("You do not teach this course");
  }
}

export async function assertTeacherEnrollmentAccess(
  req: Request,
  enrollmentId: string,
  organizationId: string,
): Promise<{ course_id: string }> {
  const result = await query<{ course_id: string }>(
    "SELECT course_id FROM enrollments WHERE id = $1",
    [enrollmentId],
  );
  const row = result.rows[0];
  if (!row) throw HttpError.notFound("Enrollment not found");
  await assertTeacherCourseAccess(req, row.course_id, organizationId);
  return row;
}
