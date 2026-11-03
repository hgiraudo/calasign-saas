// Firma de los webhooks salientes (signPayload en modules/webhooks.ts, docs/estandares/tests-automatizados.md §8): el
// header que verifican los SDK (sdk-node constructWebhookEvent, el de Python). Se recalcula a mano con node:crypto.
import { createHmac } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let mod: typeof import("../src/modules/webhooks");

beforeAll(async () => {
  process.env.APP_ENV = "dev";
  mod = await import("../src/modules/webhooks");
});

afterEach(() => vi.useRealTimers());

const mac = (k: string, t: number, body: string) => createHmac("sha256", k).update(`${t}.${body}`).digest("hex");

describe("signPayload", () => {
  it("t=<unix>,v1=<HMAC-SHA256(secreto, «t.cuerpo») en hex>", () => {
    const body = '{"id":"evt_1","type":"envelope.completed"}';
    expect(mod.signPayload("whsec_sintetico", body, 1_800_000_000)).toBe(`t=1800000000,v1=${mac("whsec_sintetico", 1_800_000_000, body)}`);
    expect(mod.SIGNATURE_HEADER).toBe("CalaSign-Signature");
  });

  it("con varios secretos (rotación): un v1 por secreto, en el mismo orden, el vigente primero", () => {
    expect(mod.signPayload(["nuevo", "viejo"], "{}", 42)).toBe(`t=42,v1=${mac("nuevo", 42, "{}")},v1=${mac("viejo", 42, "{}")}`);
    expect(mod.signPayload(["unico"], "{}", 42)).toBe(mod.signPayload("unico", "{}", 42));
  });

  it("sin timestamp usa la hora actual en segundos (redondeada hacia abajo)", () => {
    vi.useFakeTimers({ now: 1_800_000_000_999 });
    expect(mod.signPayload("k", "{}")).toBe(`t=1800000000,v1=${mac("k", 1_800_000_000, "{}")}`);
  });
});
