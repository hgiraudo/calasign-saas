import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CalaSign, CalaSignError, constructWebhookEvent, verifyWebhookSignature } from "../src/index";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** fetch simulado: responde con la lista dada, en orden, y registra los pedidos. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const r = responses.shift();
    if (!r) throw new Error("sin respuesta simulada");
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("reintentos e idempotencia", () => {
  it("reintenta un POST de creación ante 503 reutilizando la misma Idempotency-Key", async () => {
    const f = fakeFetch([json(503, { error: { code: "unavailable", message: "x" } }), json(201, { envelope: { id: "e1" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 2 });
    const r = await cs.envelopes.create({ subject: "Contrato" } as never);
    expect((r as any).envelope.id).toBe("e1");
    expect(f.calls).toHaveLength(2);
    const k1 = f.calls[0].headers["idempotency-key"];
    expect(k1).toBeTruthy();
    expect(f.calls[1].headers["idempotency-key"]).toBe(k1);
    expect(f.calls[0].headers.authorization).toBe("Bearer k");
  });

  it("respeta Retry-After en 429", async () => {
    const f = fakeFetch([json(429, {}, { "retry-after": "0.01" }), json(200, { items: [], nextCursor: null })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.list();
    expect(f.calls).toHaveLength(2);
  });

  it("no reintenta un POST sin idempotencia ante un error de red", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await expect(cs.envelopes.remind("e1")).rejects.toMatchObject({ code: "network_error" });
    expect(f.calls).toHaveLength(1);
  });

  it("errores de la API como CalaSignError con código y detalles", async () => {
    const f = fakeFetch([json(422, { error: { code: "envelope_incomplete", message: "Faltan firmantes", details: { problems: ["x"] } } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    const err = await cs.envelopes.send("e1").catch((e) => e);
    expect(err).toBeInstanceOf(CalaSignError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("envelope_incomplete");
    expect(err.details).toEqual({ problems: ["x"] });
    expect(f.calls[0].headers["idempotency-key"]).toBe("send-e1");
  });
});

describe("expectedUpdatedAt y void", () => {
  it("con expectedUpdatedAt no reintenta un PUT ante red/5xx, pero sí ante 503", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 2 });
    await expect(cs.envelopes.setFields("e1", [], { expectedUpdatedAt: "2026-01-01T00:00:00.000Z" })).rejects.toMatchObject({
      code: "network_error",
    });
    expect(f.calls).toHaveLength(1);
    const g = fakeFetch([json(500, { error: { code: "internal", message: "x" } })]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 2 });
    await expect(cs2.envelopes.update("e1", {} as never, { expectedUpdatedAt: "2026-01-01T00:00:00.000Z" })).rejects.toMatchObject({ status: 500 });
    expect(g.calls).toHaveLength(1);
    const h = fakeFetch([json(503, {}, { "retry-after": "0.01" }), json(200, { envelope: { id: "e1" } })]);
    const cs3 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: h.fn, maxRetries: 2 });
    await cs3.envelopes.setRecipients("e1", [], { expectedUpdatedAt: "2026-01-01T00:00:00.000Z" });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].headers["x-expected-updated-at"]).toBe("2026-01-01T00:00:00.000Z");
    // Sin expectedUpdatedAt el PUT sigue siendo reintentable ante red.
    const k = fakeFetch([new TypeError("fetch failed"), json(200, { envelope: { id: "e1" } })]);
    const cs4 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: k.fn, maxRetries: 2 });
    await cs4.envelopes.setFields("e1", []);
    expect(k.calls).toHaveLength(2);
  });

  it("void: un 409 not_voidable tras reintentar por 503 no se toma como anulado por el primer intento", async () => {
    const f = fakeFetch([json(503, {}, { "retry-after": "0.01" }), json(409, { error: { code: "not_voidable", message: "x" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 2 });
    await expect(cs.envelopes.void("e1", "r")).rejects.toMatchObject({ code: "not_voidable" });
    expect(f.calls).toHaveLength(2);
    const g = fakeFetch([
      json(502, {}, { "retry-after": "0.01" }),
      json(409, { error: { code: "not_voidable", message: "x" } }),
      json(200, { envelope: { id: "e1", status: "voided" } }),
    ]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 2 });
    const d = await cs2.envelopes.void("e1", "r");
    expect(d.envelope.status).toBe("voided");
    expect(g.calls[2].method).toBe("GET");
  });
});

describe("paginación", () => {
  it("iterate recorre todas las páginas con el cursor", async () => {
    const f = fakeFetch([json(200, { items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" }), json(200, { items: [{ id: "c" }], nextCursor: null })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    const ids: string[] = [];
    for await (const e of cs.envelopes.iterate({ status: ["sent", "completed"], limit: 2 })) ids.push(e.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(f.calls[0].url).toContain("status=sent%2Ccompleted");
    expect(f.calls[1].url).toContain("cursor=c1");
  });
});

describe("subida de documentos", () => {
  it("un Buffer chico de Node sube solo sus bytes, no el pool compartido", async () => {
    const pdf = Buffer.from("%PDF-1.4 chico\n%%EOF\n"); // sale del pool de 8 KB de Node
    const f = fakeFetch([json(201, { id: "d1" })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.uploadDocument("e1", pdf, "c.pdf");
    const sent = (f.calls[0].body as FormData).get("file") as Blob;
    expect(Buffer.from(await sent.arrayBuffer()).equals(pdf)).toBe(true);
    // Una vista sobre parte de otro buffer también sube solo su porción.
    const big = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const f2 = fakeFetch([json(201, { id: "d2" })]);
    await new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f2.fn }).envelopes.uploadDocument("e1", big.subarray(2, 4));
    expect([...new Uint8Array(await ((f2.calls[0].body as FormData).get("file") as Blob).arrayBuffer())]).toEqual([3, 4]);
  });
});

describe("OAuth client credentials", () => {
  it("pide el token, lo reutiliza y lo renueva ante un 401", async () => {
    const f = fakeFetch([
      json(200, { access_token: "csat_1", token_type: "Bearer", expires_in: 3600, scope: "envelopes:read" }),
      json(200, { user: {}, tenant: {} }),
      json(401, { error: { code: "unauthorized", message: "x" } }),
      json(200, { access_token: "csat_2", token_type: "Bearer", expires_in: 3600, scope: "envelopes:read" }),
      json(200, { user: {}, tenant: {} }),
    ]);
    const cs = new CalaSign({ oauth: { clientId: "csapp_x", clientSecret: "cssec_y" }, baseUrl: "http://api", fetch: f.fn });
    await cs.me();
    await cs.me();
    expect(f.calls[0].url).toBe("http://api/oauth/token");
    expect(f.calls[0].headers.authorization).toBe(`Basic ${Buffer.from("csapp_x:cssec_y").toString("base64")}`);
    expect(f.calls[1].headers.authorization).toBe("Bearer csat_1");
    expect(f.calls[4].headers.authorization).toBe("Bearer csat_2");
  });
});

describe("OAuth: error de red al pedir el token", () => {
  it("sale como CalaSignError network_error, como los demás errores de red", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const cs = new CalaSign({ oauth: { clientId: "c", clientSecret: "s" }, baseUrl: "http://api", fetch: f.fn, maxRetries: 0 });
    const err = await cs.me().catch((e) => e);
    expect(err).toBeInstanceOf(CalaSignError);
    expect(err.code).toBe("network_error");
  });
});

describe("verificación de webhooks", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "envelope.completed", data: {} });
  const sign = (t: number, b = body) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")}`;
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);

  it("acepta una firma válida y devuelve el evento", () => {
    expect(constructWebhookEvent({ payload: body, header: sign(t), secret, now }).type).toBe("envelope.completed");
    expect(verifyWebhookSignature({ payload: Buffer.from(body), header: sign(t), secret, now })).toBe(true);
  });

  it("rechaza cuerpo alterado, secreto incorrecto, firma vieja y header ausente", () => {
    expect(verifyWebhookSignature({ payload: body.replace("completed", "voided"), header: sign(t), secret, now })).toBe(false);
    expect(verifyWebhookSignature({ payload: body, header: sign(t), secret: "otro", now })).toBe(false);
    expect(verifyWebhookSignature({ payload: body, header: sign(t - 600), secret, now })).toBe(false);
    expect(verifyWebhookSignature({ payload: body, header: null, secret, now })).toBe(false);
    expect(verifyWebhookSignature({ payload: body, header: "basura", secret, now })).toBe(false);
  });
});

describe("ids en la ruta", () => {
  it("un id con '..', '/' o '?' no cambia el pedido (se codifica como un segmento)", async () => {
    const f = fakeFetch([json(404, { error: { code: "not_found", message: "x" } }), json(404, { error: { code: "not_found", message: "x" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 0 });
    await expect(cs.envelopes.get("../webhooks")).rejects.toBeInstanceOf(CalaSignError);
    await expect(cs.webhooks.delete("../envelopes/e1?x=1")).rejects.toBeInstanceOf(CalaSignError);
    expect(new URL(f.calls[0].url).pathname).toBe("/v1/envelopes/..%2Fwebhooks");
    expect(f.calls[1].method).toBe("DELETE");
    expect(new URL(f.calls[1].url).pathname).toBe("/v1/webhooks/..%2Fenvelopes%2Fe1%3Fx%3D1");
  });
});

describe("sobre completo en una llamada", () => {
  it("con content arma multipart: payload JSON con file y una parte por PDF; con send", async () => {
    const f = fakeFetch([json(201, { envelope: { id: "e1", status: "sent" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.createAndSend({
      subject: "Contrato",
      documents: [{ content: new Uint8Array([37, 80, 68, 70]), name: "c.pdf" }, { url: "https://x/y.pdf" }],
      recipients: [{ name: "Ana", email: "ana@example.com" }],
    });
    const body = f.calls[0].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const payload = JSON.parse(String(body.get("payload")));
    expect(payload.send).toBe(true);
    expect(payload.documents).toEqual([{ name: "c.pdf", file: "document0" }, { url: "https://x/y.pdf" }]);
    expect((body.get("document0") as File).name).toBe("c.pdf");
    expect(f.calls[0].headers["idempotency-key"]).toBeTruthy();
  });

  it("sin content manda JSON", async () => {
    const f = fakeFetch([json(201, { envelope: { id: "e1" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.create({ subject: "Contrato", documents: [{ base64: "JVBERi0=" }] });
    expect(JSON.parse(String(f.calls[0].body)).documents[0].base64).toBe("JVBERi0=");
  });
});

describe("ampliaciones de la API", () => {
  it("acepta un header con dos v1 (rotación del secreto) si alguno coincide", () => {
    const body = "{}";
    const now = 1_800_000_000_000;
    const t = Math.floor(now / 1000);
    const mac = (k: string) => createHmac("sha256", k).update(`${t}.${body}`).digest("hex");
    const header = `t=${t},v1=${mac("nuevo")},v1=${mac("viejo")}`;
    expect(verifyWebhookSignature({ payload: body, header, secret: "viejo", now })).toBe(true);
    expect(verifyWebhookSignature({ payload: body, header, secret: "nuevo", now })).toBe(true);
    expect(verifyWebhookSignature({ payload: body, header, secret: "otro", now })).toBe(false);
  });

  it("envía los filtros de búsqueda y los de eventos", async () => {
    const f = fakeFetch([json(200, { items: [], nextCursor: null }), json(200, { items: [], nextCursor: "9", hasMore: false })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.list({ updatedFrom: new Date("2026-10-01T00:00:00Z"), metadata: { orderId: "A1" }, recipient: "ana@x.com" });
    const u = new URL(f.calls[0].url);
    expect(u.searchParams.get("updated_from")).toBe("2026-10-01T00:00:00.000Z");
    expect(u.searchParams.get("metadata[orderId]")).toBe("A1");
    expect(u.searchParams.get("recipient")).toBe("ana@x.com");
    const page = await cs.events.list({ after: "5", types: ["envelope.completed", "recipient.signed"] });
    const e = new URL(f.calls[1].url);
    expect(e.pathname).toBe("/v1/events");
    expect(e.searchParams.get("after")).toBe("5");
    expect(e.searchParams.get("types")).toBe("envelope.completed,recipient.signed");
    expect(page.nextCursor).toBe("9");
  });

  it("clone, batch y rotateSecret llaman a sus endpoints", async () => {
    const f = fakeFetch([
      json(201, { envelope: { id: "e2" } }),
      json(200, { action: "void", succeeded: 1, failed: 0, results: [] }),
      json(200, { webhook: {}, secret: "whsec_x" }),
    ]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await cs.envelopes.clone("e1", { includeValues: true });
    await cs.envelopes.batch({ action: "void", ids: ["e1"], reason: "x" });
    await cs.webhooks.rotateSecret("w1", { graceHours: 2 });
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/envelopes/e1/clone",
      "POST /v1/envelopes/batch",
      "POST /v1/webhooks/w1/rotate-secret",
    ]);
    expect(JSON.parse(String(f.calls[2].body))).toEqual({ graceHours: 2 });
  });
});

describe("idempotencia en curso, descargas y respuestas raras", () => {
  it("las esperas por idempotency_in_progress no gastan maxRetries; el error lleva la Idempotency-Key", async () => {
    const busy = () => json(409, { error: { code: "idempotency_in_progress", message: "en curso" } });
    const f = fakeFetch([busy(), busy(), json(201, { envelope: { id: "e1" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 0, idempotencyWaitMs: 5_000 });
    const r = await cs.envelopes.create({ subject: "x" } as never, { idempotencyKey: "idem-1" });
    expect((r as any).envelope.id).toBe("e1");
    expect(f.calls).toHaveLength(3);

    const g = fakeFetch([busy()]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 3, idempotencyWaitMs: 0 });
    const err = await cs2.envelopes.create({ subject: "x" } as never, { idempotencyKey: "idem-2" }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "idempotency_in_progress", idempotencyKey: "idem-2" });
  });

  it("un 2xx que no es JSON es invalid_response", async () => {
    const f = fakeFetch([new Response("<html>proxy</html>", { status: 200, headers: { "content-type": "text/html", "x-request-id": "req-9" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    await expect(cs.envelopes.get("e1")).rejects.toMatchObject({ code: "invalid_response", status: 200, requestId: "req-9" });
  });

  it("un corte al leer una descarga se reintenta en el GET y si no, es network_error", async () => {
    const broken = () =>
      new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    const f = fakeFetch([broken(), new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 1 });
    expect(Array.from(await cs.envelopes.downloadSigned("e1"))).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([broken()]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 0 });
    await expect(cs2.envelopes.downloadAttachment("e1", "f1")).rejects.toMatchObject({ code: "network_error" });
  });

  it("events.poll termina enseguida al cancelar, también durante la espera", async () => {
    const f = fakeFetch([json(200, { items: [{ id: "ev1", cursor: "c1" }], nextCursor: "c1", hasMore: false })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    const ac = new AbortController();
    const seen: string[] = [];
    const t0 = Date.now();
    const run = (async () => {
      for await (const ev of cs.events.poll({ intervalMs: 60_000, signal: ac.signal })) seen.push(ev.id);
    })();
    setTimeout(() => ac.abort(), 20);
    await run;
    expect(seen).toEqual(["ev1"]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("celdas (421 wrong_cell) y 503 no reintentables", () => {
  const wrongCell = (baseUrl: string | null) =>
    json(
      421,
      { error: { code: "wrong_cell", message: "otra región", details: { cell: "eu", baseUrl } } },
      baseUrl ? { location: `${baseUrl}/v1/x` } : {},
    );

  it("reintenta una vez contra details.baseUrl (también un POST sin idempotencia) y la recuerda", async () => {
    const f = fakeFetch([wrongCell("https://eu.calasign.com/"), json(200, { notified: 1 }), json(200, { items: [], nextCursor: null })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: f.fn, maxRetries: 0 });
    expect(await cs.envelopes.remind("e1")).toEqual({ notified: 1 });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.calasign.com/v1/envelopes/e1/remind", "https://eu.calasign.com/v1/envelopes/e1/remind"]);
    expect(cs.baseUrl).toBe("https://eu.calasign.com");
    await cs.envelopes.list({ limit: 5 });
    expect(f.calls[2].url).toBe("https://eu.calasign.com/v1/envelopes?limit=5");
  });

  it("si la otra celda también responde 421, o no hay baseUrl, lanza wrong_cell con cellBaseUrl", async () => {
    const f = fakeFetch([wrongCell("https://eu.calasign.com"), wrongCell("https://us.calasign.com")]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: f.fn });
    const err = await cs.envelopes.get("e1").catch((e) => e);
    expect(err).toBeInstanceOf(CalaSignError);
    expect(err.status).toBe(421);
    expect(err.code).toBe("wrong_cell");
    expect(err.cellBaseUrl).toBe("https://us.calasign.com");
    expect(f.calls).toHaveLength(2);
    const g = fakeFetch([wrongCell(null)]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: g.fn });
    const err2 = await cs2.envelopes.get("e1").catch((e) => e);
    expect(err2.code).toBe("wrong_cell");
    expect(err2.cellBaseUrl).toBeNull();
    expect(g.calls).toHaveLength(1);
    expect(cs2.baseUrl).toBe("https://api.calasign.com");
  });

  it("no pasa de https a http por un 421", async () => {
    const f = fakeFetch([wrongCell("http://eu.calasign.com")]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: f.fn });
    await expect(cs.envelopes.get("e1")).rejects.toMatchObject({ code: "wrong_cell" });
    expect(f.calls).toHaveLength(1);
    expect(cs.baseUrl).toBe("https://api.calasign.com");
  });

  it("pedidos concurrentes que reciben 421: el segundo reintenta contra la celda aunque el primero ya la cambió", async () => {
    // Los dos pedidos salen contra la celda original antes de que llegue el primer 421.
    const responses = [
      wrongCell("https://eu.calasign.com"),
      wrongCell("https://eu.calasign.com"),
      json(200, { envelope: { id: "e1" } }),
      json(200, { envelope: { id: "e2" } }),
    ];
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pending = 0;
    const fn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const r = responses.shift()!;
      if (calls.length <= 2) {
        if (++pending === 2) release();
        await gate;
      }
      return r;
    }) as typeof fetch;
    const cs = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: fn, maxRetries: 0 });
    const [a, b] = await Promise.all([cs.envelopes.get("e1"), cs.envelopes.get("e2")]);
    expect([a, b]).toEqual([{ envelope: { id: "e1" } }, { envelope: { id: "e2" } }]);
    expect(calls.slice(0, 2).every((u) => u.startsWith("https://api.calasign.com/"))).toBe(true);
    expect(calls.slice(2).every((u) => u.startsWith("https://eu.calasign.com/"))).toBe(true);
    expect(cs.baseUrl).toBe("https://eu.calasign.com");
  });

  it("solo sigue el 421 hacia el mismo dominio registrable o allowedCellHosts; followCellRedirects: false no lo sigue", async () => {
    // Otro dominio: no se sigue (la credencial no viaja ahí); el error trae cellBaseUrl.
    const f = fakeFetch([wrongCell("https://calasign.evil.com")]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: f.fn });
    const err = await cs.envelopes.get("e1").catch((e) => e);
    expect(err).toMatchObject({ status: 421, code: "wrong_cell" });
    expect(err.cellBaseUrl).toBe("https://calasign.evil.com");
    expect(f.calls).toHaveLength(1);
    expect(cs.baseUrl).toBe("https://api.calasign.com");
    // com.ar: el dominio registrable es calasign.com.ar (no com.ar).
    const g = fakeFetch([wrongCell("https://eu.calasign.com.ar"), json(200, { envelope: { id: "e1" } })]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com.ar", fetch: g.fn });
    await cs2.envelopes.get("e1");
    expect(cs2.baseUrl).toBe("https://eu.calasign.com.ar");
    const g2 = fakeFetch([wrongCell("https://otro.com.ar")]);
    const cs3 = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com.ar", fetch: g2.fn });
    await expect(cs3.envelopes.get("e1")).rejects.toMatchObject({ code: "wrong_cell" });
    expect(g2.calls).toHaveLength(1);
    // Tres etiquetas solo con ccTLD + segundo nivel genérico: api.ibm.com → ibm.com (antes "api.ibm.com" por "ibm" de 3 letras).
    const ibm = fakeFetch([wrongCell("https://eu.ibm.com"), json(200, { envelope: { id: "e1" } })]);
    const csIbm = new CalaSign({ apiKey: "k", baseUrl: "https://api.ibm.com", fetch: ibm.fn });
    await csIbm.envelopes.get("e1");
    expect(csIbm.baseUrl).toBe("https://eu.ibm.com");
    const uk = fakeFetch([wrongCell("https://eu.calasign.co.uk"), json(200, { envelope: { id: "e1" } })]);
    const csUk = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.co.uk", fetch: uk.fn });
    await csUk.envelopes.get("e1");
    expect(csUk.baseUrl).toBe("https://eu.calasign.co.uk");
    // Hosting compartido: b.herokuapp.com no es "el mismo dominio" que a.herokuapp.com; solo con allowedCellHosts.
    const hk = fakeFetch([wrongCell("https://b.herokuapp.com")]);
    const csHk = new CalaSign({ apiKey: "k", baseUrl: "https://a.herokuapp.com", fetch: hk.fn });
    await expect(csHk.envelopes.get("e1")).rejects.toMatchObject({ code: "wrong_cell", cellBaseUrl: "https://b.herokuapp.com" });
    expect(hk.calls).toHaveLength(1);
    const hk2 = fakeFetch([wrongCell("https://b.herokuapp.com"), json(200, { envelope: { id: "e1" } })]);
    const csHk2 = new CalaSign({ apiKey: "k", baseUrl: "https://a.herokuapp.com", fetch: hk2.fn, allowedCellHosts: ["b.herokuapp.com"] });
    await csHk2.envelopes.get("e1");
    expect(csHk2.baseUrl).toBe("https://b.herokuapp.com");
    // allowedCellHosts habilita otro dominio, también para el pedido de token OAuth.
    const h = fakeFetch([
      json(200, { access_token: "t1", expires_in: 3600 }),
      wrongCell("https://eu.calasign-cloud.net"),
      json(200, { envelope: { id: "e1" } }),
      json(401, { error: { code: "unauthorized", message: "x" } }),
      json(200, { access_token: "t2", expires_in: 3600 }),
      json(200, { envelope: { id: "e1" } }),
    ]);
    const cs4 = new CalaSign({
      oauth: { clientId: "c", clientSecret: "s" },
      baseUrl: "https://api.calasign.com",
      fetch: h.fn,
      allowedCellHosts: ["eu.calasign-cloud.net"],
    });
    await cs4.envelopes.get("e1");
    await cs4.envelopes.get("e1");
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.calasign.com/oauth/token",
      "https://api.calasign.com/v1/envelopes/e1",
      "https://eu.calasign-cloud.net/v1/envelopes/e1",
      "https://eu.calasign-cloud.net/v1/envelopes/e1",
      "https://eu.calasign-cloud.net/oauth/token",
      "https://eu.calasign-cloud.net/v1/envelopes/e1",
    ]);
    // followCellRedirects: false, ni siquiera dentro del mismo dominio.
    const k = fakeFetch([wrongCell("https://eu.calasign.com")]);
    const cs5 = new CalaSign({ apiKey: "k", baseUrl: "https://api.calasign.com", fetch: k.fn, followCellRedirects: false });
    const err5 = await cs5.envelopes.get("e1").catch((e) => e);
    expect(err5.cellBaseUrl).toBe("https://eu.calasign.com");
    expect(k.calls).toHaveLength(1);
  });

  it("503 ai_unavailable no se reintenta (el servidor no tiene IA configurada)", async () => {
    const f = fakeFetch([json(503, { error: { code: "ai_unavailable", message: "sin IA" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 3 });
    await expect(cs.envelopes.get("e1")).rejects.toMatchObject({ status: 503, code: "ai_unavailable" });
    expect(f.calls).toHaveLength(1);
  });

  it("503 wrong_cell (celda no configurada en ese despliegue) no se reintenta", async () => {
    const f = fakeFetch([json(503, { error: { code: "wrong_cell", message: "celda no configurada" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 3 });
    await expect(cs.envelopes.get("e1")).rejects.toMatchObject({ status: 503, code: "wrong_cell" });
    expect(f.calls).toHaveLength(1);
  });

  it("503 byok_key_unavailable no se reintenta; storage_unavailable y 503 sin código sí", async () => {
    const f = fakeFetch([json(503, { error: { code: "byok_key_unavailable", message: "clave", details: { keyArn: "arn" } } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 3 });
    const err = await cs.envelopes.get("e1").catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "byok_key_unavailable", details: { keyArn: "arn" } });
    expect(f.calls).toHaveLength(1);
    const g = fakeFetch([
      json(503, { error: { code: "storage_unavailable", message: "x" } }, { "retry-after": "0.01" }),
      json(503, {}, { "retry-after": "0.01" }),
      json(200, { envelope: { id: "e1" } }),
    ]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 3 });
    await cs2.envelopes.get("e1");
    expect(g.calls).toHaveLength(3);
  });

  it("expectedUpdatedAt en void, remind y send; void con expectedUpdatedAt no se reintenta ante 5xx", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const f = fakeFetch([json(500, { error: { code: "internal_error", message: "x" } })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn, maxRetries: 2 });
    await expect(cs.envelopes.void("e1", "r", { expectedUpdatedAt: at })).rejects.toMatchObject({ status: 500 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers["x-expected-updated-at"]).toBe(at);
    const g = fakeFetch([json(200, { notified: 1 }), json(200, { envelope: { id: "e1" } })]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn });
    await cs2.envelopes.remind("e1", { expectedUpdatedAt: new Date(at) });
    await cs2.envelopes.send("e1", { expectedUpdatedAt: at });
    expect(g.calls[0].headers["x-expected-updated-at"]).toBe(at);
    expect(g.calls[1].headers["x-expected-updated-at"]).toBe(at);
    expect(g.calls[1].headers["idempotency-key"]).toBe("send-e1");
  });

  it("webhooks.get pide el endpoint por id", async () => {
    const f = fakeFetch([json(200, { id: "w1", url: "https://x" })]);
    const cs = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: f.fn });
    expect((await cs.webhooks.get("w1")).id).toBe("w1");
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "http://api/v1/webhooks/w1" });
  });
});
