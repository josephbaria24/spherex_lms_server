/**
 * Upsert IELTS Reading Mock Test 3 without wiping other IELTS quizzes.
 * Usage: npx tsx src/db/seed-ielts-reading-mock-3.ts
 *    or: npm run db:seed:ielts-reading-mock-3
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "../config/db.js";

type SeedQuestion = {
  prompt: string;
  question_type: string;
  options: { id: string; text: string }[];
  correct_option_id: string;
};

type SeedQuiz = {
  group_subject: string;
  title: string;
  description?: string;
  exam_type: "IELTS";
  category?: string;
  passing_score?: number;
  passage_html?: string | null;
  audio_url?: string | null;
  time_limit_seconds?: number | null;
  questions: SeedQuestion[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "ielts-reading-mock-3-seed.json");
const TITLE = "IELTS Reading — Mock Test 3";

async function main() {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as {
    source: string;
    quiz: SeedQuiz;
  };
  const quiz = raw.quiz;
  console.log(`Upserting ${TITLE} from ${raw.source}…`);

  const group = await query<{ id: string }>(
    `SELECT id FROM reviewer_quiz_groups
      WHERE exam_type = 'IELTS' AND subject = $1
      ORDER BY sort_order
      LIMIT 1`,
    [quiz.group_subject],
  );
  if (!group.rows[0]) {
    throw new Error(`IELTS group not found for subject=${quiz.group_subject}`);
  }
  const groupId = group.rows[0].id;

  await withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM reviewer_quizzes WHERE exam_type = 'IELTS' AND title = $1 LIMIT 1`,
      [TITLE],
    );

    let quizId: string;
    if (existing.rows[0]) {
      quizId = existing.rows[0].id;
      await client.query(
        `UPDATE reviewer_quizzes SET
           description = $2,
           category = $3,
           passing_score = $4,
           is_published = true,
           group_id = $5,
           passage_html = $6,
           audio_url = $7,
           time_limit_seconds = $8,
           updated_at = now()
         WHERE id = $1`,
        [
          quizId,
          quiz.description ?? null,
          quiz.category ?? null,
          quiz.passing_score ?? 60,
          groupId,
          quiz.passage_html?.trim() || null,
          quiz.audio_url?.trim() || null,
          quiz.time_limit_seconds ?? null,
        ],
      );
      await client.query(`DELETE FROM reviewer_quiz_questions WHERE quiz_id = $1`, [quizId]);
      console.log(`  updated quiz ${quizId}`);
    } else {
      const maxSort = await client.query<{ m: string }>(
        `SELECT COALESCE(MAX(sort_order), -1)::text AS m
           FROM reviewer_quizzes WHERE group_id = $1`,
        [groupId],
      );
      const sortOrder = Number(maxSort.rows[0]?.m ?? -1) + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quizzes
           (title, description, exam_type, category, passing_score, is_published,
            group_id, sort_order, passage_html, audio_url, time_limit_seconds)
         VALUES ($1, $2, 'IELTS', $3, $4, true, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          TITLE,
          quiz.description ?? null,
          quiz.category ?? null,
          quiz.passing_score ?? 60,
          groupId,
          sortOrder,
          quiz.passage_html?.trim() || null,
          quiz.audio_url?.trim() || null,
          quiz.time_limit_seconds ?? null,
        ],
      );
      quizId = inserted.rows[0]!.id;
      console.log(`  inserted quiz ${quizId}`);
    }

    for (let i = 0; i < quiz.questions.length; i++) {
      const q = quiz.questions[i]!;
      await client.query(
        `INSERT INTO reviewer_quiz_questions
           (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          quizId,
          i,
          q.prompt,
          q.question_type ?? "fill_blank",
          JSON.stringify(q.options ?? []),
          q.correct_option_id,
        ],
      );
    }
    console.log(`  + ${quiz.questions.length} questions`);
  });

  console.log("Done.");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
