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
       RETURNING id, email, password_hash, full_name, name, role, status, created_at`,
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
      `SELECT id, email, password_hash, full_name, name, role, status, created_at
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
      `SELECT id, email, password_hash, full_name, name, role, status,
              phone, notify_email, notify_training, notify_course_updates, created_at
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

export default router;
