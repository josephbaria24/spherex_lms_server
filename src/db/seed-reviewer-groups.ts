/**
 * Create subject groups from existing CSE quiz categories and link quizzes.
 * Usage: npx tsx src/db/seed-reviewer-groups.ts
 */
import { pool, query, withTransaction } from "../config/db.js";

const SUBJECT_META: Record<
  string,
  { title: string; description: string; accent: string; sort: number }
> = {
  Mathematics: {
    title: "Mathematics",
    description: "Word problems, operations, and quantitative reasoning practice.",
    accent: "coral",
    sort: 10,
  },
  English: {
    title: "English",
    description: "Vocabulary, analogies, grammar, usage, and reading comprehension.",
    accent: "indigo",
    sort: 20,
  },
  Filipino: {
    title: "Filipino",
    description: "Kasingkahulugan, kasalungat, wastong gamit, at pag-unawa sa binasa.",
    accent: "amber",
    sort: 30,
  },
  "Inductive Reasoning": {
    title: "Inductive Reasoning",
    description: "Pattern recognition and logical induction drills.",
    accent: "emerald",
    sort: 40,
  },
  "Philippine Constitution": {
    title: "Philippine Constitution",
    description: "Civics and constitution review items.",
    accent: "rose",
    sort: 50,
  },
  General: {
    title: "General Review",
    description: "Other CSE practice sets.",
    accent: "slate",
    sort: 100,
  },
};

function subjectFromCategory(category: string | null): string {
  if (!category) return "General";
  const head = category.split(" - ")[0]?.trim() || category.trim();
  if (SUBJECT_META[head]) return head;
  if (/math/i.test(head)) return "Mathematics";
  if (/english/i.test(head)) return "English";
  if (/filipino/i.test(head)) return "Filipino";
  if (/inductive/i.test(head)) return "Inductive Reasoning";
  if (/constitution/i.test(head)) return "Philippine Constitution";
  return head || "General";
}

async function main() {
  const quizzes = await query<{
    id: string;
    title: string;
    exam_type: string;
    category: string | null;
  }>(
    `SELECT id, title, exam_type, category
       FROM reviewer_quizzes
      WHERE exam_type = 'CSE'
      ORDER BY category NULLS LAST, title ASC`,
  );

  const bySubject = new Map<string, typeof quizzes.rows>();
  for (const quiz of quizzes.rows) {
    const subject = subjectFromCategory(quiz.category);
    const list = bySubject.get(subject) ?? [];
    list.push(quiz);
    bySubject.set(subject, list);
  }

  console.log(`Grouping ${quizzes.rows.length} quizzes into ${bySubject.size} subjects…`);

  // Clear prior auto groups for CSE subjects (keep custom ones with covers? wipe CSE subject groups)
  await query(
    `DELETE FROM reviewer_quiz_groups
      WHERE exam_type = 'CSE'
        AND subject = ANY($1::text[])`,
    [Object.keys(SUBJECT_META)],
  );

  for (const [subject, list] of bySubject) {
    const meta = SUBJECT_META[subject] ?? {
      title: subject,
      description: `${subject} practice quizzes.`,
      accent: "slate",
      sort: 90,
    };

    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quiz_groups
           (title, description, exam_type, subject, accent_color, sort_order, is_published)
         VALUES ($1,$2,'CSE',$3,$4,$5,true)
         RETURNING id`,
        [meta.title, meta.description, subject, meta.accent, meta.sort],
      );
      const groupId = inserted.rows[0]!.id;

      for (let i = 0; i < list.length; i++) {
        const quiz = list[i]!;
        await client.query(
          `UPDATE reviewer_quizzes
              SET group_id = $1, sort_order = $2, updated_at = now()
            WHERE id = $3`,
          [groupId, i, quiz.id],
        );
      }
      console.log(`  + ${meta.title} (${list.length} parts) [${meta.accent}]`);
    });
  }

  console.log("Done.");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
