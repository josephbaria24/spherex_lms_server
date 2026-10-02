/**
 * Public CSE/NLE practice quizzes for the Reviewers landing page.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS reviewer_quizzes (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      material_id    UUID REFERENCES reviewer_materials(id) ON DELETE SET NULL,
      title          TEXT NOT NULL,
      description    TEXT,
      exam_type      TEXT NOT NULL CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other')),
      category       TEXT,
      passing_score  INTEGER NOT NULL DEFAULT 70 CHECK (passing_score BETWEEN 0 AND 100),
      is_published   BOOLEAN NOT NULL DEFAULT true,
      created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reviewer_quiz_questions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      quiz_id           UUID NOT NULL REFERENCES reviewer_quizzes(id) ON DELETE CASCADE,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      prompt            TEXT NOT NULL,
      question_type     TEXT NOT NULL DEFAULT 'multiple_choice'
                        CHECK (question_type IN ('multiple_choice', 'true_false')),
      options           JSONB NOT NULL DEFAULT '[]',
      correct_option_id TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reviewer_quiz_attempts (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      quiz_id    UUID NOT NULL REFERENCES reviewer_quizzes(id) ON DELETE CASCADE,
      user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      passed     BOOLEAN NOT NULL,
      answers    JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS reviewer_quizzes_exam_type_idx ON reviewer_quizzes (exam_type);
    CREATE INDEX IF NOT EXISTS reviewer_quizzes_published_idx ON reviewer_quizzes (is_published)
      WHERE is_published = true;
    CREATE INDEX IF NOT EXISTS reviewer_quiz_questions_quiz_idx
      ON reviewer_quiz_questions (quiz_id, sort_order);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS reviewer_quiz_questions_quiz_idx;
    DROP INDEX IF EXISTS reviewer_quizzes_published_idx;
    DROP INDEX IF EXISTS reviewer_quizzes_exam_type_idx;
    DROP TABLE IF EXISTS reviewer_quiz_attempts;
    DROP TABLE IF EXISTS reviewer_quiz_questions;
    DROP TABLE IF EXISTS reviewer_quizzes;
  `);
};
