// Fase 6 + facturación: cobros al firmar, planes/suscripción y webhooks de los proveedores.
import type { FastifyInstance } from "fastify";
import type { Services } from "../context";
import { paymentRoutes } from "./payments";
import { subscriptionRoutes } from "./subscriptions";
import { billingWebhookRoutes } from "./webhooks";

export { enforceEnvelopeQuota, enforcePlanForRequest } from "./plans";
export { paymentBlocksCompletion, paymentsForCertificate } from "./payments";

export async function billingRoutes(app: FastifyInstance, s: Services) {
  await paymentRoutes(app, s);
  await subscriptionRoutes(app, s);
  await billingWebhookRoutes(app, s);
}
