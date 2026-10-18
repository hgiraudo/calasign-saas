// Cliente de la Cloud Signature Consortium API v2 (CSC): firma remota con certificados custodiados por
// un prestador (QTSP, ECD acreditada por ONAC, AC de ICP-Brasil, la CA de Calasign…). Implementa
// SignatureProvider: el documento no sale de CalaSign, solo el hash.
import { X509Certificate, constants, publicDecrypt, timingSafeEqual } from "node:crypto";
import type { SignatureProvider } from "./provider";

export type CscAuth =
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | { type: "oauth2_client"; tokenUrl: string; clientId: string; clientSecret: string; scope?: string };

export interface CscConfig {
  /** Identificador del conector (ej. "calasign-ca", "csc:icp-brasil-ac-x"). */
  id: string;
  /** URL base de la API, terminada en /csc/v2 (sin barra final). */
  baseUrl: string;
  auth: CscAuth;
  credentialId?: string | null;
  /** PIN o código para credentials/authorize (SCAL1/SCAL2 según el prestador). */
  pin?: string | null;
  otp?: string | null;
  level?: "simple" | "advanced" | "qualified";
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class CscError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const SHA256_OID = "2.16.840.1.101.3.4.2.1";
const SHA256_RSA_OID = "1.2.840.113549.1.1.11";

export class CscClient {
  private token: string | null = null;
  constructor(private readonly cfg: CscConfig) {}

  private get f() {
    return this.cfg.fetcher ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const a = this.cfg.auth;
    if (a.type === "bearer") return (this.token = a.token);
    if (a.type === "basic") {
      const res = await this.f(`${this.cfg.baseUrl}/auth/login`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ rememberMe: false }),
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) throw new CscError("CSC auth/login falló", res.status, body);
      return (this.token = body.access_token as string);
    }
    const res = await this.f(a.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: a.clientId, client_secret: a.clientSecret, ...(a.scope ? { scope: a.scope } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new CscError("OAuth2 client_credentials falló", res.status, body);
    return (this.token = body.access_token as string);
  }

  async call<T = any>(path: string, payload: Record<string, unknown>): Promise<T> {
    const res = await this.f(`${this.cfg.baseUrl}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new CscError(`CSC ${path}: ${body?.error_description ?? body?.error ?? res.status}`, res.status, body);
    return body as T;
  }

  info() {
    return this.call<{ specs?: string; name?: string; methods?: string[] }>("info", {});
  }

  async listCredentials(): Promise<string[]> {
    const r = await this.call<{ credentialIDs: string[] }>("credentials/list", { maxResults: 50 });
    return r.credentialIDs ?? [];
  }

  async credentialInfo(credentialID: string) {
    return this.call<{ cert: { certificates?: string[]; status?: string; subjectDN?: string }; key?: { algo?: string[]; status?: string }; authMode?: string }>(
      "credentials/info",
      { credentialID, certificates: "chain", certInfo: true },
    );
  }

  async authorize(credentialID: string, hashesB64: string[]): Promise<string> {
    const r = await this.call<{ SAD: string }>("credentials/authorize", {
      credentialID,
      numSignatures: hashesB64.length,
      hashes: hashesB64,
      hashAlgorithmOID: SHA256_OID,
      ...(this.cfg.pin ? { PIN: this.cfg.pin } : {}),
      ...(this.cfg.otp ? { OTP: this.cfg.otp } : {}),
    });
    if (!r.SAD) throw new CscError("CSC credentials/authorize no devolvió SAD");
    return r.SAD;
  }

  async signHash(credentialID: string, SAD: string, hashesB64: string[]): Promise<string[]> {
    const r = await this.call<{ signatures: string[] }>("signatures/signHash", {
      credentialID,
      SAD,
      hashes: hashesB64,
      hashAlgo: SHA256_OID,
      signAlgo: SHA256_RSA_OID,
    });
    return r.signatures ?? [];
  }
}

/** SignatureProvider sobre CSC v2. */
export class CscSignatureProvider implements SignatureProvider {
  readonly id: string;
  readonly level: "simple" | "advanced" | "qualified";
  readonly client: CscClient;
  private chain: Uint8Array[] | null = null;
  private credentialId: string | null;

  constructor(cfg: CscConfig) {
    this.id = cfg.id;
    this.level = cfg.level ?? "qualified";
    this.client = new CscClient(cfg);
    this.credentialId = cfg.credentialId ?? null;
  }

  private async credential(): Promise<string> {
    if (this.credentialId) return this.credentialId;
    const ids = await this.client.listCredentials();
    if (!ids.length) throw new CscError("El prestador no devolvió credenciales");
    return (this.credentialId = ids[0]);
  }

  async certificateChain(): Promise<Uint8Array[]> {
    if (this.chain) return this.chain;
    const info = await this.client.credentialInfo(await this.credential());
    const certs = info.cert?.certificates ?? [];
    if (!certs.length) throw new CscError("credentials/info sin certificados");
    return (this.chain = certs.map((b) => new Uint8Array(Buffer.from(b, "base64"))));
  }

  async signDigest(digest: Uint8Array): Promise<Uint8Array> {
    const id = await this.credential();
    const h = Buffer.from(digest).toString("base64");
    const sad = await this.client.authorize(id, [h]);
    const [sig] = await this.client.signHash(id, sad, [h]);
    if (!sig) throw new CscError("signatures/signHash no devolvió firma");
    const out = new Uint8Array(Buffer.from(sig, "base64"));
    // No se incrusta una firma que no corresponda al certificado de la credencial y al hash pedido.
    const [leaf] = await this.certificateChain();
    if (!verifyRsaSha256Digest(leaf, digest, out)) {
      throw new CscError("La firma devuelta por el prestador no corresponde al certificado de la credencial o al hash pedido");
    }
    return out;
  }
}

const SHA256_DIGEST_INFO = Buffer.from("3031300d060960864801650304020105000420", "hex");

/** Verifica una firma RSA PKCS#1 v1.5 sobre un digest SHA-256 ya calculado (lo que devuelve signHash con sha256WithRSA). */
export function verifyRsaSha256Digest(certDer: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = new X509Certificate(Buffer.from(certDer)).publicKey;
    if (key.asymmetricKeyType !== "rsa") return false;
    const decoded = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature));
    const expected = Buffer.concat([SHA256_DIGEST_INFO, Buffer.from(digest)]);
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  } catch {
    return false;
  }
}
