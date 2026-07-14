import "dotenv/config";
import { pool } from "../config/db.js";

async function main() {
  const dbs = await pool.query(
    "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
  );
  console.log("Databases on server:", dbs.rows.map((r) => r.datname).join(", "));

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log("Tables in spherex_lms:", tables.rows.map((r) => r.table_name).join(", "));

  const users = await pool.query(
    "SELECT id, email, role, status, created_at FROM users ORDER BY created_at",
  );
  console.log("Users:", JSON.stringify(users.rows, null, 2));

  const courses = await pool.query(
    "SELECT id, title, category, level FROM courses ORDER BY created_at",
  );
  console.log("Courses:", JSON.stringify(courses.rows, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
