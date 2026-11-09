/**
 * Insert Academic Writing and Speaking practice into existing IELTS groups.
 * Does not replace Listening or Reading sets.
 * Usage: npx tsx src/db/seed-ielts-productive.ts
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
  sort_order?: number;
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

async function main() {
  const raw = JSON.parse(readFileSync(join(__dirname, "ielts-quiz-seed.json"), "utf8")) as {
    groups: { subject: string; description: string }[];
    quizzes: SeedQuiz[];
  };
  const quizzes = raw.quizzes.filter(
    (quiz) => quiz.group_subject === "Writing" || quiz.group_subject === "Speaking",
  );

  for (const subject of ["Writing", "Speaking"]) {
    const description = raw.groups.find((group) => group.subject === subject)?.description;
    if (description) {
      await query(
        `UPDATE reviewer_quiz_groups
            SET description = $2, updated_at = now()
          WHERE exam_type = 'IELTS' AND subject = $1`,
        [subject, description],
      );
    }
    await query(
      `DELETE FROM reviewer_quizzes
        WHERE exam_type = 'IELTS'
          AND group_id IN (
            SELECT id FROM reviewer_quiz_groups
             WHERE exam_type = 'IELTS' AND subject = $1
          )`,
      [subject],
    );
  }

  let sort = 0;
  for (const quiz of quizzes) {
    const group = await query<{ id: string }>(
      `SELECT id FROM reviewer_quiz_groups
        WHERE exam_type = 'IELTS' AND subject = $1
        ORDER BY sort_order
        LIMIT 1`,
      [quiz.group_subject],
    );
    const groupId = group.rows[0]?.id;
    if (!groupId) throw new Error(`Missing IELTS group: ${quiz.group_subject}`);

    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quizzes
           (title, description, exam_type, category, passing_score, is_published,
            group_id, sort_order, passage_html, audio_url, time_limit_seconds)
         VALUES ($1, $2, 'IELTS', $3, $4, true, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          quiz.title,
          quiz.description ?? null,
          quiz.category ?? null,
          quiz.passing_score ?? 100,
          groupId,
          sort,
          quiz.passage_html?.trim() || null,
          quiz.audio_url?.trim() || null,
          quiz.time_limit_seconds ?? null,
        ],
      );
      const quizId = inserted.rows[0]!.id;
      for (let i = 0; i < quiz.questions.length; i++) {
        const question = quiz.questions[i]!;
        await client.query(
          `INSERT INTO reviewer_quiz_questions
             (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            quizId,
            question.sort_order ?? i,
            question.prompt,
            question.question_type,
            JSON.stringify(question.options ?? []),
            question.correct_option_id,
          ],
        );
      }
    });
    console.log(`  + ${quiz.title}`);
    sort += 1;
  }

  console.log(`Done. ${quizzes.length} writing and speaking sets.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
