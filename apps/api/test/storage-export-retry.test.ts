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

describe("OneDrive/SharePoint: reintento reutiliza por ruta si el hash coincide", () => {
  const bytes = new TextEncoder().encode("%PDF-graph");
  const opts = { envelopeId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", kind: "pdf" as const, retry: true, legacyName: "C - 0199aaaa.pdf" };

  it("quickXorHash: vacío y determinista; distinto con otro contenido", async () => {
    const { quickXorHash } = await import("../src/modules/storage-export");
    expect(quickXorHash(new Uint8Array())).toBe(Buffer.alloc(20).toString("base64"));
    expect(quickXorHash(bytes)).toBe(quickXorHash(new TextEncoder().encode("%PDF-graph")));
    expect(quickXorHash(bytes)).not.toBe(quickXorHash(new TextEncoder().encode("%PDF-graph2")));
    // El largo entra en los últimos 8 bytes (little endian, XOR): 1 byte 0x00 → solo el largo.
    const one = Buffer.from(quickXorHash(new Uint8Array([0])), "base64");
    expect([...one.subarray(12)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    // Un byte en la posición 0 queda en los bits bajos del primer bloque.
    expect(Buffer.from(quickXorHash(new Uint8Array([0xab])), "base64")[0]).toBe(0xab);
  });

  it("mismo quickXorHash en la ruta (empresas): reutiliza sin subir", async () => {
    const { quickXorHash, uploadSharepoint } = await import("../src/modules/storage-export");
    const calls = mockFetch((url, init) =>
      !init.method || init.method === "GET" ? json(200, { id: "i1", webUrl: "https://sp/i1", size: bytes.length, file: { hashes: { quickXorHash: quickXorHash(bytes) } } }) : json(500, "no"),
    );
    const r = await uploadSharepoint(creds, { driveId: "d1", folder: "F/2026" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("https://sp/i1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/drives/d1/root:/F/2026/C.pdf?");
  });

  it("otro contenido (o nada) en la ruta: sube con conflictBehavior=rename; busca también el nombre anterior", async () => {
    const { uploadOnedrive } = await import("../src/modules/storage-export");
    const calls = mockFetch((url, init) => {
      if (init.method === "PUT") return json(201, { id: "n1", webUrl: "https://od/n1" });
      return url.includes("/C.pdf?") ? json(200, { id: "o1", size: bytes.length, file: { hashes: { sha256Hash: "ABC" } } }) : json(404, { error: { code: "itemNotFound" } });
    });
    const r = await uploadOnedrive(creds, { folder: "F" }, "C.pdf", bytes, "application/pdf", undefined, opts);
    expect(r.ref).toBe("https://od/n1");
    expect(calls.filter((c) => !c.init.method).map((c) => decodeURIComponent(c.url.split("root:/")[1].split("?")[0]))).toEqual(["F/C.pdf", "F/C - 0199aaaa.pdf"]);
    expect(calls.find((c) => c.init.method === "PUT")!.url).toContain("conflictBehavior=rename");
  });

  it("sha256Hash igual (OneDrive personal): reutiliza; primer intento: no consulta", async () => {
    const { uploadOnedrive } = await import("../src/modules/storage-export");
    const hex = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    let calls = mockFetch(() => json(200, { id: "o1", webUrl: "https://od/o1", size: bytes.length, file: { hashes: { sha256Hash: hex } } }));
    expect((await uploadOnedrive(creds, {}, "C.pdf", bytes, "application/pdf", undefined, opts)).ref).toBe("https://od/o1");
    expect(calls).toHaveLength(1);
    calls = mockFetch(() => json(201, { id: "n1", webUrl: "https://od/n1" }));
    await uploadOnedrive(creds, {}, "C.pdf", bytes, "application/pdf", undefined, { ...opts, retry: false });
    expect(calls.map((c) => c.init.method)).toEqual(["PUT"]);
  });
});

describe("Box: nombre ocupado por el mismo archivo", () => {
  const bytes = new TextEncoder().encode("%PDF-box");
  const sha1 = createHash("sha1").update(bytes).digest("hex");

  it("409 con el mismo sha1: reutiliza el existente sin subir otra copia", async () => {
    const { uploadBox } = await import("../src/modules/storage-export");
    const calls = mockFetch(() => json(409, { code: "item_name_in_use", context_info: { conflicts: { type: "file", id: "77", sha1 } } }));
    const r = await uploadBox(creds, { folderId: "5", folder: "F" }, "C.pdf", bytes, "application/pdf");
    expect(r.ref).toBe("box:77");
    expect(calls).toHaveLength(1);
  });

  it("409 con otro contenido: sube con sufijo", async () => {
    const { uploadBox } = await import("../src/modules/storage-export");
    let n = 0;
    const calls = mockFetch(() => (n++ === 0 ? json(409, { context_info: { conflicts: [{ id: "77", sha1: "otro" }] } }) : json(201, { entries: [{ id: "78" }] })));
    const r = await uploadBox(creds, { folderId: "5", folder: "F" }, "C.pdf", bytes, "application/pdf");
    expect(r.ref).toBe("box:78");
    expect(calls).toHaveLength(2);
  });
});

describe("Drive: carpeta como ruta o como id", () => {
  const bytes = new TextEncoder().encode("%PDF-d");

  it("«Contratos/2026» crea cada carpeta dentro de la anterior", async () => {
    const { uploadGdrive } = await import("../src/modules/storage-export");
    const created: any[] = [];
    const calls = mockFetch((url, init) => {
      if (url.includes("/drive/v3/files?q=")) return json(200, { files: [] });
      if (init.method === "POST" && url.includes("/drive/v3/files?fields=id")) {
        const b = JSON.parse(String(init.body));
        created.push(b);
        return json(200, { id: `id-${b.name}` });
      }
      return json(200, { id: "up", webViewLink: "https://d/up" });
    });
    const r = await uploadGdrive(creds, { folder: "Contratos/2026" }, "C.pdf", bytes, "application/pdf");
    expect(created).toEqual([
      { name: "Contratos", mimeType: "application/vnd.google-apps.folder" },
      { name: "2026", mimeType: "application/vnd.google-apps.folder", parents: ["id-Contratos"] },
    ]);
    const q2 = decodeURIComponent(calls.filter((c) => c.url.includes("?q="))[1].url);
    expect(q2).toContain("'id-Contratos' in parents");
    expect(r.config).toEqual({ folderId: "id-2026" });
  });

  it("un id de carpeta que la app ve (también de una unidad compartida) se usa tal cual; si no la ve, error claro", async () => {
    const { uploadGdrive } = await import("../src/modules/storage-export");
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    let calls = mockFetch((url) =>
      url.includes(`/files/${id}?`) ? json(200, { id, mimeType: "application/vnd.google-apps.folder", trashed: false }) : json(200, { id: "up", webViewLink: "https://d/up" }),
    );
    let r = await uploadGdrive(creds, { folder: id }, "C.pdf", bytes, "application/pdf");
    expect(r.config).toEqual({ folderId: id });
    expect(calls.some((c) => c.url.includes("?q="))).toBe(false);
    // Todas las llamadas a Drive aceptan unidades compartidas.
    expect(calls.every((c) => c.url.includes("supportsAllDrives=true"))).toBe(true);
    calls = mockFetch((url, init) => {
      if (url.includes(`/files/${id}?`)) return json(404, { error: { message: "not found" } });
      if (url.includes("?q=")) return json(200, { files: [{ id: "byname" }] });
      return init.method === "POST" ? json(200, { id: "up" }) : json(500, "no");
    });
    // Un id suelto que la app no ve: el mismo error que una URL (antes creaba o usaba una carpeta llamada como el id).
    await expect(uploadGdrive(creds, { folder: id }, "C.pdf", bytes, "application/pdf")).rejects.toThrow(/no tiene acceso/);
    expect(calls.some((c) => c.url.includes("?q=") || c.init.method === "POST")).toBe(false);
    // Como URL (…/folders/<id>): si la app no la ve, falla en vez de crear carpetas con los pedazos de la URL.
    await expect(uploadGdrive(creds, { folder: `https://drive.google.com/drive/folders/${id}` }, "C.pdf", bytes, "application/pdf")).rejects.toThrow(/no tiene acceso/);
  });
});

describe("revocación de tokens al desconectar", () => {
  it("Google revoca el refresh token; Dropbox con el access token; Box con client_id/secret; Microsoft se omite", async () => {
    const { revokeProviderToken } = await import("../src/modules/storage-export");
    Object.assign(process.env, { BOX_CLIENT_ID: "bid", BOX_CLIENT_SECRET: "bsec" });
    const calls = mockFetch(() => json(200, {}));
    expect(await revokeProviderToken("gdrive", { access_token: "a", refresh_token: "r", expires_at: 0 })).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(calls[0].init.body)).toBe("token=r");
    expect(await revokeProviderToken("dropbox", { access_token: "a", expires_at: Date.now() + 3_600_000 })).toEqual({ ok: true });
    expect(calls[1].url).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
    expect((calls[1].init.headers as any).authorization).toBe("Bearer a");
    expect(await revokeProviderToken("box", { access_token: "a", refresh_token: "r", expires_at: 0 })).toEqual({ ok: true });
    expect(calls[2].url).toContain("/oauth2/revoke");
    expect(Object.fromEntries(new URLSearchParams(String(calls[2].init.body)))).toEqual({ client_id: "bid", client_secret: "bsec", token: "r" });
    expect(await revokeProviderToken("onedrive", { access_token: "a", expires_at: 0 })).toEqual({ ok: true, skipped: true });
    expect(calls).toHaveLength(3);
    // Nunca lanza: un error queda en el resultado (para el log).
    mockFetch(() => json(503, "caído"));
    expect(await revokeProviderToken("gdrive", { refresh_token: "r" })).toEqual({ ok: false, error: "HTTP 503" });
  });
});
