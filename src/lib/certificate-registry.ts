import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction } from "../config/db.js";
import {
  certificateTemplateIsReady,
  ensureCertificateTemplatesTable,
  loadCertificateTemplate,
} from "./certificate-template.js";

export type CertificateSource = "lms" | "legacy" | "ielts";

export type CertificateSerialSettings = {
  course_id: string;
  prefix: string;
  digits: number;
  next_number: number;
  updated_at: Date;
};

export type CertificateRegistryRow = {
  id: string;
  serial_number: string;
  course_title: string;
  learner_name: string;
  learner_email: string | null;
  issued_at: Date;
  source: CertificateSource;
  course_id: string | null;
  user_id: string | null;
  lms_certificate_id: string | null;
  legacy_course_id: string | null;
  legacy_user_id: string | null;
};

export async function ensureCertificateRegistryTables(): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS certificate_serial_settings (
       course_id    UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
       prefix       TEXT NOT NULL,
       digits       INTEGER NOT NULL DEFAULT 6 CHECK (digits BETWEEN 3 AND 12),
       next_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
       updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS certificate_registry (
       id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       serial_number       TEXT NOT NULL,
       course_title        TEXT NOT NULL,
       learner_name        TEXT NOT NULL,
       learner_email       TEXT,
       issued_at           TIMESTAMPTZ NOT NULL,
       source              TEXT NOT NULL CHECK (source IN ('lms', 'legacy', 'ielts')),
       course_id           UUID REFERENCES courses(id) ON DELETE SET NULL,
       user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
       lms_certificate_id  UUID REFERENCES certificates(id) ON DELETE SET NULL,
       legacy_course_id    TEXT,
       legacy_user_id      TEXT,
       created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS certificate_registry_serial_uidx
       ON certificate_registry (serial_number)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS certificate_registry_issued_idx
       ON certificate_registry (issued_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS certificate_registry_email_idx
       ON certificate_registry (lower(learner_email))`,
  );
}

export async function getSerialSettings(
  courseId: string,
): Promise<CertificateSerialSettings | null> {
  await ensureCertificateRegistryTables();
  const result = await query<CertificateSerialSettings>(
    `SELECT course_id, prefix, digits, next_number, updated_at
       FROM certificate_serial_settings WHERE course_id = $1`,
    [courseId],
  );
  return result.rows[0] ?? null;
}

export async function upsertSerialSettings(input: {
  course_id: string;
  prefix: string;
  digits: number;
  next_number: number;
}): Promise<CertificateSerialSettings> {
  await ensureCertificateRegistryTables();
  const prefix = input.prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!prefix) throw new Error("Serial code/prefix is required");
  const digits = Math.min(12, Math.max(3, Math.floor(input.digits)));
  const next = Math.max(1, Math.floor(input.next_number));
  const result = await query<CertificateSerialSettings>(
    `INSERT INTO certificate_serial_settings (course_id, prefix, digits, next_number, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (course_id) DO UPDATE SET
       prefix = EXCLUDED.prefix,
       digits = EXCLUDED.digits,
       next_number = EXCLUDED.next_number,
       updated_at = now()
     RETURNING course_id, prefix, digits, next_number, updated_at`,
    [input.course_id, prefix, digits, next],
  );
  return result.rows[0]!;
}

/** Known course title → serial acronym (legacy PSI-ELA style). */
const SERIAL_ACRONYM_ALIASES: Array<{ test: RegExp; code: string }> = [
  {
    test: /mandatory\s+eight[-\s]?hour\s+safety(\s+and\s+health)?(\s+training)?/i,
    code: "MEHSAHT",
  },
  { test: /\bmesh\b/i, code: "MEHSAHT" },
  { test: /lock\s*-?\s*out\s*tag\s*-?\s*out|\bloto\b/i, code: "LOTO" },
];

/** Build PSI-ELA-* serial prefix from a course title (e.g. MESH → PSI-ELA-MEHSAHT). */
export function suggestSerialPrefixFromTitle(title: string): string {
  for (const alias of SERIAL_ACRONYM_ALIASES) {
    if (alias.test.test(title)) return `PSI-ELA-${alias.code}`;
  }
  const tokens = title
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Eight-Hour → EH; include small words so “…Safety and Health…” → …SAH…
  let acronym = "";
  for (const token of tokens) {
    if (token.includes("-")) {
      acronym += token
        .split("-")
        .filter(Boolean)
        .map((p) => p[0]!)
        .join("");
    } else {
      acronym += token[0]!;
    }
  }
  return `PSI-ELA-${acronym.slice(0, 16) || "COURSE"}`;
}

/** Allocate next serial for a course using its settings, or PSI-ELA-{course acronym}. */
export async function allocateCourseSerial(courseId: string): Promise<string> {
  await ensureCertificateRegistryTables();
  return withTransaction(async (client) => {
    const settings = await client.query<CertificateSerialSettings>(
      `SELECT course_id, prefix, digits, next_number, updated_at
         FROM certificate_serial_settings
        WHERE course_id = $1
        FOR UPDATE`,
      [courseId],
    );
    const row = settings.rows[0];
    if (row) {
      const serial = `${row.prefix}-${String(row.next_number).padStart(row.digits, "0")}`;
      await client.query(
        `UPDATE certificate_serial_settings
            SET next_number = next_number + 1, updated_at = now()
          WHERE course_id = $1`,
        [courseId],
      );
      return serial;
    }

    const course = await client.query<{ title: string }>(
      `SELECT title FROM courses WHERE id = $1`,
      [courseId],
    );
    const prefixBase = suggestSerialPrefixFromTitle(course.rows[0]?.title ?? "Course");
    const prefix = `${prefixBase}-`;
    const digits = 6;
    const last = await client.query<{ serial_number: string }>(
      `SELECT serial_number FROM certificates
        WHERE serial_number LIKE $1
        ORDER BY serial_number DESC
        LIMIT 1`,
      [`${prefix}%`],
    );
    let seq = 1;
    const lastSerial = last.rows[0]?.serial_number;
    if (lastSerial) {
      const n = Number(lastSerial.slice(prefix.length));
      if (Number.isFinite(n)) seq = n + 1;
    }
    // Also respect legacy registry serials with the same prefix.
    const legacy = await client.query<{ serial_number: string }>(
      `SELECT serial_number FROM certificate_registry
        WHERE serial_number LIKE $1
        ORDER BY serial_number DESC
        LIMIT 1`,
      [`${prefix}%`],
    );
    const legacySerial = legacy.rows[0]?.serial_number;
    if (legacySerial) {
      const n = Number(legacySerial.slice(prefix.length));
      if (Number.isFinite(n) && n + 1 > seq) seq = n + 1;
    }
    return `${prefix}${String(seq).padStart(digits, "0")}`;
  });
}

export async function upsertRegistryEntry(input: {
  serial_number: string;
  course_title: string;
  learner_name: string;
  learner_email?: string | null;
  issued_at: Date | string;
  source: CertificateSource;
  course_id?: string | null;
  user_id?: string | null;
  lms_certificate_id?: string | null;
  legacy_course_id?: string | null;
  legacy_user_id?: string | null;
}): Promise<void> {
  await ensureCertificateRegistryTables();
  const issuedAt =
    input.issued_at instanceof Date ? input.issued_at : new Date(input.issued_at);
  await query(
    `INSERT INTO certificate_registry (
       serial_number, course_title, learner_name, learner_email, issued_at, source,
       course_id, user_id, lms_certificate_id, legacy_course_id, legacy_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (serial_number) DO UPDATE SET
       course_title = EXCLUDED.course_title,
       learner_name = EXCLUDED.learner_name,
       learner_email = COALESCE(EXCLUDED.learner_email, certificate_registry.learner_email),
       issued_at = EXCLUDED.issued_at,
       source = EXCLUDED.source,
       course_id = COALESCE(EXCLUDED.course_id, certificate_registry.course_id),
       user_id = COALESCE(EXCLUDED.user_id, certificate_registry.user_id),
       lms_certificate_id = COALESCE(EXCLUDED.lms_certificate_id, certificate_registry.lms_certificate_id),
       legacy_course_id = COALESCE(EXCLUDED.legacy_course_id, certificate_registry.legacy_course_id),
       legacy_user_id = COALESCE(EXCLUDED.legacy_user_id, certificate_registry.legacy_user_id)`,
    [
      input.serial_number.trim().toUpperCase(),
      input.course_title,
      input.learner_name,
      input.learner_email?.trim().toLowerCase() || null,
      issuedAt,
      input.source,
      input.course_id ?? null,
      input.user_id ?? null,
      input.lms_certificate_id ?? null,
      input.legacy_course_id ?? null,
      input.legacy_user_id ?? null,
    ],
  );
}

export async function syncLmsCertificatesIntoRegistry(): Promise<number> {
  await ensureCertificateRegistryTables();
  const result = await query(
    `INSERT INTO certificate_registry (
       serial_number, course_title, learner_name, learner_email, issued_at, source,
       course_id, user_id, lms_certificate_id
     )
     SELECT upper(cert.serial_number),
            COALESCE(c.title, 'Course'),
            COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Learner'),
            lower(u.email),
            cert.issued_at,
            'lms',
            cert.course_id,
            cert.user_id,
            cert.id
       FROM certificates cert
       JOIN users u ON u.id = cert.user_id
       LEFT JOIN courses c ON c.id = cert.course_id
      WHERE cert.serial_number IS NOT NULL
     ON CONFLICT (serial_number) DO UPDATE SET
       course_title = EXCLUDED.course_title,
       learner_name = EXCLUDED.learner_name,
       learner_email = EXCLUDED.learner_email,
       issued_at = EXCLUDED.issued_at,
       course_id = EXCLUDED.course_id,
       user_id = EXCLUDED.user_id,
       lms_certificate_id = EXCLUDED.lms_certificate_id`,
  );
  return result.rowCount ?? 0;
}

export async function syncIeltsCertificatesIntoRegistry(): Promise<number> {
  await ensureCertificateRegistryTables();
  try {
    const result = await query(
      `INSERT INTO certificate_registry (
         serial_number, course_title, learner_name, learner_email, issued_at, source, user_id
       )
       SELECT upper(c.serial_number),
              'IELTS Preparation',
              COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Learner'),
              lower(u.email),
              c.issued_at,
              'ielts',
              c.user_id
         FROM ielts_completion_certificates c
         JOIN users u ON u.id = c.user_id
       ON CONFLICT (serial_number) DO UPDATE SET
         learner_name = EXCLUDED.learner_name,
         learner_email = EXCLUDED.learner_email,
         issued_at = EXCLUDED.issued_at,
         user_id = EXCLUDED.user_id`,
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error("[certificate-registry] IELTS sync skipped:", err);
    return 0;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export async function importLegacyCertificateCsv(
  csvPath?: string,
): Promise<{ imported: number; skipped: number; path: string }> {
  await ensureCertificateRegistryTables();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resolved =
    csvPath ??
    path.resolve(here, "../db/psi-ela-certificate-registry.csv");
  if (!fs.existsSync(resolved)) {
    throw new Error(`CSV not found: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { imported: 0, skipped: 0, path: resolved };

  const courses = await query<{ id: string; title: string }>(
    `SELECT id, title FROM courses`,
  );
  const byTitle = new Map(
    courses.rows.map((c) => [c.title.trim().toLowerCase(), c.id] as const),
  );

  let imported = 0;
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (cols.length < 5) {
      skipped += 1;
      continue;
    }
    const [serial, courseTitle, learnerName, learnerEmail, dateIssued, legacyCourseId, legacyUserId] =
      cols;
    if (!serial || !courseTitle || !learnerName) {
      skipped += 1;
      continue;
    }
    const issuedAt = dateIssued ? new Date(dateIssued.replace(" ", "T")) : new Date();
    const courseId = byTitle.get(courseTitle.trim().toLowerCase()) ?? null;
    try {
      await upsertRegistryEntry({
        serial_number: serial,
        course_title: courseTitle,
        learner_name: learnerName,
        learner_email: learnerEmail || null,
        issued_at: Number.isNaN(issuedAt.getTime()) ? new Date() : issuedAt,
        source: "legacy",
        course_id: courseId,
        legacy_course_id: legacyCourseId || null,
        legacy_user_id: legacyUserId || null,
      });
      imported += 1;

      // Advance serial counter if this course has/can use this prefix pattern
      if (courseId) {
        const match = serial.trim().toUpperCase().match(/^(.*)-(\d+)$/);
        if (match) {
          const prefix = match[1]!;
          const num = Number(match[2]);
          const digits = match[2]!.length;
          if (Number.isFinite(num)) {
            const existing = await getSerialSettings(courseId);
            if (!existing) {
              await upsertSerialSettings({
                course_id: courseId,
                prefix,
                digits,
                next_number: num + 1,
              });
            } else if (existing.prefix === prefix && existing.next_number <= num) {
              await upsertSerialSettings({
                course_id: courseId,
                prefix: existing.prefix,
                digits: existing.digits,
                next_number: num + 1,
              });
            }
          }
        }
      }
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped, path: resolved };
}

export async function searchCertificateRegistry(input: {
  search?: string;
  source?: CertificateSource | "all";
  limit?: number;
}): Promise<CertificateRegistryRow[]> {
  await ensureCertificateRegistryTables();
  const values: unknown[] = [];
  const where: string[] = [];
  let i = 1;
  if (input.search?.trim()) {
    where.push(
      `(serial_number ILIKE $${i} OR course_title ILIKE $${i} OR learner_name ILIKE $${i} OR COALESCE(learner_email, '') ILIKE $${i})`,
    );
    values.push(`%${input.search.trim()}%`);
    i++;
  }
  if (input.source && input.source !== "all") {
    where.push(`source = $${i++}`);
    values.push(input.source);
  }
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  values.push(limit);
  const result = await query<CertificateRegistryRow>(
    `SELECT id, serial_number, course_title, learner_name, learner_email, issued_at, source,
            course_id, user_id, lms_certificate_id, legacy_course_id, legacy_user_id
       FROM certificate_registry
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY issued_at DESC
       LIMIT $${i}`,
    values,
  );
  return result.rows;
}

export async function getRegistryBySerial(
  serial: string,
): Promise<CertificateRegistryRow | null> {
  await ensureCertificateRegistryTables();
  const result = await query<CertificateRegistryRow>(
    `SELECT id, serial_number, course_title, learner_name, learner_email, issued_at, source,
            course_id, user_id, lms_certificate_id, legacy_course_id, legacy_user_id
       FROM certificate_registry
      WHERE upper(serial_number) = $1
      LIMIT 1`,
    [serial.trim().toUpperCase()],
  );
  return result.rows[0] ?? null;
}

export type AdminCertificateCourseRow = {
  course_id: string;
  course_title: string;
  template_ready: boolean;
  template_image: string | null;
  issued_count: number;
  serial_prefix: string | null;
  serial_digits: number | null;
  serial_next: number | null;
  sample_serial: string | null;
  default_serial_prefix: string;
};

export async function listAdminCertificateCourses(): Promise<{
  courses: AdminCertificateCourseRow[];
  totals: {
    courses: number;
    templates_ready: number;
    issued_lms: number;
    issued_legacy: number;
    issued_ielts: number;
    registry_total: number;
  };
}> {
  await ensureCertificateTemplatesTable();
  await ensureCertificateRegistryTables();
  await syncLmsCertificatesIntoRegistry().catch(() => 0);
  await syncIeltsCertificatesIntoRegistry().catch(() => 0);

  const courses = await query<{
    course_id: string;
    course_title: string;
    image_path: string | null;
    fields: unknown;
    serial_prefix: string | null;
    serial_digits: number | null;
    serial_next: number | null;
    issued_count: string;
  }>(
    `SELECT c.id AS course_id, c.title AS course_title,
            ct.image_path, ct.fields,
            ss.prefix AS serial_prefix, ss.digits AS serial_digits, ss.next_number AS serial_next,
            (
              SELECT COUNT(*)::text FROM certificates cert
               WHERE cert.course_id = c.id AND cert.serial_number IS NOT NULL
            ) AS issued_count
       FROM courses c
       LEFT JOIN certificate_templates ct ON ct.course_id = c.id
       LEFT JOIN certificate_serial_settings ss ON ss.course_id = c.id
      ORDER BY c.title`,
  );

  const rows: AdminCertificateCourseRow[] = courses.rows.map((row) => {
    const template = {
      image_path: row.image_path,
      fields: Array.isArray(row.fields) ? row.fields : [],
    };
    const ready = certificateTemplateIsReady(template as never);
    const digits = row.serial_digits ?? 6;
    const next = row.serial_next ?? 1;
    const inferredPrefix = suggestSerialPrefixFromTitle(row.course_title);
    const sample =
      row.serial_prefix != null
        ? `${row.serial_prefix}-${String(next).padStart(digits, "0")}`
        : `${inferredPrefix}-${String(1).padStart(digits, "0")}`;
    return {
      course_id: row.course_id,
      course_title: row.course_title,
      template_ready: ready,
      template_image: row.image_path,
      issued_count: Number(row.issued_count ?? 0),
      serial_prefix: row.serial_prefix,
      serial_digits: row.serial_digits,
      serial_next: row.serial_next,
      sample_serial: sample,
      default_serial_prefix: inferredPrefix,
    };
  });

  const counts = await query<{ source: string; n: string }>(
    `SELECT source, COUNT(*)::text AS n FROM certificate_registry GROUP BY source`,
  );
  const bySource = Object.fromEntries(counts.rows.map((r) => [r.source, Number(r.n)]));

  return {
    courses: rows,
    totals: {
      courses: rows.length,
      templates_ready: rows.filter((r) => r.template_ready).length,
      issued_lms: bySource.lms ?? 0,
      issued_legacy: bySource.legacy ?? 0,
      issued_ielts: bySource.ielts ?? 0,
      registry_total:
        (bySource.lms ?? 0) + (bySource.legacy ?? 0) + (bySource.ielts ?? 0),
    },
  };
}

export async function previewSerial(courseId: string): Promise<string | null> {
  const settings = await getSerialSettings(courseId);
  if (!settings) return null;
  return `${settings.prefix}-${String(settings.next_number).padStart(settings.digits, "0")}`;
}

/** Used by loadCertificateTemplate readiness checks elsewhere. */
export { loadCertificateTemplate };
