// Canales de terceros que la organización apagó (tenants.channel_*_enabled, migración 0128). Lo lee el envío
// (outbound.ts sendTracked, el código de verificación, el link del celular, Telegram) y las validaciones de los
// módulos (modules/channel-policy.ts). Ver packages/shared/src/organization-channels.ts.
import { normalizeOrganizationChannels, type OrganizationChannels } from "@calasign/shared";
import type { Db } from "../infra/db";

interface ChannelRow {
  channel_sms_enabled: boolean | null;
  channel_whatsapp_enabled: boolean | null;
  channel_telegram_enabled: boolean | null;
}

/** Canales permitidos de la organización (los tres encendidos si no existe: nada se apaga por un dato que falta). */
export async function tenantChannels(db: Db, tenantId: string | null | undefined): Promise<OrganizationChannels> {
  if (!tenantId) return normalizeOrganizationChannels(null);
  const t = await db.one<ChannelRow>(`SELECT channel_sms_enabled, channel_whatsapp_enabled, channel_telegram_enabled FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  return normalizeOrganizationChannels({
    sms: t?.channel_sms_enabled,
    whatsapp: t?.channel_whatsapp_enabled,
    telegram: t?.channel_telegram_enabled,
  });
}

/** Si un canal de envío está apagado para la organización (el correo nunca). */
export function channelOff(s: OrganizationChannels, channel: string): boolean {
  return (channel === "sms" || channel === "whatsapp" || channel === "telegram") && !s[channel];
}

/** Texto que queda en notifications.error (y en la evidencia) cuando un aviso no sale por un canal apagado. */
export const CHANNEL_DISABLED_NOTE = "canal apagado por la organización (Ajustes → Organización)";
