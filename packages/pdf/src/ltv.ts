// PAdES B-LT y B-LTA (ETSI EN 319 142-1 §5.4/§5.5): después de la firma B-T se agrega, como revisión
// incremental, un /DSS con certificados, OCSP y CRL de todas las cadenas (firmantes y TSA); en B-LTA,
// además, un sello de tiempo de documento (/SubFilter ETSI.RFC3161) que cubre todo, DSS incluido.
import { buildPadesCms, requestTimestampToken } from "./cms";
import type { SignatureProvider } from "./provider";
import { addDssIncremental, addSignatureIncremental, type DssData } from "./incremental";
import {
  buildChain,
  certDer,
  cmsCertificates,
  fetchCrl,
  fetchOcsp,
  hasRevocationInfo,
  isSelfSigned,
  parseCert,
  parseSignedData,
  pkijs,
  signatureTimestamp,
  signerCertOf,
  toAB,
  type Fetcher,
} from "./pki";
import { sha256 } from "./provider";
import { readPdfSignatures, type PdfSignature } from "./signatures";

export type PadesLevel = "B-B" | "B-T" | "B-LT" | "B-LTA";

export interface LtvOptions {
  level: "B-LT" | "B-LTA";
  /** TSA para el sello de documento (B-LTA). */
  tsaUrl?: string | null;
  tsaAuthHeader?: string | null;
  /** Raíces y certificados extra para completar cadenas (DER). */
  extraCerts?: Uint8Array[];
  fetcher?: Fetcher;
}

export interface LtvReport {
  level: PadesLevel;
  certs: number;
  ocsps: number;
  crls: number;
  /** Certificados para los que no se consiguió información de revocación. */
  missingRevocation: string[];
}

/** Firmantes (y sus TSA) presentes en el PDF, con la cadena que se pudo armar. */
async function signingCertificates(sigs: PdfSignature[]): Promise<{ leaves: pkijs.Certificate[]; pool: pkijs.Certificate[] }> {
  const leaves: pkijs.Certificate[] = [];
  const pool: pkijs.Certificate[] = [];
  for (const s of sigs) {
    try {
      const sd = parseSignedData(s.contents);
      pool.push(...cmsCertificates(sd));
      const leaf = signerCertOf(sd);
      if (leaf) leaves.push(leaf);
      const ts = signatureTimestamp(sd);
      if (ts) {
        pool.push(...cmsCertificates(ts));
        const tsa = signerCertOf(ts);
        if (tsa) leaves.push(tsa);
      }
    } catch {
      // firma ilegible: la reporta el validador
    }
  }
  return { leaves, pool };
}

export async function collectValidationData(pdf: Uint8Array, opts: Pick<LtvOptions, "extraCerts" | "fetcher"> = {}) {
  const { signatures } = await readPdfSignatures(pdf);
  const { leaves, pool } = await signingCertificates(signatures);
  pool.push(...(opts.extraCerts ?? []).map(parseCert));
  const data: DssData = { certs: [], ocsps: [], crls: [] };
  const missing: string[] = [];
  const done = new Set<string>();
  for (const leaf of leaves) {
    const chain = await buildChain(leaf, pool);
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const der = certDer(c);
      const key = Buffer.from(der).toString("base64");
      data.certs.push(der);
      if (done.has(key) || isSelfSigned(c)) continue;
      done.add(key);
      const issuer = chain[i + 1];
      if (!issuer) {
        missing.push(c.subject.typesAndValues.map((t) => t.value.valueBlock.value).join(", "));
        continue;
      }
      const ocsp = await fetchOcsp(c, issuer, opts.fetcher);
      if (ocsp) {
        data.ocsps.push(ocsp);
        // Certificados del respondedor (si es delegado) también van al DSS.
        try {
          const resp = pkijs.OCSPResponse.fromBER(toAB(ocsp));
          const basic = pkijs.BasicOCSPResponse.fromBER(resp.responseBytes!.response.valueBlock.valueHexView.slice().buffer);
          for (const rc of basic.certs ?? []) data.certs.push(certDer(rc));
        } catch {
          // sin certificados extra
        }
        continue;
      }
      const crl = await fetchCrl(c, opts.fetcher);
      if (crl) data.crls.push(crl);
      else missing.push(c.subject.typesAndValues.map((t) => t.value.valueBlock.value).join(", "));
    }
  }
  return { data, missing };
}

/** Lleva un PDF ya firmado (B-T) a B-LT o B-LTA. */
export async function applyLtv(pdf: Uint8Array, opts: LtvOptions): Promise<{ pdf: Uint8Array; report: LtvReport }> {
  const { data, missing } = await collectValidationData(pdf, opts);
  let out = await addDssIncremental(pdf, data);
  if (opts.level === "B-LTA") {
    if (!opts.tsaUrl) throw new Error("B-LTA requiere una TSA");
    out = await addSignatureIncremental(out, {
      type: "DocTimeStamp",
      fieldName: `DocTimeStamp${Date.now()}`,
      signatureLength: 12_000,
      sign: (content) => requestTimestampToken(opts.tsaUrl!, sha256(content), opts.tsaAuthHeader),
    });
  }
  return { pdf: out, report: { level: opts.level, certs: data.certs.length, ocsps: data.ocsps.length, crls: data.crls.length, missingRevocation: missing } };
}

/** Segunda firma CAdES (p. ej. sello de empresa) como revisión incremental, con sello de tiempo si hay TSA. */
export async function addCadesSignatureIncremental(
  pdf: Uint8Array,
  provider: SignatureProvider,
  opts: { fieldName: string; reason?: string; name?: string; location?: string; tsaUrl?: string | null; tsaAuthHeader?: string | null },
): Promise<Uint8Array> {
  return addSignatureIncremental(pdf, {
    type: "Sig",
    fieldName: opts.fieldName,
    reason: opts.reason,
    name: opts.name,
    location: opts.location,
    signatureLength: 24_000,
    sign: (content) => buildPadesCms(content, provider, { tsaUrl: opts.tsaUrl ?? null, tsaAuthHeader: opts.tsaAuthHeader ?? null }),
  });
}

/** Nivel por defecto: B-LT si la cadena publica OCSP/CRL (si no, no hay qué incrustar), si no B-T. */
export function defaultSealLevel(chainDer: Uint8Array[], hasTsa: boolean): PadesLevel {
  if (!hasTsa) return "B-B";
  return hasRevocationInfo(chainDer) ? "B-LT" : "B-T";
}
