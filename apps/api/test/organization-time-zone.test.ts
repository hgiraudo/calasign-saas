// Huso horario de la organización (migración 0123): GET/PATCH /v1/settings/organization con validación y auditoría,
// el alta de cuenta con el huso del navegador, y el certificado de finalización con las horas en ese huso. App real
// sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-tz-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const KEY = "cs_test_time_zone_settings";
const headers = { authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [
    uuidv7(),
    tenant,
    sha256Hex(KEY),
  ]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

/** PDF mínimo de una página, hecho a mano (sin dependencias). */
function samplePdf() {
  const content = "BT /F1 14 Tf 50 780 Td (Contrato) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe("huso horario de la organización", () => {
  it("por defecto UTC; se cambia con PATCH, se rechaza uno desconocido y queda en la auditoría", async () => {
    const get = await app.inject({ method: "GET", url: "/v1/settings/organization", headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ timeZone: "UTC" });

    const bad = await app.inject({ method: "PATCH", url: "/v1/settings/organization", headers, payload: { timeZone: "Marte/Olympus" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
    expect((await app.inject({ method: "GET", url: "/v1/settings/organization", headers })).json().timeZone).toBe("UTC");

    const ok = await app.inject({
      method: "PATCH",
      url: "/v1/settings/organization",
      headers,
      payload: { timeZone: "America/Argentina/Buenos_Aires" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ timeZone: "America/Argentina/Buenos_Aires" });
    const row = await db.one<any>(`SELECT time_zone FROM tenants WHERE id = $1`, [tenant]);
    expect(row.time_zone).toBe("America/Argentina/Buenos_Aires");

    const audit = await db.query<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'settings.organization_updated' ORDER BY id DESC`,
      [tenant],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ from: { timeZone: "UTC" }, to: { timeZone: "America/Argentina/Buenos_Aires" } });
  });

  it("el alta de cuenta guarda el huso que manda la web; uno inválido no frena el alta y queda en UTC", async () => {
    const stamp = Date.now();
    const alta = (email: string, timeZone: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { name: "Ana", email, password: "una-clave-segura-123", organization: `Org ${email}`, timeZone },
      });
    const a = await alta(`tz-ok+${stamp}@example.com`, "America/Bogota");
    expect(a.statusCode).toBe(201);
    const b = await alta(`tz-mal+${stamp}@example.com`, "no/existe");
    expect(b.statusCode).toBe(201);
    const rows = await db.query<any>(
      `SELECT t.time_zone, u.email FROM tenants t JOIN memberships m ON m.tenant_id = t.id JOIN users u ON u.id = m.user_id
        WHERE u.email IN ($1, $2) ORDER BY u.email`,
      [`tz-mal+${stamp}@example.com`, `tz-ok+${stamp}@example.com`],
    );
    expect(rows.map((r) => r.time_zone)).toEqual(["UTC", "America/Bogota"]);
  });

  it("el certificado escribe las horas en el huso de la organización, con su desfase, y dice cuál es", async () => {
    const { finalizeEnvelopePdf, extractPdfPlainText } = await import("@calasign/pdf");
    const { getSealProvider } = await import("../src/infra/seal");
    const certificado = async (timeZone?: string) =>
      finalizeEnvelopePdf(
        {
          documents: [{ name: "c.pdf", bytes: samplePdf() }],
          fields: [],
          certificate: {
            envelopeId: "01a00000-0000-7000-8000-000000000001",
            subject: "Contrato",
            organizationName: "T",
            senderName: "Ana",
            senderEmail: null,
            // 01:30 UTC del 5 de marzo = 22:30 del 4 en Buenos Aires.
            createdAt: "2026-03-05T01:30:00.000Z",
            sentAt: "2026-03-05T01:30:00.000Z",
            completedAt: "2026-03-05T01:30:00.000Z",
            locale: "es",
            documents: [{ name: "c.pdf", pageCount: 1, sha256: "a".repeat(64) }],
            recipients: [],
            events: [{ seq: 1, type: "envelope.sent", occurredAt: "2026-03-05T01:30:00.000Z", actor: "Ana", ip: null }],
            chainHead: "b".repeat(64),
            timeZone,
          },
        },
        { provider: await getSealProvider(), tsaUrl: null },
      ).then((pdf) => extractPdfPlainText(pdf));

    const ar = (await certificado("America/Argentina/Buenos_Aires")).text.replace(/\s+/g, " ");
    expect(ar).toContain("2026-03-04 22:30:00 UTC−03:00");
    expect(ar).toContain("Huso horario");
    expect(ar).toContain("America/Argentina/Buenos_Aires (UTC−03:00)");
    expect(ar).not.toContain("2026-03-05 01:30:00");

    // Sin huso (organizaciones que no lo configuraron): UTC, como antes.
    const utc = (await certificado()).text.replace(/\s+/g, " ");
    expect(utc).toContain("2026-03-05 01:30:00 UTC");
    expect(utc).not.toContain("UTC−");
  }, 60_000);
});
