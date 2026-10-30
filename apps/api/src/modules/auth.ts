import type { FastifyInstance } from "fastify";
import {
  CreateApiKeyInput,
  LoginInput,
  normalizeTimeZone,
  SignupInput,
  type ApiKey,
  type MeResponse,
  type ResetPasswordResponse,
} from "@calasign/shared";
import { conflict, notFound, unauthorized } from "../lib/errors";
import { hashPassword, iso, randomToken, sha256Hex, slugify, uuidv7, verifyPassword } from "../lib/util";
import { forgetCredentialHash } from "../lib/ip";
import { config } from "../config";
import { cellForSignup, registerTenantCell } from "./data/cells";
import { authenticate, clearSessionCookie, clientInfo, sessionCookieToken, type Services } from "./context";
import { assertCanManageApiKey, createTwoFactorChallenge } from "./teams";
import { clearLoginAttempts, passwordAccepted, takeLoginAttempt } from "./login-attempts";
import { openPasswordSession } from "./sessions";
import { enqueueSecurityNotice } from "./security-notices";
import { assertPasswordStrength } from "../lib/password-policy";
import { ipNetworkKey } from "../lib/ip";
import { passwordLoginTenant } from "./identity/sso";
import { AppError } from "../lib/errors";
import { encrypt } from "../lib/util";
import { enqueue } from "../infra/queue";
import { recordAudit } from "./audit";
import { z } from "zod";
import { actingPerson, credentialsCreatedBy } from "./member-access";

/** "Olvidé mi contraseña": pedidos por hora por (cuenta, red del cliente) y techo por cuenta desde cualquier red. */
const RESETS_PER_NETWORK_HOUR = 3;
const RESETS_PER_ACCOUNT_HOUR = 50;

const ForgotPasswordInput = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const ResetPasswordInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  password: z.string().min(10).max(200),
  /** Revocar también las API keys e invitaciones pendientes que creó la persona (por defecto no). */
  revokeCreatedCredentials: z.boolean().optional().default(false),
});

export async function authRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  async function createSession(reply: any, req: any, userId: string, tenantId: string, opts: { rememberMe?: boolean } = {}) {
    await openPasswordSession(s.db, req, reply, userId, tenantId, opts);
  }

  async function me(userId: string, tenantId: string): Promise<MeResponse> {
    const u = await s.db.one<any>(`SELECT id, email, name, locale FROM users WHERE id = $1`, [userId]);
    const t = await s.db.one<any>(`SELECT id, slug, name, plan, default_locale FROM tenants WHERE id = $1`, [tenantId]);
    if (!u || !t) throw unauthorized();
    return {
      user: { id: u.id, email: u.email, name: u.name, locale: u.locale },
      tenant: { id: t.id, slug: t.slug, name: t.name, plan: t.plan, defaultLocale: t.default_locale },
    };
  }

  app.post("/v1/auth/signup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = SignupInput.parse(req.body);
    const existing = await s.db.one<any>(`SELECT id, password_hash, totp_enabled_at FROM users WHERE lower(email) = lower($1)`, [input.email]);
    // Cuenta existente SIN organizaciones (p. ej. la quitaron de la única que tenía): con su contraseña (la misma prueba
    // que el ingreso, con el mismo bloqueo por cuenta) crea una organización nueva para esa cuenta. No se crea otra
    // cuenta ni se toca la existente (contraseña, nombre, 2FA). Con 2FA no: crear la organización abriría una sesión con
    // solo la contraseña. Con organizaciones, o sin la contraseña correcta, sigue siendo email_taken (sin revelar más).
    // Cuenta nueva: contraseña no común ni basada en el correo (la existente ya tiene su contraseña).
    if (!existing) assertPasswordStrength(input.password, input.email);
    const userId = existing ? await existingAccountWithoutOrganization(existing, input.password, clientInfo(req).ip) : uuidv7();
    const tenantId = uuidv7();
    const pw = existing ? null : await hashPassword(input.password);
    const locale = input.locale ?? "es";
    const { cell, requested: requestedCell } = cellForSignup(input.cell);
    await s.db.tx(async (t) => {
      if (existing) {
        // Con la cuenta bloqueada: una invitación aceptada a la vez la habría sumado a otra organización.
        await t.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        if (await t.one(`SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1`, [userId]))
          throw conflict("email_taken", "Ya existe una cuenta con ese correo");
      }
      let slug = slugify(input.organization);
      if (await t.one(`SELECT 1 FROM tenants WHERE slug = $1`, [slug])) slug = `${slug}-${tenantId.slice(-6)}`;
      await t.query(`INSERT INTO tenants (id, slug, name, default_locale, cell, time_zone, requested_cell) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        tenantId,
        slug,
        input.organization,
        locale,
        cell,
        // El de la persona que da de alta la cuenta (lo manda la web); un valor inválido no frena el alta: UTC.
        normalizeTimeZone(input.timeZone),
        // La región elegida si todavía no está configurada (quedó en la por defecto): ver cellForSignup.
        requestedCell,
      ]);
      await registerTenantCell(t, tenantId, slug, cell);
      if (!existing) {
        await t.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,$4,$5)`, [
          userId,
          input.email,
          input.name,
          pw,
          locale,
        ]);
      }
      await t.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenantId, userId]);
    });
    if (existing) {
      await recordAudit(s.db, {
        tenantId,
        action: "auth.signup_existing_account",
        actor: { type: "user", id: userId, label: input.email },
        targetType: "user",
        targetId: userId,
        ...clientInfo(req),
      }).catch(() => {});
    }
    await createSession(reply, req, userId, tenantId);
    reply.code(201);
    return me(userId, tenantId);
  });

  /**
   * Signup con un correo ya registrado: el id de la cuenta si no tiene organizaciones y la contraseña es la suya.
   * Desde afuera, toda cuenta existente se ve igual salvo con la contraseña correcta de una cuenta sin organizaciones:
   * siempre una verificación scrypt (la real o una ficticia) y siempre email_taken. El intento cuenta para el bloqueo
   * por cuenta solo en las cuentas sin organizaciones con contraseña (las únicas a las que el signup les puede abrir
   * una sesión: así no sirve para probar contraseñas sin límite), y una cuenta ya bloqueada responde email_taken sin
   * verificar la real (no too_many_attempts, que la delataba). El signup no empuja al bloqueo a las cuentas con
   * organizaciones (eso queda para /v1/auth/login).
   */
  async function existingAccountWithoutOrganization(
    u: { id: string; password_hash: unknown; totp_enabled_at: unknown },
    password: string,
    ip: string | null,
  ): Promise<string> {
    const taken = () => conflict("email_taken", "Ya existe una cuenta con ese correo");
    const hasOrganization = !!(await s.db.one(`SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1`, [u.id]));
    const hasPassword = typeof u.password_hash === "string" && u.password_hash.startsWith("scrypt$");
    let candidate = !hasOrganization && hasPassword;
    if (candidate) {
      try {
        await takeLoginAttempt(s.db, u.id, ip);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "too_many_attempts") throw e;
        candidate = false; // bloqueada: como cualquier otra cuenta existente
      }
    }
    const ok = (await verifyPassword(password, candidate ? (u.password_hash as string) : DUMMY_HASH)) && candidate;
    if (!ok) throw taken();
    await clearLoginAttempts(s.db, u.id, ip);
    if (u.totp_enabled_at) {
      throw new AppError(
        409,
        "account_without_organization_2fa",
        "Tu cuenta tiene verificación en dos pasos y no pertenece a ninguna organización: pedí que te inviten a una.",
      );
    }
    return u.id;
  }

  app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`, [input.email]);
    // Se verifica igual con un hash ficticio para no revelar qué correos existen por tiempo de respuesta. También para
    // las cuentas sin contraseña (altas por SSO o SCIM): su marca no es un hash scrypt y verifyPassword respondía al
    // instante, lo que delataba esas cuentas.
    const hasPassword = typeof u?.password_hash === "string" && u.password_hash.startsWith("scrypt$");
    // Límite por (cuenta, red) y techo global por cuenta (además del de IP de la ruta): el intento se cuenta antes de
    // verificar (ver login-attempts.ts). Se responde igual con la contraseña correcta, para no confirmarla.
    const ip = clientInfo(req).ip;
    if (u) await takeLoginAttempt(s.db, u.id, ip);
    const ok = (await verifyPassword(input.password, hasPassword ? u.password_hash : DUMMY_HASH)) && hasPassword;
    if (!u || !ok) throw unauthorized();

    // SSO obligatorio (Fase 5): se entra a la primera organización que admite contraseña.
    const pick = await passwordLoginTenant(s.db, u.id);
    if (!pick) {
      // Contraseña correcta pero sin organizaciones (la quitaron de la única que tenía, o una aceptación de invitación
      // vieja dejó la cuenta suelta): no es un 401 genérico, que hacía pensar que la contraseña estaba mal.
      await clearLoginAttempts(s.db, u.id, ip);
      // Con 2FA el alta con la misma contraseña no le crea una organización (account_without_organization_2fa): solo
      // le queda una invitación.
      const totp = await s.db.one(`SELECT 1 FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL`, [u.id]);
      throw new AppError(
        403,
        "no_organization",
        totp
          ? "Tu cuenta no pertenece a ninguna organización. Como tiene verificación en dos pasos, pedí que te inviten a una."
          : "Tu cuenta no pertenece a ninguna organización. Para crear una, registrate con este mismo correo y contraseña, o pedí que te inviten.",
        totp ? { twoFactor: true } : undefined,
      );
    }
    // Contraseña correcta: si el acceso es por SSO o hay que restablecerla, no es un intento fallido (si no, se seguía
    // contando y terminaba en too_many_attempts en vez de la indicación de SSO).
    if ("passwordResetRequired" in pick || "ssoRequired" in pick) await clearLoginAttempts(s.db, u.id, ip);
    if ("passwordResetRequired" in pick) {
      // Sus organizaciones la sumaron por SCIM o SSO (sin SSO habilitado ahora): la contraseña se habilita al restablecerla.
      throw new AppError(403, "password_reset_required", 'Para ingresar con contraseña, restablecela desde "Olvidé mi contraseña"');
    }
    if ("ssoRequired" in pick) {
      throw new AppError(403, "sso_required", "Tu organización exige ingresar con inicio de sesión único (SSO)", {
        startUrl: `/v1/auth/sso/start?org=${encodeURIComponent(pick.ssoRequired.slug)}&login_hint=${encodeURIComponent(input.email)}`,
      });
    }
    const m = { tenant_id: pick.tenantId };
    const challenge = await createTwoFactorChallenge(s.db, u.id, m.tenant_id, null, { rememberMe: input.rememberMe });
    // Con segundo factor, el cupo de la red se vacía recién cuando el código es correcto (el techo global de la cuenta
    // solo cuenta fallos: el intento se devuelve ya).
    if (challenge) {
      await passwordAccepted(s.db, u.id);
      return challenge;
    }
    await clearLoginAttempts(s.db, u.id, ip);
    await createSession(reply, req, u.id, m.tenant_id, { rememberMe: input.rememberMe });
    return me(u.id, m.tenant_id);
  });

  // ───────── Recuperación de contraseña ─────────
  // Siempre 202 (no revela si el correo existe). Límite por IP (ruta), por (cuenta, red) (3 pedidos por hora, el límite
  // principal) y un techo alto por cuenta (50 por hora, contra el bombardeo de correos desde muchas redes).
  // Pedidos desde otra red no agotan el cupo de la persona ni invalidan sus links.

  app.post("/v1/auth/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = ForgotPasswordInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [input.email]);
    if (u) {
      {
        const token = randomToken();
        const ip = clientInfo(req).ip;
        const ipKey = ipNetworkKey(ip);
        await s.db.tx(async (t) => {
          // Con la cuenta bloqueada: pedidos en paralelo (desde varias IP) pasaban todos el tope.
          await t.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [u.id]);
          const recent = await t.one<{ fromNetwork: number; total: number }>(
            `SELECT count(*) FILTER (WHERE ip_key = $2)::int AS "fromNetwork", count(*)::int AS total
               FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
            [u.id, ipKey],
          );
          // El tope es por (cuenta, red): un tercero que pide links para el correo de otra persona agota solo su cupo,
          // no el de ella (antes, 3 pedidos ajenos dejaban sin correo el pedido legítimo durante una hora).
          if ((recent?.fromNetwork ?? 0) >= RESETS_PER_NETWORK_HOUR || (recent?.total ?? 0) >= RESETS_PER_ACCOUNT_HOUR) return;
          // Un pedido nuevo reemplaza a los anteriores desde la misma red: invalida esos links sin usar. Los pedidos desde
          // otras redes vencen solos (30 minutos): si no, un tercero que pide links para el correo de otra persona
          // invalidaba el que ella acababa de recibir.
          await t.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL AND ip_key IS NOT DISTINCT FROM $2`, [
            u.id,
            ipKey,
          ]);
          await t.query(
            `INSERT INTO password_resets (token_hash, user_id, ip, ip_key, expires_at) VALUES ($1,$2,$3,$4, now() + interval '30 minutes')`,
            [sha256Hex(token), u.id, ip, ipKey],
          );
          await enqueue(t, "notify", { kind: "password_reset", userId: u.id, tokenEnc: encrypt(token) });
        });
      }
    }
    reply.code(202);
    return { ok: true };
  });

  app.post("/v1/auth/password/reset", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = ResetPasswordInput.parse(req.body);
    // Contraseña no común ni basada en el correo: con el correo de la cuenta del link (si el link no sirve, el error es
    // el de siempre, invalid_token, sin revelar nada).
    const holder = await s.db.one<{ email: string }>(
      `SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
      [sha256Hex(input.token)],
    );
    if (holder) assertPasswordStrength(input.password, holder.email);
    const pw = await hashPassword(input.password);
    const done = await s.db.tx(async (t) => {
      // Primero la cuenta (como "olvidé mi contraseña", que bloquea users y después password_resets): con el orden
      // inverso, los dos a la vez para la misma persona se bloqueaban entre sí (deadlock, 500).
      const owner = await t.one<any>(`SELECT user_id FROM password_resets WHERE token_hash = $1`, [sha256Hex(input.token)]);
      if (!owner) return null;
      await t.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [owner.user_id]);
      // Consumo atómico: el mismo link no sirve dos veces aunque lleguen dos pedidos a la vez.
      const row = await t.one<any>(
        `UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256Hex(input.token)],
      );
      if (!row) return null;
      // La verificación en dos pasos NO se borra al restablecer: controlar el correo no alcanza para saltearla (es justo
      // lo que protege). Ver "Cuentas pre-registradas con un correo ajeno" en docs/ARQUITECTURA.md.
      await t.query(`UPDATE users SET password_hash = $2, password_reset_at = now() WHERE id = $1`, [row.user_id, pw]);
      await t.query(`DELETE FROM login_attempts WHERE user_id = $1`, [row.user_id]);
      // Restablecerla prueba que controla el correo: la contraseña vale también en las organizaciones que lo sumaron
      // por SSO o SCIM (ver 0029_r11_identity).
      await t.query(`UPDATE memberships SET password_allowed = true WHERE user_id = $1 AND NOT password_allowed`, [row.user_id]);
      // Se cierran todas las sesiones abiertas: si alguien tenía la contraseña vieja, queda afuera. También los tokens
      // de apps OAuth que autorizó (con la contraseña robada se podía autorizar una app propia y, con su refresh token,
      // seguir entrando después del cambio) y los desafíos de 2FA pendientes de un login con la contraseña vieja.
      await t.query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      // Y los códigos de autorización todavía sin canjear: canjeados después daban tokens nuevos que esta revocación
      // ya no alcanzaba.
      await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
      await t.query(`DELETE FROM login_challenges WHERE user_id = $1`, [row.user_id]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
      // Las credenciales que creó (API keys, tokens SCIM, apps de servicio, invitaciones) NO se revocan por defecto: pueden
      // ser integraciones productivas. Se listan en la respuesta para que decida; si lo pide (p. ej. sospecha que alguien
      // usó su cuenta), se revocan sus API keys e invitaciones pendientes. Los tokens SCIM y las apps de servicio son de
      // la organización: los revisa un administrador.
      const credentials = await credentialsCreatedBy(t, row.user_id, { revoke: input.revokeCreatedCredentials });
      // Aviso al correo de la cuenta (en la misma transacción: si el cambio se confirma, el aviso sale).
      await enqueueSecurityNotice(t, req, row.user_id, "password_changed");
      return { userId: row.user_id as string, credentials };
    });
    if (!done) throw new AppError(400, "invalid_token", "El link para restablecer la contraseña no es válido o ya venció");
    const { userId, credentials } = done;
    const u = await s.db.one<any>(`SELECT email FROM users WHERE id = $1`, [userId]);
    const { ip, userAgent } = clientInfo(req);
    const tenants = await s.db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [userId]);
    // Auditoría en cada organización de la que es miembro y, donde ya no lo es, solo si ahí se le revocó algo: el
    // restablecimiento de la contraseña de alguien ajeno no es asunto de esa organización (y su registro, que es
    // append-only, no tiene que mostrar el correo de quien ya no es miembro salvo que haya cambiado algo propio).
    const revokedIn = (c: (typeof credentials)[number]) => Boolean(c.revoked && (c.revoked.apiKeys.length || c.revoked.invitations));
    const tenantIds = new Set<string>([...tenants.map((m) => m.tenant_id as string), ...credentials.filter(revokedIn).map((c) => c.tenantId)]);
    for (const tenantId of tenantIds) {
      const c = credentials.find((x) => x.tenantId === tenantId);
      await recordAudit(s.db, {
        tenantId,
        action: "user.password_reset",
        actor: { type: "user", id: userId, label: u?.email ?? null },
        targetType: "user",
        targetId: userId,
        ip,
        userAgent,
        data: {
          revokeCreatedCredentials: input.revokeCreatedCredentials,
          activeCreatedCredentials: {
            apiKeys: c?.apiKeys ?? 0,
            scimTokens: c?.scimTokens ?? 0,
            serviceApps: c?.serviceApps ?? 0,
            invitations: c?.invitations ?? 0,
          },
          ...(c?.revoked ? { revokedCredentials: c.revoked } : {}),
        },
      }).catch(() => {});
    }
    // Para la pantalla: credenciales activas que creó, por organización, y lo revocado (si lo pidió).
    const body: ResetPasswordResponse = {
      ok: true,
      createdCredentials: credentials
        .filter((c) => c.apiKeys || c.scimTokens || c.serviceApps || c.invitations)
        .map((c) => ({
          tenantId: c.tenantId,
          tenantName: c.tenantName,
          apiKeys: c.apiKeys,
          scimTokens: c.scimTokens,
          serviceApps: c.serviceApps,
          invitations: c.invitations,
        })),
      revokedCredentials: input.revokeCreatedCredentials
        ? {
            apiKeys: credentials.reduce((n, c) => n + (c.revoked?.apiKeys.length ?? 0), 0),
            invitations: credentials.reduce((n, c) => n + (c.revoked?.invitations ?? 0), 0),
          }
        : null,
    };
    return reply.code(200).send(body);
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = sessionCookieToken(req);
    if (token) await s.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/v1/me", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    if (!a.userId) {
      const t = await s.db.one<any>(`SELECT id, slug, name, plan, default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
      return {
        user: { id: a.apiKeyId, email: "", name: a.actor.label, locale: t.default_locale },
        tenant: { id: t.id, slug: t.slug, name: t.name, plan: t.plan, defaultLocale: t.default_locale },
      };
    }
    return me(a.userId, a.tenantId);
  });

  // ───────── API keys ─────────

  const toApiKey = (r: any): ApiKey => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: iso(r.created_at)!,
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  });

  app.get("/v1/api-keys", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM api_keys WHERE tenant_id = $1 AND oauth_client_id IS NULL ORDER BY created_at DESC`, [
      req.auth!.tenantId,
    ]);
    return { items: rows.map(toApiKey) };
  });

  app.post("/v1/api-keys", { preHandler: auth }, async (req, reply) => {
    const input = CreateApiKeyInput.parse(req.body);
    // El rol pedido se guarda en el mismo INSERT (la política de acceso ya validó que quien la crea puede otorgarlo).
    // Antes lo aplicaba un hook posterior a la respuesta que, si fallaba, dejaba la key como admin.
    const body = (req.body ?? {}) as { role?: unknown; roleId?: unknown };
    const role = body.role === "member" || body.role === "custom" ? body.role : "admin";
    const roleId = role === "custom" && typeof body.roleId === "string" ? body.roleId : null;
    if (role === "custom" && !roleId) throw new AppError(400, "invalid_role", "Falta el rol personalizado");
    const secret = `cs_${config.environment === "prod" ? "live" : "test"}_${randomToken(24)}`;
    const id = uuidv7();
    const row = await s.db.one(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role, role_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      // A nombre de la persona (también si la crea una API key): así se revoca con su baja.
      [id, req.auth!.tenantId, input.name, secret.slice(0, 12), sha256Hex(secret), await actingPerson(s.db, req.auth!), role, roleId],
    );
    reply.code(201);
    return { apiKey: toApiKey(row), secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", { preHandler: auth }, async (req, reply) => {
    await assertCanManageApiKey(s.db, req.auth!, req.params.id);
    const r = await s.db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND oauth_client_id IS NULL RETURNING key_hash`,
      [req.params.id, req.auth!.tenantId],
    );
    if (r.length === 0) throw notFound("API key");
    // El límite de pedidos de esta réplica deja de contarla por credencial (las demás, al primer pedido rechazado).
    forgetCredentialHash((r[0] as { key_hash: string }).key_hash);
    return reply.code(204).send();
  });
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
