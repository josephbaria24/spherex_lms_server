/**
 * Seed IELTS skill groups + Listening/Reading practice (Phase 2).
 * Usage: npx tsx src/db/seed-ielts-quizzes.ts
 *    or: npm run db:seed:ielts-quizzes
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "../config/db.js";

type SeedQuestion = {
  prompt: string;
  question_type: "multiple_choice" | "true_false" | "fill_blank" | "multi_select";
  options: { id: string; text: string }[];
  correct_option_id: string;
  sort_order?: number;
};

type SeedGroup = {
  title: string;
  subject: string;
  description: string;
  accent_color: string;
  sort_order: number;
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
const SEED_PATH = join(__dirname, "ielts-quiz-seed.json");

async function main() {
  const raw = JSON.parse(readFileSync(SEED_PATH, "utf8")) as {
    source: string;
    groups: SeedGroup[];
    quizzes: SeedQuiz[];
  };

  console.log(`Seeding IELTS from ${raw.source}…`);

  await query(
    `DELETE FROM reviewer_quizzes
      WHERE exam_type = 'IELTS' AND title LIKE 'IELTS %'`,
  );
  await query(`DELETE FROM reviewer_quiz_groups WHERE exam_type = 'IELTS'`);

  const groupIds = new Map<string, string>();

  for (const group of raw.groups) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO reviewer_quiz_groups
         (title, description, exam_type, subject, accent_color, sort_order, is_published)
       VALUES ($1, $2, 'IELTS', $3, $4, $5, true)
       RETURNING id`,
      [
        group.title,
        group.description,
        group.subject,
        group.accent_color,
        group.sort_order,
      ],
    );
    groupIds.set(group.subject, inserted.rows[0]!.id);
    console.log(`  + group: ${group.title}`);
  }

  let totalQuestions = 0;

  for (let qi = 0; qi < raw.quizzes.length; qi++) {
    const quiz = raw.quizzes[qi]!;
    const groupId = groupIds.get(quiz.group_subject);
    if (!groupId) {
      throw new Error(`Unknown group_subject: ${quiz.group_subject}`);
    }

    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quizzes
           (title, description, exam_type, category, passing_score, is_published,
            group_id, sort_order, passage_html, audio_url, time_limit_seconds)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          quiz.title,
          quiz.description ?? null,
          quiz.exam_type,
          quiz.category ?? null,
          quiz.passing_score ?? 70,
          groupId,
          qi,
          quiz.passage_html?.trim() || null,
          quiz.audio_url?.trim() || null,
          quiz.time_limit_seconds ?? null,
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
            JSON.stringify(q.options ?? []),
            q.correct_option_id,
          ],
        );
      }
      totalQuestions += quiz.questions.length;
      console.log(`  + ${quiz.title} (${quiz.questions.length} Q)`);
    });
  }

  console.log(
    `Done. ${raw.groups.length} groups, ${raw.quizzes.length} quizzes, ${totalQuestions} questions.`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
