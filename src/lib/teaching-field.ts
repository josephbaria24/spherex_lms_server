import { query } from "../config/db.js";
import type { TeachingField } from "./roles.js";

let ensured = false;

export async function ensureTeachingFieldColumn(): Promise<void> {
  if (ensured) return;
  await query(
    `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS teaching_field TEXT
       CHECK (teaching_field IS NULL OR teaching_field IN ('ielts', 'courses'))`,
  );
  ensured = true;
}

export async function loadTeachingField(
  userId: string,
): Promise<TeachingField | null> {
  await ensureTeachingFieldColumn();
  const result = await query<{ teaching_field: string | null }>(
    `SELECT teaching_field FROM users WHERE id = $1`,
    [userId],
  );
  const value = result.rows[0]?.teaching_field;
  if (value === "ielts" || value === "courses") return value;
  return null;
}

export function normalizeTeachingField(
  role: string | undefined,
  field: string | null | undefined,
): TeachingField | null {
  if (role !== "teacher") return null;
  if (field === "ielts" || field === "courses") return field;
  return "courses";
}
