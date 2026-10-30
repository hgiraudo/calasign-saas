// Ajustes generales de la organización: por ahora, el huso horario (migración 0123) con el que se escriben las horas
// del certificado de finalización y la fecha de los campos «fecha de firma». Ver packages/shared/src/time-zone.ts.
import type { FastifyInstance } from "fastify";
import { DEFAULT_TIME_ZONE, normalizeTimeZone, UpdateOrganizationSettingsInput, type OrganizationSettings } from "@calasign/shared";
import type { Db } from "../infra/db";
import { auditFromRequest, changedValues } from "./audit";
import { authenticate, type Services } from "./context";

/** Huso de la organización (UTC si no existe o lo guardado ya no es válido). */
export async function tenantTimeZone(db: Db, tenantId: string): Promise<string> {
  const t = await db.one<{ time_zone: string | null }>(`SELECT time_zone FROM tenants WHERE id = $1`, [tenantId]);
  return normalizeTimeZone(t?.time_zone ?? DEFAULT_TIME_ZONE);
}

export async function organizationSettingsRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  const settings = async (tenantId: string): Promise<OrganizationSettings> => ({ timeZone: await tenantTimeZone(s.db, tenantId) });

  app.get("/v1/settings/organization", { preHandler: auth }, async (req) => settings(req.auth!.tenantId));

  // Escritura: settings:manage (política genérica de /v1/settings/* en access.ts).
  app.patch("/v1/settings/organization", { preHandler: auth }, async (req) => {
    const input = UpdateOrganizationSettingsInput.parse(req.body);
    const before = await settings(req.auth!.tenantId);
    const timeZone = normalizeTimeZone(input.timeZone);
    await s.db.query(`UPDATE tenants SET time_zone = $2 WHERE id = $1`, [req.auth!.tenantId, timeZone]);
    const after = { timeZone };
    await auditFromRequest(s.db, req, req.auth!, "settings.organization_updated", {
      targetType: "settings",
      targetId: "organization",
      data: changedValues(before as unknown as Record<string, unknown>, after),
    });
    return after satisfies OrganizationSettings;
  });
}
