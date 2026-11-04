// Canales de terceros que una organización puede apagar (migración 0128, SEG-30, docs/PROVEEDORES.md §5): SMS
// (Twilio), WhatsApp (Meta Cloud API) y Telegram. La plataforma los habilita por variables de entorno; con esto una
// organización que no quiere que el teléfono o el link de firma de sus firmantes pasen por esos proveedores los apaga
// para toda la cuenta, en vez de depender de que nadie los elija destinatario por destinatario. El correo no se apaga:
// es el canal por defecto y el único que queda siempre.
//
// Sin dependencias de api.ts (api.ts no importa de acá, pero signer.ts y la web sí).
import { z } from "zod";

export const ORGANIZATION_CHANNELS = ["sms", "whatsapp", "telegram"] as const;
export type OrganizationChannel = (typeof ORGANIZATION_CHANNELS)[number];

/** true = encendido (la organización lo permite). Por defecto, los tres encendidos: nada cambia para las existentes. */
export type OrganizationChannels = Record<OrganizationChannel, boolean>;

export const DEFAULT_ORGANIZATION_CHANNELS: OrganizationChannels = { sms: true, whatsapp: true, telegram: true };

/** PATCH parcial: solo cambian los canales que vienen. */
export const OrganizationChannelsInput = z
  .object({ sms: z.boolean().optional(), whatsapp: z.boolean().optional(), telegram: z.boolean().optional() })
  .strict();
export type OrganizationChannelsInput = z.infer<typeof OrganizationChannelsInput>;

/** Canal de terceros que usa cada método de autenticación con código al teléfono. */
export const AUTH_METHOD_CHANNEL: Partial<Record<string, OrganizationChannel>> = { otp_sms: "sms", otp_whatsapp: "whatsapp" };

/** Qué pidió un destinatario que la organización apagó: un canal de aviso o el método del código de verificación. */
export interface ChannelPolicyViolation {
  channel: OrganizationChannel;
  via: "channel" | "auth_method";
}

/**
 * Primer canal apagado que pide el destinatario (canales de aviso `whatsapp`/`telegram` o métodos `otp_sms`/
 * `otp_whatsapp`), o null si todo lo que pide está permitido. `channels` son los canales de aviso tal como se guardan.
 */
export function channelPolicyViolation(
  s: OrganizationChannels,
  r: { channels?: readonly string[] | null; authMethod?: string | null },
): ChannelPolicyViolation | null {
  for (const c of r.channels ?? []) if ((c === "whatsapp" || c === "telegram") && !s[c]) return { channel: c, via: "channel" };
  const viaAuth = r.authMethod ? AUTH_METHOD_CHANNEL[r.authMethod] : undefined;
  if (viaAuth && !s[viaAuth]) return { channel: viaAuth, via: "auth_method" };
  return null;
}

/** Canales de aviso (`email`, `whatsapp`, `telegram`) que la organización permite elegir. */
export function allowedNotifyChannels<T extends string>(s: OrganizationChannels, all: readonly T[]): T[] {
  return all.filter((c) => !((c === "whatsapp" || c === "telegram") && !s[c as OrganizationChannel]));
}

/** Métodos de autenticación que la organización permite elegir (sin `otp_sms`/`otp_whatsapp` si su canal está apagado). */
export function allowedAuthMethods<T extends string>(s: OrganizationChannels, all: readonly T[]): T[] {
  return all.filter((m) => {
    const ch = AUTH_METHOD_CHANNEL[m];
    return !ch || s[ch];
  });
}

/** Lo guardado (columnas de tenants) con los valores por defecto para lo que falte. */
export function normalizeOrganizationChannels(
  v: Partial<Record<OrganizationChannel, boolean | null | undefined>> | null | undefined,
): OrganizationChannels {
  return {
    sms: v?.sms ?? DEFAULT_ORGANIZATION_CHANNELS.sms,
    whatsapp: v?.whatsapp ?? DEFAULT_ORGANIZATION_CHANNELS.whatsapp,
    telegram: v?.telegram ?? DEFAULT_ORGANIZATION_CHANNELS.telegram,
  };
}
