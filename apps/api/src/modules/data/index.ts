// Datos: BYOK, celdas (residencia de datos), renovación de sellos de archivo y verificación de dominios SSO.
import type { FastifyInstance } from "fastify";
import type { Db } from "../../infra/db";
import type { BlobStore } from "../../infra/storage";
import type { Services } from "../context";
import { archiveRoutes, archiveSweep } from "./archive";
import { byokRoutes, byokSweep, kmsMockRoutes } from "./byok";
import { cellRoutes } from "./cells";
import { ssoDomainRoutes } from "./sso-domains";

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

export async function dataRoutes(app: FastifyInstance, s: Services) {
  await cellRoutes(app, s);
  await byokRoutes(app, s);
  await kmsMockRoutes(app);
  await ssoDomainRoutes(app, s);
  await archiveRoutes(app, s, app.log);
}

/** Tareas periódicas del módulo (las llama el barrido del worker). */
export async function dataSweep(d: { db: Db; blobs: BlobStore; log: Log }) {
  await byokSweep(d.db).catch((err) => d.log.error({ err: String(err) }, "falló el chequeo de claves BYOK"));
  await archiveSweep(d).catch((err) => d.log.error({ err: String(err) }, "falló el barrido de sellos de archivo"));
}

export { createTenantStorageResolver } from "./byok";
