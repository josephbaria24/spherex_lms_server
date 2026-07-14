import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { isAdmin } from "./roles.js";

export type CourseEnrollmentPolicy = {
  id: string;
  organization_id: string | null;
  price_cents: number;
  enroll_code: string | null;
};

const ENROLL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCourseEnrollCode(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += ENROLL_CODE_CHARS[Math.floor(Math.random() * ENROLL_CODE_CHARS.length)];
  }
  return `ENR-${suffix}`;
}

export async function getCourseEnrollmentPolicy(
  courseId: string,
): Promise<CourseEnrollmentPolicy | null> {
  const result = await query<CourseEnrollmentPolicy>(
    `SELECT id, organization_id, COALESCE(price_cents, 0) AS price_cents, enroll_code
       FROM courses WHERE id = $1`,
    [courseId],
  );
  return result.rows[0] ?? null;
}

export async function userIsOrgMember(userId: string, organizationId: string): Promise<boolean> {
  const member = await query(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return Boolean(member.rows[0]);
}

export async function assertCanEnrollInCourse(
  userId: string,
  course: CourseEnrollmentPolicy,
  platformRole: string | undefined,
  options: { enroll_code?: string; payment_confirmed?: boolean },
): Promise<void> {
  if (isAdmin(platformRole)) return;

  const providedCode = options.enroll_code?.trim().toUpperCase() ?? "";
  const storedCode = course.enroll_code?.trim().toUpperCase() ?? "";
  const codeMatches = Boolean(storedCode && providedCode && storedCode === providedCode);

  if (codeMatches) return;

  const isPaid = course.price_cents > 0;
  if (isPaid) {
    if (options.payment_confirmed) return;
    throw HttpError.paymentRequired(
      "This course requires payment or a valid enrollment code",
    );
  }

  if (!course.organization_id) return;

  const isMember = await userIsOrgMember(userId, course.organization_id);
  if (isMember) return;

  if (storedCode) {
    throw HttpError.forbidden(
      "Join your organization, enter an enrollment code, or pay to enroll in this course",
    );
  }

  throw HttpError.forbidden(
    "Join your organization with a student code before enrolling in this course",
  );
}

export async function ensureUniqueEnrollCode(excludeCourseId?: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateCourseEnrollCode();
    const clash = await query(
      `SELECT id FROM courses
        WHERE upper(enroll_code) = $1
          AND ($2::uuid IS NULL OR id <> $2)`,
      [code, excludeCourseId ?? null],
    );
    if (!clash.rows[0]) return code;
  }
  throw HttpError.conflict("Could not generate a unique enrollment code");
}
