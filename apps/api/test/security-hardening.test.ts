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
