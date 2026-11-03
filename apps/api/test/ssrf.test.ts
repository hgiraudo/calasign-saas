// Destinos salientes elegidos por el cliente (webhooks, Slack/Teams, S3 compatible): fuera del entorno local no se
// puede llegar a direcciones internas, ni por IP literal ni por un nombre que resuelve a una (DNS rebinding).
import { beforeAll, describe, expect, it } from "vitest";

let mod: typeof import("../src/modules/webhooks");

beforeAll(async () => {
  process.env.APP_ENV = "dev";
  mod = await import("../src/modules/webhooks");
});

describe("SSRF", () => {
  it("safeLookup rechaza un nombre que resuelve a loopback", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => mod.safeLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.code).toBe("EPRIVATEADDR");
  });

  it("safeLookup con all:true también valida todas las direcciones", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => mod.safeLookup("localhost", { all: true }, (e) => resolve(e)));
    expect(err?.code).toBe("EPRIVATEADDR");
  });

  it("postToCustomerUrl no conecta a IP internas literales", async () => {
    await expect(mod.postToCustomerUrl("https://169.254.169.254/latest", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
    await expect(mod.postToCustomerUrl("https://10.0.0.5/hook", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
  });

  it("isPrivateAddress cubre IPv6 con IPv4 embebida en cualquier notación (literal sin DNS)", () => {
    for (const ip of [
      "::ffff:a9fe:a9fe",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "::a9fe:a9fe",
      "2002:a9fe:a9fe::1",
      "fec0::1",
      "ff02::1",
      "2001:0::1",
      "fd00::1",
      "fe80::1%eth0",
    ])
      expect(mod.isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"])
      expect(mod.isPrivateAddress(ip), ip).toBe(false);
  });

  it("isPrivateAddress cubre los rangos IPv4 reservados y no bloquea direcciones públicas vecinas", () => {
    for (const ip of [
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "127.0.0.1",
      "0.0.0.0",
      "192.0.0.170",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
    ])
      expect(mod.isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "192.0.1.1", "192.88.98.1", "198.51.101.1", "203.0.114.1", "172.32.0.1", "100.128.0.1"])
      expect(mod.isPrivateAddress(ip), ip).toBe(false);
  });

  it("postToCustomerUrl no conecta a la metadata de la nube escrita como IPv6", async () => {
    await expect(mod.postToCustomerUrl("https://[::ffff:a9fe:a9fe]/latest", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
  });

  it("isPrivateAddress cubre IPv4 mapeadas en IPv6", () => {
    expect(mod.isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(mod.isPrivateAddress("8.8.8.8")).toBe(false);
  });

  // Los dos extremos de cada rango y la dirección pública de al lado (mutation testing, §8 de tests-automatizados.md:
  // un `<=` cambiado por `<`, o un octeto que no se compara, deja pasar una dirección interna).
  it.each([
    // 0.0.0.0/8, 10/8, 127/8
    ["0.255.255.255", true],
    ["1.0.0.0", false],
    ["9.255.255.255", false],
    ["10.0.0.0", true],
    ["10.255.255.255", true],
    ["11.0.0.0", false],
    ["126.255.255.255", false],
    ["127.255.255.255", true],
    ["128.0.0.0", false],
    // 100.64.0.0/10 (CGNAT)
    ["100.63.255.255", false],
    ["100.64.0.0", true],
    ["100.127.255.255", true],
    ["100.128.0.0", false],
    ["101.64.0.1", false],
    // 169.254.0.0/16
    ["169.253.255.255", false],
    ["169.254.0.0", true],
    ["169.255.0.0", false],
    ["170.254.0.1", false],
    // 172.16.0.0/12
    ["172.15.255.255", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["173.16.0.1", false],
    // 192.168.0.0/16
    ["192.167.255.255", false],
    ["192.168.0.0", true],
    ["192.168.255.255", true],
    ["192.169.0.0", false],
    ["193.168.0.1", false],
    // 192.0.0.0/24, 192.0.2.0/24
    ["192.0.0.0", true],
    ["192.0.0.255", true],
    ["192.0.2.255", true],
    ["192.0.3.0", false],
    ["192.1.0.1", false],
    ["193.0.2.1", false],
    // 192.88.99.0/24
    ["192.88.99.255", true],
    ["192.88.100.0", false],
    ["192.89.99.1", false],
    ["193.88.99.1", false],
    // 198.18.0.0/15
    ["198.17.255.255", false],
    ["198.18.0.0", true],
    ["198.19.255.255", true],
    ["198.20.0.0", false],
    ["199.18.0.1", false],
    // 198.51.100.0/24, 203.0.113.0/24
    ["198.51.99.255", false],
    ["198.52.100.1", false],
    ["199.51.100.1", false],
    ["203.0.112.255", false],
    ["203.0.113.255", true],
    ["203.1.113.1", false],
    ["204.0.113.1", false],
    // 224.0.0.0/4 en adelante (multicast y reservadas)
    ["223.255.255.255", false],
    ["224.0.0.0", true],
  ])("IPv4 %s: interna = %s", (ip, internal) => {
    expect(mod.isPrivateAddress(ip)).toBe(internal);
  });

  it.each([
    ["::", true],
    ["::1", true],
    ["::0.0.0.2", true],
    // fc00::/7 (ULA)
    ["fbff:ffff::1", false],
    ["fc00::", true],
    ["fdff:ffff::1", true],
    // fe80::/10 (link-local), fec0::/10 (site-local), en mayúsculas y con zona
    ["fe7f::1", false],
    ["fe80::", true],
    ["FEBF::1", true],
    ["fec0::", true],
    ["feff::1", true],
    ["fe80::1%eth0", true],
    // ff00::/8 (multicast)
    ["ff00::1", true],
    ["ffff::1", true],
    // 100::/64 (descarte)
    ["100::1", true],
    ["100:0:0:0:ffff::1", true],
    ["100:0:0:1::1", false],
    ["100:1::1", false],
    ["101::1", false],
    // 2001::/32 (Teredo)
    ["2001:0:abcd::1", true],
    ["2001:1::1", false],
    ["2000::1", false],
    // ::ffff:a.b.c.d (mapeada), en las dos notaciones y con zona; la IPv4 con octetos de varios dígitos
    ["::ffff:10.0.0.1", true],
    ["::ffff:a00:1", true],
    ["0:0:0:0:0:ffff:7f00:1", true],
    ["::ffff:10.0.0.1%eth0", true],
    ["::ffff:100.64.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:8.8.8.8%eth0", false],
    ["::ffff:808:808", false],
    ["::ffff:8.88.8.8", false],
    ["::ffff:8.8.88.8", false],
    ["::ffff:8.8.8.88", false],
    ["2606:4700::ffff:a00:1", false],
    // ::a.b.c.d (IPv4 compatible)
    ["::10.0.0.1", true],
    ["::8.8.8.8", false],
    // ::ffff:0:a.b.c.d (traducida, SIIT)
    ["::ffff:0:10.0.0.1", true],
    ["::ffff:0:808:808", false],
    ["2606::ffff:0:a00:1", false],
    // 64:ff9b::/96 (NAT64): la IPv4 en los últimos 32 bits
    ["64:ff9b::10.0.0.1", true],
    ["64:ff9b::8.8.8.8", false],
    ["2606:ff9b::a00:1", false],
    // El resto de ::/8 (reservado), incluido el NAT64 de uso local 64:ff9b:1::/48 (RFC 8215)
    ["::1:ffff:808:808", true],
    ["::1:0:808:808", true],
    ["::1:808:808", true],
    ["::ffff:1:808:808", true],
    ["64:ff9b:1::808:808", true],
    ["64:ff9b:0:0:1::808:808", true],
    ["64:ff9b:0:0:0:1:808:808", true],
    ["64:ff9a::808:808", true],
    ["ff:ffff::1", true],
    // 2002::/16 (6to4): la IPv4 va en los grupos 1 y 2
    ["2002:a00:1::", true],
    ["2002:808:808::a00:1", false],
    ["2003:a00:1::", false],
    ["2a00:a00:1::", false],
    // públicas
    ["2606:4700:4700::1111", false],
    ["2a00:1450:4001::1", false],
    ["2a00:1450:4001::200e", false],
  ])("IPv6 %s: interna = %s", (ip, internal) => {
    expect(mod.isPrivateAddress(ip)).toBe(internal);
  });
});
