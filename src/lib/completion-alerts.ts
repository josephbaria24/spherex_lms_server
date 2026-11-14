import { query } from "../config/db.js";
import { sendMail } from "./mailer.js";

/** Petrosphere staff notified when a learner finishes a course or IELTS prep. */
export const STAFF_COMPLETION_EMAILS = [
  "sales@petrosphere.com.ph",
  "jlb@petrosphere.com.ph",
  "jmm@petrosphere.com.ph",
] as const;

function staffRecipients(): string {
  return [...new Set(STAFF_COMPLETION_EMAILS.map((e) => e.trim().toLowerCase()).filter(Boolean))].join(
    ", ",
  );
}

async function loadLearner(userId: string): Promise<{ name: string; email: string }> {
  const result = await query<{
    full_name: string | null;
    name: string | null;
    email: string;
  }>(`SELECT full_name, name, email FROM users WHERE id = $1`, [userId]);
  const row = result.rows[0];
  return {
    name: row?.full_name?.trim() || row?.name?.trim() || row?.email || "A learner",
    email: row?.email ?? "",
  };
}

/** Email staff when a learner finishes a course for the first time. */
export async function notifyStaffCourseCompleted(
  userId: string,
  courseId: string,
): Promise<void> {
  const [learner, course] = await Promise.all([
    loadLearner(userId),
    query<{ title: string }>(`SELECT title FROM courses WHERE id = $1`, [courseId]),
  ]);
  const title = course.rows[0]?.title ?? "a course";
  const subject = `Course completed — ${learner.name}`;
  const text = [
    `${learner.name} finished a course on PetroCademia.`,
    ``,
    `Learner: ${learner.name}`,
    `Email: ${learner.email || "—"}`,
    `Course: ${title}`,
    `Finished: ${new Date().toISOString()}`,
    ``,
    `Open Admin → Users to review their progress.`,
  ].join("\n");

  try {
    await sendMail({
      to: staffRecipients(),
      replyTo: learner.email || undefined,
      subject,
      text,
    });
  } catch (err) {
    console.error("[completion-alerts] course email failed:", err);
  }
}

/** Email staff when a learner earns the IELTS preparation certificate. */
export async function notifyStaffIeltsCompleted(
  userId: string,
  serialNumber: string,
  passedSets: number,
): Promise<void> {
  const learner = await loadLearner(userId);
  const subject = `IELTS preparation completed — ${learner.name}`;
  const text = [
    `${learner.name} finished PetroCademia IELTS preparation.`,
    ``,
    `Learner: ${learner.name}`,
    `Email: ${learner.email || "—"}`,
    `Certificate: ${serialNumber}`,
    `Practice sets passed: ${passedSets}`,
    `Finished: ${new Date().toISOString()}`,
    ``,
    `This is a PetroCademia preparation certificate, not an official IELTS result.`,
    `Open Admin → IELTS → Progress to review their scores.`,
  ].join("\n");

  try {
    await sendMail({
      to: staffRecipients(),
      replyTo: learner.email || undefined,
      subject,
      text,
    });
  } catch (err) {
    console.error("[completion-alerts] IELTS email failed:", err);
  }
}
