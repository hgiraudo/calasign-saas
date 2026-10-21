// Datos para la renovación de sellos de archivo (PAdES B-LTA): cuál es el último sello de tiempo del PDF
// (sello de documento o, si no hay, el de la firma) y hasta cuándo vale el certificado de su TSA. Cuando ese
// vencimiento se acerca hay que agregar DSS + un nuevo sello de documento (applyLtv con nivel B-LTA).
import { randomBytes } from "node:crypto";
import { requestTimestampToken } from "./cms";
import { sha256 } from "./provider";
import { commonName, nameToString, parseSignedData, signatureTimestamp, signerCertOf, tstInfoOf } from "./pki";
import { readPdfSignatures } from "./signatures";

export interface ArchiveTimestampInfo {
  /** Último sello de tiempo del documento (por fecha). null si el PDF no tiene ninguno. */
  last: { kind: "document_timestamp" | "signature_timestamp"; time: string; tsa: string | null; tsaNotAfter: string } | null;
  /** Cantidad de sellos de documento (ETSI.RFC3161). */
  documentTimestamps: number;
  /** El PDF tiene un /DSS (datos de validación incrustados: B-LT o superior). */
  hasDss: boolean;
}

export async function archiveTimestampInfo(pdf: Uint8Array): Promise<ArchiveTimestampInfo> {
  const { signatures, dss } = await readPdfSignatures(pdf);
  let last: ArchiveTimestampInfo["last"] = null;
  let docTs = 0;
  for (const s of signatures) {
    try {
      const sd = parseSignedData(s.contents);
      const token = s.type === "DocTimeStamp" ? sd : signatureTimestamp(sd);
      if (!token) continue;
      if (s.type === "DocTimeStamp") docTs++;
      const tsa = signerCertOf(token);
      if (!tsa) continue;
      const time = tstInfoOf(token).genTime;
      if (!last || time.getTime() >= new Date(last.time).getTime()) {
        last = {
          kind: s.type === "DocTimeStamp" ? "document_timestamp" : "signature_timestamp",
          time: time.toISOString(),
          tsa: commonName(tsa.subject) ?? nameToString(tsa.subject),
          tsaNotAfter: tsa.notAfter.value.toISOString(),
        };
      }
    } catch {
      // firma ilegible: la reporta el validador
    }
  }
  return { last, documentTimestamps: docTs, hasDss: Boolean(dss) };
}

/**
 * Hasta cuándo vale el certificado con el que la TSA firma HOY (pide un sello sobre un hash al azar). Sirve para no
 * "renovar" un archivo cuyo último sello ya es de ese mismo certificado: la renovación no extendería la validez.
 */
export async function tsaCertificateNotAfter(url: string, authHeader?: string | null): Promise<string> {
  const data = new Uint8Array(randomBytes(32));
  const token = await requestTimestampToken(url, sha256(data), authHeader, data);
  const cert = signerCertOf(parseSignedData(token));
  if (!cert) throw new Error("La TSA devolvió un sello sin su certificado");
  return cert.notAfter.value.toISOString();
}
