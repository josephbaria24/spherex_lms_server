-- SphereX LMS PostgreSQL schema
-- Idempotent: safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users
-- Merges the old Supabase auth.users (id, email, password) with the public
-- users profile table the client used (full_name, name, role, status).
-- Email is stored lower-cased; uniqueness is enforced case-insensitively.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'teacher', 'student', 'user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  level          TEXT CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  duration       TEXT,
  enrolled_count INTEGER NOT NULL DEFAULT 0,
  lessons        INTEGER NOT NULL DEFAULT 0,
  thumbnail      TEXT,
  image          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courses_created_at_idx ON courses (created_at DESC);
CREATE INDEX IF NOT EXISTS courses_category_idx  ON courses (category);
CREATE INDEX IF NOT EXISTS courses_level_idx     ON courses (level);

-- ---------------------------------------------------------------------------
-- enrollments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS enrollments_user_idx   ON enrollments (user_id);
CREATE INDEX IF NOT EXISTS enrollments_course_idx ON enrollments (course_id);

-- ---------------------------------------------------------------------------
-- materials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS materials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL CHECK (type IN ('IELTS', 'TOEFL', 'Technical', 'Soft Skills', 'Other')),
  category    TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  file_url    TEXT NOT NULL DEFAULT '',
  uploaded_by UUID REFERENCES users(id)   ON DELETE SET NULL,
  course_id   UUID REFERENCES courses(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS materials_updated_at_idx ON materials (updated_at DESC);
CREATE INDEX IF NOT EXISTS materials_type_idx       ON materials (type);

-- ---------------------------------------------------------------------------
-- certificates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id       UUID REFERENCES courses(id) ON DELETE SET NULL,
  certificate_url TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS certificates_user_idx ON certificates (user_id);

-- ---------------------------------------------------------------------------
-- training_sessions  (referenced by /training UI; previously mock-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  course_id        UUID REFERENCES courses(id) ON DELETE SET NULL,
  scheduled_date   TIMESTAMPTZ NOT NULL,
  duration         INTEGER NOT NULL DEFAULT 60,
  instructor       TEXT,
  status           TEXT NOT NULL DEFAULT 'upcoming'
                   CHECK (status IN ('upcoming', 'ongoing', 'completed', 'cancelled')),
  participants     INTEGER NOT NULL DEFAULT 0,
  max_participants INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_sessions_scheduled_idx
  ON training_sessions (scheduled_date DESC);

-- ---------------------------------------------------------------------------
-- course_instructors  (teacher ↔ course assignment)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_instructors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS course_instructors_teacher_idx ON course_instructors (teacher_id);
CREATE INDEX IF NOT EXISTS course_instructors_course_idx ON course_instructors (course_id);

-- ---------------------------------------------------------------------------
-- lessons  (course content units)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  content          TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published')),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lessons_course_idx ON lessons (course_id, sort_order);

-- Lesson content types: text, video, articulate (Storyline/Rise), quiz
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_content_type_check;
ALTER TABLE lessons
  ADD CONSTRAINT lessons_content_type_check
  CHECK (content_type IN ('text', 'video', 'articulate', 'quiz'));
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS articulate_url TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS articulate_launch_mode TEXT NOT NULL DEFAULT 'story';
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_articulate_launch_mode_check;
ALTER TABLE lessons
  ADD CONSTRAINT lessons_articulate_launch_mode_check
  CHECK (articulate_launch_mode IN ('story', 'scorm'));

-- ---------------------------------------------------------------------------
-- quizzes  (1:1 with quiz-type lessons)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quizzes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id      UUID NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  passing_score  INTEGER NOT NULL DEFAULT 70 CHECK (passing_score BETWEEN 0 AND 100),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id           UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  prompt            TEXT NOT NULL,
  question_type     TEXT NOT NULL DEFAULT 'multiple_choice'
                    CHECK (question_type IN ('multiple_choice', 'true_false')),
  options           JSONB NOT NULL DEFAULT '[]',
  correct_option_id TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quiz_questions_quiz_idx ON quiz_questions (quiz_id, sort_order);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id    UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed     BOOLEAN NOT NULL,
  answers    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quiz_attempts_user_idx ON quiz_attempts (user_id, quiz_id);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id    UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed    BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS lesson_progress_user_course_idx ON lesson_progress (user_id, course_id);

-- ---------------------------------------------------------------------------
-- scorm_data  (SCORM 1.2 CMI persistence per learner + lesson)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scorm_data (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id      UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id      UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  cmi            JSONB NOT NULL DEFAULT '{}',
  lesson_status  TEXT NOT NULL DEFAULT 'not attempted',
  score_raw      TEXT,
  lesson_location TEXT,
  suspend_data   TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS scorm_data_course_idx ON scorm_data (course_id, user_id);

-- ---------------------------------------------------------------------------
-- evaluations  (teacher grades / feedback on enrollments)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evaluations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  teacher_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score         INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  feedback      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'graded', 'returned')),
  evaluated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS evaluations_teacher_idx ON evaluations (teacher_id, status);
CREATE INDEX IF NOT EXISTS evaluations_enrollment_idx ON evaluations (enrollment_id);

-- ---------------------------------------------------------------------------
-- organizations  (tenant / partner orgs on SphereX)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  description       TEXT,
  logo              TEXT,
  website           TEXT,
  industry          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'suspended')),
  teacher_join_code TEXT NOT NULL,
  student_join_code TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (slug),
  UNIQUE (teacher_join_code)
);

CREATE INDEX IF NOT EXISTS organizations_status_idx ON organizations (status);
CREATE INDEX IF NOT EXISTS organizations_slug_idx ON organizations (slug);

-- Org setup: member limits & branding (Phase 5)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS max_members INTEGER CHECK (max_members IS NULL OR max_members > 0);
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_primary TEXT;
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_accent TEXT;

-- Logo display tuning (padding/position in OrgLogo)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_padding INTEGER NOT NULL DEFAULT 0
    CHECK (logo_padding >= 0 AND logo_padding <= 24);
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_position_x INTEGER NOT NULL DEFAULT 50
    CHECK (logo_position_x >= 0 AND logo_position_x <= 100);
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_position_y INTEGER NOT NULL DEFAULT 50
    CHECK (logo_position_y >= 0 AND logo_position_y <= 100);

-- Phase 6: student join codes (separate from teacher codes)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS student_join_code TEXT;

UPDATE organizations
   SET student_join_code = upper(substr(slug, 1, 6)) || '-STU-' || upper(substr(md5(id::text), 1, 4))
 WHERE student_join_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_student_join_code_uidx
  ON organizations (student_join_code)
  WHERE student_join_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- organization_members  (org-scoped roles; platform role stays on users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL
                  CHECK (role IN ('owner', 'admin', 'teacher', 'student')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members (user_id);
CREATE INDEX IF NOT EXISTS organization_members_org_role_idx
  ON organization_members (organization_id, role);

-- Tenant scope for courses (nullable until backfilled / Phase 4 enforcement)
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS courses_organization_idx ON courses (organization_id);

-- When true, learners must complete each lesson in order before opening the next.
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS require_sequential_lessons BOOLEAN NOT NULL DEFAULT false;

-- Decorative card theme (soft color palette) for course list cards
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS card_theme TEXT NOT NULL DEFAULT 'sage';

ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_card_theme_check;

UPDATE courses
SET card_theme = CASE card_theme
  WHEN 'cubes-emerald' THEN 'sage'
  WHEN 'cubes-sky' THEN 'sky'
  WHEN 'cubes-violet' THEN 'lilac'
  WHEN 'cubes-amber' THEN 'sunflower'
  WHEN 'cubes-rose' THEN 'coral'
  WHEN 'cubes-slate' THEN 'sage'
  ELSE card_theme
END
WHERE card_theme LIKE 'cubes-%';

ALTER TABLE courses ALTER COLUMN card_theme SET DEFAULT 'sage';

ALTER TABLE courses
  ADD CONSTRAINT courses_card_theme_check CHECK (card_theme IN (
    'coral', 'sunflower', 'sage', 'mint', 'sky', 'lilac'
  ));

-- Course catalog: optional price and admin-generated enrollment code
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS enroll_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS courses_enroll_code_uidx
  ON courses (upper(enroll_code))
  WHERE enroll_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','courses','enrollments','materials','training_sessions','lessons','evaluations','organizations','quizzes']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END$$;

-- Extend roles on existing databases (idempotent)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'teacher', 'student', 'user'));

-- User profile & notification preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_training BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_course_updates BOOLEAN NOT NULL DEFAULT false;
