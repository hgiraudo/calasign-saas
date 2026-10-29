// Verificación de propiedad de los dominios SSO por DNS: la organización publica un TXT
// _calasign-sso.<dominio> = calasign-sso-verify=<token>. Hasta verificarlo, el dominio no se usa para el
// descubrimiento por correo («Continuar con SSO») ni para mandar a nadie al IdP de esa organización.
// Varias organizaciones pueden reclamar el mismo dominio sin verificar; verificado, es de una sola.
import type { FastifyInstance } from "fastify";
import type { SsoDomainStatus } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { conflict, notFound } from "../../lib/errors";
import { iso, randomToken } from "../../lib/util";
import { auditFromRequest, recordAudit } from "../audit";
import { authenticate, type Services } from "../context";
import { resolveTxt } from "../custom-domains";

export const ssoTxtName = (domain: string) => `_calasign-sso.${domain}`;
export const ssoTxtValue = (token: string) => `calasign-sso-verify=${token}`;

const toStatus = (r: any): SsoDomainStatus => ({
  domain: r.domain,
  verified: Boolean(r.verified_at),
  verifiedAt: iso(r.verified_at),
  txtName: ssoTxtName(r.domain),
  txtValue: ssoTxtValue(r.verification_token),
  lastCheckedAt: iso(r.last_checked_at),
  lastError: r.last_error,
});

/**
 * Reemplaza la lista de dominios de la organización conservando la verificación de los que siguen.
 * Falla si otra organización ya verificó alguno.
 */
export async function syncSsoDomains(db: Db, tenantId: string, domains: string[]) {
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  for (const d of wanted) {
    const owner = await db.one<any>(`SELECT tenant_id FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL`, [d]);
    if (owner && owner.tenant_id !== tenantId) throw conflict("domain_taken", `El dominio ${d} ya está verificado por otra organización`);
  }
  await db.query(`DELETE FROM sso_domains WHERE tenant_id = $1 AND NOT (domain = ANY($2))`, [tenantId, wanted]);
  for (const d of wanted) {
    await db.query(`INSERT INTO sso_domains (domain, tenant_id, verification_token) VALUES ($1,$2,$3) ON CONFLICT (domain, tenant_id) DO NOTHING`, [
      d,
      tenantId,
      randomToken(18),
    ]);
  }
}

const RECHECK_HOURS = 6;
const MISSING_MARK = "Re-verificación: no se encontró el registro TXT";

/**
 * Re-verifica los dominios SSO verificados. Antes la verificación valía para siempre: si la organización perdía el
 * dominio (vencía y lo registraba otro), su IdP seguía siendo el destino del «Continuar con SSO» para esos correos,
 * SCIM podía seguir dando de alta usuarios del dominio y el dueño nuevo no podía verificarlo (domain_taken). Si el TXT
 * falta en dos controles seguidos (separados por RECHECK_HOURS), el dominio deja de estar verificado. Un error de DNS
 * no cuenta como falta. La organización lo vuelve a verificar desde Ajustes.
 */
export async function recheckVerifiedSsoDomains(
  d: { db: Db; log: { warn(o: object, m?: string): void } },
  resolve: (name: string) => Promise<string[]> = resolveTxt,
  limit = 20,
) {
  const rows = await d.db.query<any>(
    `SELECT * FROM sso_domains WHERE verified_at IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(hours => $1))
      ORDER BY last_checked_at NULLS FIRST LIMIT $2`,
    [RECHECK_HOURS, limit],
  );
  let demoted = 0;
  for (const r of rows) {
    let values: string[];
    try {
      values = await resolve(ssoTxtName(r.domain));
    } catch (e) {
      await d.db.query(`UPDATE sso_domains SET last_checked_at = now() WHERE domain = $1 AND tenant_id = $2`, [r.domain, r.tenant_id]);
      d.log.warn({ domain: r.domain, err: String((e as Error).message ?? e) }, "no se pudo re-verificar el dominio SSO");
      continue;
    }
    if (values.includes(ssoTxtValue(r.verification_token))) {
      await d.db.query(`UPDATE sso_domains SET last_checked_at = now(), last_error = NULL WHERE domain = $1 AND tenant_id = $2`, [
        r.domain,
        r.tenant_id,
      ]);
      continue;
    }
    if (!String(r.last_error ?? "").startsWith(MISSING_MARK)) {
      await d.db.query(`UPDATE sso_domains SET last_checked_at = now(), last_error = $3 WHERE domain = $1 AND tenant_id = $2`, [
        r.domain,
        r.tenant_id,
        `${MISSING_MARK} ${ssoTxtName(r.domain)}: si sigue faltando en el próximo control, el dominio deja de estar verificado`,
      ]);
      continue;
    }
    const down = await d.db.query(
      `UPDATE sso_domains SET verified_at = NULL, last_checked_at = now(), last_error = $3
        WHERE domain = $1 AND tenant_id = $2 AND verified_at IS NOT NULL RETURNING domain`,
      [r.domain, r.tenant_id, `${MISSING_MARK} ${ssoTxtName(r.domain)} en dos controles seguidos: el dominio dejó de estar verificado`],
    );
    if (!down.length) continue;
    demoted++;
    await recordAudit(d.db, {
      tenantId: r.tenant_id,
      action: "sso.domain_unverified",
      actor: { type: "system", label: "Re-verificación de dominio SSO" },
      targetType: "domain",
      targetId: r.domain,
      data: { reason: "txt_missing" },
    });
  }
  return { checked: rows.length, demoted };
}

export async function ssoDomainRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get("/v1/settings/sso/domains", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(`SELECT * FROM sso_domains WHERE tenant_id = $1 ORDER BY domain`, [req.auth!.tenantId]);
    return { items: rows.map(toStatus) };
  });

  app.post<{ Params: { domain: string } }>(
    "/v1/settings/sso/domains/:domain/verify",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const a = req.auth!;
      const domain = req.params.domain.toLowerCase();
      const r = await s.db.one<any>(`SELECT * FROM sso_domains WHERE domain = $1 AND tenant_id = $2`, [domain, a.tenantId]);
      if (!r) throw notFound("Dominio");
      let values: string[] = [];
      let error: string | null = null;
      try {
        values = await resolveTxt(ssoTxtName(domain));
      } catch (e) {
        error = `No se pudo consultar el DNS: ${(e as Error).message}`;
      }
      const ok = values.includes(ssoTxtValue(r.verification_token));
      if (!ok && !error) error = `No se encontró el registro TXT ${ssoTxtName(domain)} con el valor esperado`;
      // Chequeo y verificación con todas las filas del dominio bloqueadas: dos organizaciones que verifican a la vez
      // no pueden quedar ambas como dueñas del mismo dominio.
      const row = await s.db.tx(async (t) => {
        const rows = await t.query<any>(`SELECT tenant_id, verified_at FROM sso_domains WHERE domain = $1 FOR UPDATE`, [domain]);
        if (ok && rows.some((x) => x.verified_at && x.tenant_id !== a.tenantId)) {
          throw conflict("domain_taken", `El dominio ${domain} ya está verificado por otra organización`);
        }
        return t.one<any>(
          `UPDATE sso_domains SET verified_at = CASE WHEN $3 THEN COALESCE(verified_at, now()) ELSE verified_at END, last_checked_at = now(), last_error = $4
           WHERE domain = $1 AND tenant_id = $2 RETURNING *`,
          [domain, a.tenantId, ok, ok ? null : error],
        );
      });
      if (ok && !r.verified_at) await auditFromRequest(s.db, req, a, "sso.domain_verified", { targetType: "domain", targetId: domain });
      return toStatus(row);
    },
  );
}
