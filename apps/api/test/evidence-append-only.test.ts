// Evidencia append-only en la base (migración 0072), verificación pública atada al hash del certificado del PDF y
// registro de descargas (firmante: cadena del sobre; remitente: auditoría de la organización). App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-evidence-ao-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
type Blobs = ReturnType<typeof import("../src/infra/storage")["createBlobStore"]>;
let db: Db;
let app: App;
let blobs: Blobs;
let tenant = "";
const KEY = "cs_test_evidence_append_only";
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
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  blobs = createBlobStore();
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function envelopeWithEvents(status: string, n = 2) {
  const { uuidv7 } = await import("../src/lib/util");
  const { appendEvent, SYSTEM } = await import("../src/infra/evidence");
  const env = uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', $3)`, [env, tenant, status]);
  await db.tx(async (t) => {
    for (let i = 0; i < n; i++) await appendEvent(t, { tenantId: tenant, envelopeId: env, type: `test.e${i}`, actor: SYSTEM, data: { i } });
  });
  return env;
}

const rejected = /evidence_append_only/;

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

describe("evidencia append-only (0072)", () => {
  it("envelope_events: rechaza UPDATE y DELETE; deja mover pos y borrar los eventos de un borrador", async () => {
    const env = await envelopeWithEvents("sent");
    await expect(db.query(`UPDATE envelope_events SET data = '{"x":1}' WHERE envelope_id = $1`, [env])).rejects.toThrow(rejected);
    await expect(db.query(`UPDATE envelope_events SET hash = 'x', pos = pos WHERE envelope_id = $1`, [env])).rejects.toThrow(rejected);
    await expect(db.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [env])).rejects.toThrow(rejected);
    await expect(db.query(`TRUNCATE envelope_events`)).rejects.toThrow(rejected);
    // Solo pos (el secuenciador del feed de eventos): permitido.
    await db.query(`UPDATE envelope_events SET pos = NULL WHERE envelope_id = $1`, [env]);
    expect((await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1`, [env])).length).toBe(2);

    const draft = await envelopeWithEvents("draft");
    await db.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [draft]);
    expect((await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1`, [draft])).length).toBe(0);
  });

  it("mantenimiento explícito con SET LOCAL calasign.allow_evidence_write, solo dentro de esa transacción", async () => {
    const env = await envelopeWithEvents("completed");
    await db.tx(async (t) => {
      await t.query(`SET LOCAL calasign.allow_evidence_write = 'on'`);
      await t.query(`UPDATE envelope_events SET actor_label = 'x' WHERE envelope_id = $1`, [env]);
    });
    await expect(db.query(`UPDATE envelope_events SET actor_label = 'y' WHERE envelope_id = $1`, [env])).rejects.toThrow(rejected);
  });

  it("account_audit_log: rechaza UPDATE y DELETE", async () => {
    const { recordAudit } = await import("../src/modules/audit");
    await recordAudit(db, { tenantId: tenant, action: "test.action", actor: { type: "system" } });
    await expect(db.query(`UPDATE account_audit_log SET action = 'otra' WHERE tenant_id = $1`, [tenant])).rejects.toThrow(rejected);
    await expect(db.query(`DELETE FROM account_audit_log WHERE tenant_id = $1`, [tenant])).rejects.toThrow(rejected);
  });

  it("DELETE /v1/envelopes/:id de un borrador borra sus eventos y deja envelope.deleted en la auditoría", async () => {
    const draft = await envelopeWithEvents("draft");
    const res = await app.inject({ method: "DELETE", url: `/v1/envelopes/${draft}`, headers });
    expect(res.statusCode).toBe(204);
    expect((await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1`, [draft])).length).toBe(0);
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'envelope.deleted' AND target_id = $2`, [tenant, draft]);
    expect(audit?.data).toEqual({ subject: "Contrato" });
  });
});

describe("verificación pública atada al certificado del PDF", () => {
  async function sealedEnvelope() {
    const { uuidv7, sha256Hex } = await import("../src/lib/util");
    const { appendEvent, SYSTEM } = await import("../src/infra/evidence");
    const { getSealProvider } = await import("../src/infra/seal");
    const { finalizeEnvelopePdf } = await import("@calasign/pdf");
    const env = await envelopeWithEvents("finalizing", 3);
    const head = (await db.one<any>(`SELECT hash FROM envelope_events WHERE envelope_id = $1 ORDER BY seq DESC LIMIT 1`, [env])).hash as string;
    const pdf = await finalizeEnvelopePdf(
      {
        documents: [{ name: "c.pdf", bytes: samplePdf() }],
        fields: [],
        certificate: {
          envelopeId: env,
          subject: "Contrato",
          organizationName: "T",
          senderName: "Ana",
          senderEmail: null,
          createdAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          locale: "es",
          documents: [{ name: "c.pdf", pageCount: 1, sha256: "a".repeat(64) }],
          recipients: [],
          events: [],
          chainHead: head,
        },
      },
      { provider: await getSealProvider(), tsaUrl: null },
    );
    const file = uuidv7();
    const key = `tenants/${tenant}/envelopes/${env}/${file}-signed.pdf`;
    await blobs.put(key, pdf, "application/pdf");
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`, [
      file,
      tenant,
      key,
      pdf.length,
      sha256Hex(pdf),
    ]);
    await db.tx(async (t) => {
      await t.query(`UPDATE envelopes SET status = 'completed', completed_at = now(), signed_file_id = $2 WHERE id = $1`, [env, file]);
      await appendEvent(t, { tenantId: tenant, envelopeId: env, type: "envelope.completed", actor: SYSTEM, data: { signedSha256: sha256Hex(pdf), certificateChainHead: head } });
    });
    return { env, pdf };
  }

  function upload(pdf: Uint8Array) {
    const boundary = "----calasigntest";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(pdf),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: "POST", url: "/v1/verify", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  }

  it("ok con la cadena original; con la cadena reescrita y recalculada en la base, ok:false (certificate_head_mismatch)", async () => {
    const { env, pdf } = await sealedEnvelope();
    const good = (await upload(pdf)).json();
    expect(good.match).toBe(true);
    expect(good.chain).toMatchObject({ ok: true, events: 4 });

    // Alguien con escritura reescribe el primer evento y recalcula toda la cadena (que queda "íntegra").
    const { canonicalJson, sha256Hex } = await import("../src/lib/util");
    const { GENESIS_HASH, verifyChain } = await import("../src/infra/evidence");
    await db.tx(async (t) => {
      await t.query(`SET LOCAL calasign.allow_evidence_write = 'on'`);
      await t.query(`UPDATE envelope_events SET data = '{"i":99}' WHERE envelope_id = $1 AND seq = 1`, [env]);
      const rows = await t.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [env]);
      let prev = GENESIS_HASH;
      for (const r of rows) {
        const body = { seq: r.seq, type: r.type, actor_type: r.actor_type, actor_id: r.actor_id, ip: r.ip, user_agent: r.user_agent, data: r.data, occurred_at: new Date(r.occurred_at).toISOString() };
        const h = sha256Hex(`${prev}\n${canonicalJson(body)}`);
        await t.query(`UPDATE envelope_events SET prev_hash = $2, hash = $3 WHERE id = $1`, [r.id, prev, h]);
        prev = h;
      }
    });
    expect((await verifyChain(db, env)).ok).toBe(true);
    const bad = (await upload(pdf)).json();
    expect(bad.match).toBe(true);
    expect(bad.chain).toMatchObject({ ok: false, reason: "certificate_head_mismatch" });
  }, 60_000);

  it("anchorChain: cadena rota, sin hash del certificado, o el guardado contradice al impreso", async () => {
    const { anchorChain } = await import("../src/modules/verify");
    const rows = [{ hash: "a" }, { hash: "b" }];
    expect(anchorChain({ ok: false, brokenAt: 1, head: "x" }, rows, "a", "a").reason).toBe("chain_broken");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, null, null).reason).toBe("certificate_head_missing");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "a", "b").reason).toBe("certificate_head_mismatch");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, null, "a")).toEqual({ ok: true, head: "b" });
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "c", null).reason).toBe("certificate_head_mismatch");
  });

  it("descargas: el firmante deja document.downloaded (una vez por lapso); el remitente, auditoría", async () => {
    const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
    const { env } = await sealedEnvelope();
    const recipient = uuidv7();
    const token = randomToken();
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, signed_at, access_token_hash, access_token_enc)
       VALUES ($1,$2,$3,'signer','Ana','ana@x.test','completed', now(), $4, $5)`,
      [recipient, tenant, env, sha256Hex(token), encrypt(token)],
    );
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: `/v1/signing/${token}/signed.pdf` })).statusCode).toBe(200);
    const ev = await db.query<any>(`SELECT actor_id, data FROM envelope_events WHERE envelope_id = $1 AND type = 'document.downloaded'`, [env]);
    expect(ev).toEqual([{ actor_id: recipient, data: { kind: "signed", documentId: null } }]);

    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: `/v1/envelopes/${env}/signed.pdf`, headers })).statusCode).toBe(200);
    const audit = await db.query<any>(`SELECT target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'envelope.signed_pdf_downloaded'`, [tenant]);
    expect(audit).toEqual([{ target_id: env }]);
  }, 60_000);
});

describe("auditoría", () => {
  it("un ajuste que el handler ya auditó no se registra dos veces (settings.changed)", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/settings/evidence", headers, payload: { sealLevel: "auto" } });
    expect(res.statusCode).toBe(200);
    const rows = await db.query<any>(`SELECT action FROM account_audit_log WHERE tenant_id = $1 AND action IN ('settings.evidence_updated','settings.changed')`, [tenant]);
    expect(rows.map((r) => r.action)).toEqual(["settings.evidence_updated"]);
  });

  it("CSV: más de 50000 filas se avisa con X-Truncated y una fila final", async () => {
    await db.query(
      `INSERT INTO account_audit_log (tenant_id, actor_type, action) SELECT $1, 'system', 'bulk.test' FROM generate_series(1, 50001)`,
      [tenant],
    );
    const res = await app.inject({ method: "GET", url: "/v1/audit-log.csv?action=bulk.test", headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-truncated"]).toBe("true");
    const lines = res.body.trim().split("\r\n");
    expect(lines.length).toBe(50002);
    expect(lines[lines.length - 1]).toMatch(/TRUNCADO/);
  }, 60_000);
});
