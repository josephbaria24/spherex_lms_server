import { randomBytes } from "node:crypto";

/** Human-readable code for teachers to join an org, e.g. PETRO-A3K9 */
export function generateTeacherJoinCode(slug: string): string {
  const prefix =
    slug
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6) || "ORG";
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-${suffix}`;
}

/** Human-readable code for students to join an org, e.g. PETRO-STU-A3K9 */
export function generateStudentJoinCode(slug: string): string {
  const prefix =
    slug
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6) || "ORG";
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-STU-${suffix}`;
}
