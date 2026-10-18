// Verificación de propiedad de los dominios SSO por DNS: la organización publica un TXT
// _calasign-sso.<dominio> = calasign-sso-verify=<token>. Hasta verificarlo, el dominio no se usa para el
// descubrimiento por correo («Continuar con SSO») ni para mandar a nadie al IdP de esa organización.
// Varias organizaciones pueden reclamar el mismo dominio sin verificar; verificado, es de una sola.
import type { FastifyInstance } from "fastify";
import type { SsoDomainStatus } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { conflict, notFound } from "../../lib/errors";
import { iso, randomToken } from "../../lib/util";
import { auditFromRequest } from "../audit";
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
      if (ok) {
        const other = await s.db.one<any>(`SELECT tenant_id FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL AND tenant_id <> $2`, [domain, a.tenantId]);
        if (other) throw conflict("domain_taken", `El dominio ${domain} ya está verificado por otra organización`);
      }
      const row = await s.db.one<any>(
        `UPDATE sso_domains SET verified_at = CASE WHEN $3 THEN COALESCE(verified_at, now()) ELSE verified_at END, last_checked_at = now(), last_error = $4
         WHERE domain = $1 AND tenant_id = $2 RETURNING *`,
        [domain, a.tenantId, ok, ok ? null : error],
      );
      if (ok && !r.verified_at) await auditFromRequest(s.db, req, a, "sso.domain_verified", { targetType: "domain", targetId: domain });
      return toStatus(row);
    },
  );
}
