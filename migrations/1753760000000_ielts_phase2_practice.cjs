/**
 * IELTS Phase 2: passage, audio, timer, fill_blank / multi_select, band score on attempts.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE reviewer_quizzes
      ADD COLUMN IF NOT EXISTS passage_html TEXT,
      ADD COLUMN IF NOT EXISTS audio_url TEXT,
      ADD COLUMN IF NOT EXISTS time_limit_seconds INTEGER
        CHECK (time_limit_seconds IS NULL OR time_limit_seconds > 0);

    ALTER TABLE reviewer_quiz_questions
      DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
    ALTER TABLE reviewer_quiz_questions
      ADD CONSTRAINT reviewer_quiz_questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'true_false', 'fill_blank', 'multi_select'));

    ALTER TABLE reviewer_quiz_attempts
      ADD COLUMN IF NOT EXISTS band_score NUMERIC(3,1)
        CHECK (band_score IS NULL OR (band_score >= 0 AND band_score <= 9));
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE reviewer_quiz_attempts DROP COLUMN IF EXISTS band_score;

    ALTER TABLE reviewer_quiz_questions
      DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
    ALTER TABLE reviewer_quiz_questions
      ADD CONSTRAINT reviewer_quiz_questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'true_false'));

    ALTER TABLE reviewer_quizzes
      DROP COLUMN IF EXISTS time_limit_seconds,
      DROP COLUMN IF EXISTS audio_url,
      DROP COLUMN IF EXISTS passage_html;
  `);
};
