// Topes de las subidas: campos del multipart, PDFs procesándose a la vez (503 pdf_busy), tope de documentos de un
// borrador creado sin enviar y originales borrados por retención en la página del firmante. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-upload-limits-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const KEY = "cs_test_upload_limits_key";
const auth = { authorization: `Bearer ${KEY}` };
let pdf: Uint8Array;

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
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  pdf = minimalPdf();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

function minimalPdf() {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

function multipart(parts: { name: string; value: string | Uint8Array; filename?: string }[]) {
  const b = "----calasignlimits";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head = p.filename
      ? `--${b}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/pdf\r\n\r\n`
      : `--${b}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`;
    chunks.push(Buffer.from(head), Buffer.from(p.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { ...auth, "content-type": `multipart/form-data; boundary=${b}` } };
}

async function draft() {
  const res = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Borrador" } });
  expect(res.statusCode).toBe(201);
  return res.json().envelope.id as string;
}

describe("multipart", () => {
  it("rechaza más campos de texto que el tope global (413)", async () => {
    const id = await draft();
    const fields = Array.from({ length: 20 }, (_, i) => ({ name: `x${i}`, value: "y" }));
    const m = multipart([...fields, { name: "file", value: pdf, filename: "a.pdf" }]);
    const res = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/documents`, ...m });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json().error.code).toBe("FST_FIELDS_LIMIT");
  });

  it("acepta la subida normal y un sobre en un paso con varios documentos (tope propio de partes)", async () => {
    const id = await draft();
    const ok = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/documents`, ...multipart([{ name: "file", value: pdf, filename: "a.pdf" }]) });
    expect(ok.statusCode).toBe(201);
    const docs = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, value: pdf, filename: `d${i}.pdf` }));
    const payload = JSON.stringify({ subject: "Varios", documents: docs.map((d) => ({ file: d.name })) });
    const res = await app.inject({ method: "POST", url: "/v1/envelopes", ...multipart([{ name: "payload", value: payload }, ...docs]) });
    expect(res.statusCode).toBe(201);
    expect(res.json().documents).toHaveLength(10);
  });
});

describe("PDFs procesándose a la vez", () => {
  it("sin lugar: 503 pdf_busy con Retry-After; el sobre se verifica antes de normalizar", async () => {
    const { PDF_INGEST_LIMITS } = await import("@calasign/pdf");
    const saved = { ...PDF_INGEST_LIMITS };
    Object.assign(PDF_INGEST_LIMITS, { maxConcurrent: 0, maxQueue: 0 });
    try {
      const id = await draft();
      const res = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/documents`, ...multipart([{ name: "file", value: pdf, filename: "a.pdf" }]) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("pdf_busy");
      expect(res.headers["retry-after"]).toBe("5");
      // Un sobre que no existe responde 404 sin pedir lugar.
      const missing = await app.inject({
        method: "POST",
        url: `/v1/envelopes/00000000-0000-7000-8000-000000000000/documents`,
        ...multipart([{ name: "file", value: pdf, filename: "a.pdf" }]),
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      Object.assign(PDF_INGEST_LIMITS, saved);
    }
  });
});

describe("tope de documentos sin enviar", () => {
  it("un sobre en un paso con send: false no queda por encima del tope", async () => {
    const { ENVELOPE_LIMITS } = await import("../src/modules/envelopes");
    const saved = ENVELOPE_LIMITS.documents;
    ENVELOPE_LIMITS.documents = 1;
    try {
      const b64 = Buffer.from(pdf).toString("base64");
      const res = await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        headers: auth,
        payload: { subject: "Dos", send: false, documents: [{ base64: b64 }, { base64: b64 }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("too_many_documents");
      const left = await db.query(`SELECT 1 FROM envelopes WHERE tenant_id = $1 AND subject = 'Dos'`, [tenant]);
      expect(left).toHaveLength(0);
    } finally {
      ENVELOPE_LIMITS.documents = saved;
    }
  });
});

describe("original borrado por retención en la página del firmante", () => {
  async function setup(status: string) {
    const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
    const envelope = uuidv7();
    const recipient = uuidv7();
    const token = randomToken();
    const kept = { file: uuidv7(), doc: uuidv7() };
    const gone = { file: uuidv7(), doc: uuidv7() };
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', $3)`, [envelope, tenant, status]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc)
       VALUES ($1,$2,$3,'signer','Ana','ana@x.test','signed',$4,$5)`,
      [recipient, tenant, envelope, sha256Hex(token), encrypt(token)],
    );
    for (const [f, purged, pos] of [[kept, false, 1], [gone, true, 2]] as const) {
      await db.query(
        `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256, purged_at)
         VALUES ($1,$2,'original',$3,'application/pdf',1,'x',$4)`,
        [f.file, tenant, `missing/${f.file}.pdf`, purged ? new Date() : null],
      );
      await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,'d.pdf',$5,1,'[]')`, [
        f.doc,
        tenant,
        envelope,
        pos,
        f.file,
      ]);
    }
    return { token, kept, gone };
  }

  it("410 purged al descargarlo (no un 500) y la sesión no lo lista", async () => {
    const { token, kept, gone } = await setup("completed");
    const res = await app.inject({ method: "GET", url: `/v1/signing/${token}/documents/${gone.doc}/file` });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("purged");
    const session = await app.inject({ method: "GET", url: `/v1/signing/${token}` });
    expect(session.statusCode).toBe(200);
    expect(session.json().documents.map((d: any) => d.id)).toEqual([kept.doc]);
  });
});
