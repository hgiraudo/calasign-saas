// Política de contraseñas del personal (lib/password-policy.ts, docs/estandares/tests-automatizados.md §8): mínimo de
// 10, lista de comunes, palabras base con relleno y contraseñas armadas con el correo. Cada caso afirma un borde que un
// mutante de Stryker rompía sin que los tests de la app (staff-auth-hardening) lo notaran. Correos en example.com.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError as AppErrorT } from "../src/lib/errors";

// Módulo nuevo en cada test: la lista de comunes se carga una vez por módulo (caché) y, sin esto, Stryker reusa la de
// una corrida anterior y no ve los mutantes de la carga (un `split` roto dejaba la lista vacía sin que nada fallara).
let weakPasswordReason: typeof import("../src/lib/password-policy").weakPasswordReason;
let assertPasswordStrength: typeof import("../src/lib/password-policy").assertPasswordStrength;
let AppError: typeof AppErrorT;
beforeEach(async () => {
  vi.resetModules();
  ({ weakPasswordReason, assertPasswordStrength } = await import("../src/lib/password-policy"));
  ({ AppError } = await import("../src/lib/errors"));
});

describe("weakPasswordReason", () => {
  it("menos de 10 caracteres: too_short; 10 ya no", () => {
    expect(weakPasswordReason("Xk9#mQ2!v")).toBe("too_short");
    expect(weakPasswordReason("Xk9#mQ2!vL")).toBeNull();
    expect(weakPasswordReason("")).toBe("too_short");
  });

  it("una de la lista de comunes, sin distinguir mayúsculas", () => {
    expect(weakPasswordReason("1234567890")).toBe("common");
    expect(weakPasswordReason("BasketBall")).toBe("common");
  });

  it("un solo carácter repetido, aunque no esté en la lista", () => {
    expect(weakPasswordReason("~~~~~~~~~~~~")).toBe("common");
    expect(weakPasswordReason("ññññññññññññ")).toBe("common");
    expect(weakPasswordReason("~~~~~~~~~~~^")).toBeNull();
  });

  it("cada palabra base con números o símbolos al final", () => {
    for (const base of [
      "password",
      "passw0rd",
      "contraseña",
      "contrasena",
      "contrasenia",
      "senha",
      "calasign",
      "qwerty",
      "qwertyuiop",
      "asdfghjkl",
      "welcome",
      "bienvenido",
      "bemvindo",
      "letmein",
      "iloveyou",
      "teamo",
      "admin",
      "administrator",
      "administrador",
    ]) {
      expect(weakPasswordReason(`${base[0].toUpperCase()}${base.slice(1)}2024!#__`), base).toBe("common");
    }
  });

  it("una entrada de la lista como base con relleno; el relleno sólo cuenta al final", () => {
    expect(weakPasswordReason("basketball2024!")).toBe("common");
    expect(weakPasswordReason("2024!password-xq")).toBeNull();
    expect(weakPasswordReason("pass-word-2024")).toBeNull();
  });

  it("igual al correo completo (sin distinguir mayúsculas ni espacios del correo)", () => {
    expect(weakPasswordReason("Ana.Perez@Example.com", "  ana.perez@example.COM ")).toBe("email");
    // Con una parte local corta, sólo la comparación con el correo completo la atrapa.
    expect(weakPasswordReason("Bob@Example.com", "bob@example.com")).toBe("email");
  });

  it("contiene la parte local (sin +etiqueta) si mide 5 o más; con 4 no alcanza", () => {
    expect(weakPasswordReason("xx-mariana-77", "mariana@example.com")).toBe("email");
    expect(weakPasswordReason("xx-mariana-77", "mariana+boletin@example.com")).toBe("email");
    expect(weakPasswordReason("xx-maria-7731", "maria@example.com")).toBe("email");
    expect(weakPasswordReason("xx-juan-77310", "juan@example.com")).toBeNull();
    expect(weakPasswordReason("bananas-in-pyjamas-7", "ana@example.com")).toBeNull();
  });

  it("sus letras son la parte local repetida, al derecho o al revés", () => {
    expect(weakPasswordReason("Bob2024!Bob", "bob@example.com")).toBe("email");
    expect(weakPasswordReason("bobbobbob12", "bob@example.com")).toBe("email");
    expect(weakPasswordReason("asil-asil-2024", "lisa@example.com")).toBe("email");
    expect(weakPasswordReason("bobobobobo12", "bo@example.com")).toBe("email");
    expect(weakPasswordReason("bobbobbo-12", "bob@example.com")).toBeNull();
    expect(weakPasswordReason("bobxbobbob12", "bob@example.com")).toBeNull();
    // Del largo justo (múltiplo de la parte local) pero con otras letras.
    expect(weakPasswordReason("xyzxyzxyz-12", "bob@example.com")).toBeNull();
  });

  it("una parte local de una sola letra o una contraseña sin letras no cuentan como «basada en el correo»", () => {
    expect(weakPasswordReason("a-a-a-a-a-a-9", "a@example.com")).toBeNull();
    expect(weakPasswordReason("93718264051!", "bob@example.com")).toBeNull();
  });

  it("el correo se mira antes que la lista: una común basada en el correo es «email»", () => {
    expect(weakPasswordReason("basketball", "basketball@example.com")).toBe("email");
  });

  it("sin correo (null o vacío) no se compara con nada", () => {
    expect(weakPasswordReason("xx-mariana-77", null)).toBeNull();
    expect(weakPasswordReason("xx-mariana-77", "")).toBeNull();
  });
});

describe("assertPasswordStrength", () => {
  const thrown = (pw: string, email?: string) => {
    try {
      assertPasswordStrength(pw, email);
    } catch (e) {
      return e as AppErrorT;
    }
    return null;
  };

  it("400 weak_password con el motivo y un mensaje que dice qué hacer", () => {
    const short = thrown("corta");
    expect(short).toBeInstanceOf(AppError);
    expect([short?.status, short?.code, short?.details]).toEqual([400, "weak_password", { reason: "too_short" }]);
    expect(short?.message).toBe("La contraseña debe tener al menos 10 caracteres");
    const email = thrown("xx-mariana-77", "mariana@example.com");
    expect(email?.details).toEqual({ reason: "email" });
    expect(email?.message).toBe("La contraseña no puede ser ni contener tu correo: elegí otra");
    const common = thrown("1234567890");
    expect(common?.details).toEqual({ reason: "common" });
    expect(common?.message).toBe("Esa contraseña es demasiado común: elegí otra más difícil de adivinar");
  });

  it("una contraseña fuerte no lanza", () => {
    expect(thrown("Xk9#mQ2!vL", "mariana@example.com")).toBeNull();
  });
});
