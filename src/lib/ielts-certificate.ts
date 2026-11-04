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

  return issued;
}

export type PublicCertificate = {
  valid: true;
  kind: "ielts_preparation" | "course";
  holder_name: string;
  serial_number: string;
  issued_at: string;
  title: string;
  issuer: string;
  disclaimer: string;
  results?: IeltsCertResult[];
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
  if (!courseRow) return null;
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
