import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { query, withTransaction } from "../../config/db.js";
import { getUploadsRoot } from "../../lib/org-uploads.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { HttpError } from "../../utils/httpError.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { userHasIeltsAccess } from "../../lib/ielts-access.js";
import {
  isQuestionCorrect,
  marksToIeltsBand,
  scoreReviewerQuiz,
  shouldReportIeltsBand,
} from "../../lib/reviewer-quiz-scoring.js";
import { handleReviewerPdfImportUpload } from "../../middleware/reviewer-pdf-import-upload.js";
import {
  cleanupTempPdf,
  extractQuizzesFromPdf,
  importExtractedQuizzes,
  writeTempPdf,
} from "../../lib/import-reviewer-pdf.js";

const EXAM_TYPES = ["CSE", "NLE", "LET", "IELTS", "Other"] as const;
const QUESTION_TYPES = ["multiple_choice", "true_false", "fill_blank", "multi_select", "written_response", "audio_response"] as const;

const optionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const questionSchema = z
  .object({
    prompt: z.string().min(1),
    question_type: z.enum(QUESTION_TYPES).default("multiple_choice"),
    options: z.array(optionSchema).default([]),
    correct_option_id: z.string().min(1),
    sort_order: z.number().int().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.question_type === "written_response" || q.question_type === "audio_response") {
      const minimum = Number.parseInt(q.correct_option_id, 10);
      if (!Number.isFinite(minimum) || minimum < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This response needs a minimum length",
          path: ["correct_option_id"],
        });
      }
      return;
    }
    if (q.question_type === "fill_blank") {
      if (!q.correct_option_id.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Fill-blank questions need a correct answer",
          path: ["correct_option_id"],
        });
      }
      return;
    }
    if (q.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question needs at least two options",
        path: ["options"],
      });
    }
    if (q.question_type === "multi_select") {
      const ids = new Set(q.correct_option_id.split(",").map((s) => s.trim()).filter(Boolean));
      if (ids.size === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Multi-select needs at least one correct option",
          path: ["correct_option_id"],
        });
      }
      for (const id of ids) {
        if (!q.options.some((o) => o.id === id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown correct option id: ${id}`,
            path: ["correct_option_id"],
          });
        }
      }
      return;
    }
    if (!q.options.some((o) => o.id === q.correct_option_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "correct_option_id must match an option",
        path: ["correct_option_id"],
      });
    }
  });

const upsertQuizSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().optional().nullable(),
  exam_type: z.enum(EXAM_TYPES),
  category: z.string().optional().nullable(),
  passing_score: z.number().int().min(0).max(100).optional(),
  is_published: z.boolean().optional(),
  material_id: z.string().uuid().optional().nullable(),
  group_id: z.string().uuid().optional().nullable(),
  sort_order: z.number().int().optional(),
  passage_html: z.string().optional().nullable(),
  audio_url: z.string().max(2000).optional().nullable(),
  time_limit_seconds: z.number().int().positive().optional().nullable(),
  questions: z.array(questionSchema).min(1),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  exam_type: z.enum(EXAM_TYPES).optional(),
  search: z.string().optional(),
});

const submitSchema = z.object({
  answers: z.record(z.string(), z.string()),
});

async function getReviewerQuiz(quizId: string, includeAnswers: boolean) {
  const quizResult = await query<{
    id: string;
    title: string;
    description: string | null;
    exam_type: string;
    category: string | null;
    passing_score: number;
    is_published: boolean;
    material_id: string | null;
    group_id: string | null;
    sort_order: number;
    passage_html: string | null;
    audio_url: string | null;
    time_limit_seconds: number | null;
  }>(
    `SELECT id, title, description, exam_type, category, passing_score, is_published,
            material_id, group_id, sort_order, passage_html, audio_url, time_limit_seconds
       FROM reviewer_quizzes WHERE id = $1`,
    [quizId],
  );
  const quiz = quizResult.rows[0];
  if (!quiz) return null;

  const questions = await query<{
    id: string;
    sort_order: number;
    prompt: string;
    question_type: string;
    options: { id: string; text: string }[];
    correct_option_id: string;
  }>(
    `SELECT id, sort_order, prompt, question_type, options, correct_option_id
       FROM reviewer_quiz_questions
      WHERE quiz_id = $1
      ORDER BY sort_order, created_at`,
    [quizId],
  );

  return {
    ...quiz,
    question_count: questions.rows.length,
    questions: questions.rows.map((q) => {
      const base = {
        id: q.id,
        sort_order: q.sort_order,
        prompt: q.prompt,
        question_type: q.question_type,
        options: q.options,
      };
      if (includeAnswers) return { ...base, correct_option_id: q.correct_option_id };
      if (q.question_type === "written_response") {
        const minimum = Number.parseInt(q.correct_option_id, 10);
        return { ...base, minimum_words: Number.isFinite(minimum) ? minimum : 1 };
      }
      if (q.question_type === "audio_response") {
        const minimum = Number.parseInt(q.correct_option_id, 10);
        return { ...base, minimum_seconds: Number.isFinite(minimum) ? minimum : 1 };
      }
      return base;
    }),
  };
}

const speakingAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const audioName = /\.(webm|m4a|mp4|mp3|wav|ogg|aac|caf)$/.test(name);
    if (
      file.mimetype.startsWith("audio/") ||
      file.mimetype === "video/webm" ||
      file.mimetype === "video/mp4" ||
      file.mimetype === "application/octet-stream" ||
      audioName
    ) {
      cb(null, true);
      return;
    }
    cb(new Error("Upload an audio recording"));
  },
});

function speakingAudioExtension(mime: string, filename = ""): string {
  const name = filename.toLowerCase();
  const fromName = name.match(/\.(webm|m4a|mp4|mp3|wav|ogg|aac|caf)$/);
  if (fromName) return fromName[1] === "mp4" || fromName[1] === "caf" || fromName[1] === "aac" ? ".m4a" : `.${fromName[1]}`;
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return ".m4a";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  return ".webm";
}

export function createReviewerQuizRouter(): Router {
  const router = Router();

  // POST /reviewers/speaking-recordings — save a microphone take
  router.post(
    "/speaking-recordings",
    speakingAudioUpload.single("audio"),
    asyncHandler(async (req: Request, res: Response) => {
      const file = req.file;
      const seconds = Number(req.body?.seconds);
      if (!file || file.size < 1000) {
        throw HttpError.badRequest("The recording is empty. Speak, then stop the recording.");
      }
      if (!Number.isFinite(seconds) || seconds < 1) {
        throw HttpError.badRequest("Could not read the recording length.");
      }
      const dir = path.join(getUploadsRoot(), "ielts-speaking");
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${randomUUID()}${speakingAudioExtension(file.mimetype, file.originalname)}`;
      fs.writeFileSync(path.join(dir, filename), file.buffer);
      res.status(201).json({
        url: `/uploads/ielts-speaking/${filename}`,
        seconds: Math.round(seconds),
      });
    }),
  );

  // GET /reviewers/public/quizzes
  router.get(
    "/public/quizzes",
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
        `SELECT q.id, q.title, q.description, q.exam_type, q.category, q.passing_score,
                q.updated_at, q.time_limit_seconds,
                (SELECT COUNT(*)::int FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
           FROM reviewer_quizzes q
          WHERE ${where.join(" AND ")}
          ORDER BY q.category NULLS LAST, q.title ASC`,
        values,
      );
      res.json({ quizzes: result.rows });
    }),
  );

  // GET /reviewers/public/quizzes/:id — without answers
  router.get(
    "/public/quizzes/:id",
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const quiz = await getReviewerQuiz(id, false);
      if (!quiz || !quiz.is_published) throw HttpError.notFound("Quiz not found");
      if (quiz.exam_type === "IELTS") {
        const allowed = await userHasIeltsAccess(req.user?.sub, req.user?.role);
        if (!allowed) {
          throw HttpError.forbidden("Enter an IELTS access code to open this training");
        }
      }
      const { is_published: _pub, ...publicQuiz } = quiz;
      res.json({ quiz: publicQuiz });
    }),
  );

  // POST /reviewers/public/quizzes/:id/submit
  router.post(
    "/public/quizzes/:id/submit",
    validate(idParam, "params"),
    validate(submitSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const { answers } = submitSchema.parse(req.body);

      const quizMeta = await query<{
        id: string;
        passing_score: number;
        is_published: boolean;
        exam_type: string;
        category: string | null;
      }>(
        `SELECT id, passing_score, is_published, exam_type, category
           FROM reviewer_quizzes WHERE id = $1`,
        [id],
      );
      const quiz = quizMeta.rows[0];
      if (!quiz || !quiz.is_published) throw HttpError.notFound("Quiz not found");
      if (quiz.exam_type === "IELTS") {
        const allowed = await userHasIeltsAccess(req.user?.sub, req.user?.role);
        if (!allowed) {
          throw HttpError.forbidden("Enter an IELTS access code to open this training");
        }
      }

      const questions = await query<{
        id: string;
        question_type: string;
        correct_option_id: string;
        options: { id: string; text: string }[];
      }>(
        `SELECT id, question_type, correct_option_id, options
           FROM reviewer_quiz_questions WHERE quiz_id = $1`,
        [id],
      );
      if (questions.rows.length === 0) throw HttpError.badRequest("Quiz has no questions");

      const result = scoreReviewerQuiz(questions.rows, answers);
      const pendingReview = questions.rows.every((question) => question.question_type === "audio_response");
      const passed = pendingReview ? false : result.score >= quiz.passing_score;
      const band_score = pendingReview
        ? null
        : shouldReportIeltsBand(quiz.exam_type, quiz.category)
          ? marksToIeltsBand(result.correct, result.total)
          : null;

      const userId = req.user?.sub ?? null;
      await query(
        `INSERT INTO reviewer_quiz_attempts (quiz_id, user_id, score, passed, band_score, answers)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, pendingReview ? 0 : result.score, passed, band_score, JSON.stringify(answers)],
      );

      res.json({
        score: pendingReview ? null : result.score,
        passed,
        pending_review: pendingReview,
        passing_score: quiz.passing_score,
        correct: result.correct,
        total: result.total,
        band_score,
      });
    }),
  );

  // GET /reviewers/quizzes/attempts — admin results (must be before /quizzes/:id)
  router.get(
    "/quizzes/attempts",
    requireAuth,
    requireAdmin,
    validate(listQuery, "query"),
    asyncHandler(async (req: Request, res: Response) => {
      const filters = listQuery.parse(req.query);
      const where: string[] = [];
      const values: unknown[] = [];
      let i = 1;

      if (filters.exam_type) {
        where.push(`q.exam_type = $${i++}`);
        values.push(filters.exam_type);
      }
      if (filters.search) {
        where.push(
          `(q.title ILIKE $${i} OR q.category ILIKE $${i} OR g.title ILIKE $${i} OR u.email ILIKE $${i} OR COALESCE(u.full_name, u.name, '') ILIKE $${i})`,
        );
        values.push(`%${filters.search}%`);
        i++;
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const summary = await query<{
        total: number;
        passed: number;
        avg_score: string | null;
        avg_band: string | null;
      }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE a.passed)::int AS passed,
                AVG(a.score)::numeric(5,1) AS avg_score,
                AVG(a.band_score)::numeric(3,1) AS avg_band
           FROM reviewer_quiz_attempts a
           JOIN reviewer_quizzes q ON q.id = a.quiz_id
           LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
           LEFT JOIN users u ON u.id = a.user_id
           ${whereSql}`,
        values,
      );

      const attempts = await query(
        `SELECT a.id, a.score, a.passed, a.band_score, a.created_at,
                q.id AS quiz_id, q.title AS quiz_title, q.category, q.exam_type,
                g.id AS group_id, g.title AS group_title,
                COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), q.category, 'Practice') AS skill,
                u.id AS user_id, u.email AS user_email,
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Guest') AS user_name,
                (
                  NOT a.passed
                  AND EXISTS (
                    SELECT 1 FROM reviewer_quiz_questions qq
                     WHERE qq.quiz_id = q.id AND qq.question_type = 'audio_response'
                  )
                ) AS pending_review
           FROM reviewer_quiz_attempts a
           JOIN reviewer_quizzes q ON q.id = a.quiz_id
           LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
           LEFT JOIN users u ON u.id = a.user_id
           ${whereSql}
           ORDER BY a.created_at DESC
           LIMIT 300`,
        values,
      );

      res.json({
        summary: summary.rows[0] ?? { total: 0, passed: 0, avg_score: null, avg_band: null },
        attempts: attempts.rows,
      });
    }),
  );

  // GET /reviewers/quizzes/attempts/:id — admin attempt answers
  router.get(
    "/quizzes/attempts/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const attemptResult = await query<{
        id: string;
        quiz_id: string;
        score: number;
        passed: boolean;
        band_score: string | number | null;
        created_at: Date;
        answers: Record<string, string> | string | null;
        quiz_title: string;
        category: string | null;
        exam_type: string;
        user_email: string | null;
        user_name: string;
      }>(
        `SELECT a.id, a.quiz_id, a.score, a.passed, a.band_score, a.created_at, a.answers,
                q.title AS quiz_title, q.category, q.exam_type,
                u.email AS user_email,
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Guest') AS user_name
           FROM reviewer_quiz_attempts a
           JOIN reviewer_quizzes q ON q.id = a.quiz_id
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id = $1`,
        [id],
      );
      const attempt = attemptResult.rows[0];
      if (!attempt) throw HttpError.notFound("Attempt not found");

      const rawAnswers = attempt.answers;
      const answers: Record<string, string> =
        rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)
          ? (rawAnswers as Record<string, string>)
          : typeof rawAnswers === "string"
            ? (() => {
                try {
                  return JSON.parse(rawAnswers) as Record<string, string>;
                } catch {
                  return {};
                }
              })()
            : {};

      const questions = await query<{
        id: string;
        sort_order: number;
        prompt: string;
        question_type: string;
        options: { id: string; text: string }[] | string | null;
        correct_option_id: string;
      }>(
        `SELECT id, sort_order, prompt, question_type, options, correct_option_id
           FROM reviewer_quiz_questions
          WHERE quiz_id = $1
          ORDER BY sort_order ASC, id ASC`,
        [attempt.quiz_id],
      );

      const items = questions.rows.map((question, index) => {
        const options = Array.isArray(question.options)
          ? question.options
          : typeof question.options === "string"
            ? (() => {
                try {
                  return JSON.parse(question.options) as { id: string; text: string }[];
                } catch {
                  return [];
                }
              })()
            : [];
        const given = answers[question.id] ?? "";
        const optionLabel = (value: string) => {
          if (!value) return "";
          if (question.question_type === "multi_select") {
            return value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
              .map((id) => options.find((o) => o.id === id)?.text ?? id)
              .join(", ");
          }
          if (
            question.question_type === "multiple_choice" ||
            question.question_type === "true_false"
          ) {
            return options.find((o) => o.id === value)?.text ?? value;
          }
          return value;
        };

        let learnerDisplay = optionLabel(given) || "—";
        let correctDisplay = optionLabel(question.correct_option_id);
        let audioUrl: string | null = null;
        let audioSeconds: number | null = null;

        if (question.question_type === "written_response") {
          correctDisplay = `Min ${question.correct_option_id} words`;
        } else if (question.question_type === "audio_response") {
          correctDisplay = `Min ${question.correct_option_id}s`;
          try {
            const parsed = JSON.parse(given) as { url?: unknown; seconds?: unknown };
            audioUrl = typeof parsed.url === "string" ? parsed.url : null;
            audioSeconds = Number(parsed.seconds);
            if (!Number.isFinite(audioSeconds)) audioSeconds = null;
            learnerDisplay = audioUrl
              ? `Recording${audioSeconds != null ? ` · ${audioSeconds}s` : ""}`
              : given || "—";
          } catch {
            learnerDisplay = given || "—";
          }
        } else if (question.question_type === "fill_blank") {
          correctDisplay = question.correct_option_id;
          learnerDisplay = given || "—";
        }

        return {
          id: question.id,
          number: index + 1,
          prompt: question.prompt,
          question_type: question.question_type,
          learner_answer: learnerDisplay,
          correct_answer: correctDisplay,
          raw_answer: given || null,
          audio_url: audioUrl,
          audio_seconds: audioSeconds,
          is_correct: isQuestionCorrect(
            {
              id: question.id,
              question_type: question.question_type,
              correct_option_id: question.correct_option_id,
              options,
            },
            given || undefined,
          ),
        };
      });

      const scored = scoreReviewerQuiz(
        questions.rows.map((q) => ({
          id: q.id,
          question_type: q.question_type,
          correct_option_id: q.correct_option_id,
          options: Array.isArray(q.options) ? q.options : [],
        })),
        answers,
      );

      res.json({
        attempt: {
          id: attempt.id,
          quiz_id: attempt.quiz_id,
          quiz_title: attempt.quiz_title,
          category: attempt.category,
          exam_type: attempt.exam_type,
          score: attempt.score,
          passed: attempt.passed,
          band_score: attempt.band_score,
          created_at: attempt.created_at,
          user_name: attempt.user_name,
          user_email: attempt.user_email,
        },
        summary: scored,
        items,
      });
    }),
  );

  // GET /reviewers/quizzes — admin list
  router.get(
    "/quizzes",
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
        where.push(`(title ILIKE $${i} OR category ILIKE $${i})`);
        values.push(`%${filters.search}%`);
        i++;
      }
      const result = await query(
        `SELECT q.id, q.title, q.description, q.exam_type, q.category, q.passing_score,
                q.is_published, q.group_id, q.sort_order, q.updated_at, q.time_limit_seconds,
                (SELECT COUNT(*)::int FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count
           FROM reviewer_quizzes q
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY q.sort_order ASC, q.updated_at DESC`,
        values,
      );
      res.json({ quizzes: result.rows });
    }),
  );

  // GET /reviewers/quizzes/:id — admin (with answers)
  router.get(
    "/quizzes/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const quiz = await getReviewerQuiz(id, true);
      if (!quiz) throw HttpError.notFound("Quiz not found");
      res.json({ quiz });
    }),
  );

  // POST /reviewers/quizzes — admin create
  router.post(
    "/quizzes",
    requireAuth,
    requireAdmin,
    validate(upsertQuizSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = upsertQuizSchema.parse(req.body);
      const quizId = await withTransaction(async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO reviewer_quizzes
             (title, description, exam_type, category, passing_score, is_published,
              material_id, group_id, sort_order, passage_html, audio_url, time_limit_seconds, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          [
            body.title,
            body.description ?? null,
            body.exam_type,
            body.category ?? null,
            body.passing_score ?? 70,
            body.is_published ?? true,
            body.material_id ?? null,
            body.group_id ?? null,
            body.sort_order ?? 0,
            body.passage_html?.trim() || null,
            body.audio_url?.trim() || null,
            body.time_limit_seconds ?? null,
            req.user!.sub,
          ],
        );
        const id = inserted.rows[0]!.id;
        for (let i = 0; i < body.questions.length; i++) {
          const q = body.questions[i]!;
          await client.query(
            `INSERT INTO reviewer_quiz_questions
               (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              id,
              q.sort_order ?? i,
              q.prompt,
              q.question_type,
              JSON.stringify(q.options ?? []),
              q.correct_option_id,
            ],
          );
        }
        return id;
      });
      const quiz = await getReviewerQuiz(quizId, true);
      res.status(201).json({ quiz });
    }),
  );

  // PUT /reviewers/quizzes/:id — admin replace quiz + questions
  router.put(
    "/quizzes/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    validate(upsertQuizSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const body = upsertQuizSchema.parse(req.body);

      await withTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE reviewer_quizzes
              SET title = $1,
                  description = $2,
                  exam_type = $3,
                  category = $4,
                  passing_score = $5,
                  is_published = COALESCE($6, is_published),
                  material_id = $7,
                  group_id = CASE WHEN $8::boolean THEN $9 ELSE group_id END,
                  sort_order = COALESCE($10, sort_order),
                  passage_html = $11,
                  audio_url = $12,
                  time_limit_seconds = $13,
                  updated_at = now()
            WHERE id = $14
            RETURNING id`,
          [
            body.title,
            body.description ?? null,
            body.exam_type,
            body.category ?? null,
            body.passing_score ?? 70,
            body.is_published ?? null,
            body.material_id ?? null,
            body.group_id !== undefined,
            body.group_id ?? null,
            body.sort_order ?? null,
            body.passage_html?.trim() || null,
            body.audio_url?.trim() || null,
            body.time_limit_seconds ?? null,
            id,
          ],
        );
        if (!updated.rows[0]) throw HttpError.notFound("Quiz not found");

        await client.query(`DELETE FROM reviewer_quiz_questions WHERE quiz_id = $1`, [id]);
        for (let i = 0; i < body.questions.length; i++) {
          const q = body.questions[i]!;
          await client.query(
            `INSERT INTO reviewer_quiz_questions
               (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              id,
              q.sort_order ?? i,
              q.prompt,
              q.question_type,
              JSON.stringify(q.options ?? []),
              q.correct_option_id,
            ],
          );
        }
      });

      const quiz = await getReviewerQuiz(id, true);
      res.json({ quiz });
    }),
  );

  // PATCH /reviewers/quizzes/:id/publish
  router.patch(
    "/quizzes/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    validate(
      z.object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().optional().nullable(),
        is_published: z.boolean().optional(),
        passing_score: z.number().int().min(0).max(100).optional(),
        category: z.string().optional().nullable(),
        passage_html: z.string().optional().nullable(),
        audio_url: z.string().max(2000).optional().nullable(),
        time_limit_seconds: z.number().int().positive().optional().nullable(),
      }),
    ),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          title: z.string().min(1).max(300).optional(),
          description: z.string().optional().nullable(),
          is_published: z.boolean().optional(),
          passing_score: z.number().int().min(0).max(100).optional(),
          category: z.string().optional().nullable(),
          passage_html: z.string().optional().nullable(),
          audio_url: z.string().max(2000).optional().nullable(),
          time_limit_seconds: z.number().int().positive().optional().nullable(),
        })
        .parse(req.body);

      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        fields.push(`${k} = $${i++}`);
        values.push(typeof v === "string" && (k === "passage_html" || k === "audio_url") ? v.trim() || null : v);
      }
      if (fields.length === 0) throw HttpError.badRequest("No fields to update");
      fields.push("updated_at = now()");
      values.push(id);
      const result = await query(
        `UPDATE reviewer_quizzes SET ${fields.join(", ")} WHERE id = $${i} RETURNING id`,
        values,
      );
      if (!result.rows[0]) throw HttpError.notFound("Quiz not found");
      const quiz = await getReviewerQuiz(id, true);
      res.json({ quiz });
    }),
  );

  // POST /reviewers/import/pdf — admin upload CSE-style PDF → auto create quizzes + groups
  router.post(
    "/import/pdf",
    requireAuth,
    requireAdmin,
    handleReviewerPdfImportUpload,
    asyncHandler(async (req: Request, res: Response) => {
      const file = req.file;
      if (!file) throw HttpError.badRequest("No PDF file provided");

      const replaceExisting = String(req.body?.replace_existing ?? "true") !== "false";
      const tempPath = writeTempPdf(file.buffer, file.originalname || "reviewer.pdf");

      try {
        const payload = await extractQuizzesFromPdf(tempPath);
        const result = await importExtractedQuizzes(payload, {
          replaceExisting,
          createdBy: req.user!.sub,
        });
        res.status(201).json({
          ok: true,
          ...result,
          stats: payload.stats ?? null,
          message: `Imported ${result.quiz_count} practice parts (${result.question_count} questions) into ${result.group_count} subjects.`,
        });
      } finally {
        cleanupTempPdf(tempPath);
      }
    }),
  );

  // DELETE /reviewers/quizzes/:id
  router.delete(
    "/quizzes/:id",
    requireAuth,
    requireAdmin,
    validate(idParam, "params"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = idParam.parse(req.params);
      const result = await query("DELETE FROM reviewer_quizzes WHERE id = $1", [id]);
      if (result.rowCount === 0) throw HttpError.notFound("Quiz not found");
      res.json({ ok: true });
    }),
  );

  return router;
}
