/**
 * Reviewer / IELTS quiz scoring helpers (keeps lesson scoreQuiz unchanged).
 */

export type ReviewerScoreableQuestion = {
  id: string;
  question_type: string;
  correct_option_id: string;
  options?: { id: string; text: string }[];
};

function normalizeBlank(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeMultiSelect(value: string): string {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

export function isQuestionCorrect(
  question: ReviewerScoreableQuestion,
  answer: string | undefined,
): boolean {
  if (answer == null) return false;
  const type = question.question_type || "multiple_choice";

  if (type === "fill_blank") {
    const given = normalizeBlank(answer);
    if (!given) return false;
    if (normalizeBlank(question.correct_option_id) === given) return true;
    // Accept any option text as an alternate spelling
    return (question.options ?? []).some((o) => normalizeBlank(o.text) === given);
  }

  if (type === "multi_select") {
    return normalizeMultiSelect(answer) === normalizeMultiSelect(question.correct_option_id);
  }

  // multiple_choice | true_false
  return answer === question.correct_option_id;
}

export function scoreReviewerQuiz(
  questions: ReviewerScoreableQuestion[],
  answers: Record<string, string>,
): { score: number; correct: number; total: number } {
  const total = questions.length;
  if (total === 0) return { score: 100, correct: 0, total: 0 };

  let correct = 0;
  for (const q of questions) {
    if (isQuestionCorrect(q, answers[q.id])) correct += 1;
  }
  const score = Math.round((correct / total) * 100);
  return { score, correct, total };
}

/**
 * Approximate IELTS Academic Listening/Reading band from raw marks,
 * scaled to a 40-item paper (official-style conversion table).
 */
const BAND_FROM_OUT_OF_40: { min: number; band: number }[] = [
  { min: 39, band: 9.0 },
  { min: 37, band: 8.5 },
  { min: 35, band: 8.0 },
  { min: 33, band: 7.5 },
  { min: 30, band: 7.0 },
  { min: 27, band: 6.5 },
  { min: 23, band: 6.0 },
  { min: 19, band: 5.5 },
  { min: 15, band: 5.0 },
  { min: 13, band: 4.5 },
  { min: 10, band: 4.0 },
  { min: 8, band: 3.5 },
  { min: 6, band: 3.0 },
  { min: 4, band: 2.5 },
  { min: 2, band: 2.0 },
  { min: 1, band: 1.0 },
  { min: 0, band: 0 },
];

export function marksToIeltsBand(correct: number, total: number): number {
  if (total <= 0) return 0;
  const scaled = Math.round((correct / total) * 40);
  for (const row of BAND_FROM_OUT_OF_40) {
    if (scaled >= row.min) return row.band;
  }
  return 0;
}

export function shouldReportIeltsBand(examType: string, category: string | null): boolean {
  if (examType !== "IELTS") return false;
  const cat = (category ?? "").toLowerCase();
  // Writing/Speaking are not auto-banded in Phase 2
  if (cat.includes("writing") || cat.includes("speaking")) return false;
  return true;
}
