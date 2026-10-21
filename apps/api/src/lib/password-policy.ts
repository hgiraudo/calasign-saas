// Política de contraseñas del personal (alta, restablecimiento y cuenta creada al aceptar una invitación): además del
// mínimo de 10 caracteres del esquema compartido, se rechazan las contraseñas comunes (lista sin conexión) y las que
// se arman con la parte local del correo (basedOnEmail).
//
// Lista: common-passwords.txt.gz, las entradas de 10 o más caracteres (en minúsculas, sin repetir) de SecLists
// 100k-most-used-passwords-NCSC.txt (licencia MIT, ver common-passwords.LICENSE). Las más cortas ya las rechaza el mínimo.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { AppError } from "./errors";

let common: Set<string> | null = null;

function commonPasswords(): Set<string> {
  if (!common) {
    const raw = gunzipSync(readFileSync(new URL("./common-passwords.txt.gz", import.meta.url))).toString("utf8");
    common = new Set(raw.split("\n").filter(Boolean));
  }
  return common;
}

/**
 * Palabras base que, con números o símbolos al final ("Password2024!", "contraseña123"), siguen siendo de las primeras
 * que se prueban.
 */
const WEAK_BASES = new Set([
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
]);

/** Letras de una cadena (sin dígitos, símbolos ni espacios). */
const lettersOf = (s: string) => s.replace(/[\d\W_]+/gu, "");

/**
 * ¿La contraseña (en minúsculas) es o se arma con la parte local del correo (sin el "+etiqueta")? Contenerla cuenta
 * solo si la parte local tiene 5 o más caracteres (con una corta como "ana" se rechazaban contraseñas que nada tienen
 * que ver, como "bananas-in-pyjamas-7"). Con cualquier largo, cuenta si sus letras son las de la parte local, al derecho
 * o al revés, una o más veces ("Bob2024!", "bobbobbob12" con bob@).
 */
function basedOnEmail(p: string, email: string): boolean {
  const full = email.toLowerCase().trim();
  if (p === full) return true;
  const local = (full.split("@")[0] ?? "").replace(/\+.*$/u, "");
  if (local.length >= 5 && p.includes(local)) return true;
  const core = lettersOf(p);
  const localCore = lettersOf(local);
  if (localCore.length < 2 || !core) return false;
  const reversed = [...localCore].reverse().join("");
  return [localCore, reversed].some((x) => core.length % x.length === 0 && x.repeat(core.length / x.length) === core);
}

/** Motivo por el que la contraseña es débil, o null. */
export function weakPasswordReason(password: string, email?: string | null): "too_short" | "common" | "email" | null {
  if (password.length < 10) return "too_short";
  const p = password.toLowerCase();
  if (email && basedOnEmail(p, email)) return "email";
  if (commonPasswords().has(p)) return "common";
  // Un solo carácter repetido ("aaaaaaaaaa") o una palabra base con relleno de números y símbolos al final.
  if (/^(.)\1+$/u.test(p)) return "common";
  const base = p.replace(/[\d\W_]+$/u, "");
  if (WEAK_BASES.has(base) || (base.length >= 4 && commonPasswords().has(base))) return "common";
  return null;
}

/** 400 weak_password si la contraseña es corta, común o basada en el correo. */
export function assertPasswordStrength(password: string, email?: string | null) {
  const reason = weakPasswordReason(password, email);
  if (!reason) return;
  const msg =
    reason === "too_short"
      ? "La contraseña debe tener al menos 10 caracteres"
      : reason === "email"
        ? "La contraseña no puede ser ni contener tu correo: elegí otra"
        : "Esa contraseña es demasiado común: elegí otra más difícil de adivinar";
  throw new AppError(400, "weak_password", msg, { reason });
}
