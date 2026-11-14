#!/bin/bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p = Path("/opt/spherex/lms-server/src/utils/httpError.ts")
text = p.read_text()
text = text.replace(
    'static conflict(message = "Conflict") {\n    return new HttpError(409, message);\n  }',
    'static conflict(message = "Conflict", details?: unknown) {\n    return new HttpError(409, message, details);\n  }',
)
p.write_text(text)
print("httperror-patched")
PY
cd /opt/spherex/lms-server

DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE reviewer_quiz_questions
  DROP CONSTRAINT IF EXISTS reviewer_quiz_questions_question_type_check;
ALTER TABLE reviewer_quiz_questions
  ADD CONSTRAINT reviewer_quiz_questions_question_type_check
  CHECK (question_type IN (
    'multiple_choice', 'true_false', 'fill_blank', 'multi_select', 'written_response', 'audio_response'
  ));
INSERT INTO pgmigrations (name, run_on)
SELECT '1753810000000_audio_response_questions', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM pgmigrations WHERE name = '1753810000000_audio_response_questions'
);
SQL

./node_modules/.bin/tsx src/db/seed-ielts-productive.ts

python3 - <<'PY'
from pathlib import Path
p = Path("/opt/spherex/lms-client/app/ielts/page.tsx")
text = p.read_text()
replacements = {
    "Part 1, 2, and 3 prompts. Speak your answer, then type what you said.": "Record Part 1, 2, and 3 with your microphone. Length is checked; a person does not score the speech.",
    "Part 1–3 speaking practice coming soon.": "Record Part 1, 2, and 3 with your microphone. Length is checked; a person does not score the speech.",
}
for old, new in replacements.items():
    text = text.replace(old, new)
p.write_text(text)
print("blurb-updated")
PY

cd /opt/spherex/lms-client
npm run build
systemctl restart spherex-api spherex-client
systemctl is-active spherex-api spherex-client
