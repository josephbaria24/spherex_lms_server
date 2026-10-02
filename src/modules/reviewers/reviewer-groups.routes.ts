import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { handleReviewerGroupCoverUpload } from "../../middleware/reviewer-group-cover-upload.js";
import { reviewerGroupCoverPublicPath } from "../../lib/reviewer-group-uploads.js";

const EXAM_TYPES = ["CSE", "NLE", "LET", "IELTS", "Other"] as const;
const ACCENT_COLORS = [
  "coral",
  "indigo",
  "amber",
  "emerald",
  "rose",
  "sky",
  "violet",
  "slate",
] as const;

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  exam_type: z.enum(EXAM_TYPES).optional(),
  search: z.string().optional(),
});

const createGroupSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  exam_type: z.enum(EXAM_TYPES),
  subject: z.string().min(1).max(100).optional(),
  accent_color: z.enum(ACCENT_COLORS).optional(),
  sort_order: z.number().int().optional(),
  is_published: z.boolean().optional(),
});

const updateGroupSchema = createGroupSchema.partial();

export function createReviewerGroupRouter(): Router {
  const router = Router();

  // GET /reviewers/public/groups — published groups with nested quizzes
  router.get(
    "/public/groups",
    validate(listQuery, "query"),
    asyncHandler(async (req: Request, res: Response) => {
      const filters = listQuery.parse(req.query);
      const where: string[] = ["g.is_published = true"];
      const values: unknown[] = [];
      let i = 1;

      if (filters.exam_type) {
        where.push(`g.exam_type = $${i++}`);
        values.push(filters.exam_type);
      }
      if (filters.search) {
        where.push(
          `(g.title ILIKE $${i} OR g.description ILIKE $${i} OR g.subject ILIKE $${i})`,
        );
        values.push(`%${filters.search}%`);
        i++;
      }

      type GroupRow = {
        id: string;
        title: string;
        description: string | null;
        exam_type: string;
        subject: string;
        accent_color: string;
        cover_url: string | null;
        sort_order: number;
        is_published: boolean;
        created_at: string;
        updated_at: string;
      };
      type QuizRow = {
        id: string;
        group_id: string;
        title: string;
        description: string | null;
        exam_type: string;
        category: string | null;
        passing_score: number;
        sort_order: number;
        updated_at: string;
        question_count: number;
      };

      const groupsClean = await query<GroupRow>(
        `SELECT g.id, g.title, g.description, g.exam_type, g.subject, g.accent_color,
                g.cover_url, g.sort_order, g.is_published, g.created_at, g.updated_at
           FROM reviewer_quiz_groups g
          WHERE ${where.join(" AND ")}
          ORDER BY g.sort_order ASC, g.title ASC`,
        values,
      );

      const groupIds = groupsClean.rows.map((g) => g.id);
      const quizzesByGroup = new Map<string, QuizRow[]>();

      if (groupIds.length > 0) {
        const quizzes = await query<QuizRow>(
          `SELECT q.id, q.group_id, q.title, q.description, q.exam_type, q.category,
                  q.passing_score, q.sort_order, q.updated_at,
                  (SELECT COUNT(*)::int FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
             FROM reviewer_quizzes q
            WHERE q.is_published = true
              AND q.group_id = ANY($1::uuid[])
            ORDER BY q.sort_order ASC, q.title ASC`,
          [groupIds],
        );
        for (const quiz of quizzes.rows) {
          const list = quizzesByGroup.get(quiz.group_id) ?? [];
          list.push(quiz);
          quizzesByGroup.set(quiz.group_id, list);
        }
      }

      res.json({
        groups: groupsClean.rows.map((g) => {
          const quizzes = quizzesByGroup.get(g.id) ?? [];
          return {
            ...g,
            quizzes,
            quiz_count: quizzes.length,
            question_count: quizzes.reduce((sum, q) => sum + q.question_count, 0),
          };
        }),
      });
    }),
  );

  // GET /reviewers/public/groups/:id — published group detail with all parts
  router.get(
    "/public/groups/:id",
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);

      type GroupRow = {
        id: string;
        title: string;
        description: string | null;
        exam_type: string;
        subject: string;
        accent_color: string;
        cover_url: string | null;
        sort_order: number;
        is_published: boolean;
        created_at: string;
        updated_at: string;
      };
      type QuizRow = {
        id: string;
        group_id: string;
        title: string;
        description: string | null;
        exam_type: string;
        category: string | null;
        passing_score: number;
        sort_order: number;
        updated_at: string;
        question_count: number;
      };

      const groupResult = await query<GroupRow>(
        `SELECT g.id, g.title, g.description, g.exam_type, g.subject, g.accent_color,
                g.cover_url, g.sort_order, g.is_published, g.created_at, g.updated_at
           FROM reviewer_quiz_groups g
          WHERE g.id = $1 AND g.is_published = true`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) throw HttpError.notFound("Subject not found");

      const quizzes = await query<QuizRow>(
        `SELECT q.id, q.group_id, q.title, q.description, q.exam_type, q.category,
                q.passing_score, q.sort_order, q.updated_at,
                (SELECT COUNT(*)::int FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
           FROM reviewer_quizzes q
          WHERE q.is_published = true
            AND q.group_id = $1
          ORDER BY q.sort_order ASC, q.title ASC`,
        [id],
      );

      res.json({
        group: {
          ...group,
          quizzes: quizzes.rows,
          quiz_count: quizzes.rows.length,
          question_count: quizzes.rows.reduce((sum, q) => sum + q.question_count, 0),
        },
      });
    }),
  );

  // GET /reviewers/groups — admin
  router.get(
    "/groups",
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
      if (filters.search) {
        where.push(`(title ILIKE $${i} OR subject ILIKE $${i})`);
        values.push(`%${filters.search}%`);
        i++;
      }

      const groups = await query<{
        id: string;
        quiz_count: number;
        [key: string]: unknown;
      }>(
        `SELECT g.*,
                (SELECT COUNT(*)::int FROM reviewer_quizzes q WHERE q.group_id = g.id) AS quiz_count
           FROM reviewer_quiz_groups g
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY g.sort_order ASC, g.updated_at DESC`,
        values,
      );

      const groupIds = groups.rows.map((g) => g.id);
      const quizzesByGroup = new Map<
        string,
        Array<{
          id: string;
          group_id: string;
          title: string;
          exam_type: string;
          category: string | null;
          passing_score: number;
          is_published: boolean;
          sort_order: number;
          updated_at: string;
          question_count: number;
        }>
      >();
      if (groupIds.length > 0) {
        const quizzes = await query<{
          id: string;
          group_id: string;
          title: string;
          exam_type: string;
          category: string | null;
          passing_score: number;
          is_published: boolean;
          sort_order: number;
          updated_at: string;
          question_count: number;
        }>(
          `SELECT q.id, q.group_id, q.title, q.exam_type, q.category, q.passing_score,
                  q.is_published, q.sort_order, q.updated_at,
                  (SELECT COUNT(*)::int FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
             FROM reviewer_quizzes q
            WHERE q.group_id = ANY($1::uuid[])
            ORDER BY q.sort_order ASC, q.title ASC`,
          [groupIds],
        );
        for (const quiz of quizzes.rows) {
          const list = quizzesByGroup.get(quiz.group_id) ?? [];
          list.push(quiz);
          quizzesByGroup.set(quiz.group_id, list);
        }
      }

      res.json({
        groups: groups.rows.map((g) => ({
          ...g,
          quizzes: quizzesByGroup.get(g.id) ?? [],
        })),
      });
    }),
  );

  // POST /reviewers/groups
  router.post(
    "/groups",
    requireAuth,
    requireAdmin,
    validate(createGroupSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = createGroupSchema.parse(req.body);
      const result = await query(
        `INSERT INTO reviewer_quiz_groups
           (title, description, exam_type, subject, accent_color, sort_order, is_published, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          body.title,
          body.description ?? null,
          body.exam_type,
          body.subject ?? "General",
          body.accent_color ?? "slate",
          body.sort_order ?? 0,
          body.is_published ?? true,
          req.user!.sub,
        ],
      );
      res.status(201).json({ group: result.rows[0] });
    }),
  );

  // PATCH /reviewers/groups/:id
  router.patch(
    "/groups/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    validate(updateGroupSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const body = updateGroupSchema.parse(req.body);
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        fields.push(`${k} = $${i++}`);
        values.push(v);
      }
      if (fields.length === 0) throw HttpError.badRequest("No fields to update");
      fields.push("updated_at = now()");
      values.push(id);
      const result = await query(
        `UPDATE reviewer_quiz_groups SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
        values,
      );
      if (!result.rows[0]) throw HttpError.notFound("Group not found");
      res.json({ group: result.rows[0] });
    }),
  );

  // POST /reviewers/groups/:id/cover
  router.post(
    "/groups/:id/cover",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    (req, res, next) => {
      const { id } = idParam.parse(req.params);
      handleReviewerGroupCoverUpload(id)(req, res, next);
    },
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const file = req.file;
      if (!file) throw HttpError.badRequest("No cover image provided");
      const coverUrl = reviewerGroupCoverPublicPath(id, file.filename);
      const result = await query(
        `UPDATE reviewer_quiz_groups
            SET cover_url = $1, updated_at = now()
          WHERE id = $2
          RETURNING *`,
        [coverUrl, id],
      );
      if (!result.rows[0]) throw HttpError.notFound("Group not found");
      res.json({ group: result.rows[0] });
    }),
  );

  // DELETE /reviewers/groups/:id
  router.delete(
    "/groups/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      // Unlink quizzes first (SET NULL via FK), then delete group
      await query(`UPDATE reviewer_quizzes SET group_id = NULL WHERE group_id = $1`, [id]);
      const result = await query(`DELETE FROM reviewer_quiz_groups WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw HttpError.notFound("Group not found");
      res.json({ ok: true });
    }),
  );

  // PATCH /reviewers/quizzes/:id/group — assign quiz to a group
  router.patch(
    "/quizzes/:id/assign-group",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    validate(
      z.object({
        group_id: z.string().uuid().nullable(),
        sort_order: z.number().int().optional(),
      }),
    ),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          group_id: z.string().uuid().nullable(),
          sort_order: z.number().int().optional(),
        })
        .parse(req.body);

      const result = await query(
        `UPDATE reviewer_quizzes
            SET group_id = $1,
                sort_order = COALESCE($2, sort_order),
                updated_at = now()
          WHERE id = $3
          RETURNING *`,
        [body.group_id, body.sort_order ?? null, id],
      );
      if (!result.rows[0]) throw HttpError.notFound("Quiz not found");
      res.json({ quiz: result.rows[0] });
    }),
  );

  return router;
}
