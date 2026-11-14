#!/bin/bash
set -euo pipefail

cp /tmp/certificate-registry.ts /opt/spherex/lms-server/src/lib/certificate-registry.ts
cp /tmp/certificates.ts /opt/spherex/lms-server/src/lib/certificates.ts
cp /tmp/ielts-certificate.ts /opt/spherex/lms-server/src/lib/ielts-certificate.ts
cp /tmp/certificates.routes.ts /opt/spherex/lms-server/src/modules/certificates/certificates.routes.ts
cp /tmp/httpError.ts /opt/spherex/lms-server/src/utils/httpError.ts
cp /tmp/1753820000000_certificate_registry.cjs /opt/spherex/lms-server/migrations/
cp /tmp/seed-certificate-registry.ts /opt/spherex/lms-server/src/db/seed-certificate-registry.ts
cp /tmp/psi-ela-certificate-registry.csv /opt/spherex/lms-server/src/db/psi-ela-certificate-registry.csv
mkdir -p /opt/spherex/lms-client/app/admin/certificates
mkdir -p /opt/spherex/lms-client/app/certificates
cp /tmp/admin-certificates-page.tsx /opt/spherex/lms-client/app/admin/certificates/page.tsx
cp /tmp/public-certificates-page.tsx /opt/spherex/lms-client/app/certificates/page.tsx
cp /tmp/navigation.ts /opt/spherex/lms-client/lib/navigation.ts
cp /tmp/verify-serial-page.tsx /opt/spherex/lms-client/app/verify/\[serial\]/page.tsx

cd /opt/spherex/lms-server
DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
DB_USER=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.username))')
echo "db=$DB_NAME user=$DB_USER"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE IF NOT EXISTS certificate_serial_settings (
  course_id    UUID PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL,
  digits       INTEGER NOT NULL DEFAULT 6 CHECK (digits BETWEEN 3 AND 12),
  next_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS certificate_registry (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number       TEXT NOT NULL,
  course_title        TEXT NOT NULL,
  learner_name        TEXT NOT NULL,
  learner_email       TEXT,
  issued_at           TIMESTAMPTZ NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('lms', 'legacy', 'ielts')),
  course_id           UUID REFERENCES courses(id) ON DELETE SET NULL,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  lms_certificate_id  UUID REFERENCES certificates(id) ON DELETE SET NULL,
  legacy_course_id    TEXT,
  legacy_user_id      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS certificate_registry_serial_uidx ON certificate_registry (serial_number);
CREATE INDEX IF NOT EXISTS certificate_registry_issued_idx ON certificate_registry (issued_at DESC);
CREATE INDEX IF NOT EXISTS certificate_registry_email_idx ON certificate_registry (lower(learner_email));
ALTER TABLE certificate_serial_settings OWNER TO "${DB_USER}";
ALTER TABLE certificate_registry OWNER TO "${DB_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE certificate_serial_settings TO "${DB_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE certificate_registry TO "${DB_USER}";
INSERT INTO pgmigrations (name, run_on)
SELECT '1753820000000_certificate_registry', NOW()
WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '1753820000000_certificate_registry');
SQL

./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsx src/db/seed-certificate-registry.ts
systemctl restart spherex-api

cd /opt/spherex/lms-client
npm run build
systemctl restart spherex-client

printf '%s\n' '675b8116e2be3cba64fe06a6936fe89ec6fb003c' > /opt/spherex/state/server.sha
REMOTE_CLIENT=$(git ls-remote https://github.com/josephbaria24/spherex_lms_client.git refs/heads/master | awk 'NR==1 {print $1}')
printf '%s\n' "$REMOTE_CLIENT" > /opt/spherex/state/client.sha
sed -i 's/^SERVER_BASELINE=.*/SERVER_BASELINE=675b8116e2be3cba64fe06a6936fe89ec6fb003c/' /opt/spherex/deploy.sh

systemctl is-active spherex-api spherex-client
echo deploy-ok
