import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "") || "spherex_lms";
  parsed.pathname = "/postgres";

  const client = new Client({ connectionString: parsed.toString() });
  await client.connect();

  const exists = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );

  if (exists.rowCount && exists.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[db:create] database "${dbName}" already exists`);
  } else {
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    // eslint-disable-next-line no-console
    console.log(`[db:create] created database "${dbName}"`);
  }

  await client.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[db:create] failed:", err);
  process.exit(1);
});
