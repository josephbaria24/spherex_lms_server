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
import { appUrl, sendMail } from "../../lib/mailer.js";
import { listAdminUserIds, notifyUsers } from "../../lib/notifications.js";
import { requireAuth, requireIeltsStaff } from "../../middleware/auth.js";
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

const MOCK_IDS = ["mock-1", "mock-2", "mock-3", "mock-4", "mock-5"] as const;

const mockSessionSchema = z.object({
  mock_session_open: z.boolean(),
  open_mock_ids: z.array(z.enum(MOCK_IDS)).optional(),
});

const trackInterestSchema = z.object({
  track: z.literal("ukvi"),
});

async function ensureTrackInterestTable(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS ielts_track_interest (
       id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       track      TEXT NOT NULL CHECK (track IN ('ukvi')),
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (user_id, track)
     )`,
  );
}

function normalizeOpenMockIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item))
    .filter((id): id is (typeof MOCK_IDS)[number] =>
      (MOCK_IDS as readonly string[]).includes(id),
    );
}

async function readCatalogSettings(): Promise<{
  show_answer_keys: boolean;
  mock_session_open: boolean;
  open_mock_ids: string[];
}> {
  await query(
    `CREATE TABLE IF NOT EXISTS ielts_catalog_settings (
       id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       show_answer_keys  BOOLEAN NOT NULL DEFAULT false,
       mock_session_open BOOLEAN NOT NULL DEFAULT false,
       open_mock_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
       updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await query(
    `ALTER TABLE ielts_catalog_settings
       ADD COLUMN IF NOT EXISTS mock_session_open BOOLEAN NOT NULL DEFAULT false`,
  );
  await query(
    `ALTER TABLE ielts_catalog_settings
       ADD COLUMN IF NOT EXISTS open_mock_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
  );
  await query(
    `INSERT INTO ielts_catalog_settings (id)
     VALUES (1)
     ON CONFLICT (id) DO NOTHING`,
  );
  const result = await query<{
    show_answer_keys: boolean;
    mock_session_open: boolean;
    open_mock_ids: unknown;
  }>(
    `SELECT show_answer_keys, mock_session_open, open_mock_ids
       FROM ielts_catalog_settings WHERE id = 1`,
  );
  return {
    show_answer_keys: Boolean(result.rows[0]?.show_answer_keys),
    mock_session_open: Boolean(result.rows[0]?.mock_session_open),
    open_mock_ids: normalizeOpenMockIds(result.rows[0]?.open_mock_ids),
  };
}

const router = Router();

router.get(
  "/ielts/answer-keys",
  asyncHandler(async (_req: Request, res: Response) => {
    const settings = await readCatalogSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json(settings);
  }),
);

router.patch(
  "/ielts/mock-session",
  requireAuth,
  requireIeltsStaff,
  validate(mockSessionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = mockSessionSchema.parse(req.body);
    await readCatalogSettings();
    const openMockIds = body.mock_session_open
      ? normalizeOpenMockIds(body.open_mock_ids ?? MOCK_IDS)
      : [];
    if (body.mock_session_open && openMockIds.length === 0) {
      throw HttpError.badRequest("Choose at least one mock test to open");
    }
    const updated = await query<{
      mock_session_open: boolean;
      open_mock_ids: unknown;
    }>(
      `UPDATE ielts_catalog_settings
          SET mock_session_open = $1,
              open_mock_ids = $2::jsonb,
              updated_at = now()
        WHERE id = 1
        RETURNING mock_session_open, open_mock_ids`,
      [body.mock_session_open, JSON.stringify(openMockIds)],
    );
    res.json({
      mock_session_open: Boolean(updated.rows[0]?.mock_session_open),
      open_mock_ids: normalizeOpenMockIds(updated.rows[0]?.open_mock_ids),
    });
  }),
);

router.patch(
  "/ielts/answer-keys",
  requireAuth,
  requireIeltsStaff,
  validate(answerKeysSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { show_answer_keys } = answerKeysSchema.parse(req.body);
    await readCatalogSettings();
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
  "/ielts/track-interest",
  requireAuth,
  requireIeltsStaff,
  asyncHandler(async (_req: Request, res: Response) => {
    await ensureTrackInterestTable();
    const result = await query<{
      id: string;
      created_at: string;
      full_name: string | null;
      name: string | null;
      email: string;
    }>(
      `SELECT i.id, i.created_at, u.full_name, u.name, u.email
         FROM ielts_track_interest i
         JOIN users u ON u.id = i.user_id
        WHERE i.track = 'ukvi'
        ORDER BY i.created_at DESC`,
    );
    res.json({
      count: result.rows.length,
      requests: result.rows.map((row) => ({
        id: row.id,
        name: row.full_name || row.name || row.email,
        email: row.email,
        created_at: row.created_at,
      })),
    });
  }),
);

router.get(
  "/ielts/track-interest/mine",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await ensureTrackInterestTable();
    const result = await query(
      `SELECT 1 FROM ielts_track_interest WHERE user_id = $1 AND track = 'ukvi'`,
      [req.user!.sub],
    );
    res.json({ requested: Boolean(result.rows[0]) });
  }),
);

router.post(
  "/ielts/track-interest",
  requireAuth,
  validate(trackInterestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await ensureTrackInterestTable();
    const inserted = await query<{ id: string }>(
      `INSERT INTO ielts_track_interest (user_id, track)
       VALUES ($1, 'ukvi')
       ON CONFLICT (user_id, track) DO NOTHING
       RETURNING id`,
      [req.user!.sub],
    );
    const created = Boolean(inserted.rows[0]);
    if (created) {
      const person = await query<{ full_name: string | null; name: string | null; email: string }>(
        `SELECT full_name, name, email FROM users WHERE id = $1`,
        [req.user!.sub],
      );
      const row = person.rows[0];
      const name = row?.full_name || row?.name || row?.email || "A learner";
      const adminIds = await listAdminUserIds();
      await notifyUsers(adminIds, {
        type: "ielts.ukvi_requested",
        title: "UKVI IELTS requested",
        body: `${name} asked for IELTS for UKVI Life Skills.`,
        link: "/admin/ielts",
        referenceId: inserted.rows[0]?.id,
      });
    }
    res.json({ requested: true, created });
  }),
);

router.get(
  "/ielts/access",
  asyncHandler(async (req: Request, res: Response) => {
    const unlocked = await userHasIeltsAccess(
      req.user?.sub,
      req.user?.role,
      req.user?.teaching_field,
    );
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

    const { STAFF_COMPLETION_EMAILS } = await import("../../lib/completion-alerts.js");
    const recipients = [
      ...new Set(
        [env.supportEmail, ...STAFF_COMPLETION_EMAILS]
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
  requireIeltsStaff,
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
  requireIeltsStaff,
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
  requireIeltsStaff,
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

const announceSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(3).max(5000),
  audience: z.enum(["granted", "active", "all_learners"]).default("granted"),
});

const learnerProfileSchema = z.object({
  full_name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
});

const idParamLike = z.object({ id: z.string().uuid() });

// POST /reviewers/ielts/announce — email IELTS learners
router.post(
  "/ielts/announce",
  requireAuth,
  requireIeltsStaff,
  validate(announceSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = announceSchema.parse(req.body);
    const audienceSql =
      body.audience === "granted"
        ? `JOIN ielts_access_grants g ON g.user_id = u.id`
        : body.audience === "active"
          ? `JOIN reviewer_quiz_attempts a ON a.user_id = u.id
             JOIN reviewer_quizzes q ON q.id = a.quiz_id AND q.exam_type = 'IELTS'`
          : `WHERE u.id IN (
               SELECT user_id FROM ielts_access_grants
               UNION
               SELECT a.user_id
                 FROM reviewer_quiz_attempts a
                 JOIN reviewer_quizzes q ON q.id = a.quiz_id AND q.exam_type = 'IELTS'
                WHERE a.user_id IS NOT NULL
             )`;
    const statusClause =
      body.audience === "all_learners"
        ? `AND u.email IS NOT NULL AND u.status = 'active'`
        : `WHERE u.email IS NOT NULL AND u.status = 'active'`;
    const sql = `
      SELECT DISTINCT u.id, u.email,
             COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email) AS name
        FROM users u
        ${audienceSql}
        ${statusClause}`;

    const recipients = await query<{ id: string; email: string; name: string }>(sql);
    let sent = 0;
    let skipped = 0;
    for (const recipient of recipients.rows) {
      const result = await sendMail({
        to: recipient.email,
        subject: body.subject,
        text: [
          `Hi ${recipient.name},`,
          "",
          body.message,
          "",
          "— PetroCademia IELTS",
          appUrl("/ielts"),
        ].join("\n"),
      });
      if (result.sent) sent += 1;
      else skipped += 1;
    }
    res.json({
      ok: true,
      recipients: recipients.rows.length,
      sent,
      skipped,
    });
  }),
);

// PATCH /reviewers/ielts/learners/:id — update learner contact profile
router.patch(
  "/ielts/learners/:id",
  requireAuth,
  requireIeltsStaff,
  validate(idParamLike, "params"),
  validate(learnerProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParamLike.parse(req.params);
    const body = learnerProfileSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (body.full_name !== undefined) {
      fields.push(`full_name = $${i}`);
      fields.push(`name = $${i}`);
      values.push(body.full_name);
      i += 1;
    }
    if (body.phone !== undefined) {
      fields.push(`phone = $${i++}`);
      values.push(body.phone === "" ? null : body.phone);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);
    const result = await query(
      `UPDATE users
          SET ${fields.join(", ")}, updated_at = now()
        WHERE id = $${i}
          AND (
            EXISTS (SELECT 1 FROM ielts_access_grants g WHERE g.user_id = users.id)
            OR EXISTS (
              SELECT 1
                FROM reviewer_quiz_attempts a
                JOIN reviewer_quizzes q ON q.id = a.quiz_id AND q.exam_type = 'IELTS'
               WHERE a.user_id = users.id
            )
          )
        RETURNING id, email, full_name, name, phone, role, status`,
      values,
    );
    if (!result.rows[0]) throw HttpError.notFound("IELTS learner not found");
    res.json({ user: result.rows[0] });
  }),
);

export default router;
