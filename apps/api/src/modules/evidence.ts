// Rutas de evidencia fuerte: nivel PAdES, certificados de la organización, firma XML, sello de empresa,
// validación pública de PDF y conectores de firma (CSC v2).
import { createPublicKey, createVerify, randomBytes, X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { signXml, verifyXml } from "@calasign/xades";
import { validatePdf, sha256 as sha256Bytes } from "@calasign/pdf";
import {
  SealOptionsInput,
  UpdateEvidenceSettingsInput,
  UploadCertificateInput,
  XmlSignInput,
  XmlVerifyInput,
  type EvidenceSettings,
  type PdfValidationResponse,
  type SealOptions,
  type SignatureProviderTestResult,
  type XmlSignResponse,
} from "@calasign/shared";
import { config } from "../config";
import { appendEvent } from "../infra/evidence";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { sha256Hex, uuidv7 } from "../lib/util";
import { auditFromRequest } from "./audit";
import { authenticate, type Services } from "./context";
import { loadTenantCertificate, parseP12, sealKey, tenantCertificateProvider, toTenantCertificate } from "./custody";
import { byokForCustody } from "./data/byok";
import { lockEnvelope } from "./envelopes";
import { getCscProvider, guardedFetch, listSignatureProviders, resolveSealLevel, trustAnchors } from "./evidence-seal";

export async function evidenceRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  // ───────── Nivel PAdES de la organización ─────────

  const evidenceSettings = async (tenantId: string): Promise<EvidenceSettings> => {
    const t = await s.db.one<any>(`SELECT seal_level FROM tenants WHERE id = $1`, [tenantId]);
    return { sealLevel: t?.seal_level ?? "auto", effectiveLevel: await resolveSealLevel(s.db, tenantId), tsaConfigured: Boolean(config.seal.tsaUrl) };
  };

  app.get("/v1/settings/evidence", { preHandler: auth }, async (req) => evidenceSettings(req.auth!.tenantId));

  app.patch("/v1/settings/evidence", { preHandler: auth }, async (req) => {
    const input = UpdateEvidenceSettingsInput.parse(req.body);
    await s.db.query(`UPDATE tenants SET seal_level = $2 WHERE id = $1`, [req.auth!.tenantId, input.sealLevel]);
    await auditFromRequest(s.db, req, req.auth!, "settings.evidence_updated", { data: { sealLevel: input.sealLevel } });
    return evidenceSettings(req.auth!.tenantId);
  });

  // ───────── Certificados de la organización ─────────

  app.get("/v1/certificates", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM tenant_certificates WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [req.auth!.tenantId]);
    return { items: rows.map(toTenantCertificate) };
  });

  app.post("/v1/certificates", { preHandler: auth, bodyLimit: 3 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = UploadCertificateInput.parse(req.body);
    const parsed = parseP12(Buffer.from(input.p12Base64, "base64"), input.password);
    if (new Date(parsed.leaf.validTo) < new Date()) throw badRequest("certificate_expired", "El certificado está vencido");
    const sealed = await sealKey(parsed.keyPkcs8Pem, await byokForCustody(s.db, req.auth!.tenantId));
    const leaf = parsed.leaf;
    const id = uuidv7();
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(leaf.subject)?.[1] ?? null;
    const row = await s.db.one(
      `INSERT INTO tenant_certificates (id, tenant_id, name, subject, issuer, common_name, serial_number, not_before, not_after, sha256,
         key_algorithm, chain_pem, key_ciphertext, key_wrapped, key_wrap_method, usages, created_by, key_wrap_key_arn)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        id,
        req.auth!.tenantId,
        input.name,
        leaf.subject.replace(/\n/g, ", "),
        leaf.issuer.replace(/\n/g, ", "),
        cn,
        leaf.serialNumber.toLowerCase(),
        new Date(leaf.validFrom).toISOString(),
        new Date(leaf.validTo).toISOString(),
        leaf.fingerprint256.replace(/:/g, "").toLowerCase(),
        parsed.keyAlgorithm,
        parsed.chainPem,
        sealed.ciphertext,
        sealed.wrapped,
        sealed.method,
        input.usages ?? ["xml", "pdf_seal"],
        req.auth!.userId,
        sealed.keyArn ?? null,
      ],
    );
    await auditFromRequest(s.db, req, req.auth!, "certificate.uploaded", {
      targetType: "certificate",
      targetId: id,
      data: { name: input.name, subject: leaf.subject.replace(/\n/g, ", "), serialNumber: leaf.serialNumber, keyWrap: sealed.method },
    });
    reply.code(201);
    return { certificate: toTenantCertificate(row) };
  });

  app.delete<{ Params: { id: string } }>("/v1/certificates/:id", { preHandler: auth }, async (req, reply) => {
    // Un sobre que ya se está cerrando con sello de empresa necesita la clave: borrarla lo dejaría trabado. Se bloquean
    // los sobres que lo usan (el pase sent → finalizing toma el mismo lock), así ninguno empieza a finalizar en el medio.
    const r = await s.db.tx(async (t) => {
      const users = await t.query<any>(
        `SELECT id, status FROM envelopes WHERE company_seal_certificate_id = $1 AND tenant_id = $2
           AND status IN ('draft','sent','finalizing','awaiting_certificates') FOR UPDATE`,
        [req.params.id, req.auth!.tenantId],
      );
      const closing = users.filter((x) => x.status === "finalizing" || x.status === "awaiting_certificates").length;
      if (closing) throw conflict("certificate_in_use", `El certificado sella ${closing} sobre(s) que se están finalizando: esperá a que terminen`);
      // Borrado lógico; el material de clave se elimina de inmediato.
      const del = await t.query<any>(
        `UPDATE tenant_certificates SET deleted_at = now(), key_ciphertext = NULL, key_wrapped = NULL
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id, name`,
        [req.params.id, req.auth!.tenantId],
      );
      if (!del.length) throw notFound("Certificado");
      await t.query(`UPDATE envelopes SET company_seal_certificate_id = NULL WHERE company_seal_certificate_id = $1 AND status IN ('draft','sent')`, [req.params.id]);
      return del;
    });
    await auditFromRequest(s.db, req, req.auth!, "certificate.deleted", { targetType: "certificate", targetId: req.params.id, data: { name: r[0].name } });
    return reply.code(204).send();
  });

  // ───────── Firma XML (facturación electrónica) ─────────

  app.post("/v1/xml/sign", { preHandler: auth, bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const input = XmlSignInput.parse(req.body);
    const row = await loadTenantCertificate(s.db, req.auth!.tenantId, input.certificateId, "xml");
    const provider = await tenantCertificateProvider(s.db, row);
    let signedXml: string;
    try {
      signedXml = await signXml(input.xml, provider, {
        profile: input.profile,
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.signerRole !== undefined ? { signerRole: input.signerRole } : {}),
        ...(input.signatureAlgorithm ? { signatureAlgorithm: input.signatureAlgorithm } : {}),
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw badRequest("xml_sign_failed", `No se pudo firmar el XML: ${(e as Error).message}`);
    }
    const verification = verifyXml(signedXml);
    const sha256 = sha256Hex(signedXml);
    await auditFromRequest(s.db, req, req.auth!, "certificate.used", {
      targetType: "certificate",
      targetId: row.id,
      data: { purpose: "xml_sign", profile: input.profile, inputSha256: sha256Hex(input.xml), outputSha256: sha256, valid: verification.valid },
    });
    const res: XmlSignResponse = { signedXml, sha256, verification };
    return res;
  });

  app.post("/v1/xml/verify", { preHandler: auth, bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const input = XmlVerifyInput.parse(req.body);
    return verifyXml(input.xml);
  });

  // ───────── Sello de empresa y nivel de firma del sobre ─────────

  const sealOptions = async (tenantId: string, envelopeId: string): Promise<SealOptions> => {
    const e = await s.db.one<any>(
      `SELECT e.company_seal_certificate_id, e.signature_level, c.name, c.common_name
       FROM envelopes e LEFT JOIN tenant_certificates c ON c.id = e.company_seal_certificate_id
       WHERE e.id = $1 AND e.tenant_id = $2`,
      [envelopeId, tenantId],
    );
    if (!e) throw notFound("Sobre");
    return {
      companySealCertificateId: e.company_seal_certificate_id,
      companySeal: e.company_seal_certificate_id ? { name: e.name, commonName: e.common_name } : null,
      signatureLevel: e.signature_level,
    };
  };

  app.get<{ Params: { id: string } }>("/v1/envelopes/:id/seal-options", { preHandler: auth }, async (req) => sealOptions(req.auth!.tenantId, req.params.id));

  app.put<{ Params: { id: string } }>("/v1/envelopes/:id/seal-options", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const input = SealOptionsInput.parse(req.body);
    if (input.companySealCertificateId) await loadTenantCertificate(s.db, a.tenantId, input.companySealCertificateId, "pdf_seal");
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      // Un sobre trabado en la finalización porque su sello de empresa venció (o lo va a reemplazar otro) solo puede
      // cambiar el sello, y solo mientras no haya una finalización en curso; después se reintenta con retry-finalize.
      const recovering =
        e.status === "finalizing" &&
        input.signatureLevel === undefined &&
        input.companySealCertificateId !== undefined &&
        !(await t.one(`SELECT 1 FROM jobs WHERE queue = 'finalize' AND status IN ('pending','running') AND payload->>'envelopeId' = $1 LIMIT 1`, [e.id]));
      if (!["draft", "sent"].includes(e.status) && !recovering) throw conflict("not_editable", "El sobre ya está finalizado");
      // El certificado se vuelve a leer con la fila bloqueada: si se borró entre el chequeo y acá, el sobre no puede
      // quedar apuntando a un certificado sin clave (la finalización fallaría para siempre).
      if (input.companySealCertificateId) {
        const c = await t.one(`SELECT id FROM tenant_certificates WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR SHARE`, [
          input.companySealCertificateId,
          a.tenantId,
        ]);
        if (!c) throw notFound("Certificado");
      }
      await t.query(
        `UPDATE envelopes SET company_seal_certificate_id = CASE WHEN $2::boolean THEN $3::uuid ELSE company_seal_certificate_id END,
           signature_level = COALESCE($4, signature_level), updated_at = now(), version = version + 1 WHERE id = $1`,
        [e.id, input.companySealCertificateId !== undefined, input.companySealCertificateId ?? null, input.signatureLevel ?? null],
      );
      await appendEvent(t, {
        tenantId: a.tenantId,
        envelopeId: e.id,
        type: "envelope.seal_options_updated",
        actor: a.actor,
        data: { companySealCertificateId: input.companySealCertificateId ?? null, signatureLevel: input.signatureLevel ?? null },
      });
    });
    return sealOptions(a.tenantId, req.params.id);
  });

  // ───────── Validación pública de PDF ─────────

  app.post("/v1/validate", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const file = await req.file({ limits: { fileSize: Math.max(config.maxUploadBytes, 40 * 1024 * 1024) } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo");
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) throw badRequest("not_pdf", "El archivo no es un PDF");
    const online = config.evidence.validateOnlineRevocation;
    let report;
    try {
      report = await validatePdf(bytes, { trustAnchors: await trustAnchors(), online, fetcher: guardedFetch });
    } catch (e) {
      throw badRequest("unreadable_pdf", `No se pudo leer el PDF: ${(e as Error).message}`);
    }
    const res: PdfValidationResponse = { sha256: Buffer.from(sha256Bytes(bytes)).toString("hex"), ...report, onlineRevocation: online };
    return res;
  });

  // ───────── Conectores de firma ─────────

  app.get("/v1/signature-providers", { preHandler: auth }, async () => ({ items: await listSignatureProviders() }));

  app.post<{ Params: { id: string } }>("/v1/signature-providers/:id/test", { preHandler: auth }, async (req) => {
    const provider = getCscProvider(req.params.id);
    if (!provider) throw notFound("Conector");
    const res: SignatureProviderTestResult = { id: req.params.id, ok: false, credentials: [], certificate: null, signatureVerified: false, error: null };
    try {
      res.credentials = await provider.client.listCredentials();
      const chain = await provider.certificateChain();
      const cert = new X509Certificate(Buffer.from(chain[0]));
      res.certificate = { subject: cert.subject.replace(/\n/g, ", "), issuer: cert.issuer.replace(/\n/g, ", "), notAfter: new Date(cert.validTo).toISOString() };
      // Firma de prueba sobre datos aleatorios, verificada con la clave pública del certificado.
      const data = randomBytes(32);
      const sig = await provider.signDigest(sha256Bytes(data));
      res.signatureVerified = createVerify("RSA-SHA256").update(data).verify(createPublicKey(cert.publicKey.export({ type: "spki", format: "pem" })), Buffer.from(sig));
      res.ok = res.signatureVerified;
    } catch (e) {
      res.error = (e as Error).message;
    }
    await auditFromRequest(s.db, req, req.auth!, "signature_provider.tested", { targetType: "signature_provider", targetId: req.params.id, data: { ok: res.ok } });
    return res;
  });
}
