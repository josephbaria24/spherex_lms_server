#!/bin/bash
set -euo pipefail
cd /opt/spherex/lms-server

DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
DB_USER=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.username))')
echo "db=$DB_NAME user=$DB_USER"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
ALTER TABLE IF EXISTS ielts_completion_certificates OWNER TO "${DB_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ielts_completion_certificates TO "${DB_USER}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${DB_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${DB_USER}";
SQL

node -r dotenv/config <<'NODE'
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query("SELECT COUNT(*)::int AS n FROM ielts_completion_certificates");
  console.log("ok count=" + r.rows[0].n);
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
NODE

echo grants-ok
