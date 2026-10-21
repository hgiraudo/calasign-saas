// Avisos de seguridad de la cuenta al correo de la persona (contraseña cambiada, 2FA activada o desactivada, códigos
// de recuperación regenerados): si no fue ella, se entera y puede reaccionar. Son de la plataforma (sin marca de una
// organización: la cuenta vale en todas). Se encolan en "notify" y los envía jobs.ts (notifySecurityNotice), que
// respeta la supresión global por rebote.
import type { FastifyRequest } from "fastify";
import type { Db } from "../infra/db";
import { enqueue } from "../infra/queue";
import { ipNetworkKey } from "../lib/ip";
import { clientInfo } from "./context";

export const SECURITY_NOTICE_KINDS = ["password_changed", "2fa_enabled", "2fa_disabled", "2fa_recovery_regenerated"] as const;
export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

export function isSecurityNoticeKind(k: unknown): k is SecurityNoticeKind {
  return (SECURITY_NOTICE_KINDS as readonly unknown[]).includes(k);
}

/** Encola el aviso (en la transacción `db` si se pasa una). La red de origen va enmascarada (/24 o /64). */
export async function enqueueSecurityNotice(db: Db, req: FastifyRequest | null, userId: string, kind: SecurityNoticeKind) {
  const ip = req ? clientInfo(req).ip : null;
  await enqueue(db, "notify", { kind, userId, at: new Date().toISOString(), network: ip ? ipNetworkKey(ip) : null });
}
