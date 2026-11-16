/**
 * Rewrite SPX-CERT LMS serials for the MESH AHT course to PSI-ELA-MEHSAHT-######
 * and seed certificate_serial_settings so future issues continue that series.
 *
 * Usage (on VPS from lms-server): node -r dotenv/config scripts/fix-mesh-serial.mjs
 */
import "dotenv/config";
import pg from "pg";

const MESH_COURSE_ID = "cbc26472-d7d7-48bf-88b4-1b60b631d4d0";
const PREFIX = "PSI-ELA-MEHSAHT";
const DIGITS = 6;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

try {
  await c.query("BEGIN");

  const course = await c.query(`SELECT id, title FROM courses WHERE id = $1`, [MESH_COURSE_ID]);
  console.log("course", course.rows[0] ?? null);

  const spx = await c.query(
    `SELECT id, serial_number, user_id, course_id
       FROM certificates
      WHERE course_id = $1
         OR (
           serial_number ILIKE 'SPX-CERT%'
           AND id IN (
             SELECT lms_certificate_id FROM certificate_registry
              WHERE course_id = $1 OR course_title ILIKE '%eight-hour safety%'
           )
         )
      ORDER BY issued_at ASC`,
    [MESH_COURSE_ID],
  );
  console.log("mesh certs", spx.rows);

  const existing = await c.query(
    `SELECT serial_number FROM certificate_registry
      WHERE serial_number LIKE $1
      ORDER BY serial_number DESC
      LIMIT 1`,
    [`${PREFIX}-%`],
  );
  let next = 1;
  const last = existing.rows[0]?.serial_number;
  if (last) {
    const n = Number(String(last).slice(PREFIX.length + 1));
    if (Number.isFinite(n)) next = n + 1;
  }

  for (const row of spx.rows) {
    if (!String(row.serial_number).toUpperCase().startsWith("SPX-CERT")) continue;
    const newSerial = `${PREFIX}-${String(next).padStart(DIGITS, "0")}`;
    console.log(`rewrite ${row.serial_number} -> ${newSerial} (cert ${row.id})`);

    await c.query(`UPDATE certificates SET serial_number = $1 WHERE id = $2`, [
      newSerial,
      row.id,
    ]);

    const reg = await c.query(
      `UPDATE certificate_registry
          SET serial_number = $1,
              course_id = COALESCE(course_id, $2),
              lms_certificate_id = COALESCE(lms_certificate_id, $3)
        WHERE lms_certificate_id = $3
           OR upper(serial_number) = upper($4)
       RETURNING id, serial_number`,
      [newSerial, MESH_COURSE_ID, row.id, row.serial_number],
    );
    if (reg.rowCount === 0) {
      await c.query(
        `INSERT INTO certificate_registry (
           serial_number, course_title, learner_name, learner_email, issued_at, source,
           course_id, user_id, lms_certificate_id
         )
         SELECT $1,
                COALESCE(co.title, 'MESH AHT'),
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.name, ''), u.email, 'Learner'),
                lower(u.email),
                cert.issued_at,
                'lms',
                cert.course_id,
                cert.user_id,
                cert.id
           FROM certificates cert
           JOIN users u ON u.id = cert.user_id
           LEFT JOIN courses co ON co.id = cert.course_id
          WHERE cert.id = $2
         ON CONFLICT (serial_number) DO UPDATE SET
           lms_certificate_id = EXCLUDED.lms_certificate_id,
           course_id = EXCLUDED.course_id`,
        [newSerial, row.id],
      );
    }
    next += 1;
  }

  await c.query(
    `INSERT INTO certificate_serial_settings (course_id, prefix, digits, next_number, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (course_id) DO UPDATE SET
       prefix = EXCLUDED.prefix,
       digits = EXCLUDED.digits,
       next_number = GREATEST(certificate_serial_settings.next_number, EXCLUDED.next_number),
       updated_at = now()`,
    [MESH_COURSE_ID, PREFIX, DIGITS, next],
  );

  await c.query("COMMIT");

  const check = await c.query(
    `SELECT serial_number, course_title, lms_certificate_id, source
       FROM certificate_registry
      WHERE serial_number LIKE $1 OR course_id = $2
      ORDER BY issued_at DESC
      LIMIT 10`,
    [`${PREFIX}-%`, MESH_COURSE_ID],
  );
  const settings = await c.query(
    `SELECT * FROM certificate_serial_settings WHERE course_id = $1`,
    [MESH_COURSE_ID],
  );
  console.log("registry after", check.rows);
  console.log("settings after", settings.rows);
  console.log("ok");
} catch (err) {
  await c.query("ROLLBACK");
  console.error(err);
  process.exitCode = 1;
} finally {
  await c.end();
}
