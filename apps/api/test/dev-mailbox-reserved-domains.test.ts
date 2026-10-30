// Buzón de desarrollo con SMTP real (dev.calasign.com con SES): los correos a dominios reservados para pruebas (los de
// las suites e2e) quedan solo en el buzón. Mandarlos por SES daría un rebote duro por cada uno.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-dev-mailbox-"));
process.env.DEV_MAILBOX = "true";
process.env.SMTP_URL = "smtp://usuario:clave@smtp.invalid:587";

let channels: typeof import("../src/notifications/channels");
const sent: string[] = [];

beforeAll(async () => {
  channels = await import("../src/notifications/channels");
  channels.setMailTransportForTests({
    sendMail: async (o: any) => {
      sent.push(String(o.to));
      return { messageId: "<m@ses>", response: "250 Ok 0100-abc" } as any;
    },
  });
});
beforeEach(() => {
  sent.length = 0;
});

const mail = (to: string) => ({ channel: "email" as const, to, subject: "Asunto", text: "Texto" });

describe("buzón de desarrollo + SMTP", () => {
  it("a un dominio reservado: solo buzón, no sale por SMTP", async () => {
    for (const to of ["ana+1@example.com", "Ana <cc@mail.example.org>", "x@demo.test", "y@acme.invalid", "z@EXAMPLE.NET."]) {
      const r = await channels.deliver(mail(to));
      expect(r.provider, to).not.toBe("smtp");
    }
    expect(sent).toEqual([]);
  });

  it("a una dirección real: sale por SMTP (y queda en el buzón)", async () => {
    const r = await channels.deliver(mail("hgiraudo@gmail.com"));
    expect(r.provider).toBe("smtp");
    expect(sent).toEqual(["hgiraudo@gmail.com"]);
  });

  it("no confunde dominios parecidos con los reservados", () => {
    for (const to of ["a@example.com.ar", "a@notexample.com", "a@testing.io", "a@example.co"]) {
      expect(channels.isReservedTestAddress(to), to).toBe(false);
    }
  });
});
