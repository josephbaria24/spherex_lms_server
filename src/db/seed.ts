import { pool, query } from "../config/db.js";
import { hashPassword } from "../utils/password.js";

type SeedUser = {
  email: string;
  password: string;
  fullName: string;
  role: "admin" | "teacher" | "student" | "user";
};

async function ensureUser({ email, password, fullName, role }: SeedUser): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = lower($1)",
    [email],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed] user already exists: ${email}`);
    return existing.rows[0]!.id;
  }

  const password_hash = await hashPassword(password);
  const inserted = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, name, role, status)
     VALUES ($1, $2, $3, $3, $4, 'active')
     RETURNING id`,
    [email.toLowerCase(), password_hash, fullName, role],
  );
  // eslint-disable-next-line no-console
  console.log(`[seed] created ${role}: ${email} / ${password}`);
  return inserted.rows[0]!.id;
}

type SeedOrg = {
  name: string;
  slug: string;
  description: string;
  website?: string;
  industry: string;
  status: "pending" | "active" | "suspended";
  teacherJoinCode: string;
  studentJoinCode: string;
  logo?: string;
};

async function ensureOrganization(org: SeedOrg): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM organizations WHERE slug = $1",
    [org.slug],
  );
  if (existing.rows[0]) {
    await query(
      `UPDATE organizations
          SET teacher_join_code = $1,
              student_join_code = $2,
              status = $3
        WHERE slug = $4 AND (
          teacher_join_code IS DISTINCT FROM $1
          OR student_join_code IS DISTINCT FROM $2
          OR status IS DISTINCT FROM $3
        )`,
      [org.teacherJoinCode, org.studentJoinCode, org.status, org.slug],
    );
    // eslint-disable-next-line no-console
    console.log(
      `[seed] organization already exists: ${org.slug} (teacher: ${org.teacherJoinCode}, student: ${org.studentJoinCode})`,
    );
    return existing.rows[0].id;
  }

  const inserted = await query<{ id: string }>(
    `INSERT INTO organizations
       (name, slug, description, website, industry, status, teacher_join_code, student_join_code, logo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      org.name,
      org.slug,
      org.description,
      org.website ?? null,
      org.industry,
      org.status,
      org.teacherJoinCode,
      org.studentJoinCode,
      org.logo ?? null,
    ],
  );
  // eslint-disable-next-line no-console
  console.log(
    `[seed] created organization: ${org.name} (teacher: ${org.teacherJoinCode}, student: ${org.studentJoinCode})`,
  );
  return inserted.rows[0]!.id;
}

async function ensureOrgMember(
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "teacher" | "student",
): Promise<void> {
  await query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2
     )`,
    [organizationId, userId, role],
  );
}

async function main() {
  await ensureUser({
    email: "admin@spherex.local",
    password: "Admin123!",
    fullName: "SphereX Admin",
    role: "admin",
  });

  const orgAdminId = await ensureUser({
    email: "orgadmin@petrosphere.local",
    password: "OrgAdmin123!",
    fullName: "Petrosphere Org Admin",
    role: "teacher",
  });

  const teacherId = await ensureUser({
    email: "teacher@spherex.local",
    password: "Teacher123!",
    fullName: "Demo Teacher",
    role: "teacher",
  });

  const newTeacherId = await ensureUser({
    email: "newteacher@spherex.local",
    password: "Teacher123!",
    fullName: "New Teacher (no org)",
    role: "teacher",
  });

  const studentId = await ensureUser({
    email: "student@spherex.local",
    password: "Student123!",
    fullName: "Demo Student",
    role: "student",
  });

  const petrosphereId = await ensureOrganization({
    name: "Petrosphere Incorporated",
    slug: "petrosphere",
    description:
      "DOLE-recognized safety and compliance training for modern workplaces. Migrating from the Petrosphere eLearning Academy.",
    website: "https://elearning.petrosphere.com.ph/",
    industry: "HSE & Safety Training",
    status: "active",
    teacherJoinCode: "PETRO-DEMO",
    studentJoinCode: "PETRO-STUDENT",
    logo: "https://elearning.petrosphere.com.ph/wp-content/uploads/2020/10/ACLS-Course-1.png",
  });

  const tesdaId = await ensureOrganization({
    name: "TESDA",
    slug: "tesda",
    description:
      "Technical Skills Development Authority — national certification and skills programs on SphereX (coming soon).",
    industry: "Technical Education",
    status: "pending",
    teacherJoinCode: "TESDA-DEMO",
    studentJoinCode: "TESDA-STUDENT",
  });

  await ensureOrgMember(petrosphereId, orgAdminId, "owner");
  await ensureOrgMember(petrosphereId, teacherId, "teacher");
  await ensureOrgMember(petrosphereId, studentId, "student");
  await query("DELETE FROM organization_members WHERE user_id = $1", [newTeacherId]);
  await query(
    `UPDATE courses SET organization_id = $1 WHERE organization_id IS NULL`,
    [petrosphereId],
  );
  // eslint-disable-next-line no-console
  console.log("[seed] organization members for Petrosphere (newteacher@ has no org — use PETRO-DEMO to join)");

  const sampleCourses = [
    {
      title: "Workplace Safety Fundamentals",
      description: "Core safety practices for industrial environments.",
      category: "Safety",
      level: "beginner" as const,
      duration: "4 weeks",
    },
    {
      title: "Oil & Gas Operations 101",
      description: "Introduction to upstream and downstream operations.",
      category: "Oil & Gas",
      level: "intermediate" as const,
      duration: "6 weeks",
    },
    {
      title: "Leadership for Engineers",
      description: "Soft-skills training tailored for technical leads.",
      category: "Leadership",
      level: "advanced" as const,
      duration: "3 weeks",
    },
  ];

  const courseIds: string[] = [];
  for (const c of sampleCourses) {
    await query(
      `INSERT INTO courses (title, description, category, level, duration, organization_id)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title = $1)`,
      [c.title, c.description, c.category, c.level, c.duration, petrosphereId],
    );
    await query(
      `UPDATE courses SET organization_id = $2 WHERE title = $1 AND organization_id IS NULL`,
      [c.title, petrosphereId],
    );
    const row = await query<{ id: string }>("SELECT id FROM courses WHERE title = $1", [c.title]);
    if (row.rows[0]) courseIds.push(row.rows[0].id);
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] ensured ${sampleCourses.length} Petrosphere courses`);

  for (const courseId of courseIds.slice(0, 2)) {
    await query(
      `INSERT INTO course_instructors (course_id, teacher_id)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM course_instructors WHERE course_id = $1 AND teacher_id = $2
       )`,
      [courseId, teacherId],
    );
  }
  // eslint-disable-next-line no-console
  console.log("[seed] assigned teacher to courses");

  if (courseIds[0]) {
    const enrollment = await query<{ id: string }>(
      `INSERT INTO enrollments (user_id, course_id, progress_percent)
       SELECT $1, $2, 35
       WHERE NOT EXISTS (SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2)
       RETURNING id`,
      [studentId, courseIds[0]],
    );
    if (enrollment.rows[0]) {
      await query(
        `INSERT INTO evaluations (enrollment_id, teacher_id, status)
         SELECT $1, $2, 'pending'
         WHERE NOT EXISTS (
           SELECT 1 FROM evaluations WHERE enrollment_id = $1 AND teacher_id = $2
         )`,
        [enrollment.rows[0].id, teacherId],
      );
    }
    // eslint-disable-next-line no-console
    console.log("[seed] enrolled student + pending evaluation");
  }

  if (courseIds[0]) {
    const lessonDefs = [
      {
        title: "Introduction to Workplace Safety",
        sort: 1,
        status: "published",
        content_type: "text",
        content:
          "<h2>Welcome</h2><p>Workplace safety protects everyone. In this module you will learn core principles of hazard awareness and reporting.</p><ul><li>Know your rights</li><li>Report hazards promptly</li><li>Use PPE correctly</li></ul>",
      },
      {
        title: "Hazard Identification",
        sort: 2,
        status: "published",
        content_type: "video",
        video_url: "https://www.youtube.com/watch?v=5SiDkb8QoJc",
        description: "Watch this overview of common workplace hazards.",
      },
      {
        title: "Safety Knowledge Check",
        sort: 3,
        status: "published",
        content_type: "quiz",
      },
      {
        title: "Emergency Procedures",
        sort: 4,
        status: "draft",
        content_type: "articulate",
        articulate_url: "https://articulate-heroes-authoring.s3.amazonaws.com/uploads/rise/story.html",
      },
    ];

    for (const lesson of lessonDefs) {
      await query(
        `INSERT INTO lessons (course_id, title, description, content, content_type, video_url,
                              articulate_url, sort_order, status, created_by, duration_minutes)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 45
         WHERE NOT EXISTS (
           SELECT 1 FROM lessons WHERE course_id = $1 AND title = $2
         )`,
        [
          courseIds[0],
          lesson.title,
          (lesson as { description?: string }).description ?? null,
          (lesson as { content?: string }).content ?? null,
          lesson.content_type,
          (lesson as { video_url?: string }).video_url ?? null,
          (lesson as { articulate_url?: string }).articulate_url ?? null,
          lesson.sort,
          lesson.status,
          teacherId,
        ],
      );
      await query(
        `UPDATE lessons SET
           content_type = $3,
           content = COALESCE($4, content),
           video_url = COALESCE($5, video_url),
           articulate_url = COALESCE($6, articulate_url),
           description = COALESCE($7, description),
           status = $8
         WHERE course_id = $1 AND title = $2`,
        [
          courseIds[0],
          lesson.title,
          lesson.content_type,
          (lesson as { content?: string }).content ?? null,
          (lesson as { video_url?: string }).video_url ?? null,
          (lesson as { articulate_url?: string }).articulate_url ?? null,
          (lesson as { description?: string }).description ?? null,
          lesson.status,
        ],
      );
    }

    const quizLesson = await query<{ id: string }>(
      `SELECT id FROM lessons WHERE course_id = $1 AND title = 'Safety Knowledge Check'`,
      [courseIds[0]],
    );
    if (quizLesson.rows[0]) {
      const lessonId = quizLesson.rows[0].id;
      const existingQuiz = await query<{ id: string }>(
        "SELECT id FROM quizzes WHERE lesson_id = $1",
        [lessonId],
      );
      if (!existingQuiz.rows[0]) {
        const quizInsert = await query<{ id: string }>(
          `INSERT INTO quizzes (lesson_id, title, passing_score) VALUES ($1, $2, 70) RETURNING id`,
          [lessonId, "Workplace Safety Quiz"],
        );
        const quizId = quizInsert.rows[0]!.id;
        const questions = [
          {
            prompt: "Who is responsible for workplace safety?",
            options: [
              { id: "a", text: "Only managers" },
              { id: "b", text: "Everyone in the organization" },
              { id: "c", text: "Only safety officers" },
            ],
            correct: "b",
          },
          {
            prompt: "You should report hazards as soon as you notice them.",
            options: [
              { id: "true", text: "True" },
              { id: "false", text: "False" },
            ],
            correct: "true",
            type: "true_false",
          },
        ];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!;
          await query(
            `INSERT INTO quiz_questions (quiz_id, sort_order, prompt, question_type, options, correct_option_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              quizId,
              i,
              q.prompt,
              q.type ?? "multiple_choice",
              JSON.stringify(q.options),
              q.correct,
            ],
          );
        }
      }
    }

    await query(
      `UPDATE courses SET lessons = (SELECT COUNT(*)::int FROM lessons WHERE course_id = $1) WHERE id = $1`,
      [courseIds[0]],
    );
    // eslint-disable-next-line no-console
    console.log("[seed] ensured sample lessons with text, video, quiz, and articulate content");
  }

  const newStudentId = await ensureUser({
    email: "newstudent@spherex.local",
    password: "Student123!",
    fullName: "New Student (no org)",
    role: "student",
  });
  await query("DELETE FROM organization_members WHERE user_id = $1", [newStudentId]);

  void tesdaId;
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
