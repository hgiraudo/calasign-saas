// Destino después del ingreso por SSO: solo rutas propias; nada que el navegador convierta en "//otro-sitio".
import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "../src/modules/identity/sso";

describe("safeRedirectPath", () => {
  it("acepta rutas propias", () => {
    expect(safeRedirectPath("/app/envelopes?tab=sent")).toBe("/app/envelopes?tab=sent");
  });
  it.each(["//evil.com", "/\t/evil.com", "/\n/evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "evil.com", "/ /evil.com", "", null, 42])(
    "rechaza %j",
    (p) => {
      expect(safeRedirectPath(p)).toBe("/app");
    },
  );
});
