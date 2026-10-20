// Un original guardado antes del saneamiento de PDF puede traer capas ocultas: se sella igual, con /OCProperties en el
// PDF final y la capa apagada (se ve lo mismo que vio el firmante). Un documento que no se puede sellar (InvalidPdfError)
// es un error permanente: no se reintenta, queda envelope.finalize_failed con el código y se avisa al remitente (y a
// propietarios y administradores).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-finalize-invalid-pdf-"));
delete process.env.DATABASE_URL;
// Sin sello de tiempo ni LTV: nada de red.
process.env.TSA_URL = "";
process.env.SEAL_LEVEL = "B-B";

// Para el caso de un documento que no se puede sellar: el próximo sellado lanza este error.
const failing = vi.hoisted(() => ({ next: null as null | (() => Error) }));
vi.mock("@calasign/pdf", async (orig) => {
  const m = await orig<typeof import("@calasign/pdf")>();
  return {
    ...m,
    finalizeEnvelopePdf: vi.fn((...args: Parameters<typeof m.finalizeEnvelopePdf>) => {
      const err = failing.next?.();
      failing.next = null;
      return err ? Promise.reject(err) : m.finalizeEnvelopePdf(...args);
    }),
  };
});

const sent: { to: string; text: string }[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string; text?: string; html?: string }) => {
    sent.push({ to: m.to, text: `${m.text ?? ""}\n${m.html ?? ""}` });
    return { provider: "smtp", messageId: `id-${sent.length}` };
  }),
}));

/** PDF de una página, hecho a mano (sin dependencias), con una capa (OCG) apagada: lo que dibuja no se ve en un lector. */
function hiddenLayerPdf(): Uint8Array {
  const content = "BT /F1 14 Tf 50 780 Td (Contrato) Tj ET\n/OC /oc1 BDC BT /F1 30 Tf 50 500 Td (OCULTO) Tj ET EMC";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /oc1 6 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /OCG /Name (capa) >>",
  ];
  let out = "%PDF-1.5\n";
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

async function setup() {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createJobHandlers } = await import("../src/modules/jobs");
  const { createBlobStore } = await import("../src/infra/storage");
  const { appendEvent, SYSTEM } = await import("../src/infra/evidence");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  const db = await createDb();
  await migrate(db);
  const blobs = createBlobStore();

  /** Sobre en 'finalizing' con el PDF tal cual como original "viejo" (sin pasar por preparePdfUpload). */
  async function envelope(pdf: Uint8Array) {
    const tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
    const sender = uuidv7();
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Ana', 'x')`, [sender, `ana-${sender.slice(-8)}@x.com`]);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`, [tenant, sender]);
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, created_by, locale) VALUES ($1, $2, 'Contrato', 'finalizing', $3, 'es')`, [env, tenant, sender]);
    await appendEvent(db, { tenantId: tenant, envelopeId: env, type: "envelope.created", actor: SYSTEM, data: { subject: "Contrato" } });
    const fileId = uuidv7();
    const key = `tenants/${tenant}/envelopes/${env}/${fileId}.pdf`;
    await blobs.put(key, pdf, "application/pdf");
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)`, [
      fileId,
      tenant,
      key,
      pdf.length,
      sha256Hex(pdf),
    ]);
    await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'c.pdf',$4,1,$5)`, [
      uuidv7(),
      tenant,
      env,
      fileId,
      JSON.stringify([{ width: 600, height: 800 }]),
    ]);
    return { tenant, env, senderEmail: `ana-${sender.slice(-8)}@x.com` };
  }

  const log = { info() {}, warn() {}, error() {} };
  return { db, blobs, envelope, handlers: createJobHandlers({ db, blobs, log }) };
}

describe("finalización de originales viejos", () => {
  it("con capas ocultas: se sella con /OCProperties y la capa apagada en el PDF final", async () => {
    const { db, blobs, envelope, handlers } = await setup();
    const { tenant, env } = await envelope(hiddenLayerPdf());
    await handlers.finalize({ envelopeId: env, tenantId: tenant }, { id: 1, attempts: 1, maxAttempts: 8 });

    const e = await db.one<any>(`SELECT e.status, f.storage_key FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`, [env]);
    expect(e.status).toBe("completed");
    expect(await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.finalize_failed'`, [env])).toHaveLength(0);

    // El PDF final se guarda sin object streams: el catálogo y la página se leen como texto.
    const text = Buffer.from(await blobs.get(e.storage_key)).toString("latin1");
    const layer = /\/oc1 (\d+ 0 R)/.exec(text)?.[1];
    expect(layer).toBeDefined();
    const ocp = /\/OCProperties\s*<<\s*\/OCGs\s*\[\s*(\d+ 0 R)\s*\]\s*\/D\s*<<\s*\/BaseState \/ON\s*\/OFF\s*\[\s*(\d+ 0 R)\s*\]/.exec(text);
    expect(ocp?.slice(1)).toEqual([layer, layer]);
    await db.close();
  }, 180_000);

  it("un documento que no se puede sellar (InvalidPdfError): sin reintentos, finalize_failed con el código y aviso", async () => {
    const { InvalidPdfError } = await import("@calasign/pdf");
    const { db, envelope, handlers } = await setup();
    const { tenant, env, senderEmail } = await envelope(hiddenLayerPdf());
    failing.next = () => new InvalidPdfError("pdf_form_unsupported", "El PDF tiene un formulario cuyos campos no se pueden fijar tal como se ven");
    // Primer intento de 8: no lanza (la cola no lo reintenta) y ya queda registrado el fallo.
    await expect(handlers.finalize({ envelopeId: env, tenantId: tenant }, { id: 1, attempts: 1, maxAttempts: 8 })).resolves.toBeUndefined();

    const failed = await db.query<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.finalize_failed'`, [env]);
    expect(failed).toHaveLength(1);
    expect(failed[0].data.code).toBe("pdf_form_unsupported");
    expect(failed[0].data.error).toMatch(/formulario/);
    expect((await db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [env])).status).toBe("finalizing");

    const jobs = await db.query<any>(`SELECT payload FROM jobs WHERE queue = 'notify' AND payload->>'envelopeId' = $1`, [env]);
    expect(jobs.map((j) => j.payload)).toEqual([{ kind: "finalize_failed", envelopeId: env, tenantId: tenant, reason: "pdf_form_unsupported" }]);

    await handlers.notify(jobs[0].payload, { id: 2, attempts: 1, maxAttempts: 8 });
    expect(sent.map((m) => m.to)).toEqual([senderEmail]);
    expect(sent[0].text).toMatch(/Contrato/);
    await db.close();
  }, 180_000);
});
