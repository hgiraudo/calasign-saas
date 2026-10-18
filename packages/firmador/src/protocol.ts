// Cliente del protocolo de firma remota de CalaSign (/v1/certsign/sessions/:code).
import { createHash } from "node:crypto";
import forge from "node-forge";
import type { CertEntry, CertSource, Prepared, SessionInfo, SignResult } from "./types";
import { assertOnlySignatureAdded } from "./pdfdiff";

export class CertsignError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Interpreta `calasign-firmador://sign?api=…&code=…` (o un código suelto). */
export function parseDeepLink(input: string): { api: string | null; code: string } | null {
  const s = input.trim();
  if (/^calasign-firmador:/i.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get("code");
      const api = u.searchParams.get("api");
      if (!code) return null;
      if (api && !/^https?:\/\//i.test(api)) return null;
      return { api: api ? api.replace(/\/$/, "") : null, code };
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(s)) return { api: null, code: s.toUpperCase() };
  return null;
}

/** https, o http solo contra esta misma computadora (pruebas). Se mira el host ya parseado: "http://localhost@otro" no pasa. */
function isAllowedApi(api: string): boolean {
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && !u.username && !u.password && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/**
 * Hosts en los que el Firmador confía sin preguntar: calasign.com y sus subdominios, esta computadora, y los que el
 * usuario o su organización declaren en CALASIGN_FIRMADOR_TRUSTED_HOSTS (separados por coma; "*.dominio" admite
 * subdominios; sirve para los dominios propios de los clientes). El link de firma lo arma quien lo envía: sin este
 * control, un servidor ajeno podría pedir la firma de un documento que el usuario nunca vio en CalaSign.
 */
export function apiHostTrusted(api: string, extra: string[] = envTrustedHosts()): boolean {
  let host: string;
  try {
    host = new URL(api).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return true;
  if (host === "calasign.com" || host.endsWith(".calasign.com")) return true;
  return extra.some((e) => {
    const h = e.trim().toLowerCase();
    if (!h) return false;
    return h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h;
  });
}

function envTrustedHosts(): string[] {
  return (process.env.CALASIGN_FIRMADOR_TRUSTED_HOSTS ?? "").split(",").filter(Boolean);
}

export function apiHost(api: string): string {
  try {
    return new URL(api).host;
  } catch {
    return api;
  }
}

export class CertsignClient {
  constructor(
    readonly api: string,
    readonly code: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!isAllowedApi(api)) {
      throw new CertsignError(0, "insecure_api", "La dirección de CalaSign tiene que ser https");
    }
  }

  private url(path = "") {
    return `${this.api.replace(/\/$/, "")}/v1/certsign/sessions/${encodeURIComponent(this.code)}${path}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(this.url(path), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new CertsignError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `HTTP ${res.status}`, data?.error?.details);
    return data as T;
  }

  info() {
    return this.call<SessionInfo>("GET", "");
  }

  async document(): Promise<Uint8Array> {
    const res = await this.fetcher(this.url("/document"), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new CertsignError(res.status, "document", `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** El PDF preparado por el servidor para esta firma (con el espacio reservado y el ByteRange). */
  async prepared(): Promise<Uint8Array> {
    const res = await this.fetcher(this.url("/prepared"), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new CertsignError(res.status, "prepared", `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  certificate(chainDer: Uint8Array[]) {
    return this.call<Prepared>("POST", "/certificate", { chain: chainDer.map((d) => Buffer.from(d).toString("base64")) });
  }

  signature(sig: Uint8Array) {
    return this.call<SignResult>("POST", "/signature", { signature: Buffer.from(sig).toString("base64") });
  }
}

/**
 * Ciclo completo: certificado → preparación → controles del documento → firma local → envío. La clave nunca sale
 * de `source`. Antes de firmar se comprueba, con bytes y no con lo que diga el servidor, que lo que se firma es el
 * documento anunciado (ver assertPreparedMatchesDocument).
 */
export async function signWithEntry(client: CertsignClient, source: CertSource, entry: CertEntry): Promise<{ prepared: Prepared; result: SignResult }> {
  const info = await client.info();
  const working = await client.document();
  const prepared = await client.certificate(entry.chainDer);
  assertSignedAttributes(prepared);
  const preparedPdf = await client.prepared();
  assertPreparedMatchesDocument({
    announcedSha256: info.documentSha256,
    workingPdf: working,
    preparedPdf,
    signedAttrsDer: new Uint8Array(Buffer.from(prepared.dataToSign, "base64")),
  });
  // Además de los bytes: la revisión nueva solo puede agregar la firma (no cambiar lo que el titular vio).
  await assertOnlySignatureAdded(working, preparedPdf);
  const sig = await source.sign(entry, {
    data: new Uint8Array(Buffer.from(prepared.dataToSign, "base64")),
    digest: new Uint8Array(Buffer.from(prepared.digestToSign, "base64")),
    algorithm: prepared.signatureAlgorithm,
  });
  const result = await client.signature(sig);
  return { prepared, result };
}

const ATTR = {
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
};
const ALLOWED_ATTRS = new Set(Object.values(ATTR));

/**
 * Lo que manda el servidor tiene que ser un conjunto de atributos firmados de CMS (contentType + messageDigest de
 * 32 bytes, nada más que atributos conocidos) y el hash tiene que ser su SHA-256. Así el Firmador no firma un hash
 * arbitrario aunque la dirección de CalaSign sea falsa (no sirve como "oráculo" para otros protocolos).
 */
export function assertSignedAttributes(p: Pick<Prepared, "dataToSign" | "digestToSign">): void {
  const data = Buffer.from(p.dataToSign, "base64");
  const digest = createHash("sha256").update(data).digest("base64");
  if (digest !== p.digestToSign) throw new CertsignError(0, "bad_prepared", "El servidor mandó un hash que no corresponde a los datos a firmar");
  let set: forge.asn1.Asn1;
  try {
    set = forge.asn1.fromDer(forge.util.createBuffer(data.toString("binary")), true);
  } catch {
    throw new CertsignError(0, "bad_prepared", "Los datos a firmar no son atributos de una firma CMS");
  }
  const U = forge.asn1.Class.UNIVERSAL;
  if (set.tagClass !== U || set.type !== forge.asn1.Type.SET || !Array.isArray(set.value)) {
    throw new CertsignError(0, "bad_prepared", "Los datos a firmar no son atributos de una firma CMS");
  }
  const seen = new Set<string>();
  let mdOk = false;
  for (const attr of set.value as forge.asn1.Asn1[]) {
    const parts = attr.value as forge.asn1.Asn1[];
    if (attr.type !== forge.asn1.Type.SEQUENCE || !Array.isArray(parts) || parts.length !== 2 || parts[0].type !== forge.asn1.Type.OID) {
      throw new CertsignError(0, "bad_prepared", "Atributo de firma inválido");
    }
    const oid = forge.asn1.derToOid(parts[0].value as string);
    if (!ALLOWED_ATTRS.has(oid) || seen.has(oid)) throw new CertsignError(0, "bad_prepared", `Atributo de firma no esperado: ${oid}`);
    seen.add(oid);
    if (oid === ATTR.messageDigest) {
      const v = (parts[1].value as forge.asn1.Asn1[])?.[0];
      mdOk = v?.type === forge.asn1.Type.OCTETSTRING && typeof v.value === "string" && v.value.length === 32;
    }
  }
  if (!seen.has(ATTR.contentType) || !mdOk) throw new CertsignError(0, "bad_prepared", "Faltan atributos obligatorios de la firma CMS");
}

/**
 * Vincula la firma con el documento. Con bytes, no con lo que diga el servidor:
 *  1. el PDF de trabajo descargado es el anunciado (su SHA-256 coincide con documentSha256);
 *  2. el PDF preparado empieza exactamente con esos bytes (la firma nueva es una revisión incremental agregada);
 *  3. el ByteRange de la revisión nueva cubre todo el archivo salvo el espacio de /Contents, que está en la
 *     revisión nueva y solo tiene dígitos hexadecimales;
 *  4. el SHA-256 de los bytes cubiertos es el messageDigest de los atributos que se van a firmar.
 * Si algo no coincide, el Firmador no firma.
 */
export function assertPreparedMatchesDocument(x: {
  announcedSha256: string;
  workingPdf: Uint8Array;
  preparedPdf: Uint8Array;
  signedAttrsDer: Uint8Array;
}): void {
  const fail = (m: string) => {
    throw new CertsignError(0, "document_mismatch", `No se firma: ${m}`);
  };
  const working = Buffer.from(x.workingPdf);
  const prepared = Buffer.from(x.preparedPdf);
  if (createHash("sha256").update(working).digest("hex") !== x.announcedSha256.toLowerCase()) {
    fail("el documento descargado no es el que anunció el servidor");
  }
  if (prepared.length <= working.length || !prepared.subarray(0, working.length).equals(working)) {
    fail("el documento preparado no conserva intacto el documento que se mostró");
  }
  // ByteRange de la revisión nueva (el último del archivo, después del documento original).
  const tail = prepared.subarray(working.length).toString("latin1");
  const matches = [...tail.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (matches.length !== 1) fail("el documento preparado no tiene un único ByteRange nuevo");
  const [a, b, c, d] = matches[0].slice(1, 5).map(Number);
  if (a !== 0 || b <= working.length || c <= b || c + d !== prepared.length) fail("el ByteRange no cubre el documento completo");
  if (prepared[b] !== 0x3c || prepared[c - 1] !== 0x3e) fail("el espacio de la firma no es una cadena hexadecimal");
  const hole = prepared.subarray(b + 1, c - 1).toString("latin1");
  if (!/^[0-9a-fA-F]*$/.test(hole)) fail("el espacio de la firma tiene contenido inesperado");
  const covered = createHash("sha256").update(prepared.subarray(a, a + b)).update(prepared.subarray(c, c + d)).digest();
  const md = messageDigestOf(x.signedAttrsDer);
  if (!md || !covered.equals(md)) fail("los datos a firmar no corresponden al documento");
}

/** messageDigest (32 bytes) de un SET de atributos firmados en DER, o null. */
function messageDigestOf(der: Uint8Array): Buffer | null {
  try {
    const set = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(der).toString("binary")), true);
    for (const attr of set.value as forge.asn1.Asn1[]) {
      const parts = attr.value as forge.asn1.Asn1[];
      if (forge.asn1.derToOid(parts[0].value as string) !== ATTR.messageDigest) continue;
      const v = (parts[1].value as forge.asn1.Asn1[])?.[0];
      if (v?.type === forge.asn1.Type.OCTETSTRING && typeof v.value === "string") return Buffer.from(v.value, "binary");
    }
  } catch {
    return null;
  }
  return null;
}
