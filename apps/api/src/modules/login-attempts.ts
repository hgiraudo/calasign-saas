// Bloqueo por intentos de ingreso (contraseña y segundo factor).
//
// Cada intento se cuenta ANTES de verificar, con un contador atómico (login_attempts): si no, muchos pedidos en
// paralelo veían todos un contador bajo y probaban cientos de contraseñas. Ámbitos por cuenta:
//   - 'ip:<red>': la /24 (IPv4) o /64 (IPv6) del cliente, MAX_FAILED_LOGINS en LOGIN_WINDOW_MINUTES. Los fallos desde
//     otra red no bloquean a la persona (antes el bloqueo era solo por cuenta: cualquiera que conociera el correo la
//     dejaba afuera con 10 intentos).
//   - 'account': techo global de la cuenta (ACCOUNT_CEILING por hora, desde cualquier red) contra la prueba distribuida
//     desde muchas redes. Un acierto no lo vacía (vence solo).
//   - '2fa': códigos del segundo paso. Solo los prueba quien ya pasó la contraseña (el desafío), así que los fallos de
//     contraseña desde otras redes no bloquean un desafío ya abierto; además, cada desafío admite 5 códigos.
import type { Db } from "../infra/db";
import { AppError } from "../lib/errors";
import { ipNetworkKey } from "../lib/ip";

export const MAX_FAILED_LOGINS = 10;
export const LOGIN_WINDOW_MINUTES = 15;
export const ACCOUNT_CEILING = 100;
export const MAX_FAILED_2FA = 10;

const tooManyAttempts = () =>
  new AppError(429, "too_many_attempts", "Demasiados intentos fallidos. Probá de nuevo en unos minutos o restablecé tu contraseña.");

const ipScope = (ip: string | null | undefined) => `ip:${ipNetworkKey(ip)}`;

/** Suma un intento al ámbito y devuelve el total de la ventana (la ventana vencida empieza de nuevo). */
async function bump(db: Db, userId: string, scope: string, windowMinutes: number): Promise<number> {
  const r = await db.one<{ n: number }>(
    `INSERT INTO login_attempts (user_id, scope, window_start, n) VALUES ($1, $2, now(), 1)
     ON CONFLICT (user_id, scope) DO UPDATE SET
       n = CASE WHEN login_attempts.window_start < now() - make_interval(mins => $3::int) THEN 1 ELSE login_attempts.n + 1 END,
       window_start = CASE WHEN login_attempts.window_start < now() - make_interval(mins => $3::int) THEN now() ELSE login_attempts.window_start END
     RETURNING n`,
    [userId, scope, windowMinutes],
  );
  return r?.n ?? 0;
}

/** Total vigente del ámbito, sin sumar. */
async function current(db: Db, userId: string, scope: string, windowMinutes: number): Promise<number> {
  const r = await db.one<{ n: number }>(
    `SELECT n FROM login_attempts WHERE user_id = $1 AND scope = $2 AND window_start >= now() - make_interval(mins => $3::int)`,
    [userId, scope, windowMinutes],
  );
  return r?.n ?? 0;
}

/**
 * Antes de verificar una contraseña (login, aceptar una invitación, alta con una cuenta existente, re-autenticación):
 * cuenta el intento en el cupo de (cuenta, red del cliente) y en el techo global de la cuenta. Una cuenta o red ya
 * bloqueada no suma más (así el techo global no lo agota una red ya bloqueada).
 */
export async function takeLoginAttempt(db: Db, userId: string, ip: string | null | undefined) {
  const scope = ipScope(ip);
  if ((await current(db, userId, scope, LOGIN_WINDOW_MINUTES)) >= MAX_FAILED_LOGINS) throw tooManyAttempts();
  if ((await current(db, userId, "account", 60)) >= ACCOUNT_CEILING) throw tooManyAttempts();
  if ((await bump(db, userId, scope, LOGIN_WINDOW_MINUTES)) > MAX_FAILED_LOGINS) throw tooManyAttempts();
  if ((await bump(db, userId, "account", 60)) > ACCOUNT_CEILING) throw tooManyAttempts();
}

/** Contraseña correcta: vacía el cupo de esa red (el techo global vence solo). */
export async function clearLoginAttempts(db: Db, userId: string, ip: string | null | undefined) {
  await db.query(`DELETE FROM login_attempts WHERE user_id = $1 AND scope = $2`, [userId, ipScope(ip)]);
}

/** Antes de verificar un código del segundo paso: cupo de la cuenta para códigos (ver arriba). */
export async function takeTwoFactorAttempt(db: Db, userId: string) {
  if ((await current(db, userId, "2fa", LOGIN_WINDOW_MINUTES)) >= MAX_FAILED_2FA) throw tooManyAttempts();
  if ((await bump(db, userId, "2fa", LOGIN_WINDOW_MINUTES)) > MAX_FAILED_2FA) throw tooManyAttempts();
}

/** Código correcto: vacía el cupo de códigos y el de la red desde la que se ingresó la contraseña. */
export async function clearTwoFactorAttempts(db: Db, userId: string, ip: string | null | undefined) {
  await db.query(`DELETE FROM login_attempts WHERE user_id = $1 AND scope IN ('2fa', $2)`, [userId, ipScope(ip)]);
}
