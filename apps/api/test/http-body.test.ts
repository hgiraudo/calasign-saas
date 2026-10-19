import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readCapped, readCappedJson } from "../src/lib/http-body";

describe("readCapped", () => {
  it("lee cuerpos dentro del tope", async () => {
    expect(new TextDecoder().decode(await readCapped(new Response("hola"), 10))).toBe("hola");
    expect(await readCappedJson(new Response('{"a":1}'))).toEqual({ a: 1 });
  });
  it("corta por content-length o por bytes leídos", async () => {
    await expect(readCapped(new Response("x".repeat(20), { headers: { "content-length": "20" } }), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(8)); c.close(); } });
    await expect(readCapped(new Response(stream), 20)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("JSON inválido o demasiado grande da {}", async () => {
    expect(await readCappedJson(new Response("no json"))).toEqual({});
    expect(await readCappedJson(new Response('{"a":"' + "x".repeat(50) + '"}'), 10)).toEqual({});
  });
});
