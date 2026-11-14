#!/bin/bash
set -euo pipefail

cp /tmp/ielts-certificate.ts /opt/spherex/lms-server/src/lib/ielts-certificate.ts
cp /tmp/user-progress.ts /opt/spherex/lms-server/src/lib/user-progress.ts
cp /tmp/httpError.ts /opt/spherex/lms-server/src/utils/httpError.ts
cp /tmp/ielts-certificate.routes.ts /opt/spherex/lms-server/src/modules/reviewers/ielts-certificate.routes.ts
cp /tmp/reviewer-quizzes.routes.ts /opt/spherex/lms-server/src/modules/reviewers/reviewer-quizzes.routes.ts
cp /tmp/user-activity-sheet.tsx /opt/spherex/lms-client/components/admin/users/user-activity-sheet.tsx
cp /tmp/page.tsx /opt/spherex/lms-client/app/admin/ielts/page.tsx
cp /tmp/1753790000000_ielts_completion_certificates.cjs /opt/spherex/lms-server/migrations/ || true
cp /tmp/1753800000000_written_response_questions.cjs /opt/spherex/lms-server/migrations/ || true
cp /tmp/1753810000000_audio_response_questions.cjs /opt/spherex/lms-server/migrations/ || true

cd /opt/spherex/lms-server
DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
echo "db=$DB_NAME"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS ielts_completion_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  serial_number TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ielts_completion_certificates_user_uidx
  ON ielts_completion_certificates (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ielts_completion_certificates_serial_uidx
  ON ielts_completion_certificates (serial_number);

ALTER TABLE reviewer_quiz_questions
  DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
ALTER TABLE reviewer_quiz_questions
  ADD CONSTRAINT reviewer_quiz_questions_question_type_check
  CHECK (question_type IN (
    'multiple_choice', 'true_false', 'fill_blank', 'multi_select', 'written_response', 'audio_response'
  ));

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_course_id UUID;

INSERT INTO pgmigrations (name, run_on)
SELECT '1753790000000_ielts_completion_certificates', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1753790000000_ielts_completion_certificates');
INSERT INTO pgmigrations (name, run_on)
SELECT '1753800000000_written_response_questions', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1753800000000_written_response_questions');
INSERT INTO pgmigrations (name, run_on)
SELECT '1753810000000_audio_response_questions', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1753810000000_audio_response_questions');

SELECT 'ielts_certs' AS kind, COUNT(*)::int AS n FROM ielts_completion_certificates
UNION ALL
SELECT 'audio_q', COUNT(*)::int FROM reviewer_quiz_questions WHERE question_type = 'audio_response'
UNION ALL
SELECT 'written_q', COUNT(*)::int FROM reviewer_quiz_questions WHERE question_type = 'written_response'
UNION ALL
SELECT 'users_last_seen', COUNT(*)::int
  FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'last_seen_at';
SQL

sudo -u postgres psql -d "$DB_NAME" -c "SELECT name FROM pgmigrations ORDER BY name;"

./node_modules/.bin/tsc -p tsconfig.json
systemctl restart spherex-api

cd /opt/spherex/lms-client
npm run build
systemctl restart spherex-client

printf '%s\n' '675b8116e2be3cba64fe06a6936fe89ec6fb003c' > /opt/spherex/state/server.sha
REMOTE_CLIENT=$(git ls-remote https://github.com/josephbaria24/spherex_lms_client.git refs/heads/master | awk 'NR==1 {print $1}')
printf '%s\n' "$REMOTE_CLIENT" > /opt/spherex/state/client.sha
sed -i 's/^SERVER_BASELINE=.*/SERVER_BASELINE=675b8116e2be3cba64fe06a6936fe89ec6fb003c/' /opt/spherex/deploy.sh

systemctl start spherex-deploy.timer
systemctl is-active spherex-api spherex-client spherex-deploy.timer
grep -c 'bg-white' /opt/spherex/lms-client/components/admin/users/user-activity-sheet.tsx
grep -c getIeltsUserMonitor /opt/spherex/lms-server/dist/lib/ielts-certificate.js
echo deploy-ok
