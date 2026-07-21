import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { env } from "../../config/env.js";
import { sendMail, appUrl } from "../../lib/mailer.js";
import { hashPassword } from "../../utils/password.js";
import {
  generateTempPassword,
  generateTransactionNumber,
  generateUploadToken,
  hashToken,
  receiptPublicPath,
} from "../../lib/payment-requests.js";
import { receiptUpload } from "../../middleware/receipt-upload.js";
import {
  paymentRequestRateLimiter,
  receiptUploadRateLimiter,
} from "../../middleware/rateLimit.js";
import {
  createNotification,
  listAdminUserIds,
  listCourseInstructorIds,
  notifyUsers,
} from "../../lib/notifications.js";

type PaymentRequestRow = {
  id: string;
  transaction_number: string;
  course_id: string;
  full_name: string;
  email: string;
  phone: string;
  amount_cents: number;
  currency: string;
  status: string;
  receipt_path: string | null;
  receipt_uploaded_at: Date | null;
  upload_token_expires_at: Date;
  admin_note: string | null;
  user_id: string | null;
  created_at: Date;
  course_title?: string;
};

const createSchema = z.object({
  course_id: z.string().uuid(),
  full_name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  phone: z.string().min(7).max(40),
});

const tokenParam = z.object({ token: z.string().min(16).max(128) });
const idParam = z.object({ id: z.string().uuid() });
const rejectSchema = z.object({
  admin_note: z.string().max(500).optional(),
});
const listQuery = z.object({
  status: z
    .enum(["pending_payment", "receipt_uploaded", "approved", "rejected", "expired", "all"])
    .optional(),
});

const router = Router();

function formatPhp(cents: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

async function findByUploadToken(rawToken: string): Promise<PaymentRequestRow | null> {
  const token_hash = hashToken(rawToken);
  const result = await query<PaymentRequestRow>(
    `SELECT pr.*, c.title AS course_title
       FROM payment_requests pr
       JOIN courses c ON c.id = pr.course_id
      WHERE pr.upload_token_hash = $1
      LIMIT 1`,
    [token_hash],
  );
  return result.rows[0] ?? null;
}

// POST /api/payment-requests — start manual payment enrollment
router.post(
  "/",
  paymentRequestRateLimiter,
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);

    const course = await query<{
      id: string;
      title: string;
      price_cents: number;
    }>(
      `SELECT id, title, COALESCE(price_cents, 0) AS price_cents FROM courses WHERE id = $1`,
      [body.course_id],
    );
    const row = course.rows[0];
    if (!row) throw HttpError.notFound("Course not found");
    if (row.price_cents <= 0) {
      throw HttpError.badRequest("This course is free — enroll normally instead of requesting payment");
    }

    const uploadToken = generateUploadToken();
    const upload_token_hash = hashToken(uploadToken);
    const upload_token_expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let transaction_number = generateTransactionNumber();
    for (let i = 0; i < 5; i++) {
      const clash = await query(
        `SELECT id FROM payment_requests WHERE transaction_number = $1`,
        [transaction_number],
      );
      if (!clash.rows[0]) break;
      transaction_number = generateTransactionNumber();
    }

    const inserted = await query<PaymentRequestRow>(
      `INSERT INTO payment_requests (
         transaction_number, course_id, full_name, email, phone,
         amount_cents, currency, status, upload_token_hash, upload_token_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'PHP', 'pending_payment', $7, $8)
       RETURNING *`,
      [
        transaction_number,
        body.course_id,
        body.full_name.trim(),
        body.email.trim().toLowerCase(),
        body.phone.trim(),
        row.price_cents,
        upload_token_hash,
        upload_token_expires_at,
      ],
    );
    const pr = inserted.rows[0]!;
    const uploadUrl = appUrl(`/pay/${uploadToken}`);

    await sendMail({
      to: pr.email,
      subject: `Payment request ${pr.transaction_number} — ${row.title}`,
      text: [
        `Hi ${pr.full_name},`,
        ``,
        `Thank you for requesting access to "${row.title}".`,
        ``,
        `Transaction number: ${pr.transaction_number}`,
        `Amount: ${formatPhp(pr.amount_cents)}`,
        ``,
        env.paymentInstructions,
        ``,
        `After paying, upload your receipt here:`,
        uploadUrl,
        ``,
        `This link expires in 7 days.`,
        ``,
        `— ${env.smtp.fromName}`,
      ].join("\n"),
    });

    if (env.adminNotifyEmail) {
      await sendMail({
        to: env.adminNotifyEmail,
        subject: `New payment request ${pr.transaction_number}`,
        text: `New request for ${row.title} from ${pr.full_name} <${pr.email}> — ${formatPhp(pr.amount_cents)}`,
      });
    }

    res.status(201).json({
      payment_request: {
        id: pr.id,
        transaction_number: pr.transaction_number,
        amount_cents: pr.amount_cents,
        currency: pr.currency,
        status: pr.status,
        course_title: row.title,
        email: pr.email,
      },
      message: "Check your email for the transaction number and receipt upload link.",
    });
  }),
);

// GET /api/payment-requests/upload/:token
router.get(
  "/upload/:token",
  validate(tokenParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = tokenParam.parse(req.params);
    const pr = await findByUploadToken(token);
    if (!pr) throw HttpError.notFound("Invalid or expired upload link");
    if (new Date(pr.upload_token_expires_at) < new Date()) {
      throw HttpError.badRequest("This upload link has expired");
    }
    if (pr.status === "approved" || pr.status === "rejected") {
      throw HttpError.badRequest(`This request is already ${pr.status}`);
    }

    res.json({
      payment_request: {
        transaction_number: pr.transaction_number,
        full_name: pr.full_name,
        email: pr.email,
        amount_cents: pr.amount_cents,
        currency: pr.currency,
        status: pr.status,
        course_title: pr.course_title,
        has_receipt: Boolean(pr.receipt_path),
      },
    });
  }),
);

// POST /api/payment-requests/upload/:token/receipt
router.post(
  "/upload/:token/receipt",
  receiptUploadRateLimiter,
  validate(tokenParam, "params"),
  receiptUpload.single("receipt"),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = tokenParam.parse(req.params);
    const pr = await findByUploadToken(token);
    if (!pr) throw HttpError.notFound("Invalid or expired upload link");
    if (new Date(pr.upload_token_expires_at) < new Date()) {
      throw HttpError.badRequest("This upload link has expired");
    }
    if (pr.status === "approved" || pr.status === "rejected") {
      throw HttpError.badRequest(`This request is already ${pr.status}`);
    }
    if (!req.file) throw HttpError.badRequest("Receipt file is required");

    const receipt_path = receiptPublicPath(req.file.filename);
    const updated = await query<PaymentRequestRow>(
      `UPDATE payment_requests
          SET receipt_path = $1,
              receipt_uploaded_at = now(),
              status = 'receipt_uploaded'
        WHERE id = $2
        RETURNING *`,
      [receipt_path, pr.id],
    );

    await sendMail({
      to: pr.email,
      subject: `Receipt received — ${pr.transaction_number}`,
      text: [
        `Hi ${pr.full_name},`,
        ``,
        `We received your payment receipt for transaction ${pr.transaction_number}.`,
        `An admin will review it and grant course access once confirmed.`,
        ``,
        `— ${env.smtp.fromName}`,
      ].join("\n"),
    });

    if (env.adminNotifyEmail) {
      await sendMail({
        to: env.adminNotifyEmail,
        subject: `Receipt uploaded — ${pr.transaction_number}`,
        text: `${pr.full_name} uploaded a receipt for ${pr.course_title}. Review in Admin → Payment requests.`,
      });
    }

    const adminIds = await listAdminUserIds();
    await notifyUsers(adminIds, {
      type: "payment.receipt_uploaded",
      title: "Payment receipt ready for review",
      body: `${pr.full_name} uploaded a receipt for "${pr.course_title}" (${pr.transaction_number}).`,
      link: "/admin/payment-requests",
      referenceId: pr.id,
    });

    res.json({
      payment_request: {
        transaction_number: updated.rows[0]!.transaction_number,
        status: updated.rows[0]!.status,
      },
      message: "Receipt uploaded. We will email you when access is approved.",
    });
  }),
);

// GET /api/payment-requests (admin)
router.get(
  "/",
  requireAuth,
  requireAdmin,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const values: unknown[] = [];
    const where: string[] = [];
    if (filters.status && filters.status !== "all") {
      values.push(filters.status);
      where.push(`pr.status = $${values.length}`);
    }

    const result = await query(
      `SELECT pr.*, c.title AS course_title,
              EXISTS (
                SELECT 1 FROM users u WHERE lower(u.email) = lower(pr.email)
              ) AS email_exists
         FROM payment_requests pr
         JOIN courses c ON c.id = pr.course_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY pr.created_at DESC
         LIMIT 200`,
      values,
    );
    res.json({ payment_requests: result.rows });
  }),
);

// POST /api/payment-requests/:id/approve (admin)
router.post(
  "/:id/approve",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);

    const existing = await query<PaymentRequestRow>(
      `SELECT pr.*, c.title AS course_title
         FROM payment_requests pr
         JOIN courses c ON c.id = pr.course_id
        WHERE pr.id = $1`,
      [id],
    );
    const pr = existing.rows[0];
    if (!pr) throw HttpError.notFound("Payment request not found");
    if (pr.status === "approved") {
      throw HttpError.conflict("Already approved");
    }
    if (pr.status === "rejected") {
      throw HttpError.badRequest("Cannot approve a rejected request");
    }
    if (!pr.receipt_path) {
      throw HttpError.badRequest("Wait for the buyer to upload a receipt before approving");
    }

    const { userId, tempPassword, created } = await withTransaction(async (client) => {
      const userRes = await client.query<{
        id: string;
        email: string;
      }>(`SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1`, [pr.email]);

      let userId: string;
      let tempPassword: string | null = null;
      let created = false;

      if (userRes.rows[0]) {
        userId = userRes.rows[0].id;
      } else {
        tempPassword = generateTempPassword();
        const password_hash = await hashPassword(tempPassword);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, full_name, name, role, phone, must_change_password)
           VALUES ($1, $2, $3, $3, 'student', $4, true)
           RETURNING id`,
          [pr.email.toLowerCase(), password_hash, pr.full_name, pr.phone],
        );
        userId = inserted.rows[0]!.id;
        created = true;
      }

      const enroll = await client.query(
        `INSERT INTO enrollments (user_id, course_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, course_id) DO NOTHING
         RETURNING id`,
        [userId, pr.course_id],
      );
      if (enroll.rowCount && enroll.rowCount > 0) {
        await client.query(
          `UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = $1`,
          [pr.course_id],
        );
      }

      await client.query(
        `UPDATE payment_requests
            SET status = 'approved',
                reviewed_by = $1,
                reviewed_at = now(),
                user_id = $2
          WHERE id = $3`,
        [req.user!.sub, userId, id],
      );

      return { userId, tempPassword, created };
    });

    const loginUrl = appUrl("/login");
    if (created && tempPassword) {
      await sendMail({
        to: pr.email,
        subject: `Access granted — ${pr.course_title}`,
        text: [
          `Hi ${pr.full_name},`,
          ``,
          `Your payment for "${pr.course_title}" (txn ${pr.transaction_number}) was approved.`,
          ``,
          `Login email: ${pr.email}`,
          `Temporary password: ${tempPassword}`,
          ``,
          `Sign in here: ${loginUrl}`,
          `You will be asked to change your password on first login.`,
          ``,
          `— ${env.smtp.fromName}`,
        ].join("\n"),
      });
    } else {
      await sendMail({
        to: pr.email,
        subject: `Access granted — ${pr.course_title}`,
        text: [
          `Hi ${pr.full_name},`,
          ``,
          `Your payment for "${pr.course_title}" (txn ${pr.transaction_number}) was approved.`,
          `Sign in with your existing SphereX account: ${loginUrl}`,
          ``,
          `— ${env.smtp.fromName}`,
        ].join("\n"),
      });
    }

    await createNotification({
      userId,
      type: "payment.approved",
      title: "Payment approved — course unlocked",
      body: `Your payment for "${pr.course_title}" was approved. You can start learning now.`,
      link: "/courses",
      referenceId: id,
    });

    const instructorIds = await listCourseInstructorIds(pr.course_id);
    await notifyUsers(
      instructorIds.filter((iid) => iid !== userId),
      {
        type: "enrollment.created",
        title: "New student enrolled",
        body: `${pr.full_name} enrolled in "${pr.course_title}" via payment.`,
        link: "/teacher",
        referenceId: `pay-${id}`,
      },
    );

    res.json({ ok: true, user_id: userId, account_created: created });
  }),
);

// POST /api/payment-requests/:id/reject (admin)
router.post(
  "/:id/reject",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(rejectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = rejectSchema.parse(req.body);

    const existing = await query<PaymentRequestRow>(
      `SELECT pr.*, c.title AS course_title
         FROM payment_requests pr
         JOIN courses c ON c.id = pr.course_id
        WHERE pr.id = $1`,
      [id],
    );
    const pr = existing.rows[0];
    if (!pr) throw HttpError.notFound("Payment request not found");
    if (pr.status === "approved") {
      throw HttpError.badRequest("Cannot reject an approved request");
    }

    await query(
      `UPDATE payment_requests
          SET status = 'rejected',
              reviewed_by = $1,
              reviewed_at = now(),
              admin_note = $2
        WHERE id = $3`,
      [req.user!.sub, body.admin_note ?? null, id],
    );

    await sendMail({
      to: pr.email,
      subject: `Payment request update — ${pr.transaction_number}`,
      text: [
        `Hi ${pr.full_name},`,
        ``,
        `Your payment request for "${pr.course_title}" (${pr.transaction_number}) was not approved.`,
        body.admin_note ? `Note: ${body.admin_note}` : "",
        ``,
        `Contact support if you believe this is a mistake.`,
        ``,
        `— ${env.smtp.fromName}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });

    const userRes = await query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [pr.email],
    );
    if (userRes.rows[0]) {
      await createNotification({
        userId: userRes.rows[0].id,
        type: "payment.rejected",
        title: "Payment request not approved",
        body: body.admin_note
          ? `Your request for "${pr.course_title}" was not approved. Note: ${body.admin_note}`
          : `Your request for "${pr.course_title}" was not approved.`,
        link: "/courses",
        referenceId: id,
      });
    }

    res.json({ ok: true });
  }),
);

export default router;
