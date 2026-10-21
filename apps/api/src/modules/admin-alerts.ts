// Avisos por correo a propietarios y administradores de una organización que no son de un sobre (almacenamiento
// desactivado, sello de archivo que no se puede extender…). Con la marca de la organización (remitente, nombre del
// producto en marca blanca) y en el idioma de cada persona; cada envío queda en notifications (rebotes y quejas).
import type { Db } from "../infra/db";
import { sendTracked } from "../notifications/outbound";
import { normLocale } from "../notifications/templates";
import { productLabel, resolveBrand, senderFor } from "./white-label/brand";

export type AlertLocale = "es" | "en" | "pt-BR";
export type AlertMessage = (locale: AlertLocale, ctx: { product: string; org: string | null; name: string }) => { subject: string; text: string };

type Log = { error(o: object, m?: string): void; warn?(o: object, m?: string): void };

/**
 * Reclama un aviso de una sola vez por organización (`kind` + `key`, p. ej. el vencimiento del certificado de la TSA):
 * true solo para el primero que lo reclama (tabla tenant_alerts). Así un barrido horario no repite el correo.
 */
export async function claimTenantAlert(db: Db, tenantId: string, kind: string, key: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO tenant_alerts (tenant_id, kind, key) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, kind, key) DO NOTHING RETURNING tenant_id`,
    [tenantId, kind, key.slice(0, 200)],
  );
  return r.length > 0;
}

/**
 * Manda el aviso a propietarios y administradores. Devuelve cuántos salieron y si hubo fallos del momento (el llamador
 * decide si reintenta; con `jobId`, un reintento no repite a quien ya lo recibió).
 */
export async function alertTenantAdmins(
  db: Db,
  tenantId: string,
  template: string,
  message: AlertMessage,
  opts: { jobId?: number; log?: Log } = {},
): Promise<{ sent: number; transient: string[] }> {
  const admins = await db.query<{ email: string; name: string | null; locale: string | null }>(
    `SELECT u.email, u.name, u.locale FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role IN ('owner','admin')`,
    [tenantId],
  );
  if (!admins.length) return { sent: 0, transient: [] };
  const wl = await resolveBrand(db, tenantId, null);
  const sendAs = await senderFor(db, wl);
  const product = productLabel(wl);
  const org = (await db.one<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]))?.name ?? null;
  let sent = 0;
  const transient: string[] = [];
  for (const a of admins) {
    if (!a.email) continue;
    const locale = normLocale(a.locale);
    const m = message(locale, { product, org, name: a.name ?? "" });
    const out = await sendTracked(
      db,
      { tenantId, template, jobId: opts.jobId ?? null, log: opts.log },
      {
        channel: "email",
        to: a.email,
        tenantId,
        locale,
        subject: m.subject,
        text: m.text,
        from: sendAs.from,
        replyTo: sendAs.replyTo,
        dkim: sendAs.dkim,
        fallbackFrom: sendAs.fallbackFrom,
      },
    ).catch((e) => ({ status: "failed" as const, error: String(e), transient: true }));
    if (out.status === "failed") {
      if (out.transient) transient.push(out.error.slice(0, 300));
      else opts.log?.warn?.({ tenantId, template }, "aviso al equipo no entregado (error permanente)");
    } else sent++;
  }
  return { sent, transient };
}
