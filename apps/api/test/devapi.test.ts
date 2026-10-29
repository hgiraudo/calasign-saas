import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvelopeBatchInput } from "@calasign/shared";
import { envelopeSearchSql, metadataFilters } from "../src/modules/devapi/search";
import { signPayload } from "../src/modules/webhooks";

describe("búsqueda avanzada de sobres", () => {
  it("arma condiciones y parámetros", () => {
    const params: unknown[] = ["tenant"];
    const sql = envelopeSearchSql(
      {
        created_from: "2026-01-01",
        updated_since: "2026-02-01T00:00:00Z",
        metadata: ["orderId:A:1"],
        "metadata[canal]": "web",
        recipient: "Ana@X.com",
      },
      params,
    );
    expect(sql).toContain("e.created_at >= $2::timestamptz");
    expect(sql).toContain("e.updated_at >= $3::timestamptz");
    expect(sql).toContain("e.metadata @> $4::jsonb");
    expect(JSON.parse(params[3] as string)).toEqual({ orderId: "A:1", canal: "web" });
    expect(params[4]).toBe("ana@x.com");
  });
  it("valida fechas, metadata y origen", () => {
    expect(() => envelopeSearchSql({ created_to: "mañana" }, [])).toThrow();
    expect(() => metadataFilters({ metadata: "sinvalor" })).toThrow();
    expect(() => envelopeSearchSql({ created_via: "fax" }, [])).toThrow();
    expect(envelopeSearchSql({}, [])).toBe("");
  });
});

describe("lote", () => {
  it("exige reason para anular y rechaza ids repetidos", () => {
    const id = "0190a5c4-0000-7000-8000-000000000001";
    expect(EnvelopeBatchInput.safeParse({ action: "void", ids: [id] }).success).toBe(false);
    expect(EnvelopeBatchInput.safeParse({ action: "get", ids: [id, id] }).success).toBe(false);
    expect(EnvelopeBatchInput.safeParse({ action: "void", ids: [id], reason: "x" }).success).toBe(true);
  });
});

describe("firma de webhooks con rotación", () => {
  it("un v1 por secreto, el vigente primero", () => {
    const h = signPayload(["nuevo", "viejo"], "{}", 100);
    const mac = (k: string) => createHmac("sha256", k).update("100.{}").digest("hex");
    expect(h).toBe(`t=100,v1=${mac("nuevo")},v1=${mac("viejo")}`);
    expect(signPayload("solo", "{}", 100)).toBe(`t=100,v1=${mac("solo")}`);
  });
});
