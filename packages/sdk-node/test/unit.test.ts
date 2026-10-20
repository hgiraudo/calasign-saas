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
    await expect(cs.envelopes.setFields("e1", [], { expectedUpdatedAt: "2026-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "network_error" });
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
    const g = fakeFetch([json(502, {}, { "retry-after": "0.01" }), json(409, { error: { code: "not_voidable", message: "x" } }), json(200, { envelope: { id: "e1", status: "voided" } })]);
    const cs2 = new CalaSign({ apiKey: "k", baseUrl: "http://api", fetch: g.fn, maxRetries: 2 });
    const d = await cs2.envelopes.void("e1", "r");
    expect(d.envelope.status).toBe("voided");
    expect(g.calls[2].method).toBe("GET");
  });
});

describe("paginación", () => {
  it("iterate recorre todas las páginas con el cursor", async () => {
    const f = fakeFetch([
      json(200, { items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" }),
      json(200, { items: [{ id: "c" }], nextCursor: null }),
    ]);
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
      new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), { status: 200, headers: { "content-type": "application/pdf" } });
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
