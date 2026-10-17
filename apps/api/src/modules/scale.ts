// Fase 4 — escala: registra las rutas de envío masivo y formularios web públicos.
import type { FastifyInstance } from "fastify";
import { bulkRoutes } from "./bulk";
import type { Services } from "./context";
import { webFormRoutes } from "./webforms";

export async function scaleRoutes(app: FastifyInstance, s: Services) {
  await bulkRoutes(app, s);
  await webFormRoutes(app, s);
}
