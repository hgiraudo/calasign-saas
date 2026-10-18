import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { iceServersFor } from "../src/modules/video";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["VIDEO_ICE_SERVERS", "VIDEO_TURN_SECRET", "VIDEO_TURN_URLS", "VIDEO_TURN_TTL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("servidores ICE de la sala de video", () => {
  it("por defecto solo STUN público", () => {
    delete process.env.VIDEO_ICE_SERVERS;
    delete process.env.VIDEO_TURN_SECRET;
    const s = iceServersFor("p1");
    expect(s).toHaveLength(1);
    expect(String(s[0].urls)).toMatch(/^stun:/);
    expect(s[0].credential).toBeUndefined();
  });

  it("VIDEO_ICE_SERVERS reemplaza la lista; un JSON inválido vuelve al STUN por defecto", () => {
    process.env.VIDEO_ICE_SERVERS = JSON.stringify([{ urls: "stun:stun.example.com:3478" }]);
    expect(iceServersFor("p1")[0].urls).toBe("stun:stun.example.com:3478");
    process.env.VIDEO_ICE_SERVERS = "{no es json";
    expect(String(iceServersFor("p1")[0].urls)).toMatch(/google/);
  });

  it("credenciales TURN temporales con el esquema use-auth-secret de coturn", () => {
    process.env.VIDEO_TURN_SECRET = "secreto-compartido";
    process.env.VIDEO_TURN_URLS = "turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349";
    process.env.VIDEO_TURN_TTL = "600";
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const turn = iceServersFor("participante-1", now).find((x) => x.username);
    expect(turn?.urls).toEqual(["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"]);
    const expiry = Math.floor(now / 1000) + 600;
    expect(turn?.username).toBe(`${expiry}:participante-1`);
    expect(turn?.credential).toBe(createHmac("sha1", "secreto-compartido").update(`${expiry}:participante-1`).digest("base64"));
  });
});
