// Cerrar una preferencia de Mercado Pago que ya no existe: no está documentado si el PUT responde 404 o 400. Con un 400
// el barrido de checkouts la reintentaba para siempre. Ahora se la consulta: si no existe, 404 (el barrido la suelta);
// si ya venció, no hay nada que cerrar. Mercado Pago simulado con fetch.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MP_ACCESS_TOKEN = "TEST-calasign-mp-expire"; // calidad:permitir-secreto (token falso de prueba)
process.env.MP_API_BASE = "https://mp.example.test";

let providers: typeof import("../src/modules/billing/providers");
beforeAll(async () => {
  providers = await import("../src/modules/billing/providers");
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** PUT y GET de /checkout/preferences/:id con las respuestas dadas; registra los métodos llamados. */
function mockMp(put: Response, get?: Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (_u: any, init: any = {}) => {
    calls.push(init.method ?? "GET");
    if (init.method === "PUT") return put;
    return get ?? json(500, { message: "inesperado" });
  }) as typeof fetch;
  return calls;
}

describe("mpExpirePreference", () => {
  it("la cierra: expired", async () => {
    const calls = mockMp(json(200, { id: "p1" }));
    await expect(providers.mpExpirePreference("p1")).resolves.toBe("expired");
    expect(calls).toEqual(["PUT"]);
  });

  it("400 y la preferencia no existe: se informa como 404 (el barrido la suelta)", async () => {
    mockMp(json(400, { message: "invalid" }), json(404, { message: "not found" }));
    await expect(providers.mpExpirePreference("p2")).rejects.toMatchObject({ status: 404 });
  });

  it("400 y ya está vencida: already_expired", async () => {
    mockMp(json(400, { message: "invalid" }), json(200, { id: "p3", expires: true, expiration_date_to: "2026-01-01T00:00:00.000-03:00" }));
    await expect(providers.mpExpirePreference("p3")).resolves.toBe("already_expired");
  });

  it("400 con la preferencia vigente: sigue siendo un error (se reintenta)", async () => {
    mockMp(json(400, { message: "invalid" }), json(200, { id: "p4", expires: false }));
    await expect(providers.mpExpirePreference("p4")).rejects.toMatchObject({ status: 400 });
  });

  it("un error del servidor no se consulta ni se disfraza", async () => {
    const calls = mockMp(json(503, { message: "caído" }));
    await expect(providers.mpExpirePreference("p5")).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual(["PUT"]);
  });
});
