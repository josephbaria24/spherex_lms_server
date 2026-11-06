import { createHash, timingSafeEqual } from "node:crypto";
import { query } from "../config/db.js";
import { env } from "../config/env.js";
import { isAdmin } from "./roles.js";

export async function grantIeltsAccess(userId: string): Promise<void> {
  await query(
    `INSERT INTO ielts_access_grants (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

/** Unlocks every IELTS material for the account registered with this email. */
export async function grantIeltsAccessByEmail(email: string): Promise<void> {
  await query(
    `INSERT INTO ielts_access_grants (user_id)
     SELECT id FROM users WHERE lower(email) = lower($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [email],
  );
}

export async function revokeIeltsAccessByEmail(email: string): Promise<void> {
  await query(
    `DELETE FROM ielts_access_grants
      WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [email],
  );
}

export async function userHasIeltsAccess(
  userId: string | undefined,
  role?: string | null,
): Promise<boolean> {
  if (isAdmin(role)) return true;
  if (!userId) return false;
  const result = await query(
    "SELECT 1 FROM ielts_access_grants WHERE user_id = $1",
    [userId],
  );
  return Boolean(result.rows[0]);
}

export function ieltsAccessCodeMatches(code: string): boolean {
  const expected = env.ieltsAccessCode;
  if (!expected) return false;
  const left = createHash("sha256").update(code.trim().toUpperCase()).digest();
  const right = createHash("sha256").update(expected.toUpperCase()).digest();
  return timingSafeEqual(left, right);
}
