import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { signSession } from "../../utils/jwt.js";
import { HttpError } from "../../utils/httpError.js";
import { env, isProd } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { sendMail, appUrl } from "../../lib/mailer.js";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  name: string | null;
  role: "admin" | "teacher" | "student" | "user";
  status: "active" | "inactive" | "suspended";
  phone: string | null;
  notify_email: boolean;
  notify_training: boolean;
  notify_course_updates: boolean;
  must_change_password: boolean;
  created_at: Date;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  full_name: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const forgotSchema = z.object({
  email: z.string().email(),
});

const resetSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(8).max(128),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128).optional(),
  new_password: z.string().min(8).max(128),
});

function hashResetToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    name: row.name,
    role: row.role,
    status: row.status,
    phone: row.phone,
    notify_email: row.notify_email,
    notify_training: row.notify_training,
    notify_course_updates: row.notify_course_updates,
    must_change_password: row.must_change_password ?? false,
    created_at: row.created_at,
  };
}

function setSessionCookie(res: Response, token: string) {
  res.cookie(env.cookie.name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookie.secure || isProd,
    domain: env.cookie.domain,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(env.cookie.name, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookie.secure || isProd,
    domain: env.cookie.domain,
    path: "/",
  });
}

const USER_SELECT = `id, email, password_hash, full_name, name, role, status,
  phone, notify_email, notify_training, notify_course_updates,
  COALESCE(must_change_password, false) AS must_change_password, created_at`;

const router = Router();

router.post(
  "/register",
  validate(registerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password, full_name, name } = registerSchema.parse(req.body);

    const existing = await query<UserRow>(
      "SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [email],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw HttpError.conflict("Email already registered");
    }

    const password_hash = await hashPassword(password);
    const inserted = await query<UserRow>(
      `INSERT INTO users (email, password_hash, full_name, name)
       VALUES ($1, $2, $3, $4)
       RETURNING ${USER_SELECT}`,
      [email.toLowerCase(), password_hash, full_name ?? null, name ?? full_name ?? null],
    );

    const user = inserted.rows[0]!;
    const token = signSession({ sub: user.id, email: user.email, role: user.role });
    setSessionCookie(res, token);

    res.status(201).json({ user: publicUser(user), token });
  }),
);

router.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);

    const result = await query<UserRow>(
      `SELECT ${USER_SELECT}
         FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    const user = result.rows[0];
    if (!user) throw HttpError.unauthorized("Invalid email or password");
    if (user.status !== "active") throw HttpError.forbidden("Account is not active");

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw HttpError.unauthorized("Invalid email or password");

    const token = signSession({ sub: user.id, email: user.email, role: user.role });
    setSessionCookie(res, token);

    res.json({ user: publicUser(user), token });
  }),
);

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await query<UserRow>(
      `SELECT ${USER_SELECT}
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [req.user!.sub],
    );
    const user = result.rows[0];
    if (!user) throw HttpError.unauthorized();
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  "/forgot-password",
  validate(forgotSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = forgotSchema.parse(req.body);

    const result = await query<UserRow>(
      `SELECT ${USER_SELECT} FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const user = result.rows[0];

    // Always return ok to avoid email enumeration
    if (user && user.status === "active") {
      const rawToken = randomBytes(32).toString("hex");
      const token_hash = hashResetToken(rawToken);
      const expires_at = new Date(Date.now() + 60 * 60 * 1000);

      await query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [
        user.id,
      ]);
      await query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token_hash, expires_at],
      );

      const resetUrl = appUrl(`/reset-password?token=${rawToken}`);
      await sendMail({
        to: user.email,
        subject: "Reset your SphereX password",
        text: [
          `Hi ${user.full_name ?? user.name ?? "there"},`,
          ``,
          `We received a request to reset your password.`,
          `Open this link within 1 hour:`,
          resetUrl,
          ``,
          `If you did not request this, you can ignore this email.`,
          ``,
          `— ${env.smtp.fromName}`,
        ].join("\n"),
      });
    }

    res.json({
      ok: true,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  }),
);

router.post(
  "/reset-password",
  validate(resetSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = resetSchema.parse(req.body);
    const token_hash = hashResetToken(token);

    const tokenRow = await query<{
      id: string;
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens
        WHERE token_hash = $1
        LIMIT 1`,
      [token_hash],
    );
    const row = tokenRow.rows[0];
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      throw HttpError.badRequest("Invalid or expired reset link");
    }

    const password_hash = await hashPassword(password);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`,
      [password_hash, row.user_id],
    );
    await query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [row.id]);

    res.json({ ok: true, message: "Password updated. You can sign in now." });
  }),
);

router.post(
  "/change-password",
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = changePasswordSchema.parse(req.body);

    const result = await query<UserRow>(
      `SELECT ${USER_SELECT} FROM users WHERE id = $1 LIMIT 1`,
      [req.user!.sub],
    );
    const user = result.rows[0];
    if (!user) throw HttpError.unauthorized();

    if (!user.must_change_password) {
      if (!body.current_password) {
        throw HttpError.badRequest("Current password is required");
      }
      const ok = await verifyPassword(body.current_password, user.password_hash);
      if (!ok) throw HttpError.unauthorized("Current password is incorrect");
    }

    const password_hash = await hashPassword(body.new_password);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`,
      [password_hash, user.id],
    );

    res.json({ ok: true, message: "Password updated" });
  }),
);

export default router;
