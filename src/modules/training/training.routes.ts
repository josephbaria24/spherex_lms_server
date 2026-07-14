import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

const STATUSES = ["upcoming", "ongoing", "completed", "cancelled"] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  course_id: z.string().uuid().optional(),
  scheduled_date: z.string().datetime(),
  duration: z.number().int().positive().default(60),
  instructor: z.string().optional(),
  status: z.enum(STATUSES).default("upcoming"),
  participants: z.number().int().nonnegative().default(0),
  max_participants: z.number().int().nonnegative().default(0),
});

const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().uuid() });

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query(
      `SELECT id, title, course_id, scheduled_date, duration, instructor, status,
              participants, max_participants, created_at, updated_at
         FROM training_sessions
         ORDER BY scheduled_date DESC`,
    );
    res.json({ sessions: result.rows });
  }),
);

router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createSchema.parse(req.body);
    const result = await query(
      `INSERT INTO training_sessions
         (title, course_id, scheduled_date, duration, instructor, status, participants, max_participants)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        body.title,
        body.course_id ?? null,
        body.scheduled_date,
        body.duration,
        body.instructor ?? null,
        body.status,
        body.participants,
        body.max_participants,
      ],
    );
    res.status(201).json({ session: result.rows[0] });
  }),
);

router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(updateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");
    values.push(id);
    const result = await query(
      `UPDATE training_sessions SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    const session = result.rows[0];
    if (!session) throw HttpError.notFound("Session not found");
    res.json({ session });
  }),
);

router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM training_sessions WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Session not found");
    res.json({ ok: true });
  }),
);

export default router;
