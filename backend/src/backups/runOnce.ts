import { config } from "../config";
import { prisma } from "../db/prisma";
import { logger } from "../logger";
import { createDatabaseBackup } from "./scheduler";

const main = async () => {
  const target = await createDatabaseBackup({
    prisma,
    provider: config.effectiveDatabaseProvider,
    databaseUrl: config.databaseUrl,
    backupDir: config.backups.dir,
    assetStorageDir: config.assets.storageDir,
    secretsDir: config.backups.secretsDir,
    pgDumpPath: config.backups.pgDumpPath,
    retentionDays: config.backups.retentionDays,
  });
  logger.info("one-off backup completed", { provider: config.effectiveDatabaseProvider, target });
};

void main()
  .catch((error) => {
    logger.error("one-off backup failed", { error });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
