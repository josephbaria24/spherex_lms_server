#!/bin/bash
set -euo pipefail

cp /tmp/completion-alerts.ts /opt/spherex/lms-server/src/lib/completion-alerts.ts
cp /tmp/quiz-helpers.ts /opt/spherex/lms-server/src/lib/quiz-helpers.ts
cp /tmp/ielts-certificate.ts /opt/spherex/lms-server/src/lib/ielts-certificate.ts
cp /tmp/enrollments.routes.ts /opt/spherex/lms-server/src/modules/enrollments/enrollments.routes.ts
cp /tmp/ielts-access.routes.ts /opt/spherex/lms-server/src/modules/reviewers/ielts-access.routes.ts
cp /tmp/httpError.ts /opt/spherex/lms-server/src/utils/httpError.ts

cd /opt/spherex/lms-server
./node_modules/.bin/tsc -p tsconfig.json
systemctl restart spherex-api

printf '%s\n' '675b8116e2be3cba64fe06a6936fe89ec6fb003c' > /opt/spherex/state/server.sha
sed -i 's/^SERVER_BASELINE=.*/SERVER_BASELINE=675b8116e2be3cba64fe06a6936fe89ec6fb003c/' /opt/spherex/deploy.sh

systemctl is-active spherex-api
grep -c notifyStaffCourseCompleted dist/lib/completion-alerts.js
grep -c notifyStaffIeltsCompleted dist/lib/ielts-certificate.js
echo deploy-ok
