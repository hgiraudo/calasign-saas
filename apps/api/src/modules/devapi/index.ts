// Ampliaciones de la API para integradores (docs/API-ROADMAP.md): eventos (polling y SSE), datos de formulario,
// adjuntos del firmante, clonado y operaciones en lote. La rotación del secreto de webhooks vive en webhooks.ts y los
// filtros avanzados de GET /v1/envelopes en search.ts.
import type { FastifyInstance } from "fastify";
import type { Services } from "../context";
import { eventRoutes } from "./events";
import { envelopeOpsRoutes } from "./envelope-ops";

export async function devApiRoutes(app: FastifyInstance, s: Services) {
  await eventRoutes(app, s);
  await envelopeOpsRoutes(app, s);
}
