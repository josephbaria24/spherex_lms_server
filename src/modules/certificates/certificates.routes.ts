import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { createNotification } from "../../lib/notifications.js";

const createSchema = z.object({
  user_id: z.string().uuid(),
  course_id: z.string().uuid().optional(),
  certificate_url: z.string().url().optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  user_id: z.string().uuid().optional(),
});

const router = Router();

// GET /certificates  (?user_id=)
router.get(
  "/",
  requireAuth,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const targetUserId = filters.user_id ?? req.user!.sub;
    if (targetUserId !== req.user!.sub && req.user!.role !== "admin") {
      throw HttpError.forbidden();
    }
    const result = await query(
      `SELECT id, user_id, course_id, certificate_url, issued_at
         FROM certificates
        WHERE user_id = $1
        ORDER BY issued_at DESC`,
      [targetUserId],
    );
    res.json({ certificates: result.rows });
  }),
);

// POST /certificates  (admin)
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);
    const result = await query(
      `INSERT INTO certificates (user_id, course_id, certificate_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [body.user_id, body.course_id ?? null, body.certificate_url ?? null],
    );

    let courseTitle = "a course";
    if (body.course_id) {
      const course = await query<{ title: string }>(
        `SELECT title FROM courses WHERE id = $1`,
        [body.course_id],
      );
      if (course.rows[0]?.title) courseTitle = course.rows[0].title;
    }

    await createNotification({
      userId: body.user_id,
      type: "certificate.issued",
      title: "Certificate issued",
      body: `You earned a certificate for "${courseTitle}".`,
      link: "/achievements",
      referenceId: result.rows[0]!.id,
    });

    res.status(201).json({ certificate: result.rows[0] });
  }),
);

// DELETE /certificates/:id  (admin)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM certificates WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Certificate not found");
    res.json({ ok: true });
  }),
);

export default router;
