import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { isAdmin } from "./roles.js";
import { ORG_MEMBER_ROLES } from "./org-types.js";
import type { OrgMemberRole } from "./org-types.js";

const STAFF_PREVIEW_ROLES: OrgMemberRole[] = [
  ORG_MEMBER_ROLES.OWNER,
  ORG_MEMBER_ROLES.ADMIN,
  ORG_MEMBER_ROLES.TEACHER,
];

export type LearnAccess = { preview: boolean };

/** Students must be enrolled; platform/org staff may preview without enrollment. */
export async function assertLearnAccess(
  userId: string,
  courseId: string,
  platformRole?: string | null,
): Promise<LearnAccess> {
  if (isAdmin(platformRole)) {
    return { preview: true };
  }

  const enrollment = await query(
    "SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2",
    [userId, courseId],
  );
  if (enrollment.rows[0]) {
    return { preview: false };
  }

  const courseResult = await query<{ organization_id: string | null }>(
    "SELECT organization_id FROM courses WHERE id = $1",
    [courseId],
  );
  const course = courseResult.rows[0];
  if (!course) throw HttpError.notFound("Course not found");

  if (course.organization_id) {
    const member = await query<{ role: OrgMemberRole }>(
      `SELECT role FROM organization_members
        WHERE organization_id = $1 AND user_id = $2`,
      [course.organization_id, userId],
    );
    if (member.rows[0] && STAFF_PREVIEW_ROLES.includes(member.rows[0].role)) {
      return { preview: true };
    }
  }

  throw HttpError.forbidden("Enroll in this course to access lessons");
}

/** Ensure the user belongs to the org that owns the course (when course is org-scoped). */
export async function assertOrgAccessForCourse(
  userId: string,
  courseId: string,
  platformRole?: string | null,
): Promise<void> {
  if (isAdmin(platformRole)) return;

  const courseResult = await query<{ organization_id: string | null }>(
    "SELECT organization_id FROM courses WHERE id = $1",
    [courseId],
  );
  const course = courseResult.rows[0];
  if (!course) throw HttpError.notFound("Course not found");
  if (!course.organization_id) return;

  const member = await query(
    "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    [course.organization_id, userId],
  );
  if (!member.rows[0]) {
    throw HttpError.forbidden(
      "Join this organization with a student code before accessing this course",
    );
  }
}
