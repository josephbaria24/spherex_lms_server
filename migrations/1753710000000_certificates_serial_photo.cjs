/**
 * Adds certificate serial numbers and learner 2x2 photo for PDF certificates.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS serial_number TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS certificate_photo_path TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS certificates_serial_uidx
      ON certificates (serial_number)
      WHERE serial_number IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS certificates_user_course_uidx
      ON certificates (user_id, course_id)
      WHERE course_id IS NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS certificates_user_course_uidx;
    DROP INDEX IF EXISTS certificates_serial_uidx;
    ALTER TABLE certificates DROP COLUMN IF EXISTS serial_number;
    ALTER TABLE users DROP COLUMN IF EXISTS certificate_photo_path;
  `);
};
