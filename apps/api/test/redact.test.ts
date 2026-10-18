import { describe, expect, it } from "vitest";
import { redactUrl, safeRequestSerializer } from "../src/lib/redact";

const TOKEN = "Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

describe("redactUrl", () => {
  it("redacta los secretos en rutas conocidas", () => {
    expect(redactUrl(`/v1/signing/${TOKEN}/complete`)).toBe("/v1/signing/[redactado]/complete");
    expect(redactUrl(`/s/${TOKEN}`)).toBe("/s/[redactado]");
    expect(redactUrl("/v1/certsign/sessions/ABCDE-FGH23/signature")).toBe("/v1/certsign/sessions/[redactado]/signature");
    expect(redactUrl("/embed/short1")).toBe("/embed/[redactado]");
    expect(redactUrl(`/v1/downloads/${TOKEN}`)).toBe("/v1/downloads/[redactado]");
    expect(redactUrl(`/v1/invite/${TOKEN}/accept`)).toBe("/v1/invite/[redactado]/accept");
    expect(redactUrl(`/reset/${TOKEN}`)).toBe("/reset/[redactado]");
    expect(redactUrl(`/v1/public/negotiations/${TOKEN}/pdf`)).toBe("/v1/public/negotiations/[redactado]/pdf");
  });
  it("redacta segmentos con forma de token aunque la ruta no esté listada, pero no los UUID", () => {
    expect(redactUrl(`/v1/algo/${TOKEN}`)).toBe("/v1/algo/[redactado]");
    expect(redactUrl("/v1/envelopes/0192f0e0-0000-7000-8000-000000000001/send")).toBe("/v1/envelopes/0192f0e0-0000-7000-8000-000000000001/send");
  });
  it("redacta parámetros sensibles de la query y conserva el resto", () => {
    const out = redactUrl("/v1/auth/sso/oidc/callback?code=abc123&state=xyz&lang=es");
    expect(out).toContain("code=[redactado]");
    expect(out).toContain("state=[redactado]");
    expect(out).toContain("lang=es");
    expect(out).not.toContain("abc123");
  });
  it("el serializador no incluye headers", () => {
    const s = safeRequestSerializer({ method: "GET", url: `/s/${TOKEN}`, hostname: "x", ip: "1.2.3.4" });
    expect(s.url).toBe("/s/[redactado]");
    expect(Object.keys(s)).not.toContain("headers");
  });
});
