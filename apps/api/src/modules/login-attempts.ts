// Bloqueo por intentos de ingreso (contraseña y segundo factor).
//
// Cada intento se cuenta ANTES de verificar, con un contador atómico (login_attempts): si no, muchos pedidos en
// paralelo veían todos un contador bajo y probaban cientos de contraseñas. Ámbitos por cuenta:
//   - 'ip:<red>': la /24 (IPv4) o /64 (IPv6) del cliente, MAX_FAILED_LOGINS en LOGIN_WINDOW_MINUTES. Los fallos desde
//     otra red no bloquean a la persona (antes el bloqueo era solo por cuenta: cualquiera que conociera el correo la
//     dejaba afuera con 10 intentos).
//   - 'account': techo global de la cuenta (ACCOUNT_CEILING por hora) contra la prueba distribuida desde muchas redes.
//     Solo cuentan los fallos: el intento se suma antes de verificar (atomicidad) y se devuelve si la contraseña es
//     correcta (un ingreso o una re-autenticación correctos no lo acercan al techo). Solo se aplica a las redes
//     desconocidas: una red desde la que la cuenta ingresó bien en los últimos KNOWN_NETWORK_DAYS días ('ok:<red>') no
//     queda bloqueada por el techo (sigue con su propio cupo por red), así que un ataque distribuido no deja afuera a la
//     persona desde la red de siempre.
//   - '2fa': códigos del segundo paso. Solo los prueba quien ya pasó la contraseña (el desafío), así que los fallos de
//     contraseña desde otras redes no bloquean un desafío ya abierto; además, cada desafío admite 5 códigos.
import type { Db } from "../infra/db";
import { AppError } from "../lib/errors";
import { ipNetworkKey } from "../lib/ip";

export const MAX_FAILED_LOGINS = 10;
export const LOGIN_WINDOW_MINUTES = 15;
export const ACCOUNT_CEILING = 50;
export const MAX_FAILED_2FA = 10;
export const KNOWN_NETWORK_DAYS = 30;

const tooManyAttempts = () =>
  new AppError(429, "too_many_attempts", "Demasiados intentos fallidos. Probá de nuevo en unos minutos o restablecé tu contraseña.");

const ipScope = (ip: string | null | undefined) => `ip:${ipNetworkKey(ip)}`;
/** Red conocida: sin IP no hay red que recordar. */
const okScope = (ip: string | null | undefined) => {
  const net = ipNetworkKey(ip);
  return net === "unknown" ? null : `ok:${net}`;
};

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

/** ¿La cuenta ingresó bien desde esta red en los últimos KNOWN_NETWORK_DAYS días? */
async function knownNetwork(db: Db, userId: string, ip: string | null | undefined): Promise<boolean> {
  const scope = okScope(ip);
  if (!scope) return false;
  return !!(await db.one(
    `SELECT 1 FROM login_attempts WHERE user_id = $1 AND scope = $2 AND window_start >= now() - make_interval(days => $3::int)`,
    [userId, scope, KNOWN_NETWORK_DAYS],
  ));
}

/**
 * Antes de verificar una contraseña (login, aceptar una invitación, alta con una cuenta existente, re-autenticación):
 * cuenta el intento en el cupo de (cuenta, red del cliente) y en el techo global de la cuenta (que se devuelve si la
 * contraseña es correcta: passwordAccepted / clearLoginAttempts). El techo solo bloquea las redes desconocidas. Una
 * cuenta o red ya bloqueada no suma más (así el techo global no lo agota una red ya bloqueada).
 */
export async function takeLoginAttempt(db: Db, userId: string, ip: string | null | undefined) {
  const scope = ipScope(ip);
  if ((await current(db, userId, scope, LOGIN_WINDOW_MINUTES)) >= MAX_FAILED_LOGINS) throw tooManyAttempts();
  const known = await knownNetwork(db, userId, ip);
  if (!known && (await current(db, userId, "account", 60)) >= ACCOUNT_CEILING) throw tooManyAttempts();
  if ((await bump(db, userId, scope, LOGIN_WINDOW_MINUTES)) > MAX_FAILED_LOGINS) throw tooManyAttempts();
  if ((await bump(db, userId, "account", 60)) > ACCOUNT_CEILING && !known) {
    await refundAccount(db, userId);
    throw tooManyAttempts();
  }
}

/** Devuelve al techo global el intento sumado antes de verificar (la contraseña era correcta, o el intento no se hizo). */
async function refundAccount(db: Db, userId: string) {
  await db.query(`UPDATE login_attempts SET n = GREATEST(n - 1, 0) WHERE user_id = $1 AND scope = 'account'`, [userId]);
}

/** Recuerda la red como conocida (ingreso completo correcto). */
async function rememberNetwork(db: Db, userId: string, ip: string | null | undefined) {
  const scope = okScope(ip);
  if (!scope) return;
  await db.query(
    `INSERT INTO login_attempts (user_id, scope, window_start, n) VALUES ($1, $2, now(), 0)
     ON CONFLICT (user_id, scope) DO UPDATE SET window_start = now()`,
    [userId, scope],
  );
}

/**
 * Contraseña correcta, pero el ingreso sigue (segundo factor): devuelve el intento al techo global. El cupo de la red
 * se vacía recién con el código correcto (clearTwoFactorAttempts).
 */
export async function passwordAccepted(db: Db, userId: string) {
  await refundAccount(db, userId);
}

/** Contraseña correcta y sin segundo paso pendiente: vacía el cupo de esa red, devuelve el intento al techo y recuerda la red. */
export async function clearLoginAttempts(db: Db, userId: string, ip: string | null | undefined) {
  await db.query(`DELETE FROM login_attempts WHERE user_id = $1 AND scope = $2`, [userId, ipScope(ip)]);
  await refundAccount(db, userId);
  await rememberNetwork(db, userId, ip);
}

/** Antes de verificar un código del segundo paso: cupo de la cuenta para códigos (ver arriba). */
export async function takeTwoFactorAttempt(db: Db, userId: string) {
  if ((await current(db, userId, "2fa", LOGIN_WINDOW_MINUTES)) >= MAX_FAILED_2FA) throw tooManyAttempts();
  if ((await bump(db, userId, "2fa", LOGIN_WINDOW_MINUTES)) > MAX_FAILED_2FA) throw tooManyAttempts();
}

/**
 * Código correcto: vacía el cupo de códigos y el de la red desde la que se ingresó la contraseña, y recuerda la red (el
 * intento de contraseña ya se devolvió al techo con passwordAccepted).
 */
export async function clearTwoFactorAttempts(db: Db, userId: string, ip: string | null | undefined) {
  await db.query(`DELETE FROM login_attempts WHERE user_id = $1 AND scope IN ('2fa', $2)`, [userId, ipScope(ip)]);
  await rememberNetwork(db, userId, ip);
}
