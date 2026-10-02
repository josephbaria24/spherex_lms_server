import { mkdirSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { query } from "../config/db.js";
import { getUploadsRoot } from "./org-uploads.js";
import { createNotification } from "./notifications.js";
import { appUrl } from "./mailer.js";

export function initCertificatePhotoUploadsDirectory(): string {
  const dir = join(getUploadsRoot(), "certificate-photos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function certificatePhotoPublicPath(filename: string): string {
  return `/uploads/certificate-photos/${filename}`;
}

export function certificatePhotoAbsolutePath(publicPath: string): string | null {
  const marker = "/certificate-photos/";
  const idx = publicPath.indexOf(marker);
  if (idx < 0) return null;
  const filename = publicPath.slice(idx + marker.length).replace(/[/\\]/g, "");
  if (!filename) return null;
  return join(getUploadsRoot(), "certificate-photos", filename);
}

async function nextSerialNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SPX-CERT-${year}-`;
  const result = await query<{ serial_number: string }>(
    `SELECT serial_number FROM certificates
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

export type IssuedCertificate = {
  id: string;
  user_id: string;
  course_id: string | null;
  serial_number: string | null;
  certificate_url: string | null;
  issued_at: Date;
  created: boolean;
};

/**
 * Issue a certificate when a course is completed (idempotent per user+course).
 */
export async function issueCertificateIfNeeded(
  userId: string,
  courseId: string,
): Promise<IssuedCertificate | null> {
  const existing = await query<IssuedCertificate>(
    `SELECT id, user_id, course_id, serial_number, certificate_url, issued_at
       FROM certificates
      WHERE user_id = $1 AND course_id = $2
      LIMIT 1`,
    [userId, courseId],
  );
  if (existing.rows[0]) {
    return { ...existing.rows[0], created: false };
  }

  const course = await query<{ title: string }>(
    `SELECT title FROM courses WHERE id = $1`,
    [courseId],
  );
  const courseTitle = course.rows[0]?.title ?? "a course";

  let serial = await nextSerialNumber();
  let inserted: IssuedCertificate | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await query<IssuedCertificate>(
        `INSERT INTO certificates (user_id, course_id, serial_number, certificate_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, course_id) WHERE course_id IS NOT NULL DO NOTHING
         RETURNING id, user_id, course_id, serial_number, certificate_url, issued_at`,
        [userId, courseId, serial, null],
      );
      if (result.rows[0]) {
        inserted = { ...result.rows[0], created: true };
        break;
      }
      // conflict on user+course — already issued
      const again = await query<IssuedCertificate>(
        `SELECT id, user_id, course_id, serial_number, certificate_url, issued_at
           FROM certificates WHERE user_id = $1 AND course_id = $2 LIMIT 1`,
        [userId, courseId],
      );
      if (again.rows[0]) return { ...again.rows[0], created: false };
      serial = await nextSerialNumber();
    } catch {
      serial = await nextSerialNumber();
    }
  }

  if (!inserted) return null;

  // Point certificate_url at our PDF download path (client-proxied)
  const pdfPath = `/api/lms/certificates/${inserted.id}/pdf`;
  await query(`UPDATE certificates SET certificate_url = $1 WHERE id = $2`, [
    pdfPath,
    inserted.id,
  ]);
  inserted.certificate_url = pdfPath;

  await createNotification({
    userId,
    type: "certificate.issued",
    title: "Certificate earned",
    body: `You completed "${courseTitle}". Serial ${inserted.serial_number}. Download it from Achievements.`,
    link: "/achievements",
    referenceId: inserted.id,
  }).catch(() => {});

  return inserted;
}

type CertPdfData = {
  serial_number: string | null;
  issued_at: Date;
  course_title: string | null;
  learner_name: string;
  photo_path: string | null;
};

export async function loadCertificatePdfData(
  certificateId: string,
): Promise<CertPdfData | null> {
  const result = await query<{
    serial_number: string | null;
    issued_at: Date;
    course_title: string | null;
    full_name: string | null;
    name: string | null;
    email: string;
    certificate_photo_path: string | null;
  }>(
    `SELECT cert.serial_number, cert.issued_at, c.title AS course_title,
            u.full_name, u.name, u.email, u.certificate_photo_path
       FROM certificates cert
       JOIN users u ON u.id = cert.user_id
       LEFT JOIN courses c ON c.id = cert.course_id
      WHERE cert.id = $1`,
    [certificateId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    serial_number: row.serial_number,
    issued_at: row.issued_at,
    course_title: row.course_title,
    learner_name: row.full_name?.trim() || row.name?.trim() || row.email,
    photo_path: row.certificate_photo_path,
  };
}

export async function buildCertificatePdfBuffer(data: CertPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      layout: "landscape",
      margin: 48,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    // Border
    doc
      .lineWidth(2)
      .strokeColor("#1a1f2e")
      .rect(36, 36, pageWidth - 72, pageHeight - 72)
      .stroke();
    doc
      .lineWidth(0.75)
      .strokeColor("#e85d4a")
      .rect(44, 44, pageWidth - 88, pageHeight - 88)
      .stroke();

    doc
      .fillColor("#1a1f2e")
      .fontSize(14)
      .font("Helvetica")
      .text("SPHEREX LMS", 60, 64, { align: "center", width: pageWidth - 120 });

    doc
      .fillColor("#e85d4a")
      .fontSize(28)
      .font("Helvetica-Bold")
      .text("Certificate of Completion", 60, 96, {
        align: "center",
        width: pageWidth - 120,
      });

    doc
      .fillColor("#6b5c4f")
      .fontSize(12)
      .font("Helvetica")
      .text("This certifies that", 60, 150, {
        align: "center",
        width: pageWidth - 120,
      });

    // Optional 2x2 photo (≈51mm / ~144pt at 72dpi for 2 inches)
    const photoSize = 108;
    const photoX = pageWidth - 60 - photoSize;
    const photoY = 168;
    if (data.photo_path) {
      const abs = certificatePhotoAbsolutePath(data.photo_path);
      if (abs) {
        try {
          doc.image(abs, photoX, photoY, {
            width: photoSize,
            height: photoSize,
            fit: [photoSize, photoSize],
            align: "center",
            valign: "center",
          });
          doc
            .lineWidth(1)
            .strokeColor("#1a1f2e")
            .rect(photoX, photoY, photoSize, photoSize)
            .stroke();
        } catch {
          // skip missing/corrupt image
        }
      }
    }

    doc
      .fillColor("#1c1917")
      .fontSize(26)
      .font("Helvetica-Bold")
      .text(data.learner_name, 60, 178, {
        align: "center",
        width: pageWidth - 120 - (data.photo_path ? photoSize + 24 : 0),
      });

    doc
      .fillColor("#6b5c4f")
      .fontSize(12)
      .font("Helvetica")
      .text("has successfully completed", 60, 220, {
        align: "center",
        width: pageWidth - 120,
      });

    doc
      .fillColor("#1a1f2e")
      .fontSize(20)
      .font("Helvetica-Bold")
      .text(data.course_title ?? "Course", 60, 248, {
        align: "center",
        width: pageWidth - 120,
      });

    const issued = data.issued_at.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    doc
      .fillColor("#6b5c4f")
      .fontSize(11)
      .font("Helvetica")
      .text(`Issued on ${issued}`, 60, 300, {
        align: "center",
        width: pageWidth - 120,
      });

    if (data.serial_number) {
      doc
        .fillColor("#1a1f2e")
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(`Serial No. ${data.serial_number}`, 60, 322, {
          align: "center",
          width: pageWidth - 120,
        });
    }

    doc
      .fillColor("#8a7d72")
      .fontSize(9)
      .font("Helvetica")
      .text(appUrl("/achievements"), 60, pageHeight - 70, {
        align: "center",
        width: pageWidth - 120,
      });

    doc.end();
  });
}
