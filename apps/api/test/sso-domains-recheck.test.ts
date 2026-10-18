import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-sso-domains-"));
delete process.env.DATABASE_URL;

describe("dominio SSO: re-verificación periódica", () => {
  it("si el TXT desaparece en dos controles seguidos, el dominio deja de estar verificado y otra organización puede reclamarlo", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { recheckVerifiedSsoDomains, syncSsoDomains } = await import("../src/modules/data/sso-domains");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const viejo = uuidv7();
    const nuevo = uuidv7();
    for (const t of [viejo, nuevo]) await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [t, `t-${t.slice(-8)}`]);
    await db.query(
      `INSERT INTO sso_domains (domain, tenant_id, verification_token, verified_at, last_checked_at)
       VALUES ('empresa.test', $1, 'tok123', now() - interval '30 days', now() - interval '7 hours')`,
      [viejo],
    );
    const log = { warn() {} };
    const row = () => db.one<any>(`SELECT verified_at, last_error FROM sso_domains WHERE domain = 'empresa.test' AND tenant_id = $1`, [viejo]);
    const age = () => db.query(`UPDATE sso_domains SET last_checked_at = now() - interval '7 hours' WHERE domain = 'empresa.test'`);

    // Mientras el dominio esté verificado por la organización vieja, nadie más puede reclamarlo.
    await expect(syncSsoDomains(db, nuevo, ["empresa.test"])).rejects.toMatchObject({ code: "domain_taken" });

    // El TXT sigue publicado: queda verificado.
    let txt: string[] = ["calasign-sso-verify=tok123"];
    const resolve = async () => txt;
    await recheckVerifiedSsoDomains({ db, log }, resolve);
    expect((await row()).verified_at).not.toBeNull();

    // Un error de DNS no cuenta como falta.
    await age();
    await recheckVerifiedSsoDomains({ db, log }, async () => {
      throw new Error("DNS 503");
    });
    expect((await row()).verified_at).not.toBeNull();

    // Falta una vez: sigue verificado, con aviso.
    txt = [];
    await age();
    await recheckVerifiedSsoDomains({ db, log }, resolve);
    const once = await row();
    expect(once.verified_at).not.toBeNull();
    expect(once.last_error).toMatch(/próximo control/);

    // Falta otra vez: deja de estar verificado y el dueño nuevo del dominio lo puede reclamar.
    await age();
    const r = await recheckVerifiedSsoDomains({ db, log }, resolve);
    expect(r.demoted).toBe(1);
    expect((await row()).verified_at).toBeNull();
    await syncSsoDomains(db, nuevo, ["empresa.test"]);
    const audit = await db.one<any>(`SELECT action, target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'sso.domain_unverified'`, [viejo]);
    expect(audit).toMatchObject({ action: "sso.domain_unverified", target_id: "empresa.test" });
    await db.close();
  }, 180_000);
});
