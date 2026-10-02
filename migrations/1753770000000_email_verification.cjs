/**
 * Email verification codes for new self-serve signups.
 * Existing users stay verified (column default true).
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS email_verification_codes_user_idx
      ON email_verification_codes (user_id);
    CREATE INDEX IF NOT EXISTS email_verification_codes_hash_idx
      ON email_verification_codes (code_hash);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS email_verification_codes_hash_idx;
    DROP INDEX IF EXISTS email_verification_codes_user_idx;
    DROP TABLE IF EXISTS email_verification_codes;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
  `);
};
