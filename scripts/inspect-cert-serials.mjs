import "dotenv/config";
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(
  `select serial_number, course_title, learner_name, source, course_id, lms_certificate_id
     from certificate_registry
    where serial_number ilike '%SPX%' or serial_number ilike '%PSI%' or course_title ilike '%mesh%'
    order by issued_at desc
    limit 30`,
);
console.log("registry", JSON.stringify(r.rows, null, 2));
const s = await c.query(
  `select css.*, c.title
     from certificate_serial_settings css
     join courses c on c.id = css.course_id`,
);
console.log("settings", JSON.stringify(s.rows, null, 2));
const mesh = await c.query(
  `select id, title from courses where title ilike '%mesh%' or title ilike '%mehsaht%'`,
);
console.log("mesh courses", JSON.stringify(mesh.rows, null, 2));
await c.end();
