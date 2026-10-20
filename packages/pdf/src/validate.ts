// Validador de firmas PDF: integridad criptográfica, cobertura, sello de tiempo, cadena hasta una raíz
// de confianza, revocación (DSS incrustado u online) y nivel PAdES detectado.
import { X509Certificate } from "node:crypto";
import { fetchCrl, fetchOcsp, statusFromCrl, statusFromOcsp, type Fetcher, type RevocationStatus } from "./pki";
import {
  asn1js,
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
  /**
   * Algoritmos débiles: resumen SHA-1 o MD5 (de la firma, del sello de tiempo o de un certificado de la cadena que no es
   * la raíz) o clave RSA de menos de 2048 bits. La firma puede verificar, pero ya no prueba nada: no cuenta para
   * summary.allValid ni summary.allTrusted. `weakAlgorithmReasons` dice cuáles.
   */
  weakAlgorithm: boolean;
  weakAlgorithmReasons: string[];
  /**
   * Lo que no se pudo comprobar sin que eso invalide la firma (p. ej. un signingCertificateV2 con un resumen que no se
   * soporta, como SHA-224 o SHA-3). Solo si hay alguna.
   */
  warnings?: string[];
}

export interface ValidationReport {
  signatures: SignatureReport[];
  dss: { certs: number; ocsps: number; crls: number } | null;
  summary: {
    count: number;
    allValid: boolean;
    allTrusted: boolean;
    anyRevoked: boolean;
    modifiedAfterSigning: boolean;
    revocationUnknown: boolean;
    /** Alguna firma o sello usa algoritmos débiles (ver SignatureReport.weakAlgorithm). */
    anyWeakAlgorithm: boolean;
  };
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

// ───────────────────── Algoritmos débiles ─────────────────────
const WEAK_DIGESTS: Record<string, string> = { "1.3.14.3.2.26": "SHA-1", "1.2.840.113549.2.5": "MD5" };
const WEAK_SIGNATURE_ALGS: Record<string, string> = {
  "1.2.840.113549.1.1.4": "MD5 con RSA",
  "1.2.840.113549.1.1.5": "SHA-1 con RSA",
  "1.3.14.3.2.29": "SHA-1 con RSA",
  "1.2.840.10045.4.1": "ECDSA con SHA-1",
  "1.2.840.10040.4.3": "DSA con SHA-1",
};
const OID_RSA = "1.2.840.113549.1.1.1";

/** Algoritmos débiles del firmante de un CMS (o de un token de sello de tiempo). */
function weakCmsAlgorithms(sd: pkijs.SignedData, label: string, out: Set<string>) {
  const si = sd.signerInfos[0];
  const d = WEAK_DIGESTS[si?.digestAlgorithm.algorithmId ?? ""];
  if (d) out.add(`${label}: resumen ${d}`);
  const a = WEAK_SIGNATURE_ALGS[si?.signatureAlgorithm.algorithmId ?? ""];
  if (a) out.add(`${label}: algoritmo ${a}`);
}

/** Clave RSA corta o, si no es una raíz (autofirmado), firmado con SHA-1/MD5. */
function weakCertificate(c: pkijs.Certificate, out: Set<string>) {
  const who = commonName(c.subject) ?? nameToString(c.subject);
  if (c.subjectPublicKeyInfo.algorithm.algorithmId === OID_RSA) {
    try {
      const bits = new X509Certificate(Buffer.from(certDer(c))).publicKey.asymmetricKeyDetails?.modulusLength;
      if (bits !== undefined && bits < 2048) out.add(`certificado ${who}: clave RSA de ${bits} bits`);
    } catch {
      // clave ilegible: lo decide la verificación
    }
  }
  const alg = WEAK_SIGNATURE_ALGS[c.signatureAlgorithm.algorithmId];
  if (alg && !isSelfSigned(c)) out.add(`certificado ${who}: firmado con ${alg}`);
}

/**
 * El atributo firmado signingCertificateV2 (ESSCertIDv2) o signingCertificate (ESSCertID, SHA-1) tiene que identificar
 * al certificado con el que se verifica la firma: hash del certificado y, si está, IssuerSerial (emisor y número de
 * serie). Si no coincide, alguien pudo reemplazar el certificado del CMS por otro con la misma clave.
 */
function signingCertificateIssue(sd: pkijs.SignedData, signer: pkijs.Certificate, warnings: string[]): string | null {
  const attrs = sd.signerInfos[0].signedAttrs?.attributes ?? [];
  const v2 = attrs.find((a) => a.type === OIDS.signingCertificateV2);
  const attr = v2 ?? attrs.find((a) => a.type === OIDS.signingCertificate);
  if (!attr) return null;
  const bad = "El certificado firmante no coincide con el atributo signingCertificate";
  try {
    const outer = attr.values[0] as asn1js.Sequence;
    const first = (outer.valueBlock.value[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const els = first.valueBlock.value;
    let i = 0;
    let alg: string | undefined = v2 ? "sha256" : "sha1";
    if (v2 && els[0] instanceof asn1js.Sequence) {
      const oid = (els[0].valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString();
      alg = HASH_BY_OID[oid];
      // Resumen que no se soporta (SHA-224, SHA-3…): no se puede comprobar, pero eso no prueba que no coincida.
      if (!alg) warnings.push(`El atributo signingCertificateV2 usa un resumen no soportado (${oid}): no se pudo comprobar que identifica al certificado firmante`);
      i = 1;
    }
    const certHash = els[i];
    if (!(certHash instanceof asn1js.OctetString)) return bad;
    const want = Buffer.from(certHash.valueBlock.valueHexView);
    const encodings = [certDer(signer), new Uint8Array(signer.toSchema(false).toBER(false))];
    if (alg && !encodings.some((d) => Buffer.from(hash(alg, d)).equals(want))) return bad;
    const issuerSerial = els[i + 1];
    if (issuerSerial instanceof asn1js.Sequence) {
      const [names, serial] = issuerSerial.valueBlock.value;
      if (!(serial instanceof asn1js.Integer) || !serial.isEqual(signer.serialNumber)) return bad;
      const dn = (names as asn1js.Sequence).valueBlock.value.find((g) => g.idBlock.tagClass === 3 && g.idBlock.tagNumber === 4) as asn1js.Constructed | undefined;
      if (dn) {
        const name = new pkijs.RelativeDistinguishedNames({ schema: dn.valueBlock.value[0] });
        if (!name.isEqual(signer.issuer)) return bad;
      }
    }
    return null;
  } catch {
    return bad;
  }
}

function hasTimeStampingEku(c: pkijs.Certificate): boolean {
  const ext = c.extensions?.find((e) => e.extnID === "2.5.29.37");
  const ids: string[] = ((ext?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? []).map(String);
  return ids.includes(EKU_TIME_STAMPING);
}

async function verifyToken(token: pkijs.SignedData, imprintOf: Uint8Array, pool: pkijs.Certificate[], anchors: Set<string>, weak: Set<string>) {
  const tst = tstInfoOf(token);
  weakCmsAlgorithms(token, "sello de tiempo", weak);
  const imprintWeak = WEAK_DIGESTS[tst.messageImprint.hashAlgorithm.algorithmId];
  if (imprintWeak) weak.add(`sello de tiempo: resumen ${imprintWeak}`);
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
  if (tsa) weakCertificate(tsa, weak);
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

/**
 * Certificados que trae el PDF (CMS y DSS) sin repetidos (por huella) y con tope: buildChain prueba con firma cada
 * candidato con el mismo emisor. Se recorta (no se rechaza: un tope de recursos no es una firma rota).
 */
function dedupePool(certs: pkijs.Certificate[]): pkijs.Certificate[] {
  const seen = new Set<string>();
  const out: pkijs.Certificate[] = [];
  for (const c of certs) {
    if (out.length >= MAX_CERT_POOL) break;
    const fp = fingerprint(certDer(c));
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(c);
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
  weak: Set<string>,
): Promise<SignatureReport["chain"]> {
  const chain = await buildChain(leaf, pool);
  for (const c of chain) weakCertificate(c, weak);
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
      // "unknown" es provisional: se sigue buscando (un OCSP posterior "good" o "revoked", o una CRL) y solo queda si
      // no aparece nada concluyente. Antes el primero (el más viejo, a menudo "unknown" recién emitido) cortaba la búsqueda.
      let provisional: ChainEntry["revocation"] | null = null;
      for (const o of dss?.ocsps ?? []) {
        const r = await statusFromOcsp(o, c, issuer, at);
        if (!r) continue;
        if (r.status === "unknown") {
          provisional ??= { status: r.status, source: "dss-ocsp", revokedAt: null };
          continue;
        }
        revocation = { status: r.status, source: "dss-ocsp", revokedAt: r.revokedAt ?? null };
        if (r.status === "revoked") break;
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
      if (revocation.status === "not_checked" && provisional) revocation = provisional;
    }
    entries.push({ ...summary(c), revocation });
  }
  // Revocado al momento de firmar: la revocación es anterior a esa fecha, o no se sabe cuándo ocurrió. El OCSP trae su
  // revocationTime: sin pasarlo, un certificado revocado DESPUÉS de una firma con sello de confianza contaba como revocado.
  const revoked = entries.some(
    (e) => e.revocation.status === "revoked" && (!e.revocation.revokedAt || new Date(e.revocation.revokedAt) <= at),
  );
  // "De confianza" no dice nada de la revocación si no hubo datos (sin DSS ni consulta online): se informa aparte.
  const revocationUnknown = entries.some((e) => e.revocation.status === "not_checked" || e.revocation.status === "unknown");
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
  const { signatures, dss: rawDss } = await readPdfSignatures(pdf);
  if (signatures.length > MAX_VALIDATE_SIGNATURES) throw new Error(`el PDF tiene demasiadas firmas (${signatures.length}; máximo ${MAX_VALIDATE_SIGNATURES})`);
  // Se recorta en vez de rechazar: cada renovación del archivo agrega OCSP nuevos al final, y rechazar dejaba a ese
  // sobre sin poder renovarse nunca más. Se usan los más recientes (los últimos) y se ignoran las CRL demasiado grandes.
  const dss: PdfDss | null = rawDss
    ? {
        certs: rawDss.certs.slice(-MAX_DSS_ITEMS),
        ocsps: rawDss.ocsps.slice(-MAX_DSS_ITEMS),
        crls: rawDss.crls.filter((c) => c.length <= MAX_CRL_BYTES).slice(-MAX_DSS_ITEMS),
      }
    : null;
  const anchorsDer = opts.trustAnchors ?? [];
  const anchors = new Set(anchorsDer.map(fingerprint));
  // Las raíces de confianza se parsean una vez y no cuentan para el tope (un almacén grande no puede romper validaciones).
  const anchorCerts = anchorsDer.map(parseCert);
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
    const weak = new Set<string>();
    const warnings: string[] = [];
    const weakOf = () => ({ weakAlgorithm: weak.size > 0, weakAlgorithmReasons: [...weak], ...(warnings.length ? { warnings: [...warnings] } : {}) });
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
          ...weakOf(),
        });
        continue;
      }
      const signer = signerCertOf(sd);
      const pool = [...dedupePool([...cmsCertificates(sd), ...dssCerts]), ...anchorCerts];

      if (s.type === "DocTimeStamp") {
        const ts = await verifyToken(sd, content, pool, anchors, weak);
        reports.push({
          ...base,
          kind: "document_timestamp",
          signer: signer ? summary(signer) : null,
          signingTime: ts.time,
          timestamp: ts,
          integrity: brIssue ? { valid: false, reason: brIssue } : ts.valid ? { valid: true } : { valid: false, reason: "El sello de documento no corresponde al contenido" },
          chain: signer ? await chainReport(signer, pool, anchors, dss, opts, new Date(ts.time), weak) : { trusted: false, anchor: null, entries: [] },
          level: null,
          ...weakOf(),
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
      if (integrity.valid && signer) {
        const certIssue = signingCertificateIssue(sd, signer, warnings);
        if (certIssue) integrity = { valid: false, reason: certIssue };
      }
      if (brIssue) integrity = { valid: false, reason: brIssue };
      weakCmsAlgorithms(sd, "firma", weak);
      if (s.subFilter === "adbe.pkcs7.sha1" || s.subFilter === "adbe.x509.rsa_sha1") weak.add(`firma: SubFilter ${s.subFilter}`);
      if (signer) weakCertificate(signer, weak);
      const tsToken = signatureTimestamp(sd);
      let timestamp: SignatureReport["timestamp"] = null;
      if (tsToken) {
        const sigValue = new Uint8Array(sd.signerInfos[0].signature.valueBlock.valueHexView);
        pool.push(...dedupePool(cmsCertificates(tsToken)).slice(0, 20));
        timestamp = await verifyToken(tsToken, sigValue, pool, anchors, weak);
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
          ? await chainReport(signer, pool, anchors, dss, opts, timestamp?.valid && timestamp.trusted ? new Date(timestamp.time) : new Date(), weak)
          : { trusted: false, anchor: null, entries: [] },
        level,
        ...weakOf(),
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
        ...weakOf(),
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
      allValid: reports.length > 0 && !modifiedAfterSigning && reports.every((r) => r.integrity.valid && (!r.timestamp || r.timestamp.valid) && !r.weakAlgorithm),
      allTrusted: reports.length > 0 && reports.every((r) => r.chain.trusted && r.chain.timeValid !== false && !r.chain.revoked && !r.weakAlgorithm),
      anyRevoked: reports.some((r) => r.chain.entries.some((e) => e.revocation.status === "revoked")),
      modifiedAfterSigning,
      revocationUnknown: reports.some((r) => r.chain.revocationUnknown === true),
      anyWeakAlgorithm: reports.some((r) => r.weakAlgorithm),
    },
  };
}

export { certDer };
