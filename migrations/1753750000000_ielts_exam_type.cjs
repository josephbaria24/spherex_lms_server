/**
 * Add IELTS to reviewer exam_type checks (materials, groups, quizzes).
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE reviewer_materials
      DROP CONSTRAINT IF EXISTS reviewer_materials_exam_type_check;
    ALTER TABLE reviewer_materials
      ADD CONSTRAINT reviewer_materials_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'IELTS', 'Other'));

    ALTER TABLE reviewer_quiz_groups
      DROP CONSTRAINT IF EXISTS reviewer_quiz_groups_exam_type_check;
    ALTER TABLE reviewer_quiz_groups
      ADD CONSTRAINT reviewer_quiz_groups_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'IELTS', 'Other'));

    ALTER TABLE reviewer_quizzes
      DROP CONSTRAINT IF EXISTS reviewer_quizzes_exam_type_check;
    ALTER TABLE reviewer_quizzes
      ADD CONSTRAINT reviewer_quizzes_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'IELTS', 'Other'));
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM reviewer_quiz_attempts
      WHERE quiz_id IN (SELECT id FROM reviewer_quizzes WHERE exam_type = 'IELTS');
    DELETE FROM reviewer_quiz_questions
      WHERE quiz_id IN (SELECT id FROM reviewer_quizzes WHERE exam_type = 'IELTS');
    DELETE FROM reviewer_quizzes WHERE exam_type = 'IELTS';
    DELETE FROM reviewer_quiz_groups WHERE exam_type = 'IELTS';
    DELETE FROM reviewer_materials WHERE exam_type = 'IELTS';

    ALTER TABLE reviewer_materials
      DROP CONSTRAINT IF EXISTS reviewer_materials_exam_type_check;
    ALTER TABLE reviewer_materials
      ADD CONSTRAINT reviewer_materials_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other'));

    ALTER TABLE reviewer_quiz_groups
      DROP CONSTRAINT IF EXISTS reviewer_quiz_groups_exam_type_check;
    ALTER TABLE reviewer_quiz_groups
      ADD CONSTRAINT reviewer_quiz_groups_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other'));

    ALTER TABLE reviewer_quizzes
      DROP CONSTRAINT IF EXISTS reviewer_quizzes_exam_type_check;
    ALTER TABLE reviewer_quizzes
      ADD CONSTRAINT reviewer_quizzes_exam_type_check
      CHECK (exam_type IN ('CSE', 'NLE', 'LET', 'Other'));
  `);
};
