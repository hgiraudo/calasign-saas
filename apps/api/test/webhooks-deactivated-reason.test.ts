import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { DEACTIVATED_REASON, toEndpoint } from "../src/modules/webhooks";

const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));

// deactivatedReason del webhook: "credential_revoked" solo si está inactivo y la credencial que lo creó ya no vale (los
// conectores como n8n reactivan solo en ese caso; uno pausado a mano queda con null). Sobre PGlite con las migraciones.
describe("webhooks: deactivatedReason", () => {
  it("credential_revoked solo para inactivos con la credencial de origen revocada", async () => {
    const db = await PGlite.create();
    for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(migrations + f, "utf8").replace(/--[^\n]*(\n|$)/g, "\n").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
      for (const st of sql) await db.query(st);
    }
    // Sin claves foráneas: alcanza con filas de webhook_endpoints (la API key referida no existe = revocada/borrada).
    await db.query("SET session_replication_role = replica");
    const t = "00000000-0000-7000-8000-000000000001";
    const ins = (id: string, active: boolean, key: string | null) => db.query(`INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, secret_prefix, active, created_by_api_key) VALUES ($1,$2,'https://x','e','whsec_',$3,$4)`, [id, t, active, key]);
    await ins("00000000-0000-7000-8000-0000000000a1", false, "00000000-0000-7000-8000-0000000000f1");
    await ins("00000000-0000-7000-8000-0000000000a2", false, null);
    await ins("00000000-0000-7000-8000-0000000000a3", true, "00000000-0000-7000-8000-0000000000f1");
    const rows = (await db.query<any>(`SELECT ep.*, ${DEACTIVATED_REASON} FROM webhook_endpoints ep WHERE ep.tenant_id = $1 ORDER BY ep.id`, [t])).rows;
    expect(rows.map((r) => toEndpoint(r).deactivatedReason)).toEqual(["credential_revoked", null, null]);
    const one = (await db.query<any>(`SELECT ep.*, ${DEACTIVATED_REASON} FROM webhook_endpoints ep WHERE ep.id = $1 AND ep.tenant_id = $2`, ["00000000-0000-7000-8000-0000000000a1", t])).rows;
    expect(one[0].deactivated_reason).toBe("credential_revoked");
    const p = (await db.query<any>(`UPDATE webhook_endpoints ep SET url = COALESCE($3, url), active = COALESCE($4, active), updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING ep.*, ${DEACTIVATED_REASON}`, ["00000000-0000-7000-8000-0000000000a3", t, null, false])).rows;
    expect(p[0].deactivated_reason).toBe("credential_revoked");
    const r = (await db.query<any>(`UPDATE webhook_endpoints ep SET secret_enc = $3, secret_prefix = $4,
           previous_secret_enc = CASE WHEN $5::int > 0 THEN ep.secret_enc ELSE NULL END,
           previous_secret_expires_at = CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 hour') ELSE NULL END,
           updated_at = now()
         WHERE ep.id = $1 AND ep.tenant_id = $2 RETURNING ep.*, ${DEACTIVATED_REASON}`, ["00000000-0000-7000-8000-0000000000a2", t, "n", "whsec_n", 24])).rows;
    expect(r[0].previous_secret_enc).toBe("e");
    expect(r[0].deactivated_reason).toBe(null);
  }, 120000);

  it("toEndpoint ignora el motivo si está activo y vale null sin la columna", () => {
    expect(toEndpoint({ active: true, deactivated_reason: "credential_revoked" }).deactivatedReason).toBeNull();
    expect(toEndpoint({ active: false }).deactivatedReason).toBeNull();
  });
});
