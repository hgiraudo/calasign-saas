// Ajustes generales de la organización: el huso horario (migración 0123) con el que se escriben las horas del
// certificado de finalización y la fecha de los campos «fecha de firma» (ver packages/shared/src/time-zone.ts), y los
// canales de terceros permitidos (migración 0128: SMS, WhatsApp y Telegram; ver organization-channels.ts y
// channel-policy.ts).
import type { FastifyInstance } from "fastify";
import { DEFAULT_TIME_ZONE, normalizeTimeZone, UpdateOrganizationSettingsInput, type OrganizationSettings } from "@calasign/shared";
import type { Db } from "../infra/db";
import { tenantChannels } from "../notifications/channel-policy";
import { auditFromRequest, changedValues } from "./audit";
import { authenticate, type Services } from "./context";

/** Huso de la organización (UTC si no existe o lo guardado ya no es válido). */
export async function tenantTimeZone(db: Db, tenantId: string): Promise<string> {
  const t = await db.one<{ time_zone: string | null }>(`SELECT time_zone FROM tenants WHERE id = $1`, [tenantId]);
  return normalizeTimeZone(t?.time_zone ?? DEFAULT_TIME_ZONE);
}

/** Para la auditoría: cada canal como su propia clave (changed: ["channels.whatsapp"]), no el objeto entero. */
const flat = (x: OrganizationSettings) => ({
  timeZone: x.timeZone,
  "channels.sms": x.channels.sms,
  "channels.whatsapp": x.channels.whatsapp,
  "channels.telegram": x.channels.telegram,
});

export async function organizationSettingsRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  const settings = async (db: Db, tenantId: string): Promise<OrganizationSettings> => ({
    timeZone: await tenantTimeZone(db, tenantId),
    channels: await tenantChannels(db, tenantId),
  });

  // Lectura: cualquier miembro (la consola la usa para no ofrecer los canales apagados al armar un sobre).
  app.get("/v1/settings/organization", { preHandler: auth }, async (req) => settings(s.db, req.auth!.tenantId));

  // Escritura: settings:manage (política genérica de /v1/settings/* en access.ts: propietario y administrador).
  app.patch("/v1/settings/organization", { preHandler: auth }, async (req) => {
    const input = UpdateOrganizationSettingsInput.parse(req.body);
    const tenantId = req.auth!.tenantId;
    const { before, after } = await s.db.tx(async (t) => {
      // Con la fila bloqueada: dos cambios a la vez no se pisan el «antes» de la auditoría.
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      const before = await settings(t, tenantId);
      const after: OrganizationSettings = {
        timeZone: input.timeZone !== undefined ? normalizeTimeZone(input.timeZone) : before.timeZone,
        channels: { ...before.channels, ...stripUndefined(input.channels ?? {}) },
      };
      await t.query(
        `UPDATE tenants SET time_zone = $2, channel_sms_enabled = $3, channel_whatsapp_enabled = $4, channel_telegram_enabled = $5 WHERE id = $1`,
        [tenantId, after.timeZone, after.channels.sms, after.channels.whatsapp, after.channels.telegram],
      );
      return { before, after };
    });
    await auditFromRequest(s.db, req, req.auth!, "settings.organization_updated", {
      targetType: "settings",
      targetId: "organization",
      data: changedValues(flat(before), flat(after)),
    });
    return after satisfies OrganizationSettings;
  });
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
