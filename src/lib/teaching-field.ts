import { query } from "../config/db.js";
import type { TeachingField } from "./roles.js";

let ensured = false;

async function teachingFieldColumnExists(): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'teaching_field'
     ) AS exists`,
  );
  return Boolean(result.rows[0]?.exists);
}

/** Best-effort schema ensure. Never throws — prod app users often cannot ALTER. */
export async function ensureTeachingFieldColumn(): Promise<void> {
  if (ensured) return;
  try {
    if (await teachingFieldColumnExists()) {
      ensured = true;
      return;
    }
    await query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS teaching_field TEXT
         CHECK (teaching_field IS NULL OR teaching_field IN ('ielts', 'courses'))`,
    );
    ensured = true;
  } catch (err) {
    console.error("[teaching_field] could not ensure column:", err);
  }
}

export async function loadTeachingField(
  userId: string,
): Promise<TeachingField | null> {
  await ensureTeachingFieldColumn();
  if (!(await teachingFieldColumnExists())) return null;
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
