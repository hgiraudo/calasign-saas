import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-domains-"));
delete process.env.DATABASE_URL;

describe("dominio propio: re-verificación periódica", () => {
  it("si el TXT desaparece, el dominio deja de apuntar a la plataforma o el DNS falla seguido, deja de usarse para los links", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { recheckVerifiedDomains, tenantBaseUrl, tenantForHost } = await import("../src/modules/custom-domains");
    const { config } = await import("../src/config");
    // Los links pasan al dominio verificado solo si el entorno sirve dominios propios.
    config.customDomainsServing = true;
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
    const status = async () => (await db.one<any>(`SELECT status FROM custom_domains WHERE id = $1`, [domainId])).status;
    const reverify = () => db.query(`UPDATE custom_domains SET status = 'verified', recheck_failures = 0 WHERE id = $1`, [domainId]);

    // El TXT sigue publicado y el dominio apunta a la plataforma: queda verificado.
    let txt: string[] = ["calasign-verify=tok123"];
    let routed = true;
    const deps = { txt: async () => txt, routes: async () => routed };
    await recheckVerifiedDomains({ db, log }, deps);
    expect(await db.one<any>(`SELECT status, last_error FROM custom_domains WHERE id = $1`, [domainId])).toMatchObject({ status: "verified", last_error: null });
    expect(await tenantBaseUrl(db, tenant)).toBe("https://firmas.cliente.test");

    // Un error de DNS suelto no lo desverifica.
    const failing = {
      txt: async (): Promise<string[]> => {
        throw new Error("DNS 503");
      },
      routes: async () => true,
    };
    await age();
    await recheckVerifiedDomains({ db, log }, failing);
    expect(await status()).toBe("verified");

    // Un control correcto pone el contador en cero. Después falta el TXT una vez: sigue verificado, con aviso.
    await age();
    await recheckVerifiedDomains({ db, log }, deps);
    txt = [];
    await age();
    await recheckVerifiedDomains({ db, log }, deps);
    const once = await db.one<any>(`SELECT status, last_error FROM custom_domains WHERE id = $1`, [domainId]);
    expect(once.status).toBe("verified");
    expect(once.last_error).toMatch(/si sigue fallando/);

    // Falta otra vez: vuelve a pendiente y los links usan el dominio de la plataforma.
    await age();
    const r = await recheckVerifiedDomains({ db, log }, deps);
    expect(r.demoted).toBe(1);
    expect(await status()).toBe("pending");
    expect(await tenantBaseUrl(db, tenant)).toBe(config.appUrl);
    expect(await tenantForHost(db, "firmas.cliente.test")).toBeNull();
    const audit = await db.one<any>(`SELECT action, target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'domain.unverified'`, [tenant]);
    expect(audit).toMatchObject({ action: "domain.unverified", target_id: "firmas.cliente.test" });

    // Quien se quedó con el dominio vuelve a publicar el TXT viejo (es público: queda en los historiales de DNS) pero
    // lo sirve desde otro lado. El dominio ya no apunta a la plataforma y se desverifica igual.
    await reverify();
    txt = ["calasign-verify=tok123"];
    routed = false;
    await age();
    await recheckVerifiedDomains({ db, log }, deps);
    await age();
    await recheckVerifiedDomains({ db, log }, deps);
    expect(await status()).toBe("pending");

    // Un dominio que solo devuelve errores de DNS también termina desverificado (cuatro controles seguidos).
    await reverify();
    for (let i = 0; i < 3; i++) {
      await age();
      await recheckVerifiedDomains({ db, log }, failing);
      expect(await status()).toBe("verified");
    }
    await age();
    await recheckVerifiedDomains({ db, log }, failing);
    expect(await status()).toBe("pending");
    await db.close();
  }, 180_000);
});
