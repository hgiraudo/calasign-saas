// Fase 2 — productividad: un solo punto de registro para plantillas, adjuntos y branding.
import type { FastifyInstance } from "fastify";
import { attachmentRoutes } from "./attachments";
import { brandingRoutes } from "./branding";
import type { Services } from "./context";
import { templateRoutes } from "./templates";

export async function productivityRoutes(app: FastifyInstance, s: Services) {
  await templateRoutes(app, s);
  await attachmentRoutes(app, s);
  await brandingRoutes(app, s);
}
