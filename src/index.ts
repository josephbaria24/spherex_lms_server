import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/db.js";

async function main() {
  const app = createApp();

  try {
    await pool.query("SELECT 1");
    // eslint-disable-next-line no-console
    console.log("[db] connected");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[db] connection failed:", err);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on http://localhost:${env.port}`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
