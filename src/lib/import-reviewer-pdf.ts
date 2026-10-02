import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";

export type ImportedQuestion = {
  prompt: string;
  question_type?: "multiple_choice" | "true_false";
  options: { id: string; text: string }[];
  correct_option_id: string;
  sort_order?: number;
};

export type ImportedQuiz = {
  title: string;
  description?: string | null;
  exam_type: "CSE" | "NLE" | "LET" | "IELTS" | "Other";
  category?: string | null;
  passing_score?: number;
  questions: ImportedQuestion[];
};

export type ExtractPayload = {
  source: string;
  quizzes: ImportedQuiz[];
  stats?: {
    questions?: number;
    quizzes?: number;
    math_fixed?: number;
    prompt_math?: number;
  };
};

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

function subjectFromCategory(category: string | null | undefined): string {
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

function resolveExtractScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../scripts/extract-cse-quiz.py"),
    path.resolve(here, "../../../scripts/extract-cse-quiz.py"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw HttpError.badRequest(
    "PDF extractor script not found. Expected scripts/extract-cse-quiz.py next to the server.",
  );
}

async function resolvePythonBin(): Promise<string> {
  const candidates = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (ok) return bin;
  }
  throw HttpError.badRequest(
    "Python is required to import reviewer PDFs. Install Python 3 and pymupdf (`pip install pymupdf`).",
  );
}

export async function extractQuizzesFromPdf(pdfPath: string): Promise<ExtractPayload> {
  const script = resolveExtractScript();
  const python = await resolvePythonBin();
  const args = [script, "--pdf", pdfPath, "--stdout", "--skip-asserts"];

  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(python, args, {
      shell: process.platform === "win32",
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout: out, stderr: err, code: exitCode }));
  });

  if (code !== 0) {
    const detail = (stderr || stdout || "Unknown extractor error").slice(0, 1200);
    throw HttpError.badRequest(`PDF extraction failed: ${detail}`);
  }

  const jsonText = stdout.trim();
  if (!jsonText) {
    throw HttpError.badRequest(`PDF extraction returned no data. ${stderr.slice(0, 500)}`);
  }

  try {
    return JSON.parse(jsonText) as ExtractPayload;
  } catch {
    throw HttpError.badRequest("PDF extraction produced invalid JSON");
  }
}

export async function importExtractedQuizzes(
  payload: ExtractPayload,
  options: { replaceExisting?: boolean; createdBy?: string | null } = {},
): Promise<{
  quiz_count: number;
  question_count: number;
  group_count: number;
  source: string;
}> {
  const quizzes = payload.quizzes ?? [];
  if (quizzes.length === 0) {
    throw HttpError.badRequest("No quizzes found in the PDF. Check that answers are marked in red.");
  }

  const replaceExisting = options.replaceExisting !== false;
  const examType = quizzes[0]?.exam_type ?? "CSE";

  if (replaceExisting) {
    await query(
      `DELETE FROM reviewer_quizzes
        WHERE exam_type = $1 AND title LIKE 'CSE Reviewer%'`,
      [examType],
    );
  }

  let questionCount = 0;
  for (const quiz of quizzes) {
    if (!quiz.questions?.length) continue;
    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reviewer_quizzes
           (title, description, exam_type, category, passing_score, is_published, created_by)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         RETURNING id`,
        [
          quiz.title,
          quiz.description ?? null,
          quiz.exam_type ?? examType,
          quiz.category ?? null,
          quiz.passing_score ?? 70,
          options.createdBy ?? null,
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
      questionCount += quiz.questions.length;
    });
  }

  const groupCount = await regroupCseQuizzes();

  return {
    quiz_count: quizzes.length,
    question_count: questionCount,
    group_count: groupCount,
    source: payload.source,
  };
}

export async function regroupCseQuizzes(): Promise<number> {
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
        await client.query(
          `UPDATE reviewer_quizzes
              SET group_id = $1, sort_order = $2, updated_at = now()
            WHERE id = $3`,
          [groupId, i, list[i]!.id],
        );
      }
    });
  }

  return bySubject.size;
}

export function writeTempPdf(buffer: Buffer, originalName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spherex-reviewer-"));
  const safe = originalName.replace(/[^\w.\-]+/g, "_") || "reviewer.pdf";
  const filePath = path.join(dir, safe.endsWith(".pdf") ? safe : `${safe}.pdf`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function cleanupTempPdf(filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
