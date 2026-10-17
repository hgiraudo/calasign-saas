// Registro del bloque "firmante y evidencia". Va antes de signingRoutes: el hook de OTP tiene que estar
// declarado antes que las rutas del link para aplicarse a todas.
import type { FastifyInstance } from "fastify";
import type { Services } from "./context";
import { otpRoutes } from "./otp";
import { participantRoutes } from "./participants";
import { verifyRoutes } from "./verify";

export async function signerFeatureRoutes(app: FastifyInstance, s: Services) {
  await otpRoutes(app, s);
  await participantRoutes(app, s);
  await verifyRoutes(app, s);
}
