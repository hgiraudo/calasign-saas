// IA: la extracción de metadatos no pisa una edición manual hecha mientras el modelo respondía (barrido y extracción
// manual, 409 metadata_changed), ni guarda si los documentos cambiaron en el medio (409 documents_changed); aceptar el
// aviso de tratamiento de datos requiere una sesión web (no API key ni OAuth); y una cita se da por verificada solo si
// es larga y está en la página citada. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageText, TextLine } from "@calasign/pdf";
import { AI_NOTICE_VERSION } from "@calasign/shared";
import type { DocText } from "../src/modules/ai/heuristics";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ai-races-"));
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let P: typeof import("../src/modules/ai/provider");
let H: typeof import("../src/modules/ai/heuristics");
let sweep: typeof import("../src/modules/ai/sweep");
const KEY = "cs_test_ai_races_admin";
const ORIGIN = "http://localhost:5173";
let tenant = "";
let ownerSession = "";
let ownerId = "";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  P = await import("../src/modules/ai/provider");
  H = await import("../src/modules/ai/heuristics");
  sweep = await import("../src/modules/ai/sweep");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  await db.query(
    `INSERT INTO tenants (id, slug, name, billing_plan, ai_enabled, ai_monthly_token_budget, ai_notice_version, ai_notice_accepted_at)
     VALUES ($1, $2, 'T', 'business', true, 1000000, $3, now())`,
    [tenant, `t-${tenant.slice(-8)}`, AI_NOTICE_VERSION],
  );
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'admin', 'cs_test', $3)`, [util.uuidv7(), tenant, util.sha256Hex(KEY)]);
  ownerId = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'owner@ai-races.test', 'Owner', 'scrypt$x')`, [ownerId]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenant, ownerId]);
  ownerSession = util.randomToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1, $2, $3, now() + interval '14 days', 'password')`, [
    util.sha256Hex(ownerSession),
    ownerId,
    tenant,
  ]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  P?.setAiProviderForTests(undefined);
  await app?.close();
  await db?.close();
});

const bearer = { authorization: `Bearer ${KEY}` };

async function envelope(status = "draft") {
  const id = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at) VALUES ($1, $2, 'S', $3, CASE WHEN $3 = 'completed' THEN now() ELSE NULL END)`, [
    id,
    tenant,
    status,
  ]);
  return id;
}

/** Proveedor de prueba: corre `during` mientras "el modelo responde" y devuelve metadatos de IA. */
function providerWith(during: () => Promise<void>) {
  const base = P.getAiProvider();
  P.setAiProviderForTests(
    Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      extractMetadata: async (docs: DocText[]) => {
        const r = await base.extractMetadata(docs);
        await during();
        return { ...r, result: { ...r.result, metadata: { ...r.result.metadata, governingLaw: "de la IA" } } };
      },
    }),
  );
}

const manualPut = (id: string, governingLaw: string) =>
  app.inject({ method: "PUT", url: `/v1/envelopes/${id}/ai/metadata`, headers: bearer, payload: {
      metadata: { parties: [], effectiveDate: null, expiryDate: null, renewalDate: null, autoRenewal: null, amounts: [], governingLaw, noticePeriodDays: null },
    },
  });

describe("extracción de metadatos vs. edición manual", () => {
  it("extracción manual: una edición hecha mientras el modelo respondía no se pisa (409 metadata_changed)", async () => {
    const id = await envelope();
    providerWith(async () => {
      expect((await manualPut(id, "manual")).statusCode).toBe(200);
    });
    try {
      const r = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/ai/extract-metadata`, headers: bearer });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("metadata_changed");
      const e = await db.one<any>(`SELECT ai_metadata, ai_metadata_source FROM envelopes WHERE id = $1`, [id]);
      expect(e.ai_metadata_source).toBe("manual");
      expect(e.ai_metadata.governingLaw).toBe("manual");
      // El consumo se registró igual (el modelo respondió).
      const u = await db.one<any>(`SELECT count(*)::int AS n FROM ai_usage WHERE envelope_id = $1 AND feature = 'extract_metadata'`, [id]);
      expect(u.n).toBe(1);
    } finally {
      P.setAiProviderForTests(undefined);
    }
  });

  it("extracción manual sin cambios en el medio: guarda (también sobre metadatos manuales anteriores)", async () => {
    const id = await envelope();
    expect((await manualPut(id, "antes")).statusCode).toBe(200);
    providerWith(async () => {});
    try {
      const r = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/ai/extract-metadata`, headers: bearer });
      expect(r.statusCode).toBe(200);
      expect(r.json().source).toBe("ai");
      expect(r.json().metadata.governingLaw).toBe("de la IA");
    } finally {
      P.setAiProviderForTests(undefined);
    }
  });

  it("extracción manual: si los documentos cambian mientras el modelo responde, no se guarda (409 documents_changed)", async () => {
    const id = await envelope();
    providerWith(async () => {
      const file = util.uuidv7();
      await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',1,'h')`, [
        file,
        tenant,
        `k-${file}`,
      ]);
      await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'nuevo.pdf',$4,1,'[]')`, [
        util.uuidv7(),
        tenant,
        id,
        file,
      ]);
    });
    try {
      const r = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/ai/extract-metadata`, headers: bearer });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("documents_changed");
      expect((await db.one<any>(`SELECT ai_metadata FROM envelopes WHERE id = $1`, [id])).ai_metadata).toBeNull();
    } finally {
      P.setAiProviderForTests(undefined);
    }
  });

  it("barrido automático: si alguien cargó los metadatos a mano mientras el modelo respondía, no los pisa", async () => {
    await db.query(`UPDATE tenants SET ai_auto_extract = true WHERE id = $1`, [tenant]);
    const id = await envelope("completed");
    await db.query(`UPDATE envelopes SET ai_metadata_retry_at = now() + interval '1 year' WHERE id <> $1 AND ai_metadata IS NULL`, [id]);
    providerWith(async () => {
      expect((await manualPut(id, "manual")).statusCode).toBe(200);
    });
    try {
      const r = await sweep.runAiSweep({ db, blobs: { get: async () => new Uint8Array() } as any, log: { warn: () => {}, info: () => {} } as any });
      const e = await db.one<any>(`SELECT ai_metadata, ai_metadata_source, ai_metadata_retry_at FROM envelopes WHERE id = $1`, [id]);
      expect(e.ai_metadata_source).toBe("manual");
      expect(e.ai_metadata.governingLaw).toBe("manual");
      expect(e.ai_metadata_retry_at).toBeNull();
      expect(r.extracted).toBe(0);
    } finally {
      P.setAiProviderForTests(undefined);
      await db.query(`UPDATE tenants SET ai_auto_extract = false WHERE id = $1`, [tenant]);
    }
  });
});

describe("aviso de tratamiento de datos de la IA", () => {
  it("aceptarlo (o habilitar la IA sin el aviso vigente) requiere sesión web: con API key, 403 session_required", async () => {
    await db.query(`UPDATE tenants SET ai_enabled = false, ai_notice_version = NULL, ai_notice_accepted_at = NULL, ai_notice_accepted_by = NULL WHERE id = $1`, [tenant]);
    const patch = (headers: Record<string, string>, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: "/v1/settings/ai", headers, payload });
    for (const body of [{ enabled: true, acceptNotice: true }, { enabled: true }, { acceptNotice: true }]) {
      const r = await patch(bearer, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(403);
      expect(r.json().error.code).toBe("session_required");
    }
    // Otros ajustes con API key siguen funcionando.
    expect((await patch(bearer, { renewalAlertDays: 45 })).statusCode).toBe(200);
    const t0 = await db.one<any>(`SELECT ai_enabled, ai_notice_accepted_at FROM tenants WHERE id = $1`, [tenant]);
    expect(t0).toEqual({ ai_enabled: false, ai_notice_accepted_at: null });
    // Con la sesión de una persona: queda aceptado a su nombre.
    const ok = await patch({ cookie: `cs_session=${ownerSession}`, origin: ORIGIN }, { enabled: true, acceptNotice: true });
    expect(ok.statusCode).toBe(200);
    const t = await db.one<any>(`SELECT ai_enabled, ai_notice_version, ai_notice_accepted_by FROM tenants WHERE id = $1`, [tenant]);
    expect(t).toEqual({ ai_enabled: true, ai_notice_version: AI_NOTICE_VERSION, ai_notice_accepted_by: ownerId });
    // Ya aceptado: apagar y volver a habilitar con la API key no acepta nada nuevo y vale.
    expect((await patch(bearer, { enabled: false })).statusCode).toBe(200);
    expect((await patch(bearer, { enabled: true })).statusCode).toBe(200);
    // Ya aceptado: una integración que reenvía acceptNotice con la API key guarda lo demás y no vuelve a sellar el aviso.
    const before = await db.one<any>(`SELECT ai_notice_accepted_at, ai_notice_accepted_by FROM tenants WHERE id = $1`, [tenant]);
    const again = await patch(bearer, { acceptNotice: true, renewalAlertDays: 60 });
    expect(again.statusCode).toBe(200);
    const after = await db.one<any>(`SELECT ai_notice_accepted_at, ai_notice_accepted_by, ai_renewal_alert_days FROM tenants WHERE id = $1`, [tenant]);
    expect(after).toEqual({ ...before, ai_renewal_alert_days: 60 });
    // Con un aviso anterior (versión vieja) vuelve a hacer falta la sesión.
    await db.query(`UPDATE tenants SET ai_notice_version = 'old' WHERE id = $1`, [tenant]);
    expect((await patch(bearer, { acceptNotice: true })).json().error.code).toBe("session_required");
  });
});

describe("verificación de citas", () => {
  function line(id: string, text: string, y: number): TextLine {
    return { id, text, x: 72, y, width: text.length * 5, height: 10, spans: [{ text, x: 72, width: text.length * 5 }] };
  }
  const page = (n: number, lines: string[]): PageText => ({ page: n, width: 595, height: 842, lines: lines.map((t, i) => line(`p${n}-l${i}`, t, 100 + i * 20)) });
  const docs: DocText[] = [
    { id: "d1", name: "a.pdf", pages: [page(0, ["Cláusula primera: el plazo es de doce meses."]), page(1, ["Cláusula segunda: la ley aplicable es la de Chile."])] },
  ];

  it("una cita corta (menos de 20 caracteres y de 4 palabras) no se da por verificada aunque aparezca", () => {
    expect(H.locateQuote(docs, "de la").verified).toBe(false);
    expect(H.locateQuote(docs, "el plazo").verified).toBe(false);
    expect(H.locateQuote(docs, "el plazo es de").verified).toBe(true); // 4 palabras
    expect(H.locateQuote(docs, "la ley aplicable es la de Chile").verified).toBe(true);
  });

  it("con página citada, solo si está en esa página; sin página, en cualquier lugar", () => {
    expect(H.locateQuote(docs, "la ley aplicable es la de Chile", 2)).toEqual({ documentId: "d1", page: 2, verified: true });
    expect(H.locateQuote(docs, "la ley aplicable es la de Chile", 1)).toEqual({ documentId: null, page: 1, verified: false });
    expect(H.locateQuote(docs, "la ley aplicable es la de Chile", null)).toEqual({ documentId: "d1", page: 2, verified: true });
    expect(H.locateQuote(docs, "una cita que no está en ninguna parte", 1).verified).toBe(false);
  });

  it("con página citada, una cita corta con un número o de 6+ caracteres se verifica si está en esa página", () => {
    const money: DocText[] = [
      { id: "d2", name: "b.pdf", pages: [page(0, ["Precio total: USD 10.000 pagaderos a 30 días de la factura."]), page(1, ["Firmas."])] },
    ];
    expect(H.locateQuote(money, "USD 10.000", 1)).toEqual({ documentId: "d2", page: 1, verified: true });
    expect(H.locateQuote(money, "30 días", 1)).toEqual({ documentId: "d2", page: 1, verified: true });
    expect(H.locateQuote(money, "de la factura", 1).verified).toBe(true); // 6+ caracteres y 2 palabras
    expect(H.locateQuote(money, "factura", 1).verified).toBe(false); // una sola palabra
    expect(H.locateQuote(money, "Precio total", 1).verified).toBe(true);
    // En otra página que la citada: no.
    expect(H.locateQuote(money, "USD 10.000", 2).verified).toBe(false);
    // Sin página rige el mínimo de largo.
    expect(H.locateQuote(money, "USD 10.000").verified).toBe(false);
    expect(H.locateQuote(money, "30 días", null).verified).toBe(false);
    // Muy cortas sin número, ni con página.
    expect(H.locateQuote(docs, "de la", 1).verified).toBe(false);
  });

  it("una cita corta coincide con números y palabras enteros", () => {
    const amounts: DocText[] = [
      { id: "d3", name: "c.pdf", pages: [page(0, ["Precio: USD 10.000.000 pagaderos a 130 días; recargo del 110% (anual)."]), page(1, ["Precio: USD 10.000, a 30 días, recargo del 10%."])] },
    ];
    expect(H.locateQuote(amounts, "USD 10.000", 1).verified).toBe(false);
    expect(H.locateQuote(amounts, "30 días", 1).verified).toBe(false);
    expect(H.locateQuote(amounts, "10%", 1).verified).toBe(false);
    expect(H.locateQuote(amounts, "USD 10.000", 2)).toEqual({ documentId: "d3", page: 2, verified: true });
    expect(H.locateQuote(amounts, "30 días", 2).verified).toBe(true);
    expect(H.locateQuote(amounts, "10%", 2).verified).toBe(true);
    expect(H.locateQuote(amounts, "USD 10.000.000", 1).verified).toBe(true);
    expect(H.locateQuote(amounts, "110% (anual)", 1).verified).toBe(true);
  });
});
