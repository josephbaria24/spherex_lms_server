import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

const MATERIAL_TYPES = ["IELTS", "TOEFL", "Technical", "Soft Skills", "Other"] as const;

const createMaterialSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  type: z.enum(MATERIAL_TYPES),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  file_url: z.string().optional(),
  course_id: z.string().uuid().optional(),
});

const updateMaterialSchema = createMaterialSchema.partial();
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  type: z.enum(MATERIAL_TYPES).optional(),
  search: z.string().optional(),
});

const router = Router();

// GET /materials
router.get(
  "/",
  requireAuth,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (filters.type) {
      where.push(`type = $${i++}`);
      values.push(filters.type);
    }
    if (filters.search) {
      where.push(`(title ILIKE $${i} OR description ILIKE $${i})`);
      values.push(`%${filters.search}%`);
      i++;
    }

    const sql = `
      SELECT id, title, description, type, category, tags, file_url,
             uploaded_by, course_id, created_at, updated_at
        FROM materials
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY updated_at DESC`;

    const result = await query(sql, values);
    res.json({ materials: result.rows });
  }),
);

// GET /materials/:id
router.get(
  "/:id",
  requireAuth,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query(
      `SELECT id, title, description, type, category, tags, file_url,
              uploaded_by, course_id, created_at, updated_at
         FROM materials WHERE id = $1`,
      [id],
    );
    const material = result.rows[0];
    if (!material) throw HttpError.notFound("Material not found");
    res.json({ material });
  }),
);

// POST /materials  (admin)
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createMaterialSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createMaterialSchema.parse(req.body);
    const result = await query(
      `INSERT INTO materials (title, description, type, category, tags, file_url, uploaded_by, course_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        body.title,
        body.description ?? null,
        body.type,
        body.category ?? null,
        body.tags ?? [],
        body.file_url ?? "",
        req.user!.sub,
        body.course_id ?? null,
      ],
    );
    res.status(201).json({ material: result.rows[0] });
  }),
);

// PATCH /materials/:id  (admin)
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(updateMaterialSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateMaterialSchema.parse(req.body);
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
      `UPDATE materials SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    const material = result.rows[0];
    if (!material) throw HttpError.notFound("Material not found");
    res.json({ material });
  }),
);

// DELETE /materials/:id  (admin)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM materials WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Material not found");
    res.json({ ok: true });
  }),
);

export default router;
