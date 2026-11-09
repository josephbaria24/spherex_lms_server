import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { isAdmin } from "./roles.js";

export type CourseEnrollmentPolicy = {
  id: string;
  organization_id: string | null;
  price_cents: number;
  enroll_code: string | null;
  enroll_code_max_uses: number | null;
  enroll_code_uses: number;
  enroll_code_expires_at: Date | string | null;
};

const ENROLL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let enrollCodeColumnsReady: Promise<void> | null = null;

export async function ensureEnrollCodeColumns(): Promise<void> {
  if (!enrollCodeColumnsReady) {
    enrollCodeColumnsReady = (async () => {
      try {
        await query(
          `ALTER TABLE courses
             ADD COLUMN IF NOT EXISTS enroll_code TEXT`,
        );
        await query(
          `ALTER TABLE courses
             ADD COLUMN IF NOT EXISTS enroll_code_max_uses INTEGER`,
        );
        await query(
          `ALTER TABLE courses
             ADD COLUMN IF NOT EXISTS enroll_code_uses INTEGER NOT NULL DEFAULT 0`,
        );
        await query(
          `ALTER TABLE courses
             ADD COLUMN IF NOT EXISTS enroll_code_expires_at TIMESTAMPTZ`,
        );
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code !== "42501") throw err;
      }
    })().catch((err) => {
      enrollCodeColumnsReady = null;
      throw err;
    });
  }
  await enrollCodeColumnsReady;
}

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
  await ensureEnrollCodeColumns();
  const result = await query<CourseEnrollmentPolicy>(
    `SELECT id, organization_id, COALESCE(price_cents, 0) AS price_cents, enroll_code,
            enroll_code_max_uses,
            COALESCE(enroll_code_uses, 0) AS enroll_code_uses,
            enroll_code_expires_at
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

function assertEnrollCodeStillValid(course: CourseEnrollmentPolicy): void {
  const expiresAt = course.enroll_code_expires_at
    ? new Date(course.enroll_code_expires_at)
    : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
    throw HttpError.forbidden("This course access code has expired");
  }

  const maxUses = course.enroll_code_max_uses;
  const uses = course.enroll_code_uses ?? 0;
  if (maxUses != null && uses >= maxUses) {
    throw HttpError.forbidden("This course access code has reached its use limit");
  }
}

export async function assertCanEnrollInCourse(
  userId: string,
  course: CourseEnrollmentPolicy,
  platformRole: string | undefined,
  options: { enroll_code?: string },
): Promise<void> {
  if (isAdmin(platformRole)) return;

  const providedCode = options.enroll_code?.trim().toUpperCase() ?? "";
  const storedCode = course.enroll_code?.trim().toUpperCase() ?? "";
  const codeMatches = Boolean(storedCode && providedCode && storedCode === providedCode);

  if (codeMatches) {
    assertEnrollCodeStillValid(course);
    return;
  }

  const isPaid = course.price_cents > 0;
  if (isPaid) {
    throw HttpError.paymentRequired(
      "This course requires payment request approval or a valid enrollment code",
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

/** Count a successful new enrollment that used the course access code. */
export async function recordEnrollCodeUse(courseId: string, enrollCode?: string): Promise<void> {
  const provided = enrollCode?.trim().toUpperCase() ?? "";
  if (!provided) return;
  await ensureEnrollCodeColumns();
  await query(
    `UPDATE courses
        SET enroll_code_uses = COALESCE(enroll_code_uses, 0) + 1
      WHERE id = $1
        AND enroll_code IS NOT NULL
        AND upper(enroll_code) = $2`,
    [courseId, provided],
  );
}

export async function ensureUniqueEnrollCode(excludeCourseId?: string): Promise<string> {
  await ensureEnrollCodeColumns();
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
