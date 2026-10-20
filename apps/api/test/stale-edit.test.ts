import { describe, expect, it } from "vitest";
import { assertNotStale } from "../src/lib/errors";

// Control de edición concurrente (X-Expected-Updated-At): otra pestaña u otra persona guardó antes.
describe("assertNotStale", () => {
  const current = new Date("2026-10-20T10:00:00.123Z");
  it("sin encabezado no controla (integraciones)", () => {
    expect(() => assertNotStale({}, current)).not.toThrow();
  });
  it("con el mismo updatedAt deja guardar", () => {
    expect(() => assertNotStale({ "x-expected-updated-at": "2026-10-20T10:00:00.123Z" }, current)).not.toThrow();
  });
  it("si cambió desde que se cargó responde 409 version_changed", () => {
    expect(() => assertNotStale({ "x-expected-updated-at": "2026-10-20T09:59:59.000Z" }, current)).toThrow(
      expect.objectContaining({ status: 409, code: "version_changed" }),
    );
  });
});
