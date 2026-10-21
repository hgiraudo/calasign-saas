// Proceso worker dedicado (producción): escala aparte de la API.
import pino from "pino";
import { config } from "./config";
import { createDb } from "./infra/db";
import { startWorker } from "./infra/queue";
import { servedCells, servesAllCells } from "./infra/cells";
import { getSealProvider } from "./infra/seal";
import { createBlobStore } from "./infra/storage";
import { createJobHandlers, sweep } from "./modules/jobs";
import { createTenantStorageResolver } from "./modules/data";
import { checkAiProviderConfig } from "./modules/ai/provider";
import { warnIdentityConfig } from "./modules/identity/providers";
import { PDF_INGEST_LIMITS } from "@calasign/pdf";

// Los jobs (conectores, documentos generados) no tienen a nadie esperando la respuesta: esperan lugar más tiempo.
PDF_INGEST_LIMITS.maxConcurrent = config.pdfIngest.concurrency;
PDF_INGEST_LIMITS.queueWaitMs = Math.max(config.pdfIngest.queueWaitMs, 120_000);
const log = pino({ level: config.logLevel });
const db = await createDb();
const blobs = createBlobStore(createTenantStorageResolver(db));
await getSealProvider();
checkAiProviderConfig(log);
warnIdentityConfig(log);
const deps = { db, blobs, log };
const worker = startWorker(db, {
  handlers: createJobHandlers(deps),
  log,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  onTick: (signal) => sweep(deps, signal),
});
// Con SERVED_CELLS, solo toma los jobs de esas celdas (y los sin celda) y los barridos solo miran sus organizaciones.
log.info({ env: config.environment, cells: servesAllCells() ? "all" : [...servedCells()] }, "worker iniciado");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await worker.stop();
    // Con tope: pool.end() espera a las conexiones prestadas (p. ej. un paso del barrido que no atiende la señal).
    await Promise.race([db.close(), new Promise((r) => setTimeout(r, 5_000))]);
    process.exit(0);
  });
}
