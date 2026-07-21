import type { PoolClient, QueryResultRow } from "pg";
import { pool, query } from "../config/db.js";

export type NotificationType =
  | "payment.receipt_uploaded"
  | "payment.approved"
  | "payment.rejected"
  | "enrollment.created"
  | "certificate.issued"
  | "organization.member_joined"
  | "course.update";

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType | string;
  title: string;
  body?: string | null;
  link?: string | null;
  referenceId?: string | null;
};

type Queryable = {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

function db(client?: PoolClient): Queryable {
  return client ?? pool;
}

/** Insert a notification; skips silently on dedupe conflict. */
export async function createNotification(
  input: CreateNotificationInput,
  client?: PoolClient,
): Promise<void> {
  await db(client).query(
    `INSERT INTO notifications (user_id, type, title, body, link, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, type, reference_id) WHERE reference_id IS NOT NULL DO NOTHING`,
    [
      input.userId,
      input.type,
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.referenceId ?? null,
    ],
  );
}

export async function createNotifications(
  inputs: CreateNotificationInput[],
  client?: PoolClient,
): Promise<void> {
  for (const input of inputs) {
    await createNotification(input, client);
  }
}

export async function notifyUsers(
  userIds: string[],
  payload: Omit<CreateNotificationInput, "userId">,
  client?: PoolClient,
): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  await createNotifications(
    unique.map((userId) => ({ ...payload, userId })),
    client,
  );
}

export async function listAdminUserIds(client?: PoolClient): Promise<string[]> {
  const result = await db(client).query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin'`,
  );
  return result.rows.map((r) => r.id);
}

export async function listCourseInstructorIds(
  courseId: string,
  client?: PoolClient,
): Promise<string[]> {
  const result = await db(client).query<{ user_id: string }>(
    `SELECT user_id FROM course_instructors WHERE course_id = $1`,
    [courseId],
  );
  return result.rows.map((r) => r.user_id);
}

export async function listOrgAdminIds(
  organizationId: string,
  client?: PoolClient,
): Promise<string[]> {
  const result = await db(client).query<{ user_id: string }>(
    `SELECT user_id FROM organization_members
      WHERE organization_id = $1 AND role IN ('owner', 'admin')`,
    [organizationId],
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * Ensure admins have inbox items for existing receipt_uploaded payments
 * (covers requests created before notifications shipped).
 */
export async function syncAdminReceiptNotifications(): Promise<void> {
  const admins = await listAdminUserIds();
  if (admins.length === 0) return;

  const pending = await query<{
    id: string;
    full_name: string;
    course_title: string;
    transaction_number: string;
  }>(
    `SELECT pr.id, pr.full_name, pr.transaction_number, c.title AS course_title
       FROM payment_requests pr
       JOIN courses c ON c.id = pr.course_id
      WHERE pr.status = 'receipt_uploaded'
      ORDER BY pr.receipt_uploaded_at DESC NULLS LAST
      LIMIT 100`,
  );

  for (const pr of pending.rows) {
    await notifyUsers(admins, {
      type: "payment.receipt_uploaded",
      title: "Payment receipt ready for review",
      body: `${pr.full_name} uploaded a receipt for "${pr.course_title}" (${pr.transaction_number}).`,
      link: "/admin/payment-requests",
      referenceId: pr.id,
    });
  }
}
