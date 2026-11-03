// Verificación de la firma de los webhooks entrantes (constructWebhookEvent / verifyWebhookSignature): cada caso afirma
// un borde que un mutante de Stryker rompía sin que unit.test.ts lo notara (docs/estandares/tests-automatizados.md §8).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookSignatureError, constructWebhookEvent, verifyWebhookSignature } from "../src/index";

const secret = "whsec_sintetico";
const body = JSON.stringify({ id: "evt_1", type: "envelope.completed", data: {} });
const now = 1_800_000_000_000;
const t = Math.floor(now / 1000);
const mac = (ts: number | string, b = body, k = secret) => createHmac("sha256", k).update(`${ts}.${b}`).digest("hex");

/** constructWebhookEvent tiene que lanzar WebhookSignatureError (no un TypeError o RangeError suelto) con ese motivo. */
function rejects(header: string | null, msg: RegExp, payload: string | Uint8Array = body) {
  let err: unknown;
  try {
    constructWebhookEvent({ payload, header, secret, now });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WebhookSignatureError);
  expect((err as Error).message).toMatch(msg);
  expect(verifyWebhookSignature({ payload, header, secret, now })).toBe(false);
}

const ok = (header: string, payload: string | Uint8Array = body, toleranceSec?: number) =>
  verifyWebhookSignature({ payload, header, secret, now, toleranceSec });

describe("header de firma", () => {
  it("sin header: WebhookSignatureError que lo dice", () => {
    rejects(null, /Falta el header CalaSign-Signature/);
    rejects("", /Falta el header CalaSign-Signature/);
  });

  it("sin t, con t no numérico o sin ningún v1: «mal formado»", () => {
    rejects(`v1=${mac(t)}`, /mal formado/);
    rejects(`t=abc,v1=${mac("abc")}`, /mal formado/);
    rejects(`t=${t}`, /mal formado/);
    rejects(`t=${t},v1=`, /mal formado/);
    rejects("basura", /mal formado/);
  });

  it("el orden de los pares no importa: t después de v1 vale", () => {
    expect(ok(`v1=${mac(t)},t=${t}`)).toBe(true);
    expect(ok(` t=${t} , v1=${mac(t)} `)).toBe(true);
  });

  it("un MAC válido bajo otra clave (v0=, s=) no cuenta como v1", () => {
    rejects(`t=${t},v0=${mac(t)}`, /mal formado/);
    rejects(`t=${t},v0=${mac(t)},v1=${"0".repeat(64)}`, /Firma inválida/);
  });

  it("un v1 de otro largo no rompe la verificación: se ignora y vale el siguiente", () => {
    expect(ok(`t=${t},v1=abcd,v1=${mac(t)}`)).toBe(true);
    rejects(`t=${t},v1=abcd`, /Firma inválida/);
    rejects(`t=${t},v1=${mac(t)}00`, /Firma inválida/);
  });
});

describe("tolerancia de tiempo", () => {
  it("vale hasta exactamente 300 s de diferencia, hacia atrás y hacia adelante", () => {
    expect(ok(`t=${t - 300},v1=${mac(t - 300)}`)).toBe(true);
    expect(ok(`t=${t + 300},v1=${mac(t + 300)}`)).toBe(true);
    rejects(`t=${t - 301},v1=${mac(t - 301)}`, /fuera de la tolerancia/);
    rejects(`t=${t + 301},v1=${mac(t + 301)}`, /fuera de la tolerancia/);
  });

  it("toleranceSec cambia el límite (0: sólo el segundo actual)", () => {
    expect(ok(`t=${t},v1=${mac(t)}`, body, 0)).toBe(true);
    expect(ok(`t=${t - 1},v1=${mac(t - 1)}`, body, 0)).toBe(false);
    expect(ok(`t=${t - 3000},v1=${mac(t - 3000)}`, body, 3600)).toBe(true);
  });
});

describe("cuerpo", () => {
  it("acepta el cuerpo como bytes (Uint8Array, no sólo Buffer) y verifica sobre su texto UTF-8", () => {
    const withAccents = JSON.stringify({ id: "evt_2", type: "envelope.completed", data: { subject: "Contrato de locación" } });
    const bytes = new TextEncoder().encode(withAccents);
    expect(constructWebhookEvent({ payload: bytes, header: `t=${t},v1=${mac(t, withAccents)}`, secret, now }).id).toBe("evt_2");
  });

  it("firma válida sobre un cuerpo que no es JSON: WebhookSignatureError, no SyntaxError", () => {
    rejects(`t=${t},v1=${mac(t, "no es json")}`, /no es JSON válido/, "no es json");
  });

  it("firma de otro cuerpo o de otro secreto: «Firma inválida»", () => {
    rejects(`t=${t},v1=${mac(t, "{}")}`, /Firma inválida/);
    rejects(`t=${t},v1=${mac(t, body, "otro")}`, /Firma inválida/);
  });
});
