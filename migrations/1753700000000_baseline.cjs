/**
 * Baseline: current schema is applied via `npm run db:schema` (schema.sql).
 * Future schema changes should be added as new files in this folder and run with
 * `npm run db:migrate:up`.
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql("SELECT 1");
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = () => {
  // no-op baseline
};
