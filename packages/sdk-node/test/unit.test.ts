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
