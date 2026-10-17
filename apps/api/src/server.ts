import { buildApp } from "./app";
import { config } from "./config";
import { createDb, migrate } from "./infra/db";
import { startWorker } from "./infra/queue";
import { getSealProvider } from "./infra/seal";
import { createBlobStore } from "./infra/storage";
import { createJobHandlers, sweep } from "./modules/jobs";

const db = await createDb();
const blobs = createBlobStore();
const app = await buildApp({ db, blobs });

// En entornos chicos (local, dev) la API aplica migraciones y corre el worker en el mismo proceso.
if (!config.production || process.env.MIGRATE_ON_START === "1") await migrate(db, (m) => app.log.info(m));
await getSealProvider();

let worker: { stop(): Promise<void> } | null = null;
if (config.workerInline) {
  const deps = { db, blobs, log: app.log };
  worker = startWorker(db, { handlers: createJobHandlers(deps), log: app.log, onTick: () => sweep(deps) });
  app.log.info("worker en el mismo proceso");
}

await app.listen({ port: config.port, host: config.host });
app.log.info({ env: config.environment, db: config.databaseUrl ? "postgres" : "pglite", storage: config.storage.driver }, "CalaSign API lista");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig}: cerrando`);
    await app.close();
    await worker?.stop();
    await db.close();
    process.exit(0);
  });
}
