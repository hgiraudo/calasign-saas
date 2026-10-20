// Proceso worker dedicado (producción): escala aparte de la API.
import pino from "pino";
import { config } from "./config";
import { createDb } from "./infra/db";
import { startWorker } from "./infra/queue";
import { getSealProvider } from "./infra/seal";
import { createBlobStore } from "./infra/storage";
import { createJobHandlers, sweep } from "./modules/jobs";
import { createTenantStorageResolver } from "./modules/data";
import { checkAiProviderConfig } from "./modules/ai/provider";

const log = pino({ level: config.logLevel });
const db = await createDb();
const blobs = createBlobStore(createTenantStorageResolver(db));
await getSealProvider();
checkAiProviderConfig(log);
const deps = { db, blobs, log };
const worker = startWorker(db, {
  handlers: createJobHandlers(deps),
  log,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  onTick: () => sweep(deps),
});
log.info({ env: config.environment }, "worker iniciado");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await worker.stop();
    await db.close();
    process.exit(0);
  });
}
