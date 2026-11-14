import PDFDocument from "pdfkit";
import { query } from "../config/db.js";
import { HttpError } from "../utils/httpError.js";
import { createNotification } from "./notifications.js";
import { appUrl } from "./mailer.js";

export type IeltsCertResult = {
  quiz_id: string;
  title: string;
  skill: string;
  score: number;
  band_score: number | null;
  completed_at: string;
};

export type IeltsTestProgress = {
  id: string;
  title: string;
  skill: string;
  passed: boolean;
  best_score: number | null;
  band_score: number | null;
};

export type IeltsSkillProgress = {
  skill: string;
  total_sets: number;
  passed_sets: number;
  attempted_sets: number;
  best_band: number | null;
  pending_review: number;
};

export type IeltsLearnerProgress = {
  user_id: string;
  user_name: string;
  user_email: string;
  attempts: number;
  passed_sets: number;
  total_sets: number;
  completion_pct: number;
  avg_band: number | null;
  last_activity: string | null;
  certificate_serial: string | null;
  certificate_issued_at: string | null;
  pending_speaking: number;
  skills: IeltsSkillProgress[];
};

type ProgressRow = {
  id: string;
  title: string;
  skill: string;
  score: number | null;
  band_score: string | number | null;
  created_at: Date | null;
  passed: boolean;
};

function toNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadIeltsProgress(userId: string): Promise<IeltsTestProgress[]> {
  const result = await query<ProgressRow>(
    `SELECT q.id,
            q.title,
            COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), 'Practice') AS skill,
            best.score,
            best.band_score,
            best.created_at,
            (best.quiz_id IS NOT NULL) AS passed
       FROM reviewer_quizzes q
       LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
       LEFT JOIN LATERAL (
         SELECT quiz_id, score, band_score, created_at
           FROM reviewer_quiz_attempts
          WHERE quiz_id = q.id AND user_id = $1 AND passed = true
          ORDER BY score DESC, created_at ASC
          LIMIT 1
       ) best ON true
      WHERE q.exam_type = 'IELTS'
        AND q.is_published = true
        AND EXISTS (
          SELECT 1 FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id
        )
      ORDER BY g.sort_order NULLS LAST, q.sort_order, q.title`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    skill: row.skill,
    passed: row.passed,
    best_score: row.score,
    band_score: toNumber(row.band_score),
  }));
}

export type IeltsUserMonitor = {
  total_sets: number;
  passed_sets: number;
  completion_pct: number;
  attempts: number;
  avg_band: number | null;
  pending_speaking: number;
  last_activity: string | null;
  certificate: {
    serial_number: string;
    issued_at: string;
  } | null;
  skills: IeltsSkillProgress[];
  tests: IeltsTestProgress[];
  recent_attempts: Array<{
    id: string;
    quiz_id: string;
    quiz_title: string;
    skill: string;
    score: number;
    passed: boolean;
    pending_review: boolean;
    band_score: number | null;
    created_at: string;
  }>;
};

/** Admin: IELTS progress for one learner (Users sheet + Progress tab). */
export async function getIeltsUserMonitor(userId: string): Promise<IeltsUserMonitor> {
  const [tests, certificate, attemptsRes, skillMeta] = await Promise.all([
    loadIeltsProgress(userId),
    getIeltsCertificate(userId),
    query<{
      id: string;
      quiz_title: string;
      skill: string;
      score: number;
      passed: boolean;
      pending_review: boolean;
      band_score: string | number | null;
      created_at: Date;
      quiz_id: string;
    }>(
      `SELECT a.id, q.title AS quiz_title,
              COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), q.category, 'Practice') AS skill,
              a.score, a.passed, a.band_score, a.created_at, a.quiz_id,
              (
                NOT a.passed
                AND EXISTS (
                  SELECT 1 FROM reviewer_quiz_questions qq
                   WHERE qq.quiz_id = q.id AND qq.question_type = 'audio_response'
                )
              ) AS pending_review
         FROM reviewer_quiz_attempts a
         JOIN reviewer_quizzes q ON q.id = a.quiz_id AND q.exam_type = 'IELTS'
         LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
        WHERE a.user_id = $1
        ORDER BY a.created_at DESC
        LIMIT 40`,
      [userId],
    ),
    query<{ id: string; skill: string; is_speaking: boolean }>(
      `SELECT q.id,
              COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), 'Practice') AS skill,
              EXISTS (
                SELECT 1 FROM reviewer_quiz_questions qq
                 WHERE qq.quiz_id = q.id AND qq.question_type = 'audio_response'
              ) AS is_speaking
         FROM reviewer_quizzes q
         LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
        WHERE q.exam_type = 'IELTS'
          AND q.is_published = true
          AND EXISTS (SELECT 1 FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id)
        ORDER BY g.sort_order NULLS LAST, q.sort_order, q.title`,
    ),
  ]);

  const totalSets = tests.length;
  const passedSets = tests.filter((t) => t.passed).length;

  const attemptedByQuiz = new Map<string, { pending: boolean }>();
  for (const row of attemptsRes.rows) {
    const existing = attemptedByQuiz.get(row.quiz_id);
    if (!existing) {
      attemptedByQuiz.set(row.quiz_id, { pending: row.pending_review });
    } else if (row.pending_review) {
      existing.pending = true;
    }
  }

  const skillOrder: string[] = [];
  const skillBuckets = new Map<
    string,
    { total: number; passed: number; attempted: number; pending: number; bandSum: number; bandCount: number }
  >();
  for (const quiz of skillMeta.rows) {
    if (!skillBuckets.has(quiz.skill)) {
      skillOrder.push(quiz.skill);
      skillBuckets.set(quiz.skill, {
        total: 0,
        passed: 0,
        attempted: 0,
        pending: 0,
        bandSum: 0,
        bandCount: 0,
      });
    }
    const bucket = skillBuckets.get(quiz.skill)!;
    bucket.total += 1;
    const test = tests.find((t) => t.id === quiz.id);
    if (test?.passed) bucket.passed += 1;
    if (test?.band_score != null) {
      bucket.bandSum += test.band_score;
      bucket.bandCount += 1;
    }
    if (attemptedByQuiz.has(quiz.id)) {
      bucket.attempted += 1;
      if (!test?.passed && quiz.is_speaking) bucket.pending += 1;
    }
  }

  const skills: IeltsSkillProgress[] = skillOrder.map((skill) => {
    const bucket = skillBuckets.get(skill)!;
    return {
      skill,
      total_sets: bucket.total,
      passed_sets: bucket.passed,
      attempted_sets: bucket.attempted,
      best_band:
        bucket.bandCount > 0 ? Math.round((bucket.bandSum / bucket.bandCount) * 10) / 10 : null,
      pending_review: bucket.pending,
    };
  });

  let pendingSpeaking = 0;
  for (const skill of skills) pendingSpeaking += skill.pending_review;

  const bandValues = attemptsRes.rows
    .map((r) => toNumber(r.band_score))
    .filter((n): n is number => n != null);
  const avgBand =
    bandValues.length > 0
      ? Math.round((bandValues.reduce((a, b) => a + b, 0) / bandValues.length) * 10) / 10
      : null;

  const lastActivity = attemptsRes.rows[0]?.created_at?.toISOString() ?? null;

  return {
    total_sets: totalSets,
    passed_sets: passedSets,
    completion_pct: totalSets > 0 ? Math.round((passedSets / totalSets) * 100) : 0,
    attempts: attemptsRes.rows.length,
    avg_band: avgBand,
    pending_speaking: pendingSpeaking,
    last_activity: lastActivity,
    certificate: certificate
      ? {
          serial_number: certificate.serial_number,
          issued_at:
            certificate.issued_at instanceof Date
              ? certificate.issued_at.toISOString()
              : String(certificate.issued_at),
        }
      : null,
    skills,
    tests,
    recent_attempts: attemptsRes.rows.map((row) => ({
      id: row.id,
      quiz_id: row.quiz_id,
      quiz_title: row.quiz_title,
      skill: row.skill,
      score: row.score,
      passed: row.passed,
      pending_review: row.pending_review,
      band_score: toNumber(row.band_score),
      created_at: row.created_at.toISOString(),
    })),
  };
}

/** Admin: aggregate IELTS progress for every learner who has attempted a set. */
export async function listIeltsLearnersProgress(
  search?: string,
): Promise<{ total_sets: number; total_users: number; learners: IeltsLearnerProgress[] }> {
  const published = await query<{
    id: string;
    title: string;
    skill: string;
    is_speaking: boolean;
  }>(
    `SELECT q.id,
            q.title,
            COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), 'Practice') AS skill,
            EXISTS (
              SELECT 1 FROM reviewer_quiz_questions qq
               WHERE qq.quiz_id = q.id AND qq.question_type = 'audio_response'
            ) AS is_speaking
       FROM reviewer_quizzes q
       LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
      WHERE q.exam_type = 'IELTS'
        AND q.is_published = true
        AND EXISTS (
          SELECT 1 FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id
        )
      ORDER BY g.sort_order NULLS LAST, q.sort_order, q.title`,
  );

  const totalSets = published.rows.length;
  const enrolled = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ielts_access_grants`,
  );
  const totalUsers = Number(enrolled.rows[0]?.count ?? 0) || 0;
  const quizMeta = new Map(
    published.rows.map((row) => [
      row.id,
      { skill: row.skill, is_speaking: row.is_speaking, title: row.title },
    ]),
  );

  const values: unknown[] = [];
  let searchSql = "";
  if (search?.trim()) {
    values.push(`%${search.trim()}%`);
    searchSql = ` AND (
      u.email ILIKE $1
      OR COALESCE(u.full_name, u.name, '') ILIKE $1
    )`;
  }

  const rows = await query<{
    user_id: string;
    user_email: string;
    user_name: string;
    quiz_id: string;
    attempt_count: number;
    ever_passed: boolean;
    best_score: number | null;
    best_band: string | number | null;
    last_at: Date;
    certificate_serial: string | null;
    certificate_issued_at: Date | null;
  }>(
    `SELECT a.user_id,
            u.email AS user_email,
            COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Learner') AS user_name,
            a.quiz_id,
            COUNT(*)::int AS attempt_count,
            BOOL_OR(a.passed) AS ever_passed,
            MAX(a.score)::int AS best_score,
            MAX(a.band_score) AS best_band,
            MAX(a.created_at) AS last_at,
            c.serial_number AS certificate_serial,
            c.issued_at AS certificate_issued_at
       FROM reviewer_quiz_attempts a
       JOIN reviewer_quizzes q ON q.id = a.quiz_id AND q.exam_type = 'IELTS'
       JOIN users u ON u.id = a.user_id
       LEFT JOIN ielts_completion_certificates c ON c.user_id = a.user_id
      WHERE a.user_id IS NOT NULL
        ${searchSql}
      GROUP BY a.user_id, u.email, u.full_name, u.name, a.quiz_id, c.serial_number, c.issued_at
      ORDER BY MAX(a.created_at) DESC`,
    values,
  );

  type Acc = {
    user_id: string;
    user_name: string;
    user_email: string;
    attempts: number;
    passed_sets: number;
    bandSum: number;
    bandCount: number;
    last_activity: Date | null;
    certificate_serial: string | null;
    certificate_issued_at: Date | null;
    pending_speaking: number;
    bySkill: Map<
      string,
      {
        total_sets: number;
        passed_sets: number;
        attempted_sets: number;
        bandSum: number;
        bandCount: number;
        pending_review: number;
      }
    >;
    seenQuizzes: Set<string>;
  };

  const skillTotals = new Map<string, number>();
  for (const quiz of published.rows) {
    skillTotals.set(quiz.skill, (skillTotals.get(quiz.skill) ?? 0) + 1);
  }

  const byUser = new Map<string, Acc>();

  for (const row of rows.rows) {
    let acc = byUser.get(row.user_id);
    if (!acc) {
      const bySkill = new Map<
        string,
        {
          total_sets: number;
          passed_sets: number;
          attempted_sets: number;
          bandSum: number;
          bandCount: number;
          pending_review: number;
        }
      >();
      for (const [skill, total] of skillTotals) {
        bySkill.set(skill, {
          total_sets: total,
          passed_sets: 0,
          attempted_sets: 0,
          bandSum: 0,
          bandCount: 0,
          pending_review: 0,
        });
      }
      acc = {
        user_id: row.user_id,
        user_name: row.user_name,
        user_email: row.user_email,
        attempts: 0,
        passed_sets: 0,
        bandSum: 0,
        bandCount: 0,
        last_activity: null,
        certificate_serial: row.certificate_serial,
        certificate_issued_at: row.certificate_issued_at,
        pending_speaking: 0,
        bySkill,
        seenQuizzes: new Set(),
      };
      byUser.set(row.user_id, acc);
    }

    acc.attempts += row.attempt_count;
    if (!acc.last_activity || row.last_at > acc.last_activity) {
      acc.last_activity = row.last_at;
    }
    if (row.certificate_serial) {
      acc.certificate_serial = row.certificate_serial;
      acc.certificate_issued_at = row.certificate_issued_at;
    }

    const meta = quizMeta.get(row.quiz_id);
    const skill = meta?.skill ?? "Practice";
    if (!acc.bySkill.has(skill)) {
      acc.bySkill.set(skill, {
        total_sets: skillTotals.get(skill) ?? 0,
        passed_sets: 0,
        attempted_sets: 0,
        bandSum: 0,
        bandCount: 0,
        pending_review: 0,
      });
    }
    const skillAcc = acc.bySkill.get(skill)!;

    if (!acc.seenQuizzes.has(row.quiz_id)) {
      acc.seenQuizzes.add(row.quiz_id);
      skillAcc.attempted_sets += 1;
      if (row.ever_passed) {
        acc.passed_sets += 1;
        skillAcc.passed_sets += 1;
      } else if (meta?.is_speaking) {
        acc.pending_speaking += 1;
        skillAcc.pending_review += 1;
      }
    }

    const band = toNumber(row.best_band);
    if (band != null) {
      acc.bandSum += band;
      acc.bandCount += 1;
      skillAcc.bandSum += band;
      skillAcc.bandCount += 1;
    }
  }

  const learners: IeltsLearnerProgress[] = [...byUser.values()]
    .map((acc) => {
      const skills: IeltsSkillProgress[] = [...acc.bySkill.entries()]
        .map(([skill, s]) => ({
          skill,
          total_sets: s.total_sets,
          passed_sets: s.passed_sets,
          attempted_sets: s.attempted_sets,
          best_band:
            s.bandCount > 0 ? Math.round((s.bandSum / s.bandCount) * 10) / 10 : null,
          pending_review: s.pending_review,
        }))
        .sort((a, b) => a.skill.localeCompare(b.skill));

      return {
        user_id: acc.user_id,
        user_name: acc.user_name,
        user_email: acc.user_email,
        attempts: acc.attempts,
        passed_sets: acc.passed_sets,
        total_sets: totalSets,
        completion_pct:
          totalSets > 0 ? Math.round((acc.passed_sets / totalSets) * 100) : 0,
        avg_band:
          acc.bandCount > 0 ? Math.round((acc.bandSum / acc.bandCount) * 10) / 10 : null,
        last_activity: acc.last_activity?.toISOString() ?? null,
        certificate_serial: acc.certificate_serial,
        certificate_issued_at: acc.certificate_issued_at?.toISOString() ?? null,
        pending_speaking: acc.pending_speaking,
        skills,
      };
    })
    .sort((a, b) => {
      const aTime = a.last_activity ? Date.parse(a.last_activity) : 0;
      const bTime = b.last_activity ? Date.parse(b.last_activity) : 0;
      return bTime - aTime;
    });

  return { total_sets: totalSets, total_users: totalUsers, learners };
}

type StoredCert = {
  id: string;
  user_id: string;
  serial_number: string;
  results: IeltsCertResult[];
  issued_at: Date;
  holder_name: string;
};

async function nextSerial(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SPX-IELTS-${year}-`;
  const result = await query<{ serial_number: string }>(
    `SELECT serial_number FROM ielts_completion_certificates
      WHERE serial_number LIKE $1
      ORDER BY serial_number DESC
      LIMIT 1`,
    [`${prefix}%`],
  );
  const last = result.rows[0]?.serial_number;
  let seq = 1;
  if (last) {
    const n = Number(last.slice(prefix.length));
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(5, "0")}`;
}

export async function getIeltsCertificate(userId: string): Promise<StoredCert | null> {
  const result = await query<{
    id: string;
    user_id: string;
    serial_number: string;
    results: IeltsCertResult[];
    issued_at: Date;
    full_name: string | null;
    name: string | null;
    email: string;
  }>(
    `SELECT c.id, c.user_id, c.serial_number, c.results, c.issued_at,
            u.full_name, u.name, u.email
       FROM ielts_completion_certificates c
       JOIN users u ON u.id = c.user_id
      WHERE c.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    serial_number: row.serial_number,
    results: row.results ?? [],
    issued_at: row.issued_at,
    holder_name: row.full_name?.trim() || row.name?.trim() || row.email,
  };
}

export async function issueIeltsCertificate(userId: string): Promise<StoredCert> {
  const existing = await getIeltsCertificate(userId);
  if (existing) return existing;

  const progress = await loadIeltsProgress(userId);
  if (progress.length === 0) {
    throw HttpError.badRequest("No published IELTS practice tests are available yet.");
  }
  const missing = progress.filter((test) => !test.passed);
  if (missing.length > 0) {
    throw HttpError.badRequest(
      `Pass every published IELTS practice test first (${progress.length - missing.length} of ${progress.length} passed).`,
    );
  }

  const completed = await query<ProgressRow>(
    `SELECT q.id,
            q.title,
            COALESCE(NULLIF(g.subject, ''), NULLIF(g.title, ''), 'Practice') AS skill,
            best.score,
            best.band_score,
            best.created_at,
            true AS passed
       FROM reviewer_quizzes q
       LEFT JOIN reviewer_quiz_groups g ON g.id = q.group_id
       JOIN LATERAL (
         SELECT score, band_score, created_at
           FROM reviewer_quiz_attempts
          WHERE quiz_id = q.id AND user_id = $1 AND passed = true
          ORDER BY score DESC, created_at ASC
          LIMIT 1
       ) best ON true
      WHERE q.exam_type = 'IELTS'
        AND q.is_published = true
        AND EXISTS (SELECT 1 FROM reviewer_quiz_questions qq WHERE qq.quiz_id = q.id)
      ORDER BY g.sort_order NULLS LAST, q.sort_order, q.title`,
    [userId],
  );

  const results: IeltsCertResult[] = completed.rows.map((row) => ({
    quiz_id: row.id,
    title: row.title,
    skill: row.skill,
    score: row.score ?? 0,
    band_score: toNumber(row.band_score),
    completed_at: (row.created_at ?? new Date()).toISOString(),
  }));

  let serial = await nextSerial();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await query(
        `INSERT INTO ielts_completion_certificates (user_id, serial_number, results)
         VALUES ($1, $2, $3)`,
        [userId, serial, JSON.stringify(results)],
      );
      break;
    } catch {
      const again = await getIeltsCertificate(userId);
      if (again) return again;
      serial = await nextSerial();
    }
  }

  const issued = await getIeltsCertificate(userId);
  if (!issued) throw HttpError.badRequest("Could not issue the certificate.");

  await createNotification({
    userId,
    type: "certificate.issued",
    title: "IELTS preparation certificate",
    body: `Your PetroCademia certificate of completion is ready. Serial ${issued.serial_number}.`,
    link: "/ielts#certificate",
    referenceId: issued.id,
  }).catch(() => {});

  try {
    const { upsertRegistryEntry } = await import("./certificate-registry.js");
    await upsertRegistryEntry({
      serial_number: issued.serial_number,
      course_title: "IELTS Preparation",
      learner_name: issued.holder_name,
      learner_email: null,
      issued_at: issued.issued_at,
      source: "ielts",
      user_id: userId,
    });
  } catch (err) {
    console.error("[ielts] registry sync failed:", err);
  }

  const { notifyStaffIeltsCompleted } = await import("./completion-alerts.js");
  await notifyStaffIeltsCompleted(userId, issued.serial_number, results.length).catch(() => {});

  return issued;
}

export type PublicCertificate = {
  valid: true;
  kind: "ielts_preparation" | "course" | "legacy";
  holder_name: string;
  serial_number: string;
  issued_at: string;
  title: string;
  issuer: string;
  disclaimer: string;
  results?: IeltsCertResult[];
  learner_email?: string | null;
};

export async function lookupCertificateBySerial(
  serial: string,
): Promise<PublicCertificate | null> {
  const normalized = serial.trim().toUpperCase();
  if (!normalized) return null;

  const ielts = await query<{
    serial_number: string;
    results: IeltsCertResult[];
    issued_at: Date;
    full_name: string | null;
    name: string | null;
    email: string;
  }>(
    `SELECT c.serial_number, c.results, c.issued_at, u.full_name, u.name, u.email
       FROM ielts_completion_certificates c
       JOIN users u ON u.id = c.user_id
      WHERE upper(c.serial_number) = $1`,
    [normalized],
  );
  const ieltsRow = ielts.rows[0];
  if (ieltsRow) {
    return {
      valid: true,
      kind: "ielts_preparation",
      holder_name: ieltsRow.full_name?.trim() || ieltsRow.name?.trim() || "Learner",
      serial_number: ieltsRow.serial_number,
      issued_at: ieltsRow.issued_at.toISOString(),
      title: "IELTS Preparation",
      issuer: "Petrosphere Incorporated",
      disclaimer:
        "Certificate of completion for PetroCademia IELTS preparation. This is not an official IELTS result. Official IELTS scores are issued only by the British Council, IDP, or Cambridge.",
      results: ieltsRow.results ?? [],
    };
  }

  const course = await query<{
    serial_number: string;
    issued_at: Date;
    course_title: string | null;
    full_name: string | null;
    name: string | null;
    email: string;
  }>(
    `SELECT cert.serial_number, cert.issued_at, c.title AS course_title,
            u.full_name, u.name, u.email
       FROM certificates cert
       JOIN users u ON u.id = cert.user_id
       LEFT JOIN courses c ON c.id = cert.course_id
      WHERE upper(cert.serial_number) = $1`,
    [normalized],
  );
  const courseRow = course.rows[0];
  if (courseRow) {
    return {
      valid: true,
      kind: "course",
      holder_name: courseRow.full_name?.trim() || courseRow.name?.trim() || "Learner",
      serial_number: courseRow.serial_number,
      issued_at: courseRow.issued_at.toISOString(),
      title: courseRow.course_title ?? "Course",
      issuer: "Petrosphere Incorporated",
      disclaimer:
        "Certificate of course completion issued by PetroCademia. It confirms training finished on this platform.",
    };
  }

  try {
    const { getRegistryBySerial } = await import("./certificate-registry.js");
    const legacy = await getRegistryBySerial(normalized);
    if (!legacy) return null;
    return {
      valid: true,
      kind: legacy.source === "ielts" ? "ielts_preparation" : legacy.source === "lms" ? "course" : "legacy",
      holder_name: legacy.learner_name,
      serial_number: legacy.serial_number,
      issued_at: legacy.issued_at.toISOString(),
      title: legacy.course_title,
      issuer: "Petrosphere Incorporated",
      disclaimer:
        legacy.source === "legacy"
          ? "Certificate of completion from Petrosphere eLearning (previous platform). Verified in the PetroCademia certificate registry."
          : "Certificate of course completion issued by PetroCademia. It confirms training finished on this platform.",
      learner_email: legacy.learner_email,
    };
  } catch {
    return null;
  }
}

export function buildIeltsCertificatePdf(cert: StoredCert): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    doc.rect(0, 0, pageWidth, 10).fill("#FF4B1A");

    doc.fillColor("#1a1f2e").font("Helvetica-Bold").fontSize(12).text("PETROCADEMIA", 48, 36, {
      align: "center",
      width: pageWidth - 96,
    });
    doc
      .fillColor("#6b5c4f")
      .font("Helvetica")
      .fontSize(10)
      .text("Petrosphere Incorporated", 48, 52, { align: "center", width: pageWidth - 96 });

    doc
      .fillColor("#1a1f2e")
      .font("Helvetica-Bold")
      .fontSize(22)
      .text("Certificate of Completion", 48, 84, { align: "center", width: pageWidth - 96 });
    doc
      .fillColor("#FF4B1A")
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("IELTS Preparation", 48, 114, { align: "center", width: pageWidth - 96 });

    doc
      .fillColor("#6b5c4f")
      .font("Helvetica")
      .fontSize(11)
      .text("This certifies that", 48, 148, { align: "center", width: pageWidth - 96 });
    doc
      .fillColor("#1a1f2e")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(cert.holder_name, 48, 168, { align: "center", width: pageWidth - 96 });
    doc
      .fillColor("#6b5c4f")
      .font("Helvetica")
      .fontSize(11)
      .text("passed the PetroCademia IELTS preparation tests listed below.", 48, 196, {
        align: "center",
        width: pageWidth - 96,
      });

    const issued = cert.issued_at.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    doc
      .fillColor("#1a1f2e")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`Serial No. ${cert.serial_number}`, 48, 228, { align: "center", width: pageWidth - 96 });
    doc
      .fillColor("#6b5c4f")
      .font("Helvetica")
      .fontSize(10)
      .text(`Issued ${issued}`, 48, 244, { align: "center", width: pageWidth - 96 });

    let y = 280;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#6b5c4f");
    doc.text("Skill", 48, y, { width: 90 });
    doc.text("Test", 140, y, { width: 250 });
    doc.text("Score", 400, y, { width: 50 });
    doc.text("Practice band", 450, y, { width: 90 });
    y += 16;
    doc.moveTo(48, y).lineTo(pageWidth - 48, y).strokeColor("#ebe4da").stroke();
    y += 8;

    doc.font("Helvetica").fontSize(9).fillColor("#1a1f2e");
    for (const row of cert.results) {
      const band = row.band_score == null ? "—" : Number(row.band_score).toFixed(1);
      doc.text(row.skill, 48, y, { width: 90 });
      doc.text(row.title, 140, y, { width: 250 });
      doc.text(`${row.score}%`, 400, y, { width: 50 });
      doc.text(band, 450, y, { width: 90 });
      y += 18;
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 48;
      }
    }

    const footerY = Math.max(y + 24, doc.page.height - 110);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#8a7d72")
      .text(
        "Practice bands are PetroCademia estimates from these drills. This certificate is not an official IELTS Test Report Form. Official IELTS scores are issued only by the British Council, IDP, or Cambridge.",
        48,
        footerY,
        { width: pageWidth - 96, align: "center" },
      );
    doc
      .fontSize(8)
      .fillColor("#FF4B1A")
      .text(`Verify: ${appUrl(`/verify/${cert.serial_number}`)}`, 48, footerY + 36, {
        width: pageWidth - 96,
        align: "center",
      });

    doc.end();
  });
}
