import { PDF_INGEST_LIMITS } from "@calasign/pdf";
import { buildApp } from "./app";
import { config } from "./config";
import { createDb, migrate } from "./infra/db";
import { startWorker } from "./infra/queue";
import { getSealProvider } from "./infra/seal";
import { createBlobStore } from "./infra/storage";
import { createJobHandlers, sweep } from "./modules/jobs";
import { createTenantStorageResolver } from "./modules/data";
import { checkAiProviderConfig } from "./modules/ai/provider";
import { warnIfTitleIndexMissing } from "./modules/agreements/repository";

PDF_INGEST_LIMITS.maxConcurrent = config.pdfIngest.concurrency;
PDF_INGEST_LIMITS.queueWaitMs = config.pdfIngest.queueWaitMs;

const db = await createDb();
const blobs = createBlobStore(createTenantStorageResolver(db));
const app = await buildApp({ db, blobs });

// En entornos chicos (local, dev) la API aplica migraciones y corre el worker en el mismo proceso.
if (!config.production || process.env.MIGRATE_ON_START === "1") await migrate(db, (m) => app.log.info(m));
await warnIfTitleIndexMissing(db, app.log);
await getSealProvider();
checkAiProviderConfig(app.log);

let worker: { stop(): Promise<void> } | null = null;
if (config.workerInline) {
  const deps = { db, blobs, log: app.log };
  worker = startWorker(db, { handlers: createJobHandlers(deps), log: app.log, onTick: (signal) => sweep(deps, signal) });
  app.log.info("worker en el mismo proceso");
}

await app.listen({ port: config.port, host: config.host });
app.log.info({ env: config.environment, db: config.databaseUrl ? "postgres" : "pglite", storage: config.storage.driver }, "CalaSign API lista");

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    // Una segunda señal (Ctrl+C repetido, systemd + kill manual) no vuelve a cerrar lo que ya se está cerrando.
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${sig}: cerrando`);
    // Tope general por debajo del TimeoutStopSec de systemd (90 s): una conexión que no termina (p. ej. un cliente SSE
    // que no lee y deja el socket con datos pendientes) no deja el proceso colgado hasta el SIGKILL.
    setTimeout(() => {
      app.log.warn("apagado: tope de 60 s, se sale igual");
      process.exit(1);
    }, 60_000).unref();
    // En paralelo: app.close() espera a las requests en curso (los streams SSE terminan en su preClose) y el worker a
    // sus jobs; en serie, el worker seguía tomando jobs mientras la API esperaba y el apagado sumaba los dos tiempos.
    await Promise.all([app.close(), worker?.stop()]);
    // Con tope: pool.end() espera a las conexiones prestadas (p. ej. un paso del barrido que no atiende la señal).
    await Promise.race([db.close(), new Promise((r) => setTimeout(r, 5_000))]);
    process.exit(0);
  });
}
