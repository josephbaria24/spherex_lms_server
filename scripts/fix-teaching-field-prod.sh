#!/bin/bash
set -euo pipefail
cd /opt/spherex/lms-server
DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
echo "db=$DB_NAME"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS teaching_field TEXT
  CHECK (teaching_field IS NULL OR teaching_field IN ('ielts', 'courses'));

UPDATE users
   SET teaching_field = 'courses'
 WHERE role = 'teacher' AND teaching_field IS NULL;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'teaching_field';

SELECT role, teaching_field, COUNT(*)::int AS n
  FROM users
 GROUP BY 1, 2
 ORDER BY 1, 2;
SQL

systemctl restart spherex-api
systemctl is-active spherex-api
echo teaching-field-fixed
