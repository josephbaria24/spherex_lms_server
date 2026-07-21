import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { isAdmin } from "../../lib/roles.js";
import { syncAdminReceiptNotifications } from "../../lib/notifications.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unread_only: z.enum(["true", "false"]).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const router = Router();

// GET /api/notifications
router.get(
  "/",
  requireAuth,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const limit = filters.limit ?? 40;

    if (isAdmin(req.user!.role)) {
      await syncAdminReceiptNotifications();
    }

    const values: unknown[] = [req.user!.sub];
    const where = ["user_id = $1"];
    if (filters.unread_only === "true") {
      where.push("read_at IS NULL");
    }

    const result = await query(
      `SELECT id, type, title, body, link, reference_id, read_at, created_at
         FROM notifications
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $2`,
      [...values, limit],
    );

    const unread = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.sub],
    );

    res.json({
      notifications: result.rows,
      unread_count: Number(unread.rows[0]?.count ?? 0),
    });
  }),
);

// POST /api/notifications/read-all
router.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await query(
      `UPDATE notifications
          SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.sub],
    );
    res.json({ ok: true });
  }),
);

// POST /api/notifications/:id/read
router.post(
  "/:id/read",
  requireAuth,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query(
      `UPDATE notifications
          SET read_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id, read_at`,
      [id, req.user!.sub],
    );
    if (!result.rows[0]) throw HttpError.notFound("Notification not found");
    res.json({ notification: result.rows[0] });
  }),
);

export default router;
