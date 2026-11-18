import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { query } from "../config/db.js";
import { getUploadsRoot } from "./org-uploads.js";
import { createNotification, listAdminUserIds, notifyUsers } from "./notifications.js";
import { appUrl } from "./mailer.js";
import {
  certificateTemplateAbsolutePath,
  certificateTemplateIsReady,
  loadCertificateTemplate,
  type CertificateField,
  type CertificateTemplateRecord,
} from "./certificate-template.js";

/** Target print density for high-res template canvases (pixels → PDF points). */
const CERTIFICATE_PRINT_DPI = 300;
const PDF_POINTS_PER_INCH = 72;

function isJpegBuffer(data: Buffer): boolean {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
}

function isPngBuffer(data: Buffer): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  );
}

function isWebpBuffer(data: Buffer): boolean {
  return (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  );
}

/** Read PNG/JPEG pixel size from file headers (no decode / no re-encode). */
function readRasterImageSize(data: Buffer): { width: number; height: number } | null {
  if (isPngBuffer(data) && data.length >= 24) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (!isJpegBuffer(data)) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const size = data.readUInt16BE(offset + 2);
    // SOF0 / SOF1 / SOF2
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + size;
  }
  return null;
}

function paperSizePoints(pageSize: string): { width: number; height: number } {
  switch (pageSize) {
    case "a4-portrait":
      return { width: 595.28, height: 841.89 };
    case "letter-landscape":
      return { width: 792, height: 612 };
    case "letter-portrait":
      return { width: 612, height: 792 };
    case "a4-landscape":
    default:
      return { width: 841.89, height: 595.28 };
  }
}

/**
 * Map the template canvas onto a print-ready PDF page.
 * High-res pixel canvases (typical after a 300 DPI upload) are sized so each
 * pixel prints at CERTIFICATE_PRINT_DPI — PDFKit still embeds the original
 * raster bytes with no downsample/re-encode.
 */
function resolvePrintPage(
  template: CertificateTemplateRecord,
): { width: number; height: number; scaleX: number; scaleY: number } {
  const paper = paperSizePoints(template.page_size);
  const canvasW = Math.max(template.canvas_width, 1);
  const canvasH = Math.max(template.canvas_height, 1);
  const looksLikePixels = canvasW >= paper.width * 1.75 || canvasH >= paper.height * 1.75;

  if (looksLikePixels) {
    const width = (canvasW / CERTIFICATE_PRINT_DPI) * PDF_POINTS_PER_INCH;
    const height = (canvasH / CERTIFICATE_PRINT_DPI) * PDF_POINTS_PER_INCH;
    return { width, height, scaleX: width / canvasW, scaleY: height / canvasH };
  }

  return {
    width: paper.width,
    height: paper.height,
    scaleX: paper.width / canvasW,
    scaleY: paper.height / canvasH,
  };
}

/**
 * Embed a certificate raster at full source resolution.
 * PDFKit only supports JPEG/PNG; WebP (and other formats) must not be silently skipped.
 */
function drawFullPageImage(
  doc: InstanceType<typeof PDFDocument>,
  absolutePath: string,
  pageWidth: number,
  pageHeight: number,
): void {
  const data = readFileSync(absolutePath);
  if (isWebpBuffer(data)) {
    throw new Error(
      "Certificate background is WebP. Re-upload as PNG or JPEG so the PDF can keep print resolution.",
    );
  }
  if (!isJpegBuffer(data) && !isPngBuffer(data)) {
    throw new Error("Certificate background must be a PNG or JPEG image.");
  }
  // Pass the original bytes through — JPEG stays DCTDecode; PNG stays lossless Flate.
  // Placement size is in PDF points only; pixel dimensions inside the XObject are unchanged.
  const size = readRasterImageSize(data);
  if (size && size.width > 0 && size.height > 0) {
    const imageAspect = size.width / size.height;
    const pageAspect = pageWidth / pageHeight;
    // Prefer cover so artwork fills the page without lowering pixel density via letterboxing.
    if (Math.abs(imageAspect - pageAspect) > 0.02) {
      doc.image(data, 0, 0, {
        cover: [pageWidth, pageHeight],
        align: "center",
        valign: "center",
      });
      return;
    }
  }
  doc.image(data, 0, 0, { width: pageWidth, height: pageHeight });
}

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

async function nextSerialNumber(courseId: string): Promise<string> {
  const { allocateCourseSerial } = await import("./certificate-registry.js");
  return allocateCourseSerial(courseId);
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
  const template = await loadCertificateTemplate(courseId);
  if (!certificateTemplateIsReady(template)) {
    return null;
  }

  let serial = await nextSerialNumber(courseId);
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
      serial = await nextSerialNumber(courseId);
    } catch {
      serial = await nextSerialNumber(courseId);
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

  try {
    const learner = await query<{
      full_name: string | null;
      name: string | null;
      email: string;
    }>(`SELECT full_name, name, email FROM users WHERE id = $1`, [userId]);
    const u = learner.rows[0];
    const { upsertRegistryEntry } = await import("./certificate-registry.js");
    await upsertRegistryEntry({
      serial_number: inserted.serial_number ?? serial,
      course_title: courseTitle,
      learner_name: u?.full_name?.trim() || u?.name?.trim() || u?.email || "Learner",
      learner_email: u?.email ?? null,
      issued_at: inserted.issued_at,
      source: "lms",
      course_id: courseId,
      user_id: userId,
      lms_certificate_id: inserted.id,
    });
  } catch (err) {
    console.error("[certificates] registry sync failed:", err);
  }

  return inserted;
}

/** Tell admins a learner finished a course that still has no certificate design. */
export async function notifyAdminsMissingCertificate(
  userId: string,
  courseId: string,
  enrollmentId: string,
): Promise<void> {
  const template = await loadCertificateTemplate(courseId);
  if (certificateTemplateIsReady(template)) return;

  const details = await query<{
    full_name: string | null;
    name: string | null;
    email: string;
    title: string | null;
  }>(
    `SELECT u.full_name, u.name, u.email, c.title
       FROM users u
       LEFT JOIN courses c ON c.id = $2
      WHERE u.id = $1`,
    [userId, courseId],
  );
  const row = details.rows[0];
  const learner = row?.full_name?.trim() || row?.name?.trim() || row?.email || "A learner";
  const title = row?.title ?? "a course";
  const admins = await listAdminUserIds();
  await notifyUsers(admins, {
    type: "certificate.missing",
    title: "Finished course has no certificate",
    body: `${learner} finished "${title}". This course does not have a certificate set up yet.`,
    link: `/admin/courses/${courseId}/certificate`,
    referenceId: enrollmentId,
  });
}

type CertPdfData = {
  course_id: string | null;
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
    course_id: string | null;
    serial_number: string | null;
    issued_at: Date;
    course_title: string | null;
    full_name: string | null;
    name: string | null;
    email: string;
    certificate_photo_path: string | null;
  }>(
    `SELECT cert.course_id, cert.serial_number, cert.issued_at, c.title AS course_title,
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
    course_id: row.course_id,
    serial_number: row.serial_number,
    issued_at: row.issued_at,
    course_title: row.course_title,
    learner_name: row.full_name?.trim() || row.name?.trim() || row.email,
    photo_path: row.certificate_photo_path,
  };
}

function pdfFontName(field: CertificateField): string {
  const times = field.fontFamily === "Times";
  if (field.fontStyle === "italic" && field.fontWeight === "bold") {
    return times ? "Times-BoldItalic" : "Helvetica-BoldOblique";
  }
  if (field.fontStyle === "italic") return times ? "Times-Italic" : "Helvetica-Oblique";
  if (field.fontWeight === "bold") return times ? "Times-Bold" : "Helvetica-Bold";
  return times ? "Times-Roman" : "Helvetica";
}

function isPictureValue(value: string): boolean {
  const token = value.trim();
  return token === "{{learner_picture}}" || token === "{{trainee_picture}}";
}

function fillCertificateText(value: string, data: CertPdfData): string {
  const issued = data.issued_at.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const serial = data.serial_number ?? "";
  const title = data.course_title ?? "";
  return value
    .replaceAll("{{learner_name}}", data.learner_name)
    .replaceAll("{{trainee_name}}", data.learner_name)
    .replaceAll("{{course_title}}", title)
    .replaceAll("{{course_name}}", title)
    .replaceAll("{{completion_date}}", issued)
    .replaceAll("{{given_this}}", issued)
    .replaceAll("{{certificate_number}}", serial);
}

function renderTemplatePdf(
  data: CertPdfData,
  template: CertificateTemplateRecord,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const page = resolvePrintPage(template);
    const doc = new PDFDocument({
      size: [page.width, page.height],
      margin: 0,
      compress: true,
      autoFirstPage: true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const { scaleX, scaleY } = page;

    if (template.image_path) {
      const abs = certificateTemplateAbsolutePath(template.image_path);
      if (abs) {
        try {
          drawFullPageImage(doc, abs, pageWidth, pageHeight);
        } catch (err) {
          // Missing/unsupported artwork still prints the text fields.
          console.error("[certificates] background embed failed:", err);
        }
      }
    }

    for (const field of template.fields) {
      const x = field.x * scaleX;
      const y = field.y * scaleY;
      if (isPictureValue(field.value)) {
        const boxW = (field.boxWidth ?? 140) * scaleX;
        const boxH = (field.boxHeight ?? 140) * scaleY;
        if (data.photo_path) {
          const abs = certificatePhotoAbsolutePath(data.photo_path);
          if (abs) {
            try {
              const photo = readFileSync(abs);
              if (isJpegBuffer(photo) || isPngBuffer(photo)) {
                // Embed original photo bytes; fit inside the box (no re-encode).
                doc.image(photo, x, y, {
                  fit: [boxW, boxH],
                  align: "center",
                  valign: "center",
                });
              }
            } catch {
              // skip missing photo
            }
          }
        }
        continue;
      }

      const text = fillCertificateText(field.value, data);
      if (!text.trim()) continue;
      // fontSize on the template is in canvas units; scale to PDF points for crisp vectors.
      doc.font(pdfFontName(field)).fontSize(field.fontSize * scaleY).fillColor(field.color);
      const textWidth = doc.widthOfString(text);
      let drawX = x;
      if (field.align === "center") drawX = x - textWidth / 2;
      if (field.align === "right") drawX = x - textWidth;
      doc.text(text, drawX, y, { lineBreak: false });
    }

    doc.end();
  });
}

export async function buildCertificatePdfBuffer(
  data: CertPdfData,
  template?: CertificateTemplateRecord | null,
): Promise<Buffer> {
  if (template && (template.image_path || template.fields.length > 0)) {
    return renderTemplatePdf(data, template);
  }
  return buildDefaultCertificatePdf(data);
}

function buildDefaultCertificatePdf(data: CertPdfData): Promise<Buffer> {
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
      .text("PETROCADEMIA", 60, 64, { align: "center", width: pageWidth - 120 });

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
