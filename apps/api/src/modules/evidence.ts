// Rutas de evidencia fuerte: nivel PAdES, certificados de la organización, firma XML, sello de empresa,
// validación pública de PDF y conectores de firma (CSC v2).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { signXml, verifyXml } from "@calasign/xades";
import { commonName, parseCert, validatePdf, sha256 as sha256Bytes } from "@calasign/pdf";
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
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { AppError, assertNotStale, badRequest, conflict, notFound } from "../lib/errors";
import { sha256Hex, uuidv7 } from "../lib/util";
import { auditFromRequest } from "./audit";
import { authenticate, type Services } from "./context";
import { loadTenantCertificate, parseP12, sealKey, tenantCertificateProvider, toTenantCertificate } from "./custody";
import { byokForCustody } from "./data/byok";
import { lockEnvelope } from "./envelopes";
import { getCscProvider, guardedFetch, listSignatureProviders, resolveSealLevel, trustAnchors } from "./evidence-seal";

/** Pruebas de conectores de firma por organización y hora. */
const SIGNATURE_PROVIDER_TESTS_PER_HOUR = 5;
/** Una prueba iniciada sin resultado deja de bloquear a las demás pasado este lapso (proceso caído a mitad de prueba). */
const SIGNATURE_PROVIDER_TEST_STALE = "3 minutes";

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

  app.post("/v1/certificates", { onRequest: auth, bodyLimit: 3 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = UploadCertificateInput.parse(req.body);
    const parsed = parseP12(Buffer.from(input.p12Base64, "base64"), input.password);
    if (new Date(parsed.leaf.validTo) < new Date()) throw badRequest("certificate_expired", "El certificado está vencido");
    const id = uuidv7();
    const sealed = await sealKey(parsed.keyPkcs8Pem, { tenantId: req.auth!.tenantId, certificateId: id }, await byokForCustody(s.db, req.auth!.tenantId));
    const leaf = parsed.leaf;
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

  app.post("/v1/xml/sign", { onRequest: auth, bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
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

  app.post("/v1/xml/verify", { onRequest: auth, bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const input = XmlVerifyInput.parse(req.body);
    return verifyXml(input.xml);
  });

  // ───────── Sello de empresa y nivel de firma del sobre ─────────

  // Con `db` = la transacción del guardado, el envelopeUpdatedAt es el que dejó ese guardado (no el de otro posterior).
  const sealOptions = async (tenantId: string, envelopeId: string, db: Db = s.db): Promise<SealOptions> => {
    const e = await db.one<any>(
      `SELECT e.company_seal_certificate_id, e.signature_level, e.updated_at, c.name, c.common_name
       FROM envelopes e LEFT JOIN tenant_certificates c ON c.id = e.company_seal_certificate_id
       WHERE e.id = $1 AND e.tenant_id = $2`,
      [envelopeId, tenantId],
    );
    if (!e) throw notFound("Sobre");
    return {
      companySealCertificateId: e.company_seal_certificate_id,
      companySeal: e.company_seal_certificate_id ? { name: e.name, commonName: e.common_name } : null,
      signatureLevel: e.signature_level,
      envelopeUpdatedAt: new Date(e.updated_at).toISOString(),
    };
  };

  app.get<{ Params: { id: string } }>("/v1/envelopes/:id/seal-options", { preHandler: auth }, async (req) => sealOptions(req.auth!.tenantId, req.params.id));

  app.put<{ Params: { id: string } }>("/v1/envelopes/:id/seal-options", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const input = SealOptionsInput.parse(req.body);
    if (input.companySealCertificateId) await loadTenantCertificate(s.db, a.tenantId, input.companySealCertificateId, "pdf_seal");
    return s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      // Un sobre trabado en la finalización porque su sello de empresa venció (o lo va a reemplazar otro) solo puede
      // cambiar el sello, y solo mientras no haya una finalización en curso; después se reintenta con retry-finalize.
      const recovering =
        e.status === "finalizing" &&
        input.signatureLevel === undefined &&
        input.companySealCertificateId !== undefined &&
        !(await t.one(`SELECT 1 FROM jobs WHERE queue = 'finalize' AND status IN ('pending','running') AND payload->>'envelopeId' = $1 LIMIT 1`, [e.id]));
      if (!["draft", "sent"].includes(e.status) && !recovering) throw conflict("not_editable", "El sobre ya está finalizado");
      // Cambia el updatedAt del sobre: con X-Expected-Updated-At (el editor lo manda) no tapa una edición ajena.
      assertNotStale(req.headers, e.updated_at);
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
           signature_level = COALESCE($4, signature_level),
           updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond'), version = version + 1 WHERE id = $1`,
        [e.id, input.companySealCertificateId !== undefined, input.companySealCertificateId ?? null, input.signatureLevel ?? null],
      );
      await appendEvent(t, {
        tenantId: a.tenantId,
        envelopeId: e.id,
        type: "envelope.seal_options_updated",
        actor: a.actor,
        data: { companySealCertificateId: input.companySealCertificateId ?? null, signatureLevel: input.signatureLevel ?? null },
      });
      // Se lee dentro de la transacción: si otro guarda después del COMMIT, el editor no adopta su versión sin sus datos.
      return sealOptions(a.tenantId, e.id, t);
    });
  });

  // ───────── Validación pública de PDF ─────────

  app.post("/v1/validate", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const file = await req.file({ limits: { fileSize: Math.max(config.maxUploadBytes, 40 * 1024 * 1024) } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo", { limit: "file" });
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

  // Los conectores CSC son de la plataforma (compartidos por todas las organizaciones) y no hay un rol de operador de
  // plataforma: cualquier administrador de una organización puede probarlos. Por eso la prueba solo dice si funciona y
  // el nombre del titular (sin la lista de credenciales, el certificado completo ni el error del prestador, que va al
  // log) y tiene un tope por organización: cada prueba es una firma en el prestador (algunos cobran por firma).
  app.post<{ Params: { id: string } }>("/v1/signature-providers/:id/test", { preHandler: auth }, async (req) => {
    const provider = getCscProvider(req.params.id);
    if (!provider) throw notFound("Conector");
    // Reserva corta: con un candado por organización (sin esperar: si otra reserva lo tiene, 429) se cuenta el tope y
    // se registra el inicio de la prueba (signature_provider.test_started, que cuenta para el tope). Las llamadas al
    // prestador (hasta ~50 s) corren después, fuera de la transacción: antes la transacción y el candado quedaban
    // abiertos durante la prueba y tenían tomada una conexión del pool. Mientras haya un inicio sin resultado
    // (signature_provider.tested con el mismo testId) de hace menos de SIGNATURE_PROVIDER_TEST_STALE, otra prueba de la
    // organización responde 429 provider_test_in_progress; si el proceso se cae a mitad de la prueba, se libera sola.
    const tenantId = req.auth!.tenantId;
    const testId = uuidv7();
    const busy = () =>
      new AppError(429, "provider_test_in_progress", "Ya hay una prueba de conector en curso en tu organización: esperá a que termine");
    await s.db.tx(async (t) => {
      const lock = await t.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('signature_provider.tested:' || $1::text)) AS ok`, [tenantId]);
      if (!lock?.ok) throw busy();
      const running = await t.one(
        `SELECT 1 FROM account_audit_log st
          WHERE st.tenant_id = $1 AND st.action = 'signature_provider.test_started' AND st.occurred_at > now() - $2::interval
            AND NOT EXISTS (SELECT 1 FROM account_audit_log r WHERE r.tenant_id = $1 AND r.action = 'signature_provider.tested'
                             AND r.occurred_at >= st.occurred_at AND r.data->>'testId' = st.data->>'testId')
          LIMIT 1`,
        [tenantId, SIGNATURE_PROVIDER_TEST_STALE],
      );
      if (running) throw busy();
      // Cuentan los inicios (cada uno es una firma en el prestador) y los resultados anteriores a la reserva (sin testId).
      const recent = await t.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM account_audit_log
          WHERE tenant_id = $1 AND occurred_at > now() - interval '1 hour'
            AND (action = 'signature_provider.test_started' OR (action = 'signature_provider.tested' AND NOT (data ? 'testId')))`,
        [tenantId],
      );
      if ((recent?.n ?? 0) >= SIGNATURE_PROVIDER_TESTS_PER_HOUR) {
        throw new AppError(429, "provider_test_limit", `Se pueden hacer hasta ${SIGNATURE_PROVIDER_TESTS_PER_HOUR} pruebas de conectores por hora: probá más tarde`, {
          max: SIGNATURE_PROVIDER_TESTS_PER_HOUR,
        });
      }
      await auditFromRequest(t, req, req.auth!, "signature_provider.test_started", { targetType: "signature_provider", targetId: req.params.id, data: { testId } });
    });
    const res: SignatureProviderTestResult = { id: req.params.id, ok: false, holder: null, signatureVerified: false, error: null };
    try {
      const chain = await provider.certificateChain();
      res.holder = commonName(parseCert(chain[0]).subject) ?? null;
      // Firma de prueba sobre datos aleatorios: signDigest ya la verifica con la clave pública del certificado de la
      // credencial (RSA o ECDSA) y falla si no corresponde.
      await provider.signDigest(sha256Bytes(randomBytes(32)));
      res.signatureVerified = true;
      res.ok = true;
    } catch (e) {
      req.log.warn({ provider: req.params.id, err: String((e as Error)?.message ?? e).slice(0, 500) }, "prueba de conector de firma fallida");
      res.error = "No se pudo firmar con el conector: revisá su configuración (el detalle quedó en el log del servidor)";
    }
    // El resultado cierra la reserva (la libera para otra prueba).
    await auditFromRequest(s.db, req, req.auth!, "signature_provider.tested", {
      targetType: "signature_provider",
      targetId: req.params.id,
      data: { ok: res.ok, testId },
    });
    return res;
  });
}
