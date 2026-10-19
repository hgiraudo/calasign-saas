import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assertEmbeddableImage, assertPngSize, pngDimensions } from "@calasign/pdf";
import { requestPath } from "../src/lib/util";

/** PNG mínimo (RGBA) con las dimensiones que se pidan en la cabecera y casi ningún dato. */
function png(width: number, height: number): Uint8Array {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(width <= 4 ? (width * 4 + 1) * height : 16))), chunk("IEND", Buffer.alloc(0))]),
  );
}

describe("imágenes PNG: tope de píxeles antes de decodificar", () => {
  it("lee las dimensiones de la cabecera", () => {
    expect(pngDimensions(png(16000, 16000))).toEqual({ width: 16000, height: 16000 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it("rechaza un PNG chico que declara dimensiones enormes sin reservar memoria", async () => {
    const bomb = png(16000, 16000);
    expect(bomb.length).toBeLessThan(200);
    expect(() => assertPngSize(bomb)).toThrow(/demasiado grande/);
    await expect(assertEmbeddableImage(bomb, "image/png")).rejects.toThrow(/demasiado grande/);
    await expect(assertEmbeddableImage(png(3001, 3000), "image/png", 3000 * 3000)).rejects.toThrow(/demasiado grande/);
  });
  it("acepta un PNG válido chico", async () => {
    await expect(assertEmbeddableImage(png(2, 2), "image/png")).resolves.toBeUndefined();
  });
});

describe("requestPath: ruta decodificada como la ve el router", () => {
  it("decodifica percent-encoding (los prefijos /v1/ no se saltean)", () => {
    expect(requestPath({ url: "/%761/auth/login?x=1" })).toBe("/v1/auth/login");
    expect(requestPath({ url: "/v1/signing/%41bc/file" })).toBe("/v1/signing/Abc/file");
    expect(requestPath({ url: "/v1/me#frag" })).toBe("/v1/me");
  });
  it("una secuencia inválida queda cruda (no lanza)", () => {
    expect(requestPath({ url: "/v1/%E0%A4%A" })).toBe("/v1/%E0%A4%A");
  });
});

describe("plantillas de documentos: presupuesto de salida", async () => {
  const { renderTemplate, TemplateSyntaxError } = await import("@calasign/shared");
  it("each anidados que multiplican el trabajo se cortan con un error de plantilla", () => {
    const depth = 8;
    const source = `${"{{#each a}}\n".repeat(depth)}x\n${"{{/each}}\n".repeat(depth)}`;
    const data = { a: Array.from({ length: 100 }, (_, i) => i) };
    expect(() => renderTemplate(source, data)).toThrow(TemplateSyntaxError);
  });
  it("una variable larga repetida también", () => {
    expect(() => renderTemplate("{{#each a}}\n{{big}}\n{{/each}}", { a: Array.from({ length: 50 }), big: "x".repeat(100_000) })).toThrow(/demasiado grande/);
  });
  it("un documento normal se genera", () => {
    expect(renderTemplate("# Hola {{nombre}}\n\n{{#each items}}\n- {{item}}\n{{/each}}", { nombre: "Ana", items: [1, 2, 3] }).blocks.length).toBeGreaterThan(0);
  });
});

describe("expresiones regulares sin retroceso catastrófico", async () => {
  const { parseFilter } = await import("../src/modules/identity/scim");
  const { renderTemplate } = await import("@calasign/shared");
  it("filtro SCIM largo: se rechaza sin evaluar la regex", () => {
    const t0 = Date.now();
    expect(() => parseFilter(" ".repeat(20_000), ["userName"])).toThrow(/demasiado largo/);
    expect(parseFilter('userName eq "ana@x.com"', ["userName"])).toEqual({ attr: "userName", value: "ana@x.com" });
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it("línea {{#if seguida de miles de espacios: lineal", () => {
    const t0 = Date.now();
    renderTemplate(`{{#if${" ".repeat(200_000)}`, {});
    expect(Date.now() - t0).toBeLessThan(500);
    expect(renderTemplate("{{#if  a}}\nsí\n{{/if}}", { a: true }).blocks.length).toBe(1);
  });
});
