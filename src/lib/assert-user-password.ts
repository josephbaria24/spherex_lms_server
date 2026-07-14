import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { verifyPassword } from "../utils/password.js";

export async function assertUserPassword(userId: string, password: string): Promise<void> {
  const result = await query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw HttpError.unauthorized();

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw HttpError.unauthorized("Incorrect password");
}
