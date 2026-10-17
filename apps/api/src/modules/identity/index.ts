// Bloque "identidad" (Fase 5): KYC del firmante, SSO de remitentes y SCIM. Se registra después de
// signerFeatureRoutes (hook de OTP) y antes de signingRoutes: el bloqueo por identidad va después del OTP.
import type { FastifyInstance } from "fastify";
import type { Services } from "../context";
import { identityKycRoutes } from "./kyc";
import { scimRoutes } from "./scim";
import { ssoRoutes } from "./sso";

export async function identityRoutes(app: FastifyInstance, s: Services) {
  await identityKycRoutes(app, s);
  await ssoRoutes(app, s);
  await scimRoutes(app, s);
}
