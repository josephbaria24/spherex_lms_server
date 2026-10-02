import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/db.js";
import { logger } from "./lib/logger.js";

async function main() {
  const app = createApp();

  try {
    await pool.query("SELECT 1");
    logger.info("database connected");
  } catch (err) {
    logger.error({ err }, "database connection failed");
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    logger.info({ port: env.port }, "server listening");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
