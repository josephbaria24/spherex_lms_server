/**
 * Public exam review materials (CSE, NLE, etc.) managed by admins for the landing page.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS reviewer_materials (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title        TEXT NOT NULL,
      description  TEXT,
      exam_type    TEXT NOT NULL CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other')),
      category     TEXT,
      tags         TEXT[] NOT NULL DEFAULT '{}',
      file_url     TEXT NOT NULL DEFAULT '',
      external_url TEXT,
      is_published BOOLEAN NOT NULL DEFAULT true,
      uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS reviewer_materials_updated_at_idx ON reviewer_materials (updated_at DESC);
    CREATE INDEX IF NOT EXISTS reviewer_materials_exam_type_idx ON reviewer_materials (exam_type);
    CREATE INDEX IF NOT EXISTS reviewer_materials_published_idx ON reviewer_materials (is_published)
      WHERE is_published = true;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS reviewer_materials_published_idx;
    DROP INDEX IF EXISTS reviewer_materials_exam_type_idx;
    DROP INDEX IF EXISTS reviewer_materials_updated_at_idx;
    DROP TABLE IF EXISTS reviewer_materials;
  `);
};
