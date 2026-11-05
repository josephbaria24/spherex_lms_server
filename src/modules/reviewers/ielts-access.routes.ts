import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import {
  grantIeltsAccess,
  grantIeltsAccessByEmail,
  ieltsAccessCodeMatches,
  userHasIeltsAccess,
} from "../../lib/ielts-access.js";
import { sendMail } from "../../lib/mailer.js";
import { listAdminUserIds, notifyUsers } from "../../lib/notifications.js";
import { requireAuth } from "../../middleware/auth.js";
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

const router = Router();

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
    if (req.user?.sub) await grantIeltsAccess(req.user.sub);
    await grantIeltsAccessByEmail(body.email);
    const unlocked = await userHasIeltsAccess(req.user?.sub, req.user?.role);

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
          unlocked
            ? `Their account now has every IELTS practice set and material.`
            : `No matching account was signed in. Access applies when they sign in with ${body.email}.`,
        ].join("\n"),
      });
      mailed = mail.sent;
    } catch (err) {
      console.error("IELTS access request email failed:", err);
    }

    res.json({
      ok: true,
      unlocked,
      message: unlocked
        ? "All IELTS materials are unlocked on your account."
        : mailed
          ? "Access request sent. Sign in with this email to open every IELTS material."
          : "Your request was saved. Sign in with this email to open every IELTS material.",
    });
  }),
);

export default router;
