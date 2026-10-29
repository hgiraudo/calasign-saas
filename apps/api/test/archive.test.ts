// Renovación de sellos de archivo (B-LTA) con la PKI de laboratorio (OCSP/CRL/TSA locales).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLab, type LabPki, type LabServer } from "@calasign/pdf/lab";

let pki: LabPki;
let server: LabServer;

beforeAll(async () => {
  ({ pki, server } = await startLab());
  const dir = mkdtempSync(join(tmpdir(), "calasign-archive-"));
  mkdirSync(join(dir, "trust"));
  writeFileSync(join(dir, "seal.key.pem"), pki.seal.keyPem);
  writeFileSync(join(dir, "seal.chain.pem"), pki.sealChainPem);
  writeFileSync(join(dir, "trust", "root.pem"), pki.root.certPem);
  Object.assign(process.env, {
    DATA_DIR: join(dir, "data"),
    TSA_URL: `${server.url}/tsr`,
    SEAL_KEY_FILE: join(dir, "seal.key.pem"),
    SEAL_CHAIN_FILE: join(dir, "seal.chain.pem"),
    TRUST_STORE_DIR: join(dir, "trust"),
    ARCHIVE_RENEWAL_MIN_INTERVAL_DAYS: "30",
  });
}, 60_000);
afterAll(async () => server?.close());

/** PDF mínimo de una página, hecho a mano (sin dependencias). */
async function samplePdf() {
  const content = "BT /F1 14 Tf 50 780 Td (Contrato para archivo) Tj ET";
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

describe("renovación de sellos de archivo", () => {
  it("agrega DSS + sello de documento nuevo, guarda la versión y deja el historial", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { createBlobStore } = await import("../src/infra/storage");
    const { getSealProvider } = await import("../src/infra/seal");
    const { archiveSweep, archiveInfo } = await import("../src/modules/data/archive");
    const { applyLtv, archiveTimestampInfo, finalizeEnvelopePdf, validatePdf } = await import("@calasign/pdf");
    const { uuidv7, sha256Hex } = await import("../src/lib/util");

    const db = await createDb();
    await migrate(db);
    const blobs = createBlobStore();
    const log = { info() {}, warn() {}, error() {} };
    const provider = await getSealProvider();
    const tsaUrl = `${server.url}/tsr`;

    // PDF final como lo deja un sobre completado con nivel B-LTA.
    const sealed = await finalizeEnvelopePdf(
      {
        documents: [{ name: "c.pdf", bytes: await samplePdf() }],
        fields: [],
        certificate: {
          envelopeId: "0192f0e0-0000-7000-8000-0000000000aa",
          subject: "Contrato",
          organizationName: "ACME",
          senderName: "Ana",
          senderEmail: null,
          createdAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          locale: "es",
          documents: [{ name: "c.pdf", pageCount: 1, sha256: "a".repeat(64) }],
          recipients: [],
          events: [],
          chainHead: "c".repeat(64),
        },
      },
      { provider, tsaUrl },
    );
    const anchors = [pki.root.certDer];
    const lta = (await applyLtv(sealed, { level: "B-LTA", tsaUrl, extraCerts: anchors })).pdf;
    const before = await archiveTimestampInfo(lta);
    expect(before.hasDss).toBe(true);
    expect(before.documentTimestamps).toBe(1);
    expect(before.last?.kind).toBe("document_timestamp");

    const tenant = uuidv7();
    const env = uuidv7();
    const file = uuidv7();
    const key = `tenants/${tenant}/envelopes/${env}/${file}-signed.pdf`;
    await blobs.put(key, lta, "application/pdf");
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'T')`, [tenant, `t-${tenant.slice(-6)}`]);
    await db.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
      [file, tenant, key, lta.length, sha256Hex(lta)],
    );
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id) VALUES ($1,$2,'S','completed', now(), $3)`, [
      env,
      tenant,
      file,
    ]);

    // El certificado de la TSA de laboratorio vence en ~2 años: con un umbral de 1 día no se renueva…
    const quiet = await archiveSweep({ db, blobs, log }, { days: 1, force: true });
    expect(quiet).toMatchObject({ inspected: 1, renewed: 0, failed: 0 });
    let info = await archiveInfo(db, env);
    expect(info.validUntil).toBe(before.last!.tsaNotAfter);
    expect(info.versions).toHaveLength(1);

    // …con un umbral que lo alcanza, sí.
    const run = await archiveSweep({ db, blobs, log }, { days: 2000, force: true });
    expect(run).toMatchObject({ renewed: 1, failed: 0 });
    info = await archiveInfo(db, env);
    expect(info.renewals).toBe(1);
    expect(info.versions.map((v) => v.reason)).toEqual(["completed", "archive_renewal"]);
    expect(info.versions[0].sha256).toBe(sha256Hex(lta));

    const e = await db.one<any>(`SELECT f.storage_key, f.sha256 FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`, [env]);
    expect(e.sha256).toBe(info.versions[1].sha256);
    const renewed = await blobs.get(e.storage_key);
    const after = await archiveTimestampInfo(renewed);
    expect(after.documentTimestamps).toBe(2);
    const report = await validatePdf(renewed, { trustAnchors: anchors });
    expect(report.signatures.every((s) => s.integrity.valid)).toBe(true);
    expect(report.signatures.filter((s) => s.kind === "document_timestamp")).toHaveLength(2);
    expect(report.summary.allTrusted).toBe(true);
    // La versión anterior sigue guardada y encontrable por hash (/v1/verify).
    expect(await blobs.get(key)).toEqual(lta);
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.archive_renewed'`, [env]);
    expect(ev.data).toMatchObject({ version: 2, previousSha256: sha256Hex(lta), signedSha256: e.sha256 });

    // No se vuelve a renovar antes del intervalo mínimo (sin forzar) y el barrido normal está limitado a 1 por hora.
    const again = await archiveSweep({ db, blobs, log }, { days: 2000 });
    expect(again.renewed).toBe(0);

    // Pasado el intervalo mínimo: el último sello ya es del certificado que la TSA usa hoy, así que "renovar" no
    // extendería nada. El barrido consulta ese certificado y saltea el sobre (antes renovaba cada 30 días).
    const { resetArchiveSweepClock } = await import("../src/modules/data/archive");
    // El intervalo se mide desde la última renovación exitosa (archive_renewed_at), no desde el último chequeo.
    expect((await db.one<any>(`SELECT archive_renewed_at IS NOT NULL AS ok FROM envelopes WHERE id = $1`, [env])).ok).toBe(true);
    await db.query(
      `UPDATE envelopes SET archive_renewed_at = now() - interval '31 days', archive_checked_at = now() - interval '31 days', archive_error = NULL WHERE id = $1`,
      [env],
    );
    resetArchiveSweepClock();
    const sameTsa = await archiveSweep({ db, blobs, log }, { days: 2000 });
    expect(sameTsa).toMatchObject({ renewed: 0, failed: 0, notExtendable: 1 });
    expect((await archiveInfo(db, env)).renewals).toBe(1);
    // Queda a la vista que renovar no sirve con esta TSA (y se avisa una vez a la organización).
    expect((await archiveInfo(db, env)).errorCode).toBe("tsa_cannot_extend");
    expect(await db.query(`SELECT kind FROM tenant_alerts WHERE tenant_id = $1`, [tenant])).toEqual([{ kind: "archive_tsa_cannot_extend" }]);
    await db.query(`UPDATE envelopes SET archive_error = NULL WHERE id = $1`, [env]);

    // El tope de renovaciones también vale para el barrido (aun forzado).
    await db.query(`UPDATE envelopes SET archive_renewals = 50 WHERE id = $1`, [env]);
    expect((await archiveSweep({ db, blobs, log }, { days: 2000, force: true, envelopeId: env })).renewed).toBe(0);

    // B-T con "LTV pendiente" que se completa: la versión original (sin DSS) no tenía vigencia de archivo.
    const bt = uuidv7();
    const btFile = uuidv7();
    const btKey = `tenants/${tenant}/envelopes/${bt}/${btFile}-signed.pdf`;
    await blobs.put(btKey, sealed, "application/pdf");
    await db.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
      [btFile, tenant, btKey, sealed.length, sha256Hex(sealed)],
    );
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id, archive_checked_at, archive_error)
       VALUES ($1,$2,'S','completed', now(), $3, now(), 'LTV pendiente')`,
      [bt, tenant, btFile],
    );
    expect((await archiveSweep({ db, blobs, log }, { force: true, envelopeId: bt })).renewed).toBe(1);
    const btInfo = await archiveInfo(db, bt);
    expect(btInfo.versions.map((v) => [v.reason, v.validUntil === null])).toEqual([
      ["completed", true],
      ["archive_renewal", false],
    ]);

    // El PDF cambia mientras se renueva (otra renovación ganó): archive_changed no es una falla del sobre en el barrido.
    const ch = uuidv7();
    const chFile = uuidv7();
    const chKey = `tenants/${tenant}/envelopes/${ch}/${chFile}-signed.pdf`;
    await blobs.put(chKey, lta, "application/pdf");
    await db.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
      [chFile, tenant, chKey, lta.length, sha256Hex(lta)],
    );
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id, archive_valid_until, archive_checked_at)
       VALUES ($1,$2,'S','completed', now(), $3, now() + interval '10 days', now())`,
      [ch, tenant, chFile],
    );
    const racing = {
      ...blobs,
      get: (k: string) => blobs.get(k),
      put: async (k: string, b: Uint8Array, ct: string) => {
        await blobs.put(k, b, ct);
        // Justo antes de la transacción que guarda la versión renovada, otra ya cambió el PDF del sobre.
        await db.query(`UPDATE envelopes SET signed_file_id = $2 WHERE id = $1`, [ch, file]);
      },
      delete: (k: string) => blobs.delete(k),
    } as typeof blobs;
    const raced = await archiveSweep({ db, blobs: racing, log }, { days: 2000, force: true, envelopeId: ch });
    expect(raced).toMatchObject({ renewed: 0, failed: 0 });
    expect((await archiveInfo(db, ch)).error).toBeNull();
  }, 120_000);
});
