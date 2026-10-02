import { createHash, randomInt } from "node:crypto";
import { query } from "../config/db.js";
import { env } from "../config/env.js";
import { sendMail } from "./mailer.js";
import { HttpError } from "../utils/httpError.js";
import { isAdmin, isTeacher } from "./roles.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

type VerificationUser = {
  id: string;
  email: string;
  full_name: string | null;
  name: string | null;
};

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeVerificationCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

export async function assertEmailVerified(userId: string, role?: string | null): Promise<void> {
  if (isAdmin(role) || isTeacher(role)) return;

  const result = await query<{ email_verified: boolean }>(
    `SELECT COALESCE(email_verified, true) AS email_verified FROM users WHERE id = $1`,
    [userId],
  );
  if (!result.rows[0]) throw HttpError.unauthorized();
  if (!result.rows[0].email_verified) {
    throw HttpError.forbidden("Verify your email before continuing");
  }
}

export async function issueVerificationCode(
  user: VerificationUser,
  options?: { enforceCooldown?: boolean },
): Promise<{ sent: boolean }> {
  if (options?.enforceCooldown) {
    const latest = await query<{ created_at: Date }>(
      `SELECT created_at FROM email_verification_codes
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id],
    );
    const createdAt = latest.rows[0]?.created_at;
    if (createdAt && Date.now() - new Date(createdAt).getTime() < RESEND_COOLDOWN_MS) {
      throw HttpError.tooManyRequests("Wait a minute before requesting another code");
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await query(`UPDATE email_verification_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [
    user.id,
  ]);
  await query(
    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashCode(code), expiresAt],
  );

  const greeting = user.full_name ?? user.name ?? "there";
  const mail = await sendMail({
    to: user.email,
    subject: "Your SphereX verification code",
    text: [
      `Hi ${greeting},`,
      ``,
      `Your verification code is: ${code}`,
      `It expires in 10 minutes.`,
      ``,
      `If you did not create a SphereX account, you can ignore this email.`,
      ``,
      `— ${env.smtp.fromName}`,
    ].join("\n"),
  });

  return { sent: Boolean(mail.sent) };
}

export async function consumeVerificationCode(userId: string, rawCode: string): Promise<void> {
  const code = normalizeVerificationCode(rawCode);
  if (code.length !== 6) {
    throw HttpError.badRequest("Enter the 6-digit code from your email");
  }

  const row = await query<{ id: string }>(
    `SELECT id FROM email_verification_codes
      WHERE user_id = $1
        AND code_hash = $2
        AND used_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, hashCode(code)],
  );
  if (!row.rows[0]) {
    throw HttpError.badRequest("Invalid or expired verification code");
  }

  await query(`UPDATE email_verification_codes SET used_at = now() WHERE id = $1`, [row.rows[0].id]);
  await query(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, [userId]);
  await query(
    `UPDATE email_verification_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
}
