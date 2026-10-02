/**
 * Seed CSE practice quizzes extracted from the CSC Professional/Sub-Professional PDF.
 * Usage: npx tsx src/db/seed-cse-quizzes.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "../config/db.js";

type SeedQuestion = {
  prompt: string;
  question_type: "multiple_choice" | "true_false";
  options: { id: string; text: string }[];
  correct_option_id: string;
  sort_order?: number;
};

type SeedQuiz = {
  title: string;
  description?: string;
  exam_type: "CSE" | "NLE" | "LET" | "IELTS" | "Other";
  category?: string;
  passing_score?: number;
  questions: SeedQuestion[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "cse-quiz-seed.json");

async function main() {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as {
    source: string;
    quizzes: SeedQuiz[];
  };

  console.log(`Seeding ${raw.quizzes.length} quizzes from ${raw.source}…`);

  // Remove previous CSE seeded quizzes (titles start with CSE Reviewer)
  await query(
    `DELETE FROM reviewer_quizzes
      WHERE exam_type = 'CSE' AND title LIKE 'CSE Reviewer%'`,
  );

  let totalQuestions = 0;

  for (const quiz of raw.quizzes) {
    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quizzes
           (title, description, exam_type, category, passing_score, is_published)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [
          quiz.title,
          quiz.description ?? null,
          quiz.exam_type,
          quiz.category ?? null,
          quiz.passing_score ?? 70,
        ],
      );
      const quizId = inserted.rows[0]!.id;

      for (let i = 0; i < quiz.questions.length; i++) {
        const q = quiz.questions[i]!;
        await client.query(
          `INSERT INTO reviewer_quiz_questions
             (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            quizId,
            q.sort_order ?? i,
            q.prompt,
            q.question_type ?? "multiple_choice",
            JSON.stringify(q.options),
            q.correct_option_id,
          ],
        );
      }
      totalQuestions += quiz.questions.length;
      console.log(`  + ${quiz.title} (${quiz.questions.length} Q)`);
    });
  }

  console.log(`Done. ${raw.quizzes.length} quizzes, ${totalQuestions} questions.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
