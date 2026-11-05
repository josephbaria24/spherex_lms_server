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

async function promoteIeltsRequest(userId: string): Promise<boolean> {
  const promoted = await query(
    `INSERT INTO ielts_access_grants (user_id)
     SELECT u.id
       FROM users u
      WHERE u.id = $1
        AND EXISTS (
          SELECT 1
            FROM ielts_access_requests r
           WHERE r.user_id = u.id
              OR lower(r.email) = lower(u.email)
        )
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [userId],
  );
  return Boolean(promoted.rows[0]);
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
  if (result.rows[0]) return true;
  return promoteIeltsRequest(userId);
}

export function ieltsAccessCodeMatches(code: string): boolean {
  const expected = env.ieltsAccessCode;
  if (!expected) return false;
  const left = createHash("sha256").update(code.trim().toUpperCase()).digest();
  const right = createHash("sha256").update(expected.toUpperCase()).digest();
  return timingSafeEqual(left, right);
}
