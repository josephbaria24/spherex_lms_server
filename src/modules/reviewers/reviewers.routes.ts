import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

const EXAM_TYPES = ["CSE", "NLE", "LET", "IELTS", "Other"] as const;

const createReviewerSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  exam_type: z.enum(EXAM_TYPES),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  file_url: z.string().optional(),
  external_url: z.string().url().optional().nullable(),
  is_published: z.boolean().optional(),
});

const updateReviewerSchema = createReviewerSchema.partial().extend({
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  exam_type: z.enum(EXAM_TYPES).optional(),
  search: z.string().optional(),
  published: z.enum(["true", "false"]).optional(),
});

const PUBLIC_SELECT = `
  id, title, description, exam_type, category, tags,
  file_url, external_url, created_at, updated_at`;

const ADMIN_SELECT = `
  id, title, description, exam_type, category, tags,
  file_url, external_url, is_published, uploaded_by,
  created_at, updated_at`;

function cleanPath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\.\.+/g, "");
}

function buildSignedUrl(filePath: string): string {
  if (!env.bunny.pullZone || !env.bunny.securityKey) {
    throw HttpError.badRequest("Bunny pull zone is not configured");
  }
  const safePath = cleanPath(filePath);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const token = crypto
    .createHash("md5")
    .update(env.bunny.securityKey + safePath + expires)
    .digest("hex");
  const pullZone = env.bunny.pullZone.replace(/\/$/, "");
  return `${pullZone}/${safePath}?token=${token}&expires=${expires}`;
}

const router = Router();

// GET /reviewers/public — published materials for landing page (no auth)
router.get(
  "/public",
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const where: string[] = ["is_published = true"];
    const values: unknown[] = [];
    let i = 1;

    if (filters.exam_type) {
      where.push(`exam_type = $${i++}`);
      values.push(filters.exam_type);
    }
    if (filters.search) {
      where.push(`(title ILIKE $${i} OR description ILIKE $${i} OR category ILIKE $${i})`);
      values.push(`%${filters.search}%`);
      i++;
    }

    const result = await query(
      `SELECT ${PUBLIC_SELECT}
         FROM reviewer_materials
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC`,
      values,
    );
    res.json({ materials: result.rows });
  }),
);

// POST /reviewers/public/:id/download — signed Bunny URL for published file (no auth)
router.post(
  "/public/:id/download",
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query(
      `SELECT id, file_url, external_url, is_published
         FROM reviewer_materials WHERE id = $1`,
      [id],
    );
    const material = result.rows[0] as
      | { id: string; file_url: string; external_url: string | null; is_published: boolean }
      | undefined;

    if (!material || !material.is_published) {
      throw HttpError.notFound("Reviewer material not found");
    }

    if (material.external_url && !material.file_url) {
      res.json({ url: material.external_url, external: true });
      return;
    }

    if (!material.file_url) {
      throw HttpError.badRequest("No downloadable file for this material");
    }

    res.json({ url: buildSignedUrl(material.file_url), external: false });
  }),
);

// GET /reviewers — admin list (all, including drafts)
router.get(
  "/",
  requireAuth,
  requireAdmin,
  validate(listQuery, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = listQuery.parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (filters.exam_type) {
      where.push(`exam_type = $${i++}`);
      values.push(filters.exam_type);
    }
    if (filters.published === "true") {
      where.push("is_published = true");
    } else if (filters.published === "false") {
      where.push("is_published = false");
    }
    if (filters.search) {
      where.push(`(title ILIKE $${i} OR description ILIKE $${i} OR category ILIKE $${i})`);
      values.push(`%${filters.search}%`);
      i++;
    }

    const result = await query(
      `SELECT ${ADMIN_SELECT}
         FROM reviewer_materials
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC`,
      values,
    );
    res.json({ materials: result.rows });
  }),
);

// GET /reviewers/:id
router.get(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query(
      `SELECT ${ADMIN_SELECT} FROM reviewer_materials WHERE id = $1`,
      [id],
    );
    const material = result.rows[0];
    if (!material) throw HttpError.notFound("Reviewer material not found");
    res.json({ material });
  }),
);

// POST /reviewers  (admin) — create; file_url may be empty until Bunny upload completes
router.post(
  "/",
  requireAuth,
  requireAdmin,
  validate(createReviewerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = createReviewerSchema.parse(req.body);

    const result = await query(
      `INSERT INTO reviewer_materials
         (title, description, exam_type, category, tags, file_url, external_url, is_published, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        body.title,
        body.description ?? null,
        body.exam_type,
        body.category ?? null,
        body.tags ?? [],
        body.file_url ?? "",
        body.external_url ?? null,
        body.is_published ?? true,
        req.user!.sub,
      ],
    );
    res.status(201).json({ material: result.rows[0] });
  }),
);

// PATCH /reviewers/:id  (admin)
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  validate(updateReviewerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const body = updateReviewerSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
    if (fields.length === 0) throw HttpError.badRequest("No fields to update");

    fields.push(`updated_at = now()`);
    values.push(id);

    const result = await query(
      `UPDATE reviewer_materials SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values,
    );
    const material = result.rows[0];
    if (!material) throw HttpError.notFound("Reviewer material not found");
    res.json({ material });
  }),
);

// DELETE /reviewers/:id  (admin)
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  validate(idParam, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = idParam.parse(req.params);
    const result = await query("DELETE FROM reviewer_materials WHERE id = $1", [id]);
    if (result.rowCount === 0) throw HttpError.notFound("Reviewer material not found");
    res.json({ ok: true });
  }),
);

export default router;
