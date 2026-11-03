// Autenticación que imprime el certificado de finalización para un firmante autorregistrado (pentest white-box del
// 31-Oct-2026): quien usa un formulario o un link público de workflow escribe el correo que quiere y ve el link en
// pantalla; el certificado no puede decir «link enviado al canal del destinatario» (packages/pdf finalize.test.ts
// prueba el texto impreso).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-cert-auth-"));
const { certificateAuthMethod } = await import("../src/modules/otp");

describe("certificateAuthMethod", () => {
  it("autorregistrado con link y sin validar el correo: link en pantalla, correo no verificado", () => {
    expect(certificateAuthMethod({ auth_method: "link", self_registered: true, authenticated_at: null })).toBe("link_self_registered");
  });
  it("un firmante invitado por la organización conserva su método", () => {
    expect(certificateAuthMethod({ auth_method: "link", self_registered: false })).toBe("link");
    expect(certificateAuthMethod({ auth_method: "otp_sms", self_registered: false })).toBe("otp_sms");
  });
  it("autorregistrado que validó el correo con el código: el código por correo, no «no verificado»", () => {
    expect(certificateAuthMethod({ auth_method: "otp_email", self_registered: true, authenticated_at: new Date() })).toBe("otp_email");
  });
  it("autorregistrado con código por SMS: el canal verificado es el teléfono y se imprime ese", () => {
    expect(certificateAuthMethod({ auth_method: "otp_sms", self_registered: true, authenticated_at: new Date() })).toBe("otp_sms");
  });
});
