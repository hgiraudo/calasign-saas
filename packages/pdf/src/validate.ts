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
  timestamp: { time: string; tsa: string | null; valid: boolean } | null;
  integrity: { valid: boolean; reason?: string };
  coversWholeDocument: boolean;
  /** true si después de esta firma hay revisiones incrementales (DSS, otra firma, sello de documento). */
  modifiedAfter: boolean;
  /** trusted: llega a una raíz de confianza. timeValid: todos los certificados eran válidos al momento de firmar. */
  chain: { trusted: boolean; anchor: string | null; entries: ChainEntry[]; timeValid?: boolean };
  level: PadesLevel | null;
}

export interface ValidationReport {
  signatures: SignatureReport[];
  dss: { certs: number; ocsps: number; crls: number } | null;
  summary: { count: number; allValid: boolean; allTrusted: boolean; anyRevoked: boolean };
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

async function verifyToken(token: pkijs.SignedData, imprintOf: Uint8Array) {
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
  return { time: tst.genTime.toISOString(), tsa: tsa ? commonName(tsa.subject) ?? nameToString(tsa.subject) : null, valid: sigOk && expected.equals(got) };
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
        const r = await statusFromOcsp(o, c, issuer);
        if (r) { revocation = { status: r.status, source: "dss-ocsp" }; break; }
      }
      if (revocation.status === "not_checked") {
        for (const crl of dss?.crls ?? []) {
          const r = await statusFromCrl(crl, c, issuer);
          if (r) { revocation = { status: r.status, source: "dss-crl", revokedAt: r.revokedAt ?? null }; break; }
        }
      }
      if (revocation.status === "not_checked" && opts.online) {
        const o = await fetchOcsp(c, issuer, opts.fetcher);
        const r = o ? await statusFromOcsp(o, c, issuer) : null;
        if (r) revocation = { status: r.status, source: "online-ocsp" };
        else {
          const crl = await fetchCrl(c, opts.fetcher);
          const r2 = crl ? await statusFromCrl(crl, c, issuer) : null;
          if (r2) revocation = { status: r2.status, source: "online-crl", revokedAt: r2.revokedAt ?? null };
        }
      }
    }
    entries.push({ ...summary(c), revocation });
  }
  return { trusted, anchor: trusted ? nameToString(last.subject) : null, entries, timeValid };
}

export async function validatePdf(pdf: Uint8Array, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const { signatures, dss } = await readPdfSignatures(pdf);
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
    };
    const brIssue = byteRangeIssue(pdf, s.byteRange);
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
    const pool = [...cmsCertificates(sd), ...dssCerts, ...anchorsDer.map(parseCert)];

    if (s.type === "DocTimeStamp") {
      const ts = await verifyToken(sd, content);
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
    if (brIssue) integrity = { valid: false, reason: brIssue };
    const tsToken = signatureTimestamp(sd);
    let timestamp: SignatureReport["timestamp"] = null;
    if (tsToken) {
      const sigValue = new Uint8Array(sd.signerInfos[0].signature.valueBlock.valueHexView);
      timestamp = await verifyToken(tsToken, sigValue);
      pool.push(...cmsCertificates(tsToken));
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
      // Validez de la cadena al momento de firmar: el del sello de tiempo si hay (y es válido), si no el declarado.
      chain: signer
        ? await chainReport(signer, pool, anchors, dss, opts, new Date(timestamp?.valid ? timestamp.time : signingTime ?? Date.now()))
        : { trusted: false, anchor: null, entries: [] },
      level,
    });
  }

  return {
    signatures: reports,
    dss: dss ? { certs: dss.certs.length, ocsps: dss.ocsps.length, crls: dss.crls.length } : null,
    summary: {
      count: reports.length,
      allValid: reports.length > 0 && reports.every((r) => r.integrity.valid && (!r.timestamp || r.timestamp.valid)),
      allTrusted: reports.length > 0 && reports.every((r) => r.chain.trusted && r.chain.timeValid !== false),
      anyRevoked: reports.some((r) => r.chain.entries.some((e) => e.revocation.status === "revoked")),
    },
  };
}

export { certDer };
