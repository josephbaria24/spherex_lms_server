import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  grantIeltsAccess,
  grantIeltsAccessByEmail,
  ieltsAccessCodeMatches,
  revokeIeltsAccessByEmail,
  userHasIeltsAccess,
} from "../../lib/ielts-access.js";
import { sendMail } from "../../lib/mailer.js";
import { listAdminUserIds, notifyUsers } from "../../lib/notifications.js";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { paymentRequestRateLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";

const requestSchema = z.object({
  training: z.string().trim().min(2).max(120),
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(7).max(40),
});

const codeSchema = z.object({
  code: z.string().trim().min(4).max(64),
});

const idParam = z.object({
  id: z.string().uuid(),
});

async function ensureRequestStatusColumn(): Promise<void> {
  await query(
    `ALTER TABLE ielts_access_requests
       ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
  );
}

const answerKeysSchema = z.object({
  show_answer_keys: z.boolean(),
});

async function readShowAnswerKeys(): Promise<boolean> {
  await query(
    `CREATE TABLE IF NOT EXISTS ielts_catalog_settings (
       id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       show_answer_keys BOOLEAN NOT NULL DEFAULT false,
       updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await query(
    `INSERT INTO ielts_catalog_settings (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`,
  );
  const result = await query<{ show_answer_keys: boolean }>(
    `SELECT show_answer_keys FROM ielts_catalog_settings WHERE id = 1`,
  );
  return Boolean(result.rows[0]?.show_answer_keys);
}

const router = Router();

router.get(
  "/ielts/answer-keys",
  asyncHandler(async (_req: Request, res: Response) => {
    const show_answer_keys = await readShowAnswerKeys();
    res.setHeader("Cache-Control", "no-store");
    res.json({ show_answer_keys });
  }),
);

router.patch(
  "/ielts/answer-keys",
  requireAuth,
  requireAdmin,
  validate(answerKeysSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { show_answer_keys } = answerKeysSchema.parse(req.body);
    await readShowAnswerKeys();
    const updated = await query<{ show_answer_keys: boolean }>(
      `UPDATE ielts_catalog_settings
          SET show_answer_keys = $1,
              updated_at = now()
        WHERE id = 1
        RETURNING show_answer_keys`,
      [show_answer_keys],
    );
    res.json({ show_answer_keys: Boolean(updated.rows[0]?.show_answer_keys) });
  }),
);

router.get(
  "/ielts/access",
  asyncHandler(async (req: Request, res: Response) => {
    const unlocked = await userHasIeltsAccess(req.user?.sub, req.user?.role);
    res.json({ unlocked });
  }),
);

router.post(
  "/ielts/access",
  requireAuth,
  validate(codeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code } = codeSchema.parse(req.body);
    if (!env.ieltsAccessCode) {
      throw HttpError.badRequest("IELTS access codes are not set up yet. Request access first.");
    }
    if (!ieltsAccessCodeMatches(code)) {
      throw HttpError.badRequest("That access code is not valid");
    }
    await grantIeltsAccess(req.user!.sub);
    res.json({ unlocked: true });
  }),
);

router.post(
  "/ielts/access-request",
  paymentRequestRateLimiter,
  validate(requestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = requestSchema.parse(req.body);
    await ensureRequestStatusColumn();
    const inserted = await query<{ id: string }>(
      `INSERT INTO ielts_access_requests (user_id, training, full_name, email, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        req.user?.sub ?? null,
        body.training,
        body.full_name,
        body.email.toLowerCase(),
        body.phone,
      ],
    );
    const requestId = inserted.rows[0]?.id;

    const adminIds = await listAdminUserIds();
    await notifyUsers(adminIds, {
      type: "ielts.access_requested",
      title: "IELTS access request",
      body: `${body.full_name} requested access to ${body.training}. ${body.email} · ${body.phone}`,
      link: "/admin/ielts",
      referenceId: requestId,
    });

    const recipients = [
      ...new Set(
        [env.supportEmail, "jlb@petrosphere.com.ph", "jmm@petrosphere.com.ph"]
          .map((address) => address.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    let mailed = false;
    try {
      const mail = await sendMail({
        to: recipients.join(", "),
        replyTo: body.email,
        subject: `IELTS access request — ${body.training}`,
        text: [
          `${body.full_name} requested access to ${body.training}.`,
          ``,
          `Email: ${body.email}`,
          `Phone: ${body.phone}`,
          req.user?.sub ? `Account: ${req.user.sub}` : "Account: not signed in",
          ``,
          `This request is pending. Materials stay locked until an admin accepts it.`,
        ].join("\n"),
      });
      mailed = mail.sent;
    } catch (err) {
      console.error("IELTS access request email failed:", err);
    }

    res.json({
      ok: true,
      unlocked: false,
      message: mailed
        ? "Request sent. An admin still needs to accept it before IELTS materials open."
        : "Request saved. An admin still needs to accept it before IELTS materials open.",
    });
  }),
);

router.get(
  "/ielts/access-requests",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    await ensureRequestStatusColumn();
    const result = await query(
      `SELECT id, user_id, training, full_name, email, phone, status, created_at
         FROM ielts_access_requests
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    res.json({ requests: result.rows });
  }),
);

router.post(
  "/ielts/access-requests/:id/accept",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    await ensureRequestStatusColumn();
    const { id } = idParam.parse(req.params);
    const updated = await query<{
      id: string;
      user_id: string | null;
      email: string;
      full_name: string;
      training: string;
    }>(
      `UPDATE ielts_access_requests
          SET status = 'accepted'
        WHERE id = $1 AND status = 'pending'
        RETURNING id, user_id, email, full_name, training`,
      [id],
    );
    const request = updated.rows[0];
    if (!request) throw HttpError.badRequest("That request is no longer pending");
    if (request.user_id) await grantIeltsAccess(request.user_id);
    await grantIeltsAccessByEmail(request.email);
    res.json({ ok: true, status: "accepted" });
  }),
);

router.post(
  "/ielts/access-requests/:id/reject",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    await ensureRequestStatusColumn();
    const { id } = idParam.parse(req.params);
    const updated = await query<{ user_id: string | null; email: string }>(
      `UPDATE ielts_access_requests
          SET status = 'rejected'
        WHERE id = $1 AND status = 'pending'
        RETURNING user_id, email`,
      [id],
    );
    const request = updated.rows[0];
    if (!request) throw HttpError.badRequest("That request is no longer pending");
    if (request.user_id) {
      await query("DELETE FROM ielts_access_grants WHERE user_id = $1", [request.user_id]);
    }
    await revokeIeltsAccessByEmail(request.email);
    res.json({ ok: true, status: "rejected" });
  }),
);

export default router;
