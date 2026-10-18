// Controles sobre el certificado con el que firma un titular (firma con certificado propio):
// vigencia, usos de clave, emisor permitido, confianza y coincidencia con el documento de identidad declarado.
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { buildChain, commonName, fingerprint, isSelfSigned, issuedBy, nameToString, parseCert, serialHex, toAB } from "./pki";

const OID = {
  serialNumber: "2.5.4.5",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  /** ICP-Brasil, pessoa física: nascimento (8) + CPF (11) + NIS (11) + RG… */
  icpBrasilPf: "2.16.76.1.3.1",
  /** ICP-Brasil, pessoa jurídica: CNPJ. */
  icpBrasilCnpj: "2.16.76.1.3.3",
  /** ICP-Brasil, responsável pela PJ (mismo formato que PF). */
  icpBrasilResponsavel: "2.16.76.1.3.4",
};

/** EKU aceptables para firmar documentos (si el certificado declara EKU). */
const SIGNING_EKUS = new Set([
  "2.5.29.37.0", // anyExtendedKeyUsage
  "1.3.6.1.5.5.7.3.36", // documentSigning
  "1.3.6.1.5.5.7.3.4", // emailProtection (habitual en certificados de persona)
  "1.3.6.1.5.5.7.3.2", // clientAuth (e-CPF de ICP-Brasil y DNIe lo traen junto con firma)
  "1.2.840.113583.1.1.5", // Adobe Authentic Documents Trust
  "1.3.6.1.4.1.311.10.3.12", // Microsoft Document Signing
]);

export interface IdentityCandidate {
  source: "serialNumber" | "commonName" | "icp-brasil-cpf" | "icp-brasil-cnpj";
  value: string;
}

/** Números de identidad que trae el certificado (atributo serialNumber, CN, OIDs de ICP-Brasil). */
export function identityCandidates(certDer: Uint8Array): IdentityCandidate[] {
  const c = parseCert(certDer);
  const out: IdentityCandidate[] = [];
  for (const tv of c.subject.typesAndValues) {
    if (tv.type === OID.serialNumber) out.push({ source: "serialNumber", value: String(tv.value.valueBlock.value) });
  }
  const cn = commonName(c.subject);
  if (cn) out.push({ source: "commonName", value: cn });
  const san = c.extensions?.find((e) => e.extnID === OID.subjectAltName);
  if (san) {
    try {
      const names = (san.parsedValue as pkijs.AltName | undefined)?.altNames ?? pkijs.AltName.fromBER(toAB(new Uint8Array(san.extnValue.valueBlock.valueHexView))).altNames;
      for (const gn of names) {
        if (gn.type !== 0) continue; // otherName
        const seq = gn.value as asn1js.Sequence;
        const items = (seq?.valueBlock?.value ?? []) as asn1js.BaseBlock[];
        const oid = (items[0] as asn1js.ObjectIdentifier | undefined)?.valueBlock?.toString();
        const text = otherNameText(items[1]);
        if (!oid || !text) continue;
        if (oid === OID.icpBrasilPf || oid === OID.icpBrasilResponsavel) {
          const cpf = text.replace(/\D/g, "").slice(8, 19);
          if (/^\d{11}$/.test(cpf) && !/^0+$/.test(cpf)) out.push({ source: "icp-brasil-cpf", value: cpf });
        } else if (oid === OID.icpBrasilCnpj) {
          const cnpj = text.replace(/\D/g, "").slice(0, 14);
          if (/^\d{14}$/.test(cnpj)) out.push({ source: "icp-brasil-cnpj", value: cnpj });
        }
      }
    } catch {
      // SAN ilegible: se usan los demás candidatos.
    }
  }
  return out;
}

function otherNameText(b: asn1js.BaseBlock | undefined): string | null {
  // value [0] EXPLICIT, adentro un OCTET STRING o un string ASN.1.
  let v: any = b;
  for (let i = 0; i < 3 && v; i++) {
    if (v instanceof asn1js.OctetString) return Buffer.from(v.valueBlock.valueHexView).toString("latin1");
    if (typeof v.valueBlock?.value === "string") return v.valueBlock.value;
    v = Array.isArray(v.valueBlock?.value) ? v.valueBlock.value[0] : null;
  }
  return null;
}

/** Normaliza un número de documento: dígitos si tiene al menos 6; si no, alfanumérico en mayúsculas. */
export function normalizeIdNumber(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 6) return digits;
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * ¿Algún número del certificado coincide con el documento declarado? Compara grupos de dígitos (cédula RD
 * 001-1234567-8, CPF 123.456.789-09, DNI 12345678, CC 1.020.304.050, "PNOPE-12345678", "NOMBRE:12345678909").
 */
export function matchesIdDocument(declared: string, candidates: IdentityCandidate[]): IdentityCandidate | null {
  const want = normalizeIdNumber(declared);
  if (want.length < 5) return null;
  for (const c of candidates) {
    if (normalizeIdNumber(c.value) === want) return c;
    // Grupos de dígitos dentro del valor (CN "NOMBRE:CPF", serialNumber con prefijo ETSI "IDCCO-…", "PNOPE-…").
    for (const g of c.value.match(/\d[\d.\-\s]*\d/g) ?? []) {
      if (g.replace(/\D/g, "") === want) return c;
    }
    if (/^[A-Z0-9]+$/.test(want) && !/^\d+$/.test(want)) {
      const tokens = c.value.toUpperCase().split(/[^A-Z0-9]+/);
      if (tokens.includes(want)) return c;
    }
  }
  return null;
}

export interface CertificateCheckOptions {
  now?: Date;
  /** Si viene, el DN del emisor tiene que contener alguno (sin distinguir mayúsculas). */
  allowedIssuers?: string[] | null;
  /** Certificados raíz/intermedios de confianza (DER). */
  trustAnchors?: Uint8Array[];
  /** Exigir que la cadena llegue a un ancla de confianza. */
  requireTrusted?: boolean;
  /** Documento declarado del firmante: si viene, tiene que coincidir. */
  idDocumentNumber?: string | null;
}

export interface CertificateCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  subject: string;
  issuer: string;
  commonName: string | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
  trusted: boolean;
  /** Cadena ordenada desde el firmante (DER), completada con las anclas cuando hizo falta. */
  chainDer: Uint8Array[];
  identityMatch: IdentityCandidate | null;
}

export async function checkSigningCertificate(chainDerIn: Uint8Array[], o: CertificateCheckOptions = {}): Promise<CertificateCheck> {
  if (!chainDerIn.length) throw new Error("falta el certificado del firmante");
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = o.now ?? new Date();
  const leaf = parseCert(chainDerIn[0]);
  const pool = [...chainDerIn.slice(1), ...(o.trustAnchors ?? [])].map(parseCert);

  const notBefore = leaf.notBefore.value;
  const notAfter = leaf.notAfter.value;
  if (now < notBefore) errors.push("el certificado todavía no es válido");
  if (now > notAfter) errors.push("el certificado está vencido");

  const ku = leaf.extensions?.find((e) => e.extnID === OID.keyUsage);
  if (ku) {
    const bits = new Uint8Array((ku.parsedValue as asn1js.BitString | undefined)?.valueBlock?.valueHexView ?? []);
    const b0 = bits[0] ?? 0;
    // bit 0 digitalSignature (0x80), bit 1 nonRepudiation/contentCommitment (0x40).
    if (!(b0 & 0x80) && !(b0 & 0x40)) errors.push("el certificado no permite firmar (key usage)");
  }
  const eku = leaf.extensions?.find((e) => e.extnID === OID.extKeyUsage);
  if (eku) {
    const ids: string[] = ((eku.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? []).map(String);
    if (ids.length && !ids.some((x) => SIGNING_EKUS.has(x))) errors.push("el certificado no está habilitado para firmar documentos (extended key usage)");
  }
  if (leaf.extensions?.some((e) => e.extnID === "2.5.29.19" && (e.parsedValue as pkijs.BasicConstraints | undefined)?.cA)) {
    errors.push("es un certificado de autoridad certificante, no de una persona");
  }

  const issuer = nameToString(leaf.issuer);
  if (o.allowedIssuers?.length && !o.allowedIssuers.some((x) => issuer.toLowerCase().includes(x.toLowerCase()))) {
    errors.push("el emisor del certificado no está entre los permitidos para este sobre");
  }

  const chain = await buildChain(leaf, pool);
  const anchors = new Set((o.trustAnchors ?? []).map((d) => fingerprint(d)));
  let trusted = false;
  for (const c of chain) {
    if (anchors.has(fingerprint(new Uint8Array(c.toSchema(true).toBER(false))))) trusted = true;
  }
  if (!trusted && anchors.size) {
    const top = chain[chain.length - 1];
    for (const a of (o.trustAnchors ?? []).map(parseCert)) if (await issuedBy(top, a)) trusted = true;
  }
  if (!trusted) {
    if (o.requireTrusted) errors.push("el certificado no proviene de una autoridad certificante de confianza");
    else warnings.push(isSelfSigned(chain[chain.length - 1]) ? "la autoridad certificante no está en el almacén de confianza" : "no se pudo completar la cadena de certificación");
  }
  for (const c of chain.slice(1)) {
    if (now > c.notAfter.value) errors.push(`vencido en la cadena: ${commonName(c.subject) ?? nameToString(c.subject)}`);
  }

  let identityMatch: IdentityCandidate | null = null;
  if (o.idDocumentNumber) {
    identityMatch = matchesIdDocument(o.idDocumentNumber, identityCandidates(chainDerIn[0]));
    if (!identityMatch) errors.push("el certificado no corresponde al documento de identidad declarado del firmante");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    subject: nameToString(leaf.subject),
    issuer,
    commonName: commonName(leaf.subject),
    serialNumber: serialHex(leaf),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    sha256: fingerprint(chainDerIn[0]),
    trusted,
    chainDer: chain.map((c) => new Uint8Array(c.toSchema(true).toBER(false))),
    identityMatch,
  };
}
