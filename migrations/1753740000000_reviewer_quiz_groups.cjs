/**
 * Reviewer quiz groups (subject cards) with optional cover images.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS reviewer_quiz_groups (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title        TEXT NOT NULL,
      description  TEXT,
      exam_type    TEXT NOT NULL CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other')),
      subject      TEXT NOT NULL DEFAULT 'General',
      accent_color TEXT NOT NULL DEFAULT 'slate'
                   CHECK (accent_color IN (
                     'coral', 'indigo', 'amber', 'emerald', 'rose', 'sky', 'violet', 'slate'
                   )),
      cover_url    TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      is_published BOOLEAN NOT NULL DEFAULT true,
      created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE reviewer_quizzes
      ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES reviewer_quiz_groups(id) ON DELETE SET NULL;

    ALTER TABLE reviewer_quizzes
      ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS reviewer_quiz_groups_exam_type_idx ON reviewer_quiz_groups (exam_type);
    CREATE INDEX IF NOT EXISTS reviewer_quiz_groups_published_idx ON reviewer_quiz_groups (is_published)
      WHERE is_published = true;
    CREATE INDEX IF NOT EXISTS reviewer_quizzes_group_id_idx ON reviewer_quizzes (group_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS reviewer_quizzes_group_id_idx;
    DROP INDEX IF EXISTS reviewer_quiz_groups_published_idx;
    DROP INDEX IF EXISTS reviewer_quiz_groups_exam_type_idx;
    ALTER TABLE reviewer_quizzes DROP COLUMN IF EXISTS sort_order;
    ALTER TABLE reviewer_quizzes DROP COLUMN IF EXISTS group_id;
    DROP TABLE IF EXISTS reviewer_quiz_groups;
  `);
};
