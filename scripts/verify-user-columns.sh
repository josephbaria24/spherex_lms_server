#!/bin/bash
set -euo pipefail
cd /opt/spherex/lms-server
DB_NAME=$(node -r dotenv/config -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//, ""))')
sudo -u postgres psql -d "$DB_NAME" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('last_seen_at','last_login_at','active_course_id') ORDER BY 1;"
sudo -u postgres psql -d "$DB_NAME" -c "SELECT COUNT(*) AS users FROM users;"
echo "--- api ---"
systemctl is-active spherex-api
journalctl -u spherex-api --since "20 min ago" --no-pager | grep -E "active_course_id|last_seen_at" | tail -n 5 || true
echo "done"
