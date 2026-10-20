import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { legacySafeBaseName, safeBaseName } from "../src/modules/connectors/evidence-file";
import { dropboxContentHash, uploadDropbox, uploadGdrive } from "../src/modules/storage-export";

const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest();
const creds = { access_token: "tok", expires_at: Date.now() + 3_600_000 };
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Simula fetch con un manejador y registra las llamadas. */
function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = String(u);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

describe("nombre del archivo exportado", () => {
  it("lleva el id completo del sobre: dos sobres uuidv7 del mismo minuto con el mismo asunto no comparten nombre", () => {
    const a = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
    const b = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
    expect(safeBaseName("Contrato: ACME/2026", a)).toBe(`Contrato ACME 2026 - ${a}`);
    expect(safeBaseName("Contrato", a)).not.toBe(safeBaseName("Contrato", b));
    expect(legacySafeBaseName("Contrato", a)).toBe("Contrato - 0199aaaa");
    expect(safeBaseName("", a)).toBe(`documento - ${a}`);
  });
});

describe("content_hash de Dropbox", () => {
  it("SHA-256 de los SHA-256 de cada bloque de 4 MiB", () => {
    const small = new TextEncoder().encode("hola");
    expect(dropboxContentHash(small)).toBe(createHash("sha256").update(sha(small)).digest("hex"));
    const big = new Uint8Array(4 * 1024 * 1024 + 10).fill(7);
    const expected = createHash("sha256")
      .update(Buffer.concat([sha(big.subarray(0, 4 * 1024 * 1024)), sha(big.subarray(4 * 1024 * 1024))]))
      .digest("hex");
    expect(dropboxContentHash(big)).toBe(expected);
    expect(dropboxContentHash(new Uint8Array())).toBe(createHash("sha256").digest("hex"));
  });
});

describe("Dropbox: nunca pisa a ciegas", () => {
  const bytes = new TextEncoder().encode("%PDF-mio");
  const opts = { envelopeId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", kind: "pdf" as const, retry: true, legacyName: "C - 0199aaaa.pdf" };
  const argOf = (init: RequestInit) => JSON.parse(String((init.headers as any)["dropbox-api-arg"]));

  it("primer intento: add + autorename, sin consultar metadatos", async () => {
    const calls = mockFetch(() => json(200, { path_display: "/F/C.pdf" }));
    const r = await uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, { ...opts, retry: false });
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0].init)).toMatchObject({ path: "/F/C.pdf", mode: "add", autorename: true });
    expect(r.ref).toBe("dropbox:/F/C.pdf");
  });

  it("reintento con el mismo contenido en la ruta: lo reutiliza sin subir", async () => {
    const calls = mockFetch((url) => (url.endsWith("/get_metadata") ? json(200, { ".tag": "file", path_display: "/F/C.pdf", content_hash: dropboxContentHash(bytes) }) : json(500, "no")));
    const r = await uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("dropbox:/F/C.pdf");
    expect(calls.every((c) => c.url.endsWith("/get_metadata"))).toBe(true);
  });

  it("reintento con otro archivo en la ruta (de otro sobre): no lo pisa, sube con add + autorename", async () => {
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/get_metadata")) {
        const p = JSON.parse(String(init.body)).path;
        return p === "/F/C.pdf" ? json(200, { ".tag": "file", path_display: p, content_hash: "otro" }) : json(409, { error_summary: "path/not_found/.." });
      }
      return json(200, { path_display: "/F/C (1).pdf" });
    });
    const r = await uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    const meta = calls.filter((c) => c.url.endsWith("/get_metadata")).map((c) => JSON.parse(String(c.init.body)).path);
    expect(meta).toEqual(["/F/C.pdf", "/F/C - 0199aaaa.pdf"]);
    const up = calls.find((c) => c.url.endsWith("/files/upload"))!;
    expect(argOf(up.init)).toMatchObject({ mode: "add", autorename: true });
    expect(r.ref).toBe("dropbox:/F/C (1).pdf");
  });

  it("reintento en curso desde el formato de nombre anterior: reutiliza el archivo viejo si es el mismo", async () => {
    mockFetch((url, init) => {
      if (!url.endsWith("/get_metadata")) return json(500, "no");
      const p = JSON.parse(String(init.body)).path;
      return p === "/F/C - 0199aaaa.pdf" ? json(200, { ".tag": "file", path_display: p, content_hash: dropboxContentHash(bytes) }) : json(409, { error_summary: "path/not_found/" });
    });
    const r = await uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("dropbox:/F/C - 0199aaaa.pdf");
  });
});

describe("Dropbox: conexión sin files.metadata.read", () => {
  const bytes = new TextEncoder().encode("%PDF-mio");
  const opts = { envelopeId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", kind: "pdf" as const, retry: true, legacyName: "C - 0199aaaa.pdf" };

  it.each([
    [401, { error_summary: "missing_scope/..", error: { ".tag": "missing_scope", required_scope: "files.metadata.read" } }],
    [400, "Error in call to API function \"files/get_metadata\": Your app is not permitted to access this endpoint because it does not have the required scope 'files.metadata.read'."],
  ])("get_metadata %i por scope: sube igual (add + autorename) en vez de fallar", async (status, body) => {
    const calls = mockFetch((url) => (url.endsWith("/get_metadata") ? json(status, body) : json(200, { path_display: "/F/C.pdf" })));
    const r = await uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("dropbox:/F/C.pdf");
    expect(calls.filter((c) => c.url.endsWith("/get_metadata"))).toHaveLength(1);
    const up = calls.find((c) => c.url.endsWith("/files/upload"))!;
    expect(JSON.parse(String((up.init.headers as any)["dropbox-api-arg"]))).toMatchObject({ mode: "add", autorename: true });
  });

  it("un 401 que no es de scope (token inválido) sigue fallando", async () => {
    mockFetch(() => json(401, { error_summary: "invalid_access_token/.." }));
    await expect(uploadDropbox(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts)).rejects.toThrow(/HTTP 401/);
  });
});

describe("Drive: reintento reutiliza solo si coincide el sha256", () => {
  const bytes = new TextEncoder().encode("%PDF-mio");
  const mySha = createHash("sha256").update(bytes).digest("hex");
  const opts = { envelopeId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", kind: "pdf" as const, retry: true };

  it("mismo sha256 en appProperties: reutiliza", async () => {
    const calls = mockFetch(() => json(200, { files: [{ id: "f1", webViewLink: "https://d/f1", appProperties: { calasignSha256: mySha } }] }));
    const r = await uploadGdrive(creds, { folderId: "fold" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("https://d/f1");
    expect(calls).toHaveLength(1);
  });

  it("otro contenido (o sin sha256): reemplaza el contenido de ese archivo, sin crear otro", async () => {
    const calls = mockFetch((url, init) =>
      init.method === "PATCH" ? json(200, { id: "f1", webViewLink: "https://d/f1" }) : url.includes("/upload/") ? json(500, "no") : json(200, { files: [{ id: "f1", appProperties: {} }] }),
    );
    const r = await uploadGdrive(creds, { folderId: "fold" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("https://d/f1");
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(patch.url).toContain("/upload/drive/v3/files/f1?uploadType=multipart");
    expect(String(patch.init.body)).toContain(mySha);
    // El meta lleva el nombre actual: un archivo subido con el formato viejo de nombre queda renombrado.
    expect(String(patch.init.body)).toContain(`"name":"C.pdf"`);
  });

  it("primera subida: guarda el sha256 en appProperties", async () => {
    const calls = mockFetch(() => json(200, { id: "n1", webViewLink: "https://d/n1" }));
    await uploadGdrive(creds, { folderId: "fold" }, "C.pdf", bytes, "application/pdf", undefined, { ...opts, retry: false });
    expect(String(calls[0].init.body)).toContain(`"calasignSha256":"${mySha}"`);
  });
});
