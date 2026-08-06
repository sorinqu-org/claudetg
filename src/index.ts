import { ClaudeTelegramApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { Database } from "./db.js";
import { startHealthServer } from "./health.js";
import { Logger, errorFields } from "./logger.js";

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const logger = new Logger(config.logLevel);
  const database = new Database(config.databasePath, config.agent.eventRetentionPerSession);
  const app = new ClaudeTelegramApp(config, database, logger);
  const health = startHealthServer(config.healthPort, logger);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    try {
      await app.stop();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      database.close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.start();
}

main().catch((error: unknown) => {
  const logger = new Logger("error");
  logger.error("Fatal startup failure", errorFields(error));
  process.exitCode = 1;
});
