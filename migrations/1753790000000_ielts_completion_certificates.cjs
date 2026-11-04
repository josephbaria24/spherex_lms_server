/**
 * Certificate of completion for PetroCademia IELTS preparation (not an official IELTS result).
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ielts_completion_certificates (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      serial_number TEXT NOT NULL,
      results       JSONB NOT NULL DEFAULT '[]',
      issued_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ielts_completion_certificates_user_uidx
      ON ielts_completion_certificates (user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ielts_completion_certificates_serial_uidx
      ON ielts_completion_certificates (serial_number);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS ielts_completion_certificates;
  `);
};
