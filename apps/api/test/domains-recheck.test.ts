import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-domains-"));
delete process.env.DATABASE_URL;

describe("dominio propio: re-verificación periódica", () => {
  it("si el TXT desaparece en dos controles seguidos, el dominio deja de usarse para los links", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { recheckVerifiedDomains, tenantBaseUrl, tenantForHost } = await import("../src/modules/custom-domains");
    const { config } = await import("../src/config");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
    const domainId = uuidv7();
    await db.query(
      `INSERT INTO custom_domains (id, tenant_id, domain, verification_token, status, verified_at, last_checked_at)
       VALUES ($1, $2, 'firmas.cliente.test', 'tok123', 'verified', now() - interval '30 days', now() - interval '7 hours')`,
      [domainId, tenant],
    );
    const log = { warn() {} };
    const age = () => db.query(`UPDATE custom_domains SET last_checked_at = now() - interval '7 hours' WHERE id = $1`, [domainId]);

    // El TXT sigue publicado: queda verificado.
    let txt: string[] = ["calasign-verify=tok123"];
    const resolve = async () => txt;
    await recheckVerifiedDomains({ db, log }, resolve);
    expect((await db.one<any>(`SELECT status, last_error FROM custom_domains WHERE id = $1`, [domainId]))).toMatchObject({ status: "verified", last_error: null });
    expect(await tenantBaseUrl(db, tenant)).toBe("https://firmas.cliente.test");

    // Un error de DNS no cuenta como falta.
    await age();
    await recheckVerifiedDomains({ db, log }, async () => {
      throw new Error("DNS 503");
    });
    expect((await db.one<any>(`SELECT status FROM custom_domains WHERE id = $1`, [domainId])).status).toBe("verified");

    // Falta una vez: sigue verificado, con aviso.
    txt = [];
    await age();
    await recheckVerifiedDomains({ db, log }, resolve);
    const once = await db.one<any>(`SELECT status, last_error FROM custom_domains WHERE id = $1`, [domainId]);
    expect(once.status).toBe("verified");
    expect(once.last_error).toMatch(/próximo control/);

    // Falta otra vez: vuelve a pendiente y los links usan el dominio de la plataforma.
    await age();
    const r = await recheckVerifiedDomains({ db, log }, resolve);
    expect(r.demoted).toBe(1);
    expect((await db.one<any>(`SELECT status FROM custom_domains WHERE id = $1`, [domainId])).status).toBe("pending");
    expect(await tenantBaseUrl(db, tenant)).toBe(config.appUrl);
    expect(await tenantForHost(db, "firmas.cliente.test")).toBeNull();
    const audit = await db.one<any>(`SELECT action, target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'domain.unverified'`, [tenant]);
    expect(audit).toMatchObject({ action: "domain.unverified", target_id: "firmas.cliente.test" });
    await db.close();
  }, 180_000);
});
