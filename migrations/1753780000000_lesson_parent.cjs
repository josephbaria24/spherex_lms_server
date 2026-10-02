/**
 * Nest a quiz lesson under a content lesson (one level).
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lessons
      ADD COLUMN IF NOT EXISTS parent_lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS lessons_parent_idx ON lessons (parent_lesson_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS lessons_parent_idx;
    ALTER TABLE lessons DROP COLUMN IF EXISTS parent_lesson_id;
  `);
};
