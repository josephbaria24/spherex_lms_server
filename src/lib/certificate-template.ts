import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { query } from "../config/db.js";
import { getUploadsRoot } from "./org-uploads.js";

export const CERTIFICATE_PAGE_SIZES = [
  "a4-landscape",
  "a4-portrait",
  "letter-landscape",
  "letter-portrait",
] as const;

export type CertificatePageSize = (typeof CERTIFICATE_PAGE_SIZES)[number];

export const certificateFieldSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  value: z.string().max(500),
  x: z.number().finite(),
  y: z.number().finite(),
  fontSize: z.number().min(6).max(200),
  boxWidth: z.number().min(8).max(2000).optional(),
  boxHeight: z.number().min(8).max(2000).optional(),
  fontWeight: z.enum(["normal", "bold"]),
  fontStyle: z.enum(["normal", "italic"]),
  fontFamily: z.enum(["Helvetica", "Times"]),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  align: z.enum(["left", "center", "right"]),
});

export type CertificateField = z.infer<typeof certificateFieldSchema>;

export const saveCertificateTemplateSchema = z.object({
  fields: z.array(certificateFieldSchema).max(40),
  page_size: z.enum(CERTIFICATE_PAGE_SIZES).default("a4-landscape"),
  canvas_width: z.number().int().min(100).max(8000),
  canvas_height: z.number().int().min(100).max(8000),
});

export type CertificateTemplateRecord = {
  id: string;
  course_id: string;
  image_path: string | null;
  fields: CertificateField[];
  page_size: CertificatePageSize;
  canvas_width: number;
  canvas_height: number;
};

const TEMPLATE_SEGMENT = "certificate-templates";

export function certificateTemplateDir(courseId: string): string {
  return path.join(getUploadsRoot(), TEMPLATE_SEGMENT, courseId);
}

export function certificateTemplatePublicPath(courseId: string, filename: string): string {
  return `/uploads/${TEMPLATE_SEGMENT}/${courseId}/${filename}`;
}

export function certificateTemplateAbsolutePath(publicPath: string): string | null {
  const marker = `/${TEMPLATE_SEGMENT}/`;
  const idx = publicPath.indexOf(marker);
  if (idx < 0) return null;
  const rest = publicPath.slice(idx + marker.length);
  const [courseId, filename] = rest.split("/");
  if (!courseId || !filename || filename.includes("..") || courseId.includes("..")) return null;
  return path.join(getUploadsRoot(), TEMPLATE_SEGMENT, courseId, filename);
}

export function clearCertificateTemplateImages(courseId: string): void {
  const dir = certificateTemplateDir(courseId);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("background.")) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

function asFields(value: unknown): CertificateField[] {
  const parsed = z.array(certificateFieldSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function asPageSize(value: string): CertificatePageSize {
  return (CERTIFICATE_PAGE_SIZES as readonly string[]).includes(value)
    ? (value as CertificatePageSize)
    : "a4-landscape";
}

export async function loadCertificateTemplate(
  courseId: string,
): Promise<CertificateTemplateRecord | null> {
  const result = await query<{
    id: string;
    course_id: string;
    image_path: string | null;
    fields: unknown;
    page_size: string;
    canvas_width: number;
    canvas_height: number;
  }>(
    `SELECT id, course_id, image_path, fields, page_size, canvas_width, canvas_height
       FROM certificate_templates
      WHERE course_id = $1`,
    [courseId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    course_id: row.course_id,
    image_path: row.image_path,
    fields: asFields(row.fields),
    page_size: asPageSize(row.page_size),
    canvas_width: row.canvas_width,
    canvas_height: row.canvas_height,
  };
}

export async function saveCertificateTemplate(
  courseId: string,
  input: z.infer<typeof saveCertificateTemplateSchema>,
): Promise<CertificateTemplateRecord> {
  const result = await query<{
    id: string;
    course_id: string;
    image_path: string | null;
    fields: unknown;
    page_size: string;
    canvas_width: number;
    canvas_height: number;
  }>(
    `INSERT INTO certificate_templates (course_id, fields, page_size, canvas_width, canvas_height)
     VALUES ($1, $2::jsonb, $3, $4, $5)
     ON CONFLICT (course_id) DO UPDATE SET
       fields = EXCLUDED.fields,
       page_size = EXCLUDED.page_size,
       canvas_width = EXCLUDED.canvas_width,
       canvas_height = EXCLUDED.canvas_height
     RETURNING id, course_id, image_path, fields, page_size, canvas_width, canvas_height`,
    [
      courseId,
      JSON.stringify(input.fields),
      input.page_size,
      input.canvas_width,
      input.canvas_height,
    ],
  );
  const row = result.rows[0]!;
  return {
    id: row.id,
    course_id: row.course_id,
    image_path: row.image_path,
    fields: asFields(row.fields),
    page_size: asPageSize(row.page_size),
    canvas_width: row.canvas_width,
    canvas_height: row.canvas_height,
  };
}

export async function setCertificateTemplateImage(
  courseId: string,
  imagePath: string,
): Promise<void> {
  await query(
    `INSERT INTO certificate_templates (course_id, image_path)
     VALUES ($1, $2)
     ON CONFLICT (course_id) DO UPDATE SET image_path = EXCLUDED.image_path`,
    [courseId, imagePath],
  );
}
