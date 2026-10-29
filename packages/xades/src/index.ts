// Firma XML enveloped: XMLDSig, XAdES-BES y XAdES-EPES (ETSI TS 101 903 v1.3.2), con perfiles para
// facturación electrónica de RD (DGII e-CF), Colombia (DIAN) y Perú (SUNAT CPE). La canonicalización (C14N 1.0 inclusiva y
// exclusiva) es la de xml-crypto; la firma la hace un XmlSigner (compatible con SignatureProvider), así la
// clave puede estar en KMS, en un HSM, en un prestador CSC o cifrada en la base.
import { createHash, createVerify, randomUUID, X509Certificate } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { C14nCanonicalization, ExclusiveCanonicalization, type NamespacePrefix } from "xml-crypto";

export const NS = {
  ds: "http://www.w3.org/2000/09/xmldsig#",
  xades: "http://uri.etsi.org/01903/v1.3.2#",
  xades141: "http://uri.etsi.org/01903/v1.4.1#",
  ublExt: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

export const ALG = {
  c14n: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  excC14n: "http://www.w3.org/2001/10/xml-exc-c14n#",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  sha512: "http://www.w3.org/2001/04/xmlenc#sha512",
  signedProps: "http://uri.etsi.org/01903#SignedProperties",
};

export type XmlProfile = "xades-bes" | "xades-epes" | "dian-fe" | "dgii-ecf" | "sunat-cpe";
export type XmlSignatureAlgorithm = "rsa-sha256" | "rsa-sha1";

export interface XmlSigner {
  /** DER: [firmante, intermedias…]. */
  certificateChain(): Promise<Uint8Array[]>;
  /** RSA PKCS#1 v1.5 sobre un digest SHA-256. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /** RSA PKCS#1 v1.5 sobre un digest SHA-1. Solo hace falta para perfiles que exigen RSA-SHA1 (SUNAT). */
  signDigestSha1?(digest: Uint8Array): Promise<Uint8Array>;
}

export interface SignaturePolicy {
  identifier: string;
  description?: string;
  /** Hash del documento de política, en base64. */
  hashBase64: string;
  hashAlgorithm?: "sha256" | "sha512";
}

export interface XmlSignOptions {
  profile: XmlProfile;
  /** Requerida para xades-epes; dian-fe trae una por defecto (configurable). */
  policy?: SignaturePolicy | null;
  signerRole?: string | null;
  signingTime?: Date;
  /** Desfase horario a usar en SigningTime (ej. "-05:00"). Por defecto UTC ("Z"). */
  timeZoneOffset?: string | null;
  canonicalization?: "c14n" | "exc-c14n";
  digest?: "sha256" | "sha512";
  /** Incluir todos los certificados de la cadena en KeyInfo (por defecto solo el firmante). */
  includeChain?: boolean;
  /** Algoritmo de firma y de digest. Por defecto RSA-SHA256; sunat-cpe usa RSA-SHA1 (guía UBL 2.1 de SUNAT). */
  signatureAlgorithm?: XmlSignatureAlgorithm;
  /** Id de ds:Signature. sunat-cpe lo toma de cac:Signature/cbc:ID (o usa "SignatureSP"). */
  signatureId?: string;
}

/**
 * Política de firma DIAN v2. SUPUESTO a confirmar contra el Anexo Técnico vigente de la DIAN:
 * identificador y hash del PDF de la política publicados por la DIAN. Configurable por tenant.
 */
export const DIAN_POLICY_V2: SignaturePolicy = {
  identifier: "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf",
  description: "Política de firma para facturas electrónicas de la República de Colombia.",
  hashBase64: "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=",
  hashAlgorithm: "sha256",
};

interface ProfileDefaults {
  xades: boolean;
  canonicalization: "c14n" | "exc-c14n";
  policy: SignaturePolicy | null;
  signerRole: string | null;
  timeZoneOffset: string | null;
  keyInfoReference: boolean;
  dataObjectFormat: boolean;
  signatureAlgorithm: XmlSignatureAlgorithm;
  /** Dónde va ds:Signature: al final de la raíz o en un ext:ExtensionContent vacío (UBL). */
  placement: "root" | "ubl-last-empty" | "ubl-first-empty";
}

/**
 * Supuestos por perfil (ver docs/FIRMA-XML.md):
 * - dgii-ecf: XMLDSig enveloped (sin XAdES), C14N inclusiva, RSA-SHA256, firma al final del elemento raíz.
 * - dian-fe: XAdES-EPES 1.3.2 con política DIAN v2, rol "supplier", C14N inclusiva, firma dentro del
 *   último ext:ExtensionContent vacío (UBLExtensions), SigningTime con -05:00 y referencia a KeyInfo.
 * - sunat-cpe: XMLDSig enveloped (sin XAdES), C14N inclusiva, RSA-SHA1 y digest SHA-1 por defecto
 *   (como la guía de elaboración de documentos XML UBL 2.1 de SUNAT; configurable a RSA-SHA256),
 *   firma dentro del primer ext:ExtensionContent vacío y Id tomado de cac:Signature/cbc:ID.
 * - xades-bes / xades-epes: genéricos, C14N exclusiva, con DataObjectFormat.
 */
const PROFILES: Record<XmlProfile, ProfileDefaults> = {
  "dgii-ecf": {
    xades: false,
    canonicalization: "c14n",
    policy: null,
    signerRole: null,
    timeZoneOffset: null,
    keyInfoReference: false,
    dataObjectFormat: false,
    signatureAlgorithm: "rsa-sha256",
    placement: "root",
  },
  "dian-fe": {
    xades: true,
    canonicalization: "c14n",
    policy: DIAN_POLICY_V2,
    signerRole: "supplier",
    timeZoneOffset: "-05:00",
    keyInfoReference: true,
    dataObjectFormat: false,
    signatureAlgorithm: "rsa-sha256",
    placement: "ubl-last-empty",
  },
  "sunat-cpe": {
    xades: false,
    canonicalization: "c14n",
    policy: null,
    signerRole: null,
    timeZoneOffset: null,
    keyInfoReference: false,
    dataObjectFormat: false,
    signatureAlgorithm: "rsa-sha1",
    placement: "ubl-first-empty",
  },
  "xades-bes": {
    xades: true,
    canonicalization: "exc-c14n",
    policy: null,
    signerRole: null,
    timeZoneOffset: null,
    keyInfoReference: false,
    dataObjectFormat: true,
    signatureAlgorithm: "rsa-sha256",
    placement: "root",
  },
  "xades-epes": {
    xades: true,
    canonicalization: "exc-c14n",
    policy: null,
    signerRole: null,
    timeZoneOffset: null,
    keyInfoReference: false,
    dataObjectFormat: true,
    signatureAlgorithm: "rsa-sha256",
    placement: "root",
  },
};

const DIGEST_URI = { sha256: ALG.sha256, sha512: ALG.sha512, sha1: ALG.sha1 } as const;
const DIGEST_BY_URI: Record<string, "sha256" | "sha512" | "sha1"> = {
  [ALG.sha256]: "sha256",
  [ALG.sha512]: "sha512",
  "http://www.w3.org/2000/09/xmldsig#sha1": "sha1",
};

// ───────────────────────────── Utilidades DOM ─────────────────────────────

function ancestorNamespaces(node: Node): NamespacePrefix[] {
  const out: NamespacePrefix[] = [];
  const seen = new Set<string>();
  let cur = node.parentNode as Element | null;
  while (cur && cur.nodeType === 1) {
    const attrs = (cur as Element).attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) {
        const prefix = a.name === "xmlns" ? "" : a.name.slice(6);
        if (seen.has(prefix)) continue;
        seen.add(prefix);
        out.push({ prefix, namespaceURI: a.value });
      }
    }
    cur = cur.parentNode as Element | null;
  }
  // El prefijo vacío (namespace por defecto) lo maneja la opción defaultNs.
  return out.filter((n) => n.prefix !== "");
}

function inheritedDefaultNs(node: Node): string {
  let cur = node.parentNode as Element | null;
  while (cur && cur.nodeType === 1) {
    const v = (cur as Element).getAttribute("xmlns");
    if (v !== null && (cur as Element).hasAttribute("xmlns")) return v;
    cur = cur.parentNode as Element | null;
  }
  return "";
}

/** Canonicaliza un elemento dentro de su documento (con los namespaces heredados según el algoritmo). */
export function canonicalize(node: Node, algorithm: string): string {
  if (algorithm === ALG.excC14n) return new ExclusiveCanonicalization().process(node as Element, {});
  const out = new C14nCanonicalization().process(node as Element, { ancestorNamespaces: ancestorNamespaces(node) });
  // C14N inclusiva: el ápice del subconjunto lleva TODOS los namespaces en alcance, también el por defecto
  // heredado (xml-crypto no lo emite). Va primero porque "xmlns" ordena antes que "xmlns:*".
  const el = node as Element;
  const inherited = inheritedDefaultNs(node);
  if (inherited && !el.hasAttribute("xmlns") && el.prefix) {
    const open = `<${el.tagName}`;
    if (out.startsWith(open))
      return `${open} xmlns="${inherited.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}"${out.slice(open.length)}`;
  }
  return out;
}

/**
 * URI="" (el documento entero, sin comentarios): C14N del nodo documento. Además de la raíz incluye las instrucciones de
 * procesamiento que están fuera de ella (p. ej. <?xml-stylesheet?>), separadas por un salto de línea, como lo hacen
 * xmlsec y los validadores de la DIAN / SUNAT. Canonicalizando solo la raíz, un XML con una de esas instrucciones salía
 * con un digest que ningún validador externo reproducía. La declaración XML no es parte del documento canonicalizado
 * (xmldom la expone como una instrucción "xml").
 */
function canonicalizeDocument(doc: Document, algorithm: string): string {
  const root = doc.documentElement!;
  let before = "";
  let after = "";
  let afterRoot = false;
  for (let n = doc.firstChild; n; n = n.nextSibling) {
    if (n === root) {
      afterRoot = true;
      continue;
    }
    if (n.nodeType !== 7 || n.nodeName.toLowerCase() === "xml") continue;
    const data = (n as ProcessingInstruction).data;
    const pi = `<?${n.nodeName}${data ? ` ${data}` : ""}?>`;
    if (afterRoot) after += `\n${pi}`;
    else before += `${pi}\n`;
  }
  return before + canonicalize(root, algorithm) + after;
}

function findById(doc: Document, id: string): Element | null {
  const found = findAllById(doc, id);
  return found[0] ?? null;
}

function findAllById(doc: Document, id: string): Element[] {
  const all = doc.getElementsByTagName("*");
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.getAttribute("Id") === id || e.getAttribute("ID") === id || e.getAttribute("id") === id) out.push(e);
  }
  return out;
}

function firstChildNS(el: Element, ns: string, local: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === local) return n as Element;
  return null;
}

function descendantsNS(el: Element | Document, ns: string, local: string): Element[] {
  const list = el.getElementsByTagNameNS(ns, local);
  const out: Element[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function b64(data: Uint8Array | Buffer) {
  return Buffer.from(data).toString("base64");
}

function digest(alg: "sha256" | "sha512" | "sha1", data: string | Uint8Array) {
  return createHash(alg).update(data).digest();
}

/**
 * Nombre RFC 2253 a partir del DN que da node:crypto: una línea por RDN en orden del certificado, con los valores YA
 * escapados según RFC 2253 (OpenSSL con ASN1_STRFLGS_ESC_2253: `, + " \ < > ;`, # o espacio inicial y espacio final) y
 * los RDN multivaluados unidos con " + " (un "+" dentro de un valor sale como "\+"). Volver a escapar duplicaba las
 * barras ("O=Empresa\, S.A." → "O=Empresa\\\, S.A.") y X509IssuerName no coincidía con el emisor real del certificado.
 */
function rfc2253(dn: string): string {
  return dn
    .split("\n")
    .filter(Boolean)
    .reverse()
    .map((rdn) => rdn.split(" + ").reverse().join("+"))
    .join(",");
}

function formatTime(d: Date, offset: string | null): string {
  if (!offset || offset === "Z") return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return d.toISOString();
  const mins = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const local = new Date(d.getTime() + mins * 60_000).toISOString().replace("Z", "");
  return `${local}${offset}`;
}

/** Id que el UBL declara para su firma (cac:Signature/cbc:ID), usado por SUNAT como Id de ds:Signature. */
function ublSignatureId(doc: Document): string | null {
  const cac = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
  const cbc = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
  const sig = descendantsNS(doc, cac, "Signature")[0];
  const id = sig ? firstChildNS(sig, cbc, "ID")?.textContent?.trim() : null;
  return id || null;
}

// ───────────────────────────── Firma ─────────────────────────────

export async function signXml(xml: string, signer: XmlSigner, options: XmlSignOptions): Promise<string> {
  const p = PROFILES[options.profile];
  const c14nAlg = (options.canonicalization ?? p.canonicalization) === "exc-c14n" ? ALG.excC14n : ALG.c14n;
  const sigAlg: XmlSignatureAlgorithm = options.signatureAlgorithm ?? p.signatureAlgorithm;
  // Con RSA-SHA1 los digests de referencia también son SHA-1 (así lo pide SUNAT); si no, SHA-256 o el indicado.
  const dAlg: "sha256" | "sha512" | "sha1" = sigAlg === "rsa-sha1" ? "sha1" : (options.digest ?? "sha256");
  if (sigAlg === "rsa-sha1" && !signer.signDigestSha1) throw new Error("Este certificado o proveedor no puede firmar con RSA-SHA1");
  const dUri = DIGEST_URI[dAlg];
  const policy = options.policy !== undefined ? options.policy : p.policy;
  if (options.profile === "xades-epes" && !policy) throw new Error("XAdES-EPES requiere una política de firma");
  const role = options.signerRole !== undefined ? options.signerRole : p.signerRole;
  const signingTime = options.signingTime ?? new Date();

  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("XML inválido");

  const chain = await signer.certificateChain();
  const leaf = new X509Certificate(Buffer.from(chain[0]));
  if (leaf.publicKey.asymmetricKeyType !== "rsa") throw new Error("Solo certificados RSA");

  const uid = randomUUID();
  const ids = {
    sig: options.signatureId ?? (options.profile === "sunat-cpe" ? (ublSignatureId(doc) ?? "SignatureSP") : `xmldsig-${uid}`),
    ref0: `xmldsig-${uid}-ref0`,
    keyInfo: `xmldsig-${uid}-keyinfo`,
    signedProps: `xmldsig-${uid}-signedprops`,
    sigValue: `xmldsig-${uid}-sigvalue`,
    qualifying: `xmldsig-${uid}-qualifying`,
  };

  // 1) Digest del documento (transformación enveloped = el documento antes de insertar la firma).
  const docDigest = b64(digest(dAlg, canonicalizeDocument(doc, c14nAlg)));

  // 2) Armado de ds:Signature (sin espacios entre elementos: lo que se firma es exactamente esto).
  const certs = (options.includeChain ? chain : [chain[0]]).map((c) => `<ds:X509Certificate>${b64(c)}</ds:X509Certificate>`).join("");
  const xadesNs = p.xades ? ` xmlns:xades="${NS.xades}"` : "";
  let signedProps = "";
  if (p.xades) {
    const certDigest = b64(digest(dAlg, leaf.raw));
    const serialDec = BigInt(`0x${leaf.serialNumber}`).toString(10);
    const policyXml = policy
      ? `<xades:SignaturePolicyIdentifier><xades:SignaturePolicyId><xades:SigPolicyId><xades:Identifier>${esc(policy.identifier)}</xades:Identifier>${
          policy.description ? `<xades:Description>${esc(policy.description)}</xades:Description>` : ""
        }</xades:SigPolicyId><xades:SigPolicyHash><ds:DigestMethod Algorithm="${DIGEST_URI[policy.hashAlgorithm ?? "sha256"]}"/><ds:DigestValue>${esc(
          policy.hashBase64,
        )}</ds:DigestValue></xades:SigPolicyHash></xades:SignaturePolicyId></xades:SignaturePolicyIdentifier>`
      : "";
    const roleXml = role
      ? `<xades:SignerRole><xades:ClaimedRoles><xades:ClaimedRole>${esc(role)}</xades:ClaimedRole></xades:ClaimedRoles></xades:SignerRole>`
      : "";
    const dof = p.dataObjectFormat
      ? `<xades:SignedDataObjectProperties><xades:DataObjectFormat ObjectReference="#${ids.ref0}"><xades:MimeType>text/xml</xades:MimeType></xades:DataObjectFormat></xades:SignedDataObjectProperties>`
      : "";
    signedProps =
      `<ds:Object><xades:QualifyingProperties Id="${ids.qualifying}" Target="#${esc(ids.sig)}">` +
      `<xades:SignedProperties Id="${ids.signedProps}"><xades:SignedSignatureProperties>` +
      `<xades:SigningTime>${formatTime(signingTime, options.timeZoneOffset !== undefined ? options.timeZoneOffset : p.timeZoneOffset)}</xades:SigningTime>` +
      `<xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="${dUri}"/><ds:DigestValue>${certDigest}</ds:DigestValue></xades:CertDigest>` +
      `<xades:IssuerSerial><ds:X509IssuerName>${esc(rfc2253(leaf.issuer))}</ds:X509IssuerName><ds:X509SerialNumber>${serialDec}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate>` +
      `${policyXml}${roleXml}</xades:SignedSignatureProperties>${dof}</xades:SignedProperties></xades:QualifyingProperties></ds:Object>`;
  }
  const refs =
    `<ds:Reference Id="${ids.ref0}" URI=""><ds:Transforms><ds:Transform Algorithm="${ALG.enveloped}"/>` +
    (c14nAlg === ALG.excC14n ? `<ds:Transform Algorithm="${ALG.excC14n}"/>` : "") +
    `</ds:Transforms><ds:DigestMethod Algorithm="${dUri}"/><ds:DigestValue>${docDigest}</ds:DigestValue></ds:Reference>` +
    // Sin Transforms, un verificador canonicaliza con C14N inclusiva: con exc-c14n el digest se declara igual que en la
    // referencia a SignedProperties (si no, ni verifyXml ni un validador externo lo reproducían).
    (p.keyInfoReference
      ? `<ds:Reference URI="#${ids.keyInfo}">${
          c14nAlg === ALG.excC14n ? `<ds:Transforms><ds:Transform Algorithm="${ALG.excC14n}"/></ds:Transforms>` : ""
        }<ds:DigestMethod Algorithm="${dUri}"/><ds:DigestValue>KEYINFO</ds:DigestValue></ds:Reference>`
      : "") +
    (p.xades
      ? `<ds:Reference Type="${ALG.signedProps}" URI="#${ids.signedProps}">${
          c14nAlg === ALG.excC14n ? `<ds:Transforms><ds:Transform Algorithm="${ALG.excC14n}"/></ds:Transforms>` : ""
        }<ds:DigestMethod Algorithm="${dUri}"/><ds:DigestValue>SIGNEDPROPS</ds:DigestValue></ds:Reference>`
      : "");
  const sigXml =
    // El Id puede venir del propio XML (cac:Signature/cbc:ID en SUNAT): se escapa como cualquier atributo.
    `<ds:Signature xmlns:ds="${NS.ds}"${xadesNs} Id="${esc(ids.sig)}">` +
    `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${c14nAlg}"/><ds:SignatureMethod Algorithm="${sigAlg === "rsa-sha1" ? ALG.rsaSha1 : ALG.rsaSha256}"/>${refs}</ds:SignedInfo>` +
    `<ds:SignatureValue Id="${ids.sigValue}">SIGVALUE</ds:SignatureValue>` +
    `<ds:KeyInfo Id="${ids.keyInfo}"><ds:X509Data>${certs}</ds:X509Data></ds:KeyInfo>` +
    signedProps +
    `</ds:Signature>`;

  // 3) Ubicación: DIAN en el último ext:ExtensionContent vacío, SUNAT en el primero; si no, al final de la raíz.
  let parent: Element = root;
  if (p.placement !== "root") {
    const contents = descendantsNS(doc, NS.ublExt, "ExtensionContent").filter(
      (e) => !Array.from({ length: e.childNodes.length }, (_, i) => e.childNodes[i]).some((n) => n.nodeType === 1),
    );
    if (contents.length) parent = p.placement === "ubl-first-empty" ? contents[0] : contents[contents.length - 1];
    // Sin lugar para la firma no se la pone en la raíz: el XML saldría "firmado" pero la DIAN / SUNAT lo rechazan.
    else
      throw new Error(
        `El XML de ${options.profile === "sunat-cpe" ? "SUNAT" : "la DIAN"} necesita un ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent vacío para la firma`,
      );
  }
  const fragment = new DOMParser().parseFromString(sigXml, "text/xml").documentElement!;
  const sigEl = doc.importNode(fragment, true) as Element;
  parent.appendChild(sigEl);

  // 4) Digests de KeyInfo y SignedProperties, ya en su contexto de namespaces.
  const signedInfo = firstChildNS(sigEl, NS.ds, "SignedInfo")!;
  for (const ref of descendantsNS(signedInfo, NS.ds, "Reference")) {
    const uri = ref.getAttribute("URI") ?? "";
    if (!uri.startsWith("#")) continue;
    const target = findById(doc, uri.slice(1));
    if (!target) throw new Error(`referencia sin destino ${uri}`);
    const dv = firstChildNS(ref, NS.ds, "DigestValue")!;
    dv.textContent = b64(digest(dAlg, canonicalize(target, c14nAlg)));
  }

  // 5) Firma de SignedInfo.
  const siC14n = canonicalize(signedInfo, c14nAlg);
  const sig =
    sigAlg === "rsa-sha1"
      ? await signer.signDigestSha1!(new Uint8Array(digest("sha1", siC14n)))
      : await signer.signDigest(new Uint8Array(digest("sha256", siC14n)));
  firstChildNS(sigEl, NS.ds, "SignatureValue")!.textContent = b64(sig);

  // Un "\r" en el DOM solo puede venir de una referencia &#13; / &#xD; en el texto (el parser normaliza los saltos de
  // línea literales, y en los atributos xmldom ya lo escribe como &#13;). xmldom lo serializa literal en el texto, y
  // al volver a leer el XML firmado se normaliza a "\n": el digest calculado (C14N lo escribe &#xD;) no se reproducía
  // y la firma no verificaba, ni con verifyXml ni con un validador externo. Se escribe como referencia.
  return new XMLSerializer().serializeToString(doc).replace(/\r/g, "&#13;");
}

// ───────────────────────────── Verificación ─────────────────────────────

export interface XmlVerifyResult {
  valid: boolean;
  signatureValid: boolean;
  references: { uri: string; type: string | null; valid: boolean }[];
  signer: { subject: string; issuer: string; serialNumber: string; notAfter: string } | null;
  xades: { signingTime: string | null; signingCertificateMatches: boolean | null; policyIdentifier: string | null; signerRole: string | null } | null;
  errors: string[];
}

/** Verifica la primera ds:Signature del documento (enveloped). No valida la cadena de confianza. */
export function verifyXml(xml: string): XmlVerifyResult {
  const errors: string[] = [];
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const sigEl = descendantsNS(doc, NS.ds, "Signature")[0];
  if (!sigEl) return { valid: false, signatureValid: false, references: [], signer: null, xades: null, errors: ["sin ds:Signature"] };
  const signedInfo = firstChildNS(sigEl, NS.ds, "SignedInfo");
  // Una ds:Signature sin SignedInfo es inválida, no un error interno (/v1/xml/verify respondía 500).
  if (!signedInfo)
    return { valid: false, signatureValid: false, references: [], signer: null, xades: null, errors: ["ds:Signature sin ds:SignedInfo"] };
  const c14nAlg = firstChildNS(signedInfo, NS.ds, "CanonicalizationMethod")?.getAttribute("Algorithm") ?? ALG.c14n;
  const certB64 = descendantsNS(sigEl, NS.ds, "X509Certificate")[0]?.textContent?.replace(/\s+/g, "") ?? "";
  let cert: X509Certificate | null = null;
  try {
    cert = new X509Certificate(Buffer.from(certB64, "base64"));
  } catch {
    errors.push("certificado ilegible en KeyInfo");
  }

  const references: XmlVerifyResult["references"] = [];
  // SignedProperties que efectivamente cubre la firma (destino de su referencia): las propiedades se leen de ahí y no del
  // primer SignedProperties que aparezca, que podría ser uno agregado sin firmar dentro de otro ds:Object.
  let signedPropsTarget: Element | null = null;
  for (const ref of descendantsNS(signedInfo, NS.ds, "Reference")) {
    const uri = ref.getAttribute("URI") ?? "";
    const type = ref.getAttribute("Type");
    const algUri = firstChildNS(ref, NS.ds, "DigestMethod")?.getAttribute("Algorithm") ?? ALG.sha256;
    const alg = DIGEST_BY_URI[algUri] ?? "sha256";
    const expected = firstChildNS(ref, NS.ds, "DigestValue")?.textContent?.trim() ?? "";
    const transforms = descendantsNS(ref, NS.ds, "Transform").map((t) => t.getAttribute("Algorithm"));
    const refC14n = transforms.find((t) => t === ALG.excC14n || t === ALG.c14n) ?? ALG.c14n;
    let target: Element | null;
    let canonical: string | null = null;
    if (uri === "") {
      const clone = new DOMParser().parseFromString(xml, "text/xml");
      const s = descendantsNS(clone, NS.ds, "Signature")[0];
      if (transforms.includes(ALG.enveloped)) s?.parentNode?.removeChild(s);
      target = clone.documentElement;
      if (target) canonical = canonicalizeDocument(clone, refC14n);
    } else {
      // Un Id repetido permite "envolver" la firma (signature wrapping): la referencia apuntaría a un elemento y el
      // lector del documento leería el otro. Se rechaza.
      const matches = findAllById(doc, uri.replace(/^#/, ""));
      if (matches.length > 1) errors.push(`Id repetido en el documento: "${uri}"`);
      target = matches.length === 1 ? matches[0] : null;
      if (target) canonical = canonicalize(target, refC14n);
    }
    const valid = canonical !== null && b64(digest(alg, canonical)) === expected;
    if (!valid) errors.push(`digest no coincide en referencia "${uri}"`);
    if (valid && type === ALG.signedProps && target?.namespaceURI === NS.xades && target.localName === "SignedProperties")
      signedPropsTarget ??= target;
    references.push({ uri, type, valid });
  }

  let signatureValid = false;
  if (cert) {
    const value = Buffer.from(firstChildNS(sigEl, NS.ds, "SignatureValue")?.textContent?.replace(/\s+/g, "") ?? "", "base64");
    const sigMethod = firstChildNS(signedInfo, NS.ds, "SignatureMethod")?.getAttribute("Algorithm");
    const v = createVerify(sigMethod === ALG.rsaSha1 ? "RSA-SHA1" : "RSA-SHA256");
    v.update(canonicalize(signedInfo, c14nAlg));
    signatureValid = v.verify(cert.publicKey, value);
    if (!signatureValid) errors.push("SignatureValue no verifica");
  }

  let xades: XmlVerifyResult["xades"] = null;
  const sp = signedPropsTarget ?? descendantsNS(sigEl, NS.xades, "SignedProperties")[0];
  if (sp) {
    const certDigestEl = descendantsNS(sp, NS.xades, "CertDigest")[0];
    let matches: boolean | null = null;
    if (certDigestEl && cert) {
      const alg = DIGEST_BY_URI[firstChildNS(certDigestEl, NS.ds, "DigestMethod")?.getAttribute("Algorithm") ?? ""] ?? "sha256";
      matches = b64(digest(alg, cert.raw)) === firstChildNS(certDigestEl, NS.ds, "DigestValue")?.textContent?.trim();
      if (!matches) errors.push("SigningCertificate no corresponde al certificado de KeyInfo");
    }
    xades = {
      signingTime: descendantsNS(sp, NS.xades, "SigningTime")[0]?.textContent ?? null,
      signingCertificateMatches: matches,
      policyIdentifier: descendantsNS(sp, NS.xades, "Identifier")[0]?.textContent ?? null,
      signerRole: descendantsNS(sp, NS.xades, "ClaimedRole")[0]?.textContent ?? null,
    };
    if (!signedPropsTarget) errors.push("SignedProperties no está referenciado o no verifica");
    else if (descendantsNS(sigEl, NS.xades, "SignedProperties").some((e) => e !== signedPropsTarget))
      errors.push("hay más de un SignedProperties en la firma");
  }

  // La firma tiene que cubrir el documento entero (referencia URI="" con la transformación enveloped): una firma que
  // solo referencia elementos sueltos (KeyInfo, SignedProperties…) no prueba nada sobre el contenido del documento.
  const coversDocument = descendantsNS(signedInfo, NS.ds, "Reference").some(
    (ref) =>
      (ref.getAttribute("URI") ?? "") === "" && descendantsNS(ref, NS.ds, "Transform").some((t) => t.getAttribute("Algorithm") === ALG.enveloped),
  );
  if (!coversDocument) errors.push('la firma no cubre el documento completo (falta la referencia URI="" enveloped)');

  return {
    valid: errors.length === 0 && signatureValid && references.every((r) => r.valid),
    signatureValid,
    references,
    signer: cert
      ? {
          subject: cert.subject.replace(/\n/g, ", "),
          issuer: cert.issuer.replace(/\n/g, ", "),
          serialNumber: cert.serialNumber,
          notAfter: new Date(cert.validTo).toISOString(),
        }
      : null,
    xades,
    errors,
  };
}
