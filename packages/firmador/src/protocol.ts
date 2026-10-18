// Cliente del protocolo de firma remota de CalaSign (/v1/certsign/sessions/:code).
import type { CertEntry, CertSource, Prepared, SessionInfo, SignResult } from "./types";

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

export class CertsignClient {
  constructor(
    readonly api: string,
    readonly code: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^https:\/\//i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(api)) {
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

  certificate(chainDer: Uint8Array[]) {
    return this.call<Prepared>("POST", "/certificate", { chain: chainDer.map((d) => Buffer.from(d).toString("base64")) });
  }

  signature(sig: Uint8Array) {
    return this.call<SignResult>("POST", "/signature", { signature: Buffer.from(sig).toString("base64") });
  }
}

/** Ciclo completo: certificado → preparación → firma local → envío. La clave nunca sale de `source`. */
export async function signWithEntry(client: CertsignClient, source: CertSource, entry: CertEntry): Promise<{ prepared: Prepared; result: SignResult }> {
  const prepared = await client.certificate(entry.chainDer);
  const sig = await source.sign(entry, {
    data: new Uint8Array(Buffer.from(prepared.dataToSign, "base64")),
    digest: new Uint8Array(Buffer.from(prepared.digestToSign, "base64")),
    algorithm: prepared.signatureAlgorithm,
  });
  const result = await client.signature(sig);
  return { prepared, result };
}
