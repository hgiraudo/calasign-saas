// Validador de firmas PDF: integridad criptográfica, cobertura, sello de tiempo, cadena hasta una raíz
// de confianza, revocación (DSS incrustado u online) y nivel PAdES detectado.
import { fetchCrl, fetchOcsp, statusFromCrl, statusFromOcsp, type Fetcher, type RevocationStatus } from "./pki";
import {
  HASH_BY_OID,
  OIDS,
  buildChain,
  certDer,
  cmsCertificates,
  commonName,
  fingerprint,
  hash,
  isSelfSigned,
  nameToString,
  parseCert,
  parseSignedData,
  pkijs,
  serialHex,
  signatureTimestamp,
  signerCertOf,
  toAB,
  tstInfoOf,
} from "./pki";
import type { PadesLevel } from "./ltv";
import { byteRangeIssue, readPdfSignatures, signedContent, type PdfDss } from "./signatures";
import { withDecodeBudget } from "./stream-budget";
import { PDFDocument } from "pdf-lib";
import { changesAfterRevision, type ChangesAfter } from "./revisions";

export interface CertSummary {
  subject: string;
  issuer: string;
  commonName: string | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
}

export interface ChainEntry extends CertSummary {
  revocation: { status: RevocationStatus | "not_checked" | "trust_anchor"; source: string | null; revokedAt?: string | null };
}

export interface SignatureReport {
  index: number;
  fieldName: string | null;
  kind: "signature" | "document_timestamp";
  subFilter: string | null;
  signer: CertSummary | null;
  signingTime: string | null;
  /** valid: el token verifica y corresponde a lo sellado. trusted: además la TSA llega a una raíz de confianza, tiene EKU
   * timeStamping y su certificado era válido en esa fecha (solo entonces la fecha cuenta como prueba de existencia). */
  timestamp: { time: string; tsa: string | null; valid: boolean; trusted?: boolean } | null;
  integrity: { valid: boolean; reason?: string };
  coversWholeDocument: boolean;
  /** true si después de esta firma hay revisiones incrementales (DSS, otra firma, sello de documento). */
  modifiedAfter: boolean;
  /** Qué cambiaron esas revisiones: solo evidencia (firmas, sellos, DSS) o lo que se ve (páginas, anotaciones). Con
   * "content" la firma verifica sobre su revisión, pero el documento que se muestra ya no es el firmado. */
  changesAfter: ChangesAfter;
  /** trusted: llega a una raíz de confianza. timeValid: todos los certificados eran válidos al momento de firmar. */
  chain: { trusted: boolean; anchor: string | null; entries: ChainEntry[]; timeValid?: boolean; revoked?: boolean; revocationUnknown?: boolean };
  level: PadesLevel | null;
}

export interface ValidationReport {
  signatures: SignatureReport[];
  dss: { certs: number; ocsps: number; crls: number } | null;
  summary: { count: number; allValid: boolean; allTrusted: boolean; anyRevoked: boolean; modifiedAfterSigning: boolean; revocationUnknown: boolean };
}

export interface ValidateOptions {
  /** Raíces de confianza (DER). */
  trustAnchors?: Uint8Array[];
  /** Consultar OCSP/CRL online si el DSS no alcanza. */
  online?: boolean;
  fetcher?: Fetcher;
}

function summary(c: pkijs.Certificate): CertSummary {
  return {
    subject: nameToString(c.subject),
    issuer: nameToString(c.issuer),
    commonName: commonName(c.subject),
    serialNumber: serialHex(c),
    notBefore: c.notBefore.value.toISOString(),
    notAfter: c.notAfter.value.toISOString(),
    sha256: fingerprint(certDer(c)),
  };
}

const EKU_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";

function hasTimeStampingEku(c: pkijs.Certificate): boolean {
  const ext = c.extensions?.find((e) => e.extnID === "2.5.29.37");
  const ids: string[] = ((ext?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? []).map(String);
  return ids.includes(EKU_TIME_STAMPING);
}

async function verifyToken(token: pkijs.SignedData, imprintOf: Uint8Array, pool: pkijs.Certificate[], anchors: Set<string>) {
  const tst = tstInfoOf(token);
  const alg = HASH_BY_OID[tst.messageImprint.hashAlgorithm.algorithmId] ?? "sha256";
  const expected = Buffer.from(hash(alg, imprintOf));
  const got = Buffer.from(tst.messageImprint.hashedMessage.valueBlock.valueHexView);
  let sigOk = false;
  try {
    // Con eContentType TSTInfo, pkijs toma `data` como el dato sellado y verifica también el messageImprint.
    sigOk = (await token.verify({ signer: 0, data: toAB(imprintOf), checkChain: false, extendedMode: true })).signatureVerified === true;
  } catch {
    sigOk = false;
  }
  const tsa = signerCertOf(token);
  const valid = sigOk && expected.equals(got);
  let trusted = false;
  if (valid && tsa && hasTimeStampingEku(tsa)) {
    const at = tst.genTime;
    const chain = await buildChain(tsa, [...cmsCertificates(token), ...pool]);
    const last = chain[chain.length - 1];
    trusted =
      isSelfSigned(last) &&
      anchors.has(fingerprint(certDer(last))) &&
      chain.every((c) => c.notBefore.value <= at && at <= c.notAfter.value);
  }
  return { time: tst.genTime.toISOString(), tsa: tsa ? commonName(tsa.subject) ?? nameToString(tsa.subject) : null, valid, trusted };
}

/** Sin repetidos (por huella) y con tope: buildChain prueba con firma cada candidato con el mismo emisor. */
function dedupePool(certs: pkijs.Certificate[]): pkijs.Certificate[] {
  const seen = new Set<string>();
  const out: pkijs.Certificate[] = [];
  for (const c of certs) {
    const fp = fingerprint(certDer(c));
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(c);
    if (out.length > MAX_CERT_POOL) throw new Error(`el PDF trae demasiados certificados (máximo ${MAX_CERT_POOL})`);
  }
  return out;
}

async function chainReport(
  leaf: pkijs.Certificate,
  pool: pkijs.Certificate[],
  anchors: Set<string>,
  dss: PdfDss | null,
  opts: ValidateOptions,
  at: Date,
): Promise<SignatureReport["chain"]> {
  const chain = await buildChain(leaf, pool);
  const timeValid = chain.every((c) => c.notBefore.value <= at && at <= c.notAfter.value);
  const last = chain[chain.length - 1];
  const trusted = isSelfSigned(last) && anchors.has(fingerprint(certDer(last)));
  const entries: ChainEntry[] = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const issuer = chain[i + 1];
    let revocation: ChainEntry["revocation"] = { status: "not_checked", source: null };
    if (isSelfSigned(c)) revocation = { status: "trust_anchor", source: null };
    else if (issuer) {
      for (const o of dss?.ocsps ?? []) {
        const r = await statusFromOcsp(o, c, issuer, at);
        if (r) { revocation = { status: r.status, source: "dss-ocsp", revokedAt: r.revokedAt ?? null }; break; }
      }
      if (revocation.status === "not_checked") {
        for (const crl of dss?.crls ?? []) {
          const r = await statusFromCrl(crl, c, issuer, at);
          if (r) { revocation = { status: r.status, source: "dss-crl", revokedAt: r.revokedAt ?? null }; break; }
        }
      }
      if (revocation.status === "not_checked" && opts.online) {
        const o = await fetchOcsp(c, issuer, opts.fetcher);
        const r = o ? await statusFromOcsp(o, c, issuer, at) : null;
        if (r) revocation = { status: r.status, source: "online-ocsp", revokedAt: r.revokedAt ?? null };
        else {
          const crl = await fetchCrl(c, opts.fetcher);
          const r2 = crl ? await statusFromCrl(crl, c, issuer, at) : null;
          if (r2) revocation = { status: r2.status, source: "online-crl", revokedAt: r2.revokedAt ?? null };
        }
      }
    }
    entries.push({ ...summary(c), revocation });
  }
  // Revocado al momento de firmar: la revocación es anterior a esa fecha, o no se sabe cuándo ocurrió. El OCSP trae su
  // revocationTime: sin pasarlo, un certificado revocado DESPUÉS de una firma con sello de confianza contaba como revocado.
  const revoked = entries.some(
    (e) => e.revocation.status === "revoked" && (!e.revocation.revokedAt || new Date(e.revocation.revokedAt) <= at),
  );
  // "De confianza" no dice nada de la revocación si no hubo datos (sin DSS ni consulta online): se informa aparte.
  const revocationUnknown = entries.some((e) => e.revocation.status === "not_checked");
  return { trusted, anchor: trusted ? nameToString(last.subject) : null, entries, timeValid, revoked, revocationUnknown };
}

export async function validatePdf(pdf: Uint8Array, opts: ValidateOptions = {}): Promise<ValidationReport> {
  // Toda la validación con un tope de descompresión: la usa /v1/validate (público) y carga el PDF varias veces
  // (firmas, revisiones de cada firma).
  return withDecodeBudget(() => validatePdfUnbudgeted(pdf, opts));
}

/**
 * Tope de firmas por PDF a validar. Cada firma copia y hashea el contenido firmado y, si hay cambios después, vuelve a
 * parsear esa revisión: un PDF público con miles de campos de firma (cada uno con otro ByteRange) colgaba la API.
 */
export const MAX_VALIDATE_SIGNATURES = 50;

/**
 * Topes del DSS y del conjunto de certificados (el validador es público): con miles de certificados o una CRL enorme,
 * el parseo ASN.1 y las verificaciones de firma consumían memoria y CPU sin límite.
 */
export const MAX_DSS_ITEMS = 300;
export const MAX_CRL_BYTES = 5 * 1024 * 1024;
export const MAX_CERT_POOL = 300;

async function validatePdfUnbudgeted(pdf: Uint8Array, opts: ValidateOptions): Promise<ValidationReport> {
  const { signatures, dss } = await readPdfSignatures(pdf);
  if (signatures.length > MAX_VALIDATE_SIGNATURES) throw new Error(`el PDF tiene demasiadas firmas (${signatures.length}; máximo ${MAX_VALIDATE_SIGNATURES})`);
  if (dss && (dss.certs.length > MAX_DSS_ITEMS || dss.ocsps.length > MAX_DSS_ITEMS || dss.crls.length > MAX_DSS_ITEMS)) {
    throw new Error(`el DSS del PDF es demasiado grande (máximo ${MAX_DSS_ITEMS} certificados, OCSP o CRL)`);
  }
  if (dss?.crls.some((c) => c.length > MAX_CRL_BYTES)) throw new Error(`el DSS del PDF trae una CRL demasiado grande (máximo ${MAX_CRL_BYTES / 1048576} MB)`);
  const anchorsDer = opts.trustAnchors ?? [];
  const anchors = new Set(anchorsDer.map(fingerprint));
  const dssCerts = (dss?.certs ?? []).map((d) => {
    try {
      return parseCert(d);
    } catch {
      return null;
    }
  }).filter((c): c is pkijs.Certificate => !!c);
  const docTsEnds = signatures.filter((s) => s.type === "DocTimeStamp").map((s) => s.byteRange[2] + s.byteRange[3]);
  const reports: SignatureReport[] = [];

  for (const [index, s] of signatures.entries()) {
    const end = s.byteRange[2] + s.byteRange[3];
    const base = {
      index,
      fieldName: s.fieldName,
      subFilter: s.subFilter,
      coversWholeDocument: s.byteRange[0] === 0 && end === pdf.length,
      modifiedAfter: end < pdf.length,
      changesAfter: "none" as ChangesAfter,
    };
    try {
      const brIssue = byteRangeIssue(pdf, s.byteRange, s.contents);
      const content = signedContent(pdf, s.byteRange);
      let sd: pkijs.SignedData;
      try {
        sd = parseSignedData(s.contents);
      } catch (e) {
        reports.push({
          ...base,
          kind: s.type === "DocTimeStamp" ? "document_timestamp" : "signature",
          signer: null,
          signingTime: s.signingTimeM,
          timestamp: null,
          integrity: { valid: false, reason: `CMS ilegible: ${(e as Error).message}` },
          chain: { trusted: false, anchor: null, entries: [] },
          level: null,
        });
        continue;
      }
      const signer = signerCertOf(sd);
      const pool = dedupePool([...cmsCertificates(sd), ...dssCerts, ...anchorsDer.map(parseCert)]);

      if (s.type === "DocTimeStamp") {
        const ts = await verifyToken(sd, content, pool, anchors);
        reports.push({
          ...base,
          kind: "document_timestamp",
          signer: signer ? summary(signer) : null,
          signingTime: ts.time,
          timestamp: ts,
          integrity: brIssue ? { valid: false, reason: brIssue } : ts.valid ? { valid: true } : { valid: false, reason: "El sello de documento no corresponde al contenido" },
          chain: signer ? await chainReport(signer, pool, anchors, dss, opts, new Date(ts.time)) : { trusted: false, anchor: null, entries: [] },
          level: null,
        });
        continue;
      }

      let integrity: SignatureReport["integrity"];
      try {
        const r = await sd.verify({ signer: 0, data: toAB(content), checkChain: false, extendedMode: true });
        integrity = r.signatureVerified ? { valid: true } : { valid: false, reason: r.message || "La firma no verifica" };
      } catch (e) {
        integrity = { valid: false, reason: (e as Error).message ?? "La firma no verifica" };
      }
      // Con contenido incrustado (eContent), pkijs verifica la firma sobre ese contenido e ignora `data`: una firma
      // hecha sobre otra cosa validaba en cualquier PDF. Solo se acepta adbe.pkcs7.sha1, cuyo eContent es el SHA-1 de
      // lo firmado, y si coincide con el ByteRange.
      const ec = sd.encapContentInfo?.eContent;
      if (ec) {
        const inner = Buffer.from(ec.getValue());
        const ok = s.subFilter === "adbe.pkcs7.sha1" && inner.equals(Buffer.from(hash("sha1", content)));
        if (!ok) integrity = { valid: false, reason: "El CMS trae contenido incrustado que no es este documento" };
      }
      if (brIssue) integrity = { valid: false, reason: brIssue };
      const tsToken = signatureTimestamp(sd);
      let timestamp: SignatureReport["timestamp"] = null;
      if (tsToken) {
        const sigValue = new Uint8Array(sd.signerInfos[0].signature.valueBlock.valueHexView);
        pool.push(...dedupePool(cmsCertificates(tsToken)).slice(0, 20));
        timestamp = await verifyToken(tsToken, sigValue, pool, anchors);
      }
      const signingTimeAttr = sd.signerInfos[0].signedAttrs?.attributes.find((a) => a.type === OIDS.signingTime);
      const signingTime = s.signingTimeM ?? (signingTimeAttr ? (signingTimeAttr.values[0] as any).toDate?.()?.toISOString?.() ?? null : null);
      const hasV2 = !!sd.signerInfos[0].signedAttrs?.attributes.some((a) => a.type === OIDS.signingCertificateV2 || a.type === OIDS.signingCertificate);
      const padesBase = s.subFilter === "ETSI.CAdES.detached" && hasV2;
      let level: PadesLevel | null = null;
      if (padesBase) {
        level = timestamp ? "B-T" : "B-B";
        const hasRevData = (dss?.ocsps.length ?? 0) + (dss?.crls.length ?? 0) > 0 || (dss?.certs.length ?? 0) > 0;
        if (level === "B-T" && dss && hasRevData) level = docTsEnds.some((e) => e > end) ? "B-LTA" : "B-LT";
      }
      reports.push({
        ...base,
        kind: "signature",
        signer: signer ? summary(signer) : null,
        signingTime,
        timestamp,
        integrity,
        // Validez de la cadena al momento de firmar: la fecha del sello de tiempo solo si es de una TSA de confianza (prueba de
        // existencia). Sin eso, la fecha declarada la elige quien firma: se evalúa al día de hoy (sin prueba de existencia).
        // Sin integridad no se analiza la cadena (es lo más costoso y el informe ya dice que la firma no vale).
        chain: signer && integrity.valid
          ? await chainReport(signer, pool, anchors, dss, opts, timestamp?.valid && timestamp.trusted ? new Date(timestamp.time) : new Date())
          : { trusted: false, anchor: null, entries: [] },
        level,
      });
    } catch (e) {
      // Una firma o sello mal formado (sin signerInfos, sello sin TSTInfo…) se informa como inválido: antes hacía
      // fallar la validación del PDF entero y un sello basura agregado al final ocultaba el informe.
      reports.push({
        ...base,
        kind: s.type === "DocTimeStamp" ? "document_timestamp" : "signature",
        signer: null,
        signingTime: s.signingTimeM,
        timestamp: null,
        integrity: { valid: false, reason: `Firma ilegible: ${(e as Error)?.message ?? String(e)}` },
        chain: { trusted: false, anchor: null, entries: [] },
        level: null,
      });
    }
  }

  // B-LTA solo con un sello de documento posterior que verifica (antes contaba cualquiera).
  const validDocTsEnds = reports
    .filter((r) => r.kind === "document_timestamp" && r.integrity.valid && r.timestamp?.valid)
    .map((r) => signatures[r.index].byteRange[2] + signatures[r.index].byteRange[3]);
  for (const r of reports) {
    const end = signatures[r.index].byteRange[2] + signatures[r.index].byteRange[3];
    if (r.level === "B-LTA" && !validDocTsEnds.some((e) => e > end)) r.level = "B-LT";
  }

  // Lo agregado después de cada firma: solo cuentan como evidencia los widgets de firmas y sellos posteriores que verifican.
  const verified = new Set(
    reports.filter((r) => r.integrity.valid && (!r.timestamp || r.timestamp.valid)).map((r) => signatures[r.index].byteRange.join(",")),
  );
  const current = reports.some((r) => r.modifiedAfter) ? await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true }) : undefined;
  // Una vez por revisión: varias firmas que terminan en el mismo lugar comparten el resultado.
  const byEnd = new Map<number, Promise<ChangesAfter>>();
  for (const r of reports) {
    if (r.modifiedAfter) {
      const [, , c, d] = signatures[r.index].byteRange;
      let p = byEnd.get(c + d);
      if (!p) byEnd.set(c + d, (p = changesAfterRevision(pdf, c + d, verified, current)));
      r.changesAfter = await p;
    }
  }
  const modifiedAfterSigning = reports.some((r) => r.changesAfter === "content");

  return {
    signatures: reports,
    dss: dss ? { certs: dss.certs.length, ocsps: dss.ocsps.length, crls: dss.crls.length } : null,
    summary: {
      count: reports.length,
      allValid: reports.length > 0 && !modifiedAfterSigning && reports.every((r) => r.integrity.valid && (!r.timestamp || r.timestamp.valid)),
      allTrusted: reports.length > 0 && reports.every((r) => r.chain.trusted && r.chain.timeValid !== false && !r.chain.revoked),
      anyRevoked: reports.some((r) => r.chain.entries.some((e) => e.revocation.status === "revoked")),
      modifiedAfterSigning,
      revocationUnknown: reports.some((r) => r.chain.revocationUnknown === true),
    },
  };
}

export { certDer };
