// Evidencia append-only en la base (migraciones 0072 y 0074), verificación pública atada al hash del certificado del PDF y
// registro de descargas (firmante: cadena del sobre; remitente: auditoría de la organización). App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-evidence-ao-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
type Blobs = ReturnType<(typeof import("../src/infra/storage"))["createBlobStore"]>;
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
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [
    uuidv7(),
    tenant,
    sha256Hex(KEY),
  ]);
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

  it("un sobre no vuelve a borrador (0074): la excepción de borradores no sirve para borrar evidencia", async () => {
    const env = await envelopeWithEvents("sent");
    await expect(db.query(`UPDATE envelopes SET status = 'draft' WHERE id = $1`, [env])).rejects.toThrow(rejected);
    await expect(db.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [env])).rejects.toThrow(rejected);
    // Otros cambios de estado y de columnas siguen permitidos; un borrador puede seguir siendo borrador.
    await db.query(`UPDATE envelopes SET status = 'voided', subject = 'x' WHERE id = $1`, [env]);
    const draft = await envelopeWithEvents("draft");
    await db.query(`UPDATE envelopes SET status = 'draft', subject = 'y' WHERE id = $1`, [draft]);
    // Mantenimiento explícito.
    await db.tx(async (t) => {
      await t.query(`SET LOCAL calasign.allow_evidence_write = 'on'`);
      await t.query(`UPDATE envelopes SET status = 'draft' WHERE id = $1`, [env]);
    });
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
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'envelope.deleted' AND target_id = $2`, [
      tenant,
      draft,
    ]);
    expect(audit?.data).toEqual({ subject: "Contrato" });
  });
});

describe("verificación pública atada al certificado del PDF", () => {
  async function sealedEnvelope(opts: { legacy?: boolean } = {}) {
    const { uuidv7, sha256Hex } = await import("../src/lib/util");
    const { appendEvent, SYSTEM } = await import("../src/infra/evidence");
    const { getSealProvider } = await import("../src/infra/seal");
    const { finalizeEnvelopePdf } = await import("@calasign/pdf");
    const env = await envelopeWithEvents("finalizing", 3);
    const head = (await db.one<any>(`SELECT hash FROM envelope_events WHERE envelope_id = $1 ORDER BY seq DESC LIMIT 1`, [env])).hash as string;
    let pdf = await finalizeEnvelopePdf(
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
    if (opts.legacy) {
      // PDF sellado antes de que finalize.ts escribiera la Keyword: el hash solo está impreso en el certificado.
      // (Se rompe el prefijo dentro del string hex UTF-16BE de /Keywords, mismo largo: "c" → "x".)
      const buf = Buffer.from(pdf);
      const hex = (t: string) => Buffer.from(t, "utf16le").swap16().toString("hex").toUpperCase();
      const at = buf.indexOf(hex("calasign-chain-head:"), 0, "latin1");
      expect(at).toBeGreaterThan(0);
      buf.write(hex("x"), at, "latin1");
      pdf = new Uint8Array(buf);
    }
    const file = uuidv7();
    const key = `tenants/${tenant}/envelopes/${env}/${file}-signed.pdf`;
    await blobs.put(key, pdf, "application/pdf");
    await db.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
      [file, tenant, key, pdf.length, sha256Hex(pdf)],
    );
    await db.tx(async (t) => {
      await t.query(`UPDATE envelopes SET status = 'completed', completed_at = now(), signed_file_id = $2 WHERE id = $1`, [env, file]);
      await appendEvent(t, {
        tenantId: tenant,
        envelopeId: env,
        type: "envelope.completed",
        actor: SYSTEM,
        data: { signedSha256: sha256Hex(pdf), certificateChainHead: head },
      });
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

  /** Quien tiene escritura en la base reescribe el primer evento y recalcula toda la cadena (que queda "íntegra"). */
  async function rewriteChain(env: string): Promise<string> {
    const { canonicalJson, sha256Hex } = await import("../src/lib/util");
    const { GENESIS_HASH } = await import("../src/infra/evidence");
    let prev = GENESIS_HASH;
    await db.tx(async (t) => {
      await t.query(`SET LOCAL calasign.allow_evidence_write = 'on'`);
      await t.query(`UPDATE envelope_events SET data = '{"i":99}' WHERE envelope_id = $1 AND seq = 1`, [env]);
      const rows = await t.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [env]);
      for (const r of rows) {
        const body = {
          seq: r.seq,
          type: r.type,
          actor_type: r.actor_type,
          actor_id: r.actor_id,
          ip: r.ip,
          user_agent: r.user_agent,
          data: r.data,
          occurred_at: new Date(r.occurred_at).toISOString(),
        };
        const h = sha256Hex(`${prev}\n${canonicalJson(body)}`);
        await t.query(`UPDATE envelope_events SET prev_hash = $2, hash = $3 WHERE id = $1`, [r.id, prev, h]);
        prev = h;
      }
    });
    return prev;
  }

  it("ok con la cadena original; con la cadena reescrita y recalculada en la base, ok:false (certificate_head_mismatch)", async () => {
    const { env, pdf } = await sealedEnvelope();
    const good = (await upload(pdf)).json();
    expect(good.match).toBe(true);
    expect(good.chain).toMatchObject({ ok: true, events: 4 });

    // Alguien con escritura reescribe el primer evento y recalcula toda la cadena (que queda "íntegra").
    const { verifyChain } = await import("../src/infra/evidence");
    await rewriteChain(env);
    expect((await verifyChain(db, env)).ok).toBe(true);
    const bad = (await upload(pdf)).json();
    expect(bad.match).toBe(true);
    expect(bad.chain).toMatchObject({ ok: false, reason: "certificate_head_mismatch" });
  }, 60_000);

  it("el ancla sale de los bytes del PDF: reescribir eventos, envelope.completed y files.chain_head en la base no alcanza", async () => {
    const { sha256Hex } = await import("../src/lib/util");
    const { verifyChain } = await import("../src/infra/evidence");
    const { env, pdf } = await sealedEnvelope();
    const head = await rewriteChain(env);
    expect((await verifyChain(db, env)).ok).toBe(true);
    // También el hash guardado en envelope.completed (el último evento: se recalcula después) y la cache del archivo.
    await db.tx(async (t) => {
      await t.query(`SET LOCAL calasign.allow_evidence_write = 'on'`);
      await t.query(
        `UPDATE envelope_events SET data = jsonb_set(data, '{certificateChainHead}', to_jsonb($2::text)) WHERE envelope_id = $1 AND type = 'envelope.completed'`,
        [env, head],
      );
    });
    const newHead = await rewriteChain(env);
    await db.query(`UPDATE files SET chain_head = $2 WHERE sha256 = $1`, [sha256Hex(pdf), newHead]);
    const res = (await upload(pdf)).json();
    expect(res.match).toBe(true);
    expect(res.chain).toMatchObject({ ok: false, reason: "certificate_head_mismatch" });
  }, 60_000);

  it("files.chain_head: con Keyword en el PDF no se usa ni se escribe; solo NULL → valor (trigger)", async () => {
    const { sha256Hex } = await import("../src/lib/util");
    const { pdf } = await sealedEnvelope();
    const file = () => db.one<any>(`SELECT id, chain_head FROM files WHERE sha256 = $1`, [sha256Hex(pdf)]);
    expect((await upload(pdf)).json().chain).toMatchObject({ ok: true });
    expect((await file()).chain_head).toBeNull();
    // Una cache que contradice a la Keyword del PDF: mismatch.
    await db.query(`UPDATE files SET chain_head = $2 WHERE id = $1`, [(await file()).id, "f".repeat(64)]);
    expect((await upload(pdf)).json().chain).toMatchObject({ ok: false, reason: "certificate_head_mismatch" });
    // Una vez fijada no cambia.
    await expect(db.query(`UPDATE files SET chain_head = $2 WHERE id = $1`, [(await file()).id, "e".repeat(64)])).rejects.toThrow(
      /evidence_append_only/,
    );
    await expect(db.query(`UPDATE files SET chain_head = NULL WHERE id = $1`, [(await file()).id])).rejects.toThrow(/evidence_append_only/);
  }, 60_000);

  it("PDF sin Keyword (anterior): se lee una vez con pdf.js y se guarda; después se usa la cache", async () => {
    const { sha256Hex } = await import("../src/lib/util");
    const { env, pdf } = await sealedEnvelope({ legacy: true });
    const { findChainHeadKeyword } = await import("@calasign/pdf");
    expect(findChainHeadKeyword(pdf)).toBeNull();
    const head = (
      await db.one<any>(`SELECT data->>'certificateChainHead' AS h FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.completed'`, [
        env,
      ])
    ).h;
    const file = () => db.one<any>(`SELECT id, chain_head FROM files WHERE sha256 = $1`, [sha256Hex(pdf)]);
    expect((await file()).chain_head).toBeNull();
    expect((await upload(pdf)).json().chain).toMatchObject({ ok: true });
    expect((await file()).chain_head).toBe(head);
    expect((await upload(pdf)).json().chain).toMatchObject({ ok: true });
  }, 60_000);

  it("printedChainHead: un error al leer el PDF no se guarda como '' (no es 'no lo trae')", async () => {
    const { printedChainHead } = await import("../src/modules/verify");
    const calls: unknown[] = [];
    const fake = { db: { query: async (...args: unknown[]) => (calls.push(args), []) } } as any;
    expect(await printedChainHead(fake, "f1", null, Buffer.from("no es un pdf"))).toEqual({ head: null, cached: null });
    expect(calls).toEqual([]);
  }, 60_000);

  it("certificado: IP de la última apertura anterior a la firma (si no hay, la última)", async () => {
    const { certificateViewIp } = await import("../src/modules/jobs");
    const v = (actor: string, at: string, ip: string) => ({ type: "recipient.viewed", actor_id: actor, occurred_at: at, ip });
    const events = [
      v("r1", "2026-01-01T10:00:00Z", "1.1.1.1"),
      v("r2", "2026-01-01T10:30:00Z", "9.9.9.9"),
      v("r1", "2026-01-02T10:00:00Z", "2.2.2.2"),
      v("r1", "2026-01-05T10:00:00Z", "3.3.3.3"),
    ];
    expect(certificateViewIp(events, "r1", "2026-01-03T00:00:00Z")).toBe("2.2.2.2");
    expect(certificateViewIp(events, "r1", null)).toBe("3.3.3.3");
    expect(certificateViewIp(events, "r1", "2025-12-31T00:00:00Z")).toBe("3.3.3.3");
    expect(certificateViewIp(events, "r3", null)).toBeNull();
  });

  it("anchorChain: cadena rota, sin hash del certificado, o el guardado contradice al impreso", async () => {
    const { anchorChain } = await import("../src/modules/verify");
    const rows = [{ hash: "a" }, { hash: "b" }];
    expect(anchorChain({ ok: false, brokenAt: 1, head: "x" }, rows, "a", "a").reason).toBe("chain_broken");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, null, null).reason).toBe("certificate_head_missing");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "a", "b").reason).toBe("certificate_head_mismatch");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, null, "a")).toEqual({ ok: true, head: "b" });
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "c", null).reason).toBe("certificate_head_mismatch");
    // La cache del archivo (files.chain_head) tampoco puede contradecir al PDF.
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "a", "a", "b").reason).toBe("certificate_head_mismatch");
    expect(anchorChain({ ok: true, brokenAt: null, head: "b" }, rows, "a", "a", "a")).toEqual({ ok: true, head: "b" });
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

    // El documento: el visor (sin ?download=1) no es una descarga; el botón (?download=1) sí.
    const doc = uuidv7();
    const fileId = (await db.one<any>(`SELECT signed_file_id FROM envelopes WHERE id = $1`, [env])).signed_file_id;
    await db.query(
      `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'d.pdf',$4,1,'[]')`,
      [doc, tenant, env, fileId],
    );
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}/documents/${doc}/file` })).statusCode).toBe(200);
    const kinds = async () =>
      (await db.query<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'document.downloaded' ORDER BY seq`, [env])).map(
        (r) => r.data.kind,
      );
    expect(await kinds()).toEqual(["signed"]);
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}/documents/${doc}/file?download=1` })).statusCode).toBe(200);
    expect(await kinds()).toEqual(["signed", "document"]);

    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: `/v1/envelopes/${env}/signed.pdf`, headers })).statusCode).toBe(200);
    const audit = await db.query<any>(`SELECT target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'envelope.signed_pdf_downloaded'`, [
      tenant,
    ]);
    expect(audit).toEqual([{ target_id: env }]);
  }, 60_000);
});

describe("fecha de firma", () => {
  it("se guarda sin zona (como antes) y se estampa con ' UTC'", async () => {
    const { formatSigningDate, signingDateForDisplay } = await import("@calasign/shared");
    const { toStampFields } = await import("../src/modules/stamp-fields");
    const d = new Date("2026-03-04T23:30:00Z");
    expect(formatSigningDate(d, "es")).toBe("04/03/2026");
    expect(formatSigningDate(d, "en")).toBe("2026-03-04");
    expect(signingDateForDisplay("04/03/2026")).toBe("04/03/2026 UTC");
    expect(signingDateForDisplay("04/03/2026 UTC")).toBe("04/03/2026 UTC");
    const base = { document_id: "d", page: 0, x: 0, y: 0, width: 10, height: 10, recipient_id: "r" };
    const out = toStampFields(
      [
        { ...base, type: "date_signed", value: "04/03/2026", read_only: false },
        { ...base, type: "date_signed", value: "1 de marzo", read_only: true },
        { ...base, type: "text", value: "04/03/2026", read_only: false },
      ],
      [{ id: "d" }],
      new Map(),
      "UTC",
    );
    expect(out.map((f) => f.value)).toEqual(["04/03/2026 UTC", "1 de marzo", "04/03/2026"]);
  });

  it("en el huso de la organización: la fecha es la de ese huso y se estampa con su desfase", async () => {
    const { formatSigningDate, signingDateForDisplay } = await import("@calasign/shared");
    const { toStampFields } = await import("../src/modules/stamp-fields");
    const tz = "America/Argentina/Buenos_Aires";
    // 23:30 UTC del 4 de marzo: en Buenos Aires (UTC−03:00) todavía son las 20:30 del 4; a la 01:30 UTC del 5, las
    // 22:30 del 4. La fecha UTC sería el 5: con el huso de la organización, sigue siendo el 4.
    expect(formatSigningDate(new Date("2026-03-04T23:30:00Z"), "es", tz)).toBe("04/03/2026");
    expect(formatSigningDate(new Date("2026-03-05T01:30:00Z"), "es", tz)).toBe("04/03/2026");
    expect(formatSigningDate(new Date("2026-03-05T01:30:00Z"), "es")).toBe("05/03/2026");
    expect(signingDateForDisplay("04/03/2026", tz)).toBe("04/03/2026 UTC−03:00");
    expect(signingDateForDisplay("04/03/2026 UTC−03:00", tz)).toBe("04/03/2026 UTC−03:00");
    const base = { document_id: "d", page: 0, x: 0, y: 0, width: 10, height: 10, recipient_id: "r" };
    const out = toStampFields([{ ...base, type: "date_signed", value: "04/03/2026", read_only: false }], [{ id: "d" }], new Map(), tz);
    expect(out[0].value).toBe("04/03/2026 UTC−03:00");
  });

  it("el desfase es el del día de la firma y el huso, el que registró su evento (no los del sellado)", async () => {
    const { toStampFields } = await import("../src/modules/stamp-fields");
    const base = { document_id: "d", page: 0, x: 0, y: 0, width: 10, height: 10, read_only: false, type: "date_signed" };
    const out = toStampFields(
      [
        { ...base, recipient_id: "ny", value: "2026-01-15" },
        { ...base, recipient_id: "ba", value: "15/01/2026" },
        { ...base, recipient_id: "viejo", value: "15/01/2026" },
        { ...base, recipient_id: "ventana", value: "15/07/2027" },
      ],
      [{ id: "d" }],
      new Map(),
      // Huso actual de la organización: en julio Nueva York está en horario de verano (UTC−04:00).
      "America/New_York",
      new Map([
        // Firmó en enero en Nueva York: UTC−05:00, aunque el sellado sea en julio (UTC−04:00).
        ["ny", { at: new Date("2026-01-15T15:00:00Z"), timeZone: "America/New_York" }],
        // La organización estaba en Buenos Aires cuando firmó y después cambió de huso.
        ["ba", { at: new Date("2026-01-15T15:00:00Z"), timeZone: "America/Argentina/Buenos_Aires" }],
        // Firmado antes de que la fecha se escribiera en el huso de la organización (y sin huso en el evento): UTC.
        ["viejo", { at: new Date("2026-07-15T15:00:00Z"), timeZone: null }],
        // Firmado después, pero antes de que el evento registrara el huso: el actual de la organización, en ese día.
        ["ventana", { at: new Date("2027-07-15T15:00:00Z"), timeZone: null }],
      ]),
    );
    expect(out.map((f) => f.value)).toEqual(["2026-01-15 UTC−05:00", "15/01/2026 UTC−03:00", "15/01/2026 UTC", "15/07/2027 UTC−04:00"]);
  });
});

describe("auditoría", () => {
  it("un ajuste que el handler ya auditó no se registra dos veces (settings.changed)", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/settings/evidence", headers, payload: { sealLevel: "auto" } });
    expect(res.statusCode).toBe(200);
    const rows = await db.query<any>(
      `SELECT action FROM account_audit_log WHERE tenant_id = $1 AND action IN ('settings.evidence_updated','settings.changed')`,
      [tenant],
    );
    expect(rows.map((r) => r.action)).toEqual(["settings.evidence_updated"]);
  });

  it("CSV: más de 50000 filas se avisa con X-Truncated y una fila final", async () => {
    await db.query(`INSERT INTO account_audit_log (tenant_id, actor_type, action) SELECT $1, 'system', 'bulk.test' FROM generate_series(1, 50001)`, [
      tenant,
    ]);
    const res = await app.inject({ method: "GET", url: "/v1/audit-log.csv?action=bulk.test", headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-truncated"]).toBe("true");
    const lines = res.body.trim().split("\r\n");
    expect(lines.length).toBe(50002);
    expect(lines[lines.length - 1]).toMatch(/TRUNCADO/);
    // Las 50001 filas tienen el mismo occurred_at: continuar con beforeId trae exactamente la que faltó (con "to=<fecha>"
    // se repetían todas o se perdía esa).
    const next = res.headers["x-next-before-id"];
    expect(lines[lines.length - 1]).toContain(`beforeId=${next}`);
    const rest = await app.inject({ method: "GET", url: `/v1/audit-log.csv?action=bulk.test&beforeId=${next}`, headers });
    expect(rest.statusCode).toBe(200);
    expect(rest.headers["x-truncated"]).toBeUndefined();
    // Cada parte con su propio nombre de archivo (la primera sin sufijo, la continuación con "-desde-<beforeId>").
    expect(res.headers["content-disposition"]).toMatch(/filename="auditoria-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(rest.headers["content-disposition"]).toMatch(new RegExp(`filename="auditoria-\\d{4}-\\d{2}-\\d{2}-desde-${next}\\.csv"`));
    const restLines = rest.body.trim().split("\r\n");
    expect(restLines.length).toBe(2);
    const idOf = (l: string) => Number(l.split(",")[0].replace(/"/g, ""));
    const ids = new Set([...lines.slice(1, -1), ...restLines.slice(1)].map(idOf));
    expect(ids.size).toBe(50001);
    const all = await db.query<any>(`SELECT id FROM account_audit_log WHERE tenant_id = $1 AND action = 'bulk.test'`, [tenant]);
    expect(all.every((r) => ids.has(Number(r.id)))).toBe(true);
    // beforeId inválido o de otra organización: 400.
    expect((await app.inject({ method: "GET", url: `/v1/audit-log.csv?beforeId=abc`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/audit-log.csv?beforeId=999999999`, headers })).statusCode).toBe(400);
  }, 60_000);
});
