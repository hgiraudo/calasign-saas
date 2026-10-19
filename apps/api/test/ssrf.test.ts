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
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      mod.safeLookup("localhost", {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe("EPRIVATEADDR");
  });

  it("safeLookup con all:true también valida todas las direcciones", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      mod.safeLookup("localhost", { all: true }, (e) => resolve(e)),
    );
    expect(err?.code).toBe("EPRIVATEADDR");
  });

  it("postToCustomerUrl no conecta a IP internas literales", async () => {
    await expect(mod.postToCustomerUrl("https://169.254.169.254/latest", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
    await expect(mod.postToCustomerUrl("https://10.0.0.5/hook", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
  });

  it("isPrivateAddress cubre IPv6 con IPv4 embebida en cualquier notación (literal sin DNS)", () => {
    for (const ip of ["::ffff:a9fe:a9fe", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "::a9fe:a9fe", "2002:a9fe:a9fe::1", "fec0::1", "ff02::1", "2001:0::1", "fd00::1", "fe80::1%eth0"])
      expect(mod.isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"]) expect(mod.isPrivateAddress(ip), ip).toBe(false);
  });

  it("isPrivateAddress cubre los rangos IPv4 reservados y no bloquea direcciones públicas vecinas", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "127.0.0.1", "0.0.0.0", "192.0.0.170", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255"])
      expect(mod.isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "192.0.1.1", "192.88.98.1", "198.51.101.1", "203.0.114.1", "172.32.0.1", "100.128.0.1"]) expect(mod.isPrivateAddress(ip), ip).toBe(false);
  });

  it("postToCustomerUrl no conecta a la metadata de la nube escrita como IPv6", async () => {
    await expect(mod.postToCustomerUrl("https://[::ffff:a9fe:a9fe]/latest", {}, "{}", 2000)).rejects.toThrow(/dirección interna/);
  });

  it("isPrivateAddress cubre IPv4 mapeadas en IPv6", () => {
    expect(mod.isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(mod.isPrivateAddress("8.8.8.8")).toBe(false);
  });
});
