/** @type {import("node-pg-migrate").MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    "certificate_serial_settings",
    {
      course_id: {
        type: "uuid",
        primaryKey: true,
        references: "courses",
        onDelete: "CASCADE",
      },
      prefix: { type: "text", notNull: true },
      digits: { type: "integer", notNull: true, default: 6 },
      next_number: { type: "integer", notNull: true, default: 1 },
      updated_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("now()"),
      },
    },
    { ifNotExists: true },
  );

  pgm.createTable(
    "certificate_registry",
    {
      id: {
        type: "uuid",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()"),
      },
      serial_number: { type: "text", notNull: true },
      course_title: { type: "text", notNull: true },
      learner_name: { type: "text", notNull: true },
      learner_email: { type: "text" },
      issued_at: { type: "timestamptz", notNull: true },
      source: { type: "text", notNull: true },
      course_id: {
        type: "uuid",
        references: "courses",
        onDelete: "SET NULL",
      },
      user_id: {
        type: "uuid",
        references: "users",
        onDelete: "SET NULL",
      },
      lms_certificate_id: {
        type: "uuid",
        references: "certificates",
        onDelete: "SET NULL",
      },
      legacy_course_id: { type: "text" },
      legacy_user_id: { type: "text" },
      created_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("now()"),
      },
    },
    { ifNotExists: true },
  );

  pgm.addConstraint("certificate_registry", "certificate_registry_source_check", {
    check: "source IN ('lms', 'legacy', 'ielts')",
  });

  pgm.createIndex("certificate_registry", "serial_number", {
    name: "certificate_registry_serial_uidx",
    unique: true,
    ifNotExists: true,
  });
  pgm.createIndex("certificate_registry", "issued_at", {
    name: "certificate_registry_issued_idx",
    ifNotExists: true,
  });
  pgm.createIndex("certificate_registry", "learner_email", {
    name: "certificate_registry_email_idx",
    ifNotExists: true,
  });
};

/** @type {import("node-pg-migrate").MigrationBuilder} */
exports.down = (pgm) => {
  pgm.dropTable("certificate_registry", { ifExists: true, cascade: true });
  pgm.dropTable("certificate_serial_settings", { ifExists: true, cascade: true });
};
