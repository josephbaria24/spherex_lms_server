#!/bin/bash
set -euo pipefail
cd /opt/spherex/lms-server

DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE reviewer_quiz_questions
  DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
ALTER TABLE reviewer_quiz_questions
  ADD CONSTRAINT reviewer_quiz_questions_question_type_check
  CHECK (question_type IN ('multiple_choice', 'true_false', 'fill_blank', 'multi_select', 'written_response'));
INSERT INTO pgmigrations (name, run_on)
SELECT '1753800000000_written_response_questions', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM pgmigrations WHERE name = '1753800000000_written_response_questions'
);
SQL

./node_modules/.bin/tsx src/db/seed-ielts-productive.ts

python3 - <<'PY'
from pathlib import Path
p = Path("/opt/spherex/lms-client/app/ielts/page.tsx")
text = p.read_text()
text = text.replace(
    "Task 1 & Task 2 practice coming soon.",
    "Task 1 chart description and Task 2 essay. Length is checked; a person does not mark the writing.",
)
text = text.replace(
    "Part 1\u20133 speaking practice coming soon.",
    "Part 1, 2, and 3 prompts. Speak your answer, then type what you said.",
)
p.write_text(text)
print("blurbs-updated")
PY

cd /opt/spherex/lms-client
npm run build
systemctl restart spherex-api spherex-client
systemctl is-active spherex-api spherex-client
