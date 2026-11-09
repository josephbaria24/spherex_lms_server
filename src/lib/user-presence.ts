import { query } from "../config/db.js";

/** Consider a user online if seen within this window. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

let presenceColumnsReady: Promise<void> | null = null;

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return result.rows[0]?.exists === true;
}

export async function ensureUserPresenceColumns(): Promise<void> {
  if (!presenceColumnsReady) {
    presenceColumnsReady = (async () => {
      const needed = [
        ["last_login_at", "TIMESTAMPTZ"],
        ["last_seen_at", "TIMESTAMPTZ"],
        ["active_course_id", "UUID"],
      ] as const;

      for (const [column, definition] of needed) {
        if (await columnExists("users", column)) continue;
        try {
          await query(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? String((err as { code?: unknown }).code ?? "")
              : "";
          if (code === "42501" || code === "42701") continue;
          throw err;
        }
      }
    })().catch((err) => {
      presenceColumnsReady = null;
      throw err;
    });
  }
  await presenceColumnsReady;
}

export function isUserOnline(lastSeenAt: string | Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return Date.now() - seen <= ONLINE_WINDOW_MS;
}

export async function recordLoginPresence(userId: string): Promise<void> {
  await ensureUserPresenceColumns();
  await query(
    `UPDATE users
        SET last_login_at = now(),
            last_seen_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [userId],
  );
}

export async function touchUserPresence(
  userId: string,
  options?: { courseId?: string | null; clearCourse?: boolean },
): Promise<void> {
  await ensureUserPresenceColumns();
  if (options?.clearCourse) {
    await query(
      `UPDATE users
          SET last_seen_at = now(),
              active_course_id = NULL,
              updated_at = now()
        WHERE id = $1`,
      [userId],
    );
    return;
  }
  if (options?.courseId) {
    const course = await query<{ id: string }>(`SELECT id FROM courses WHERE id = $1`, [
      options.courseId,
    ]);
    if (!course.rows[0]) {
      await query(
        `UPDATE users SET last_seen_at = now(), updated_at = now() WHERE id = $1`,
        [userId],
      );
      return;
    }
    await query(
      `UPDATE users
          SET last_seen_at = now(),
              active_course_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [userId, options.courseId],
    );
    return;
  }
  await query(
    `UPDATE users SET last_seen_at = now(), updated_at = now() WHERE id = $1`,
    [userId],
  );
}
