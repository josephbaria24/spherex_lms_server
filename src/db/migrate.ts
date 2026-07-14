import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const sqlPath = join(__dirname, "schema.sql");
  const sql = await readFile(sqlPath, "utf8");

  // eslint-disable-next-line no-console
  console.log(`[migrate] applying schema from ${sqlPath}`);
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log("[migrate] done");
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[migrate] failed:", err);
  process.exit(1);
});
