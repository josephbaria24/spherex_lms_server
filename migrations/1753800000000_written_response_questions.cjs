/**
 * Written responses for IELTS Writing and Speaking practice.
 * correct_option_id stores the minimum word count.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE reviewer_quiz_questions
      DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
    ALTER TABLE reviewer_quiz_questions
      ADD CONSTRAINT reviewer_quiz_questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'true_false', 'fill_blank', 'multi_select', 'written_response'));
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM reviewer_quiz_questions WHERE question_type = 'written_response';
    ALTER TABLE reviewer_quiz_questions
      DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
    ALTER TABLE reviewer_quiz_questions
      ADD CONSTRAINT reviewer_quiz_questions_question_type_check
      CHECK (question_type IN ('multiple_choice', 'true_false', 'fill_blank', 'multi_select'));
  `);
};
