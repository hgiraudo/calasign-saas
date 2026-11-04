// Validación de los canales que la organización apagó (SMS, WhatsApp, Telegram; migración 0128) en todo lo que elige
// canales o método de verificación de un destinatario: sobres (POST/PUT, en una llamada, MCP y lotes por dentro),
// sobres desde plantilla (API, low-code, CRM, conectores, formularios web, envío masivo), correcciones, reasignación y
// delegación, clonado, generación de documentos y workflows. Un canal apagado da 400 channel_disabled con el
// destinatario y qué cambiar. El envío (outbound.ts) vuelve a mirar: lo que se apagó después no sale por ese canal.
import { channelPolicyViolation, type ChannelPolicyViolation, type OrganizationChannels } from "@calasign/shared";
import type { Db } from "../infra/db";
import { AppError } from "../lib/errors";
import { tenantChannels } from "../notifications/channel-policy";

const LABEL = { sms: "el SMS", whatsapp: "WhatsApp", telegram: "Telegram" } as const;

/** Mensaje en castellano de un canal apagado (lo traduce la web por details: detailText de channel_disabled). */
export function channelDisabledMessage(who: string, v: ChannelPolicyViolation): string {
  const where = "(Ajustes → Organización → Canales)";
  if (v.via === "auth_method")
    return `${who}: la organización apagó ${LABEL[v.channel]} ${where}, así que el código de verificación no puede ir por ahí: elegí el código por correo u otra verificación`;
  return `${who}: la organización apagó ${LABEL[v.channel]} como canal de aviso ${where}: quitalo de los canales del destinatario (el correo siempre está disponible)`;
}

export function channelDisabledError(who: string, v: ChannelPolicyViolation, path?: string): AppError {
  return new AppError(400, "channel_disabled", channelDisabledMessage(who, v), {
    recipient: who,
    channel: v.channel,
    via: v.via,
    // nosemgrep: calasign-url-en-error-o-log — el campo del cuerpo del pedido (recipients[0].channels), no una URL
    ...(path ? { path } : {}),
  });
}

/** Lo mínimo de un destinatario para validarlo (el nombre es para el mensaje). */
export interface ChannelChoice {
  name?: string | null;
  role?: string | null;
  channels?: readonly string[] | null;
  authMethod?: string | null;
}

/**
 * Primer destinatario de la lista que pide un canal apagado, con su posición y el nombre para el mensaje (null si
 * todos están permitidos).
 */
export function firstChannelViolation(
  s: OrganizationChannels,
  list: readonly ChannelChoice[],
): { index: number; who: string; v: ChannelPolicyViolation } | null {
  for (const [index, r] of list.entries()) {
    const v = channelPolicyViolation(s, r);
    if (v) return { index, who: r.name || r.role || `destinatario ${index + 1}`, v };
  }
  return null;
}

/**
 * 400 channel_disabled si algún destinatario de la lista pide un canal que la organización apagó. `path`: prefijo del
 * `details.path` (queda `<prefijo>.<índice>`) o el path exacto de cada elemento.
 */
export async function assertChannelsAllowed(
  db: Db,
  tenantId: string,
  list: readonly ChannelChoice[],
  path: string | ((index: number) => string) = "recipients",
): Promise<void> {
  if (!list.length) return;
  const bad = firstChannelViolation(await tenantChannels(db, tenantId), list);
  if (bad) throw channelDisabledError(bad.who, bad.v, typeof path === "function" ? path(bad.index) : `${path}.${bad.index}`);
}

/**
 * Lo mismo sobre lo ya escrito en `recipients` (dentro de la transacción del llamador: el 400 deshace la escritura).
 * Así se cubre todo camino que inserta destinatarios, con los canales por defecto que haya puesto (p. ej. WhatsApp para
 * quien solo trae teléfono). `recipientIds`: solo esos (una corrección no falla por lo que ya tenía otro destinatario).
 */
export async function assertEnvelopeChannelsAllowed(db: Db, tenantId: string, envelopeId: string, recipientIds?: readonly string[]): Promise<void> {
  const s = await tenantChannels(db, tenantId);
  if (s.sms && s.whatsapp && s.telegram) return;
  if (recipientIds && !recipientIds.length) return;
  const rows = await db.query<{ name: string; role: string; channels: string[] | null; auth_method: string | null }>(
    `SELECT name, role, channels, auth_method FROM recipients
      WHERE tenant_id = $1 AND envelope_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY routing_order, id`,
    [tenantId, envelopeId, recipientIds ? [...recipientIds] : null],
  );
  const bad = firstChannelViolation(
    s,
    rows.map((r) => ({ name: r.name, role: r.role, channels: r.channels, authMethod: r.auth_method })),
  );
  if (bad) throw channelDisabledError(bad.who, bad.v);
}
