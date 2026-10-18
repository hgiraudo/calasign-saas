import type { FastifyInstance } from "fastify";
import { CreateApiKeyInput, LoginInput, SignupInput, type ApiKey, type MeResponse } from "@calasign/shared";
import { conflict, notFound, unauthorized } from "../lib/errors";
import { hashPassword, iso, randomToken, sha256Hex, slugify, uuidv7, verifyPassword } from "../lib/util";
import { config } from "../config";
import { cellForSignup, registerTenantCell } from "./data/cells";
import { SESSION_COOKIE, authenticate, clientInfo, type Services } from "./context";
import { MAX_FAILED_LOGINS, createTwoFactorChallenge, recentFailedLogins } from "./teams";
import { passwordLoginTenant } from "./identity/sso";
import { AppError } from "../lib/errors";
import { encrypt } from "../lib/util";
import { enqueue } from "../infra/queue";
import { recordAudit } from "./audit";
import { z } from "zod";

const SESSION_DAYS = 14;

const ForgotPasswordInput = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const ResetPasswordInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/), password: z.string().min(10).max(200) });

export async function authRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  async function createSession(reply: any, req: any, userId: string, tenantId: string) {
    const token = randomToken();
    const { ip, userAgent } = clientInfo(req);
    await s.db.query(
      `INSERT INTO sessions (token_hash, user_id, tenant_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '${SESSION_DAYS} days')`,
      [sha256Hex(token), userId, tenantId, ip, userAgent],
    );
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: SESSION_DAYS * 86400,
    });
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
    const exists = await s.db.one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [input.email]);
    if (exists) throw conflict("email_taken", "Ya existe una cuenta con ese correo");
    const userId = uuidv7();
    const tenantId = uuidv7();
    const pw = await hashPassword(input.password);
    const locale = input.locale ?? "es";
    const cell = cellForSignup(input.cell);
    await s.db.tx(async (t) => {
      let slug = slugify(input.organization);
      if (await t.one(`SELECT 1 FROM tenants WHERE slug = $1`, [slug])) slug = `${slug}-${tenantId.slice(-6)}`;
      await t.query(`INSERT INTO tenants (id, slug, name, default_locale, cell) VALUES ($1,$2,$3,$4,$5)`, [
        tenantId,
        slug,
        input.organization,
        locale,
        cell,
      ]);
      await registerTenantCell(t, tenantId, slug, cell);
      await t.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,$4,$5)`, [
        userId,
        input.email,
        input.name,
        pw,
        locale,
      ]);
      await t.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenantId, userId]);
    });
    await createSession(reply, req, userId, tenantId);
    reply.code(201);
    return me(userId, tenantId);
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`, [input.email]);
    // Se verifica igual con un hash ficticio para no revelar qué correos existen por tiempo de respuesta.
    const ok = await verifyPassword(input.password, u?.password_hash ?? DUMMY_HASH);
    // Límite por cuenta (además del de IP): muchos intentos fallidos recientes bloquean la cuenta 15 minutos,
    // aunque lleguen desde IPs distintas. Se responde igual con la contraseña correcta, para no confirmarla.
    if (u && (await recentFailedLogins(s.db, u.id)) >= MAX_FAILED_LOGINS) {
      throw new AppError(429, "too_many_attempts", "Demasiados intentos fallidos. Probá de nuevo en unos minutos o restablecé tu contraseña.");
    }
    if (!u || !ok) throw unauthorized();
    // SSO obligatorio (Fase 5): se entra a la primera organización que admite contraseña.
    const pick = await passwordLoginTenant(s.db, u.id);
    if (!pick) throw unauthorized();
    if ("passwordResetRequired" in pick) {
      // Sus organizaciones la sumaron por SCIM o SSO (sin SSO habilitado ahora): la contraseña se habilita al restablecerla.
      throw new AppError(403, "password_reset_required", "Para ingresar con contraseña, restablecela desde \"Olvidé mi contraseña\"");
    }
    if ("ssoRequired" in pick) {
      throw new AppError(403, "sso_required", "Tu organización exige ingresar con inicio de sesión único (SSO)", {
        startUrl: `/v1/auth/sso/start?org=${encodeURIComponent(pick.ssoRequired.slug)}&login_hint=${encodeURIComponent(input.email)}`,
      });
    }
    const m = { tenant_id: pick.tenantId };
    const challenge = await createTwoFactorChallenge(s.db, u.id, m.tenant_id);
    if (challenge) return challenge;
    await createSession(reply, req, u.id, m.tenant_id);
    return me(u.id, m.tenant_id);
  });

  // ───────── Recuperación de contraseña ─────────
  // Siempre 202 (no revela si el correo existe). Límite por IP (ruta) y por cuenta (3 pedidos por hora).

  app.post("/v1/auth/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = ForgotPasswordInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [input.email]);
    if (u) {
      const recent = await s.db.one<any>(`SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id]);
      if ((recent?.n ?? 0) < 3) {
        const token = randomToken();
        await s.db.tx(async (t) => {
          // Un pedido nuevo invalida los links anteriores que no se usaron.
          await t.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
          await t.query(`INSERT INTO password_resets (token_hash, user_id, ip, expires_at) VALUES ($1,$2,$3, now() + interval '30 minutes')`, [
            sha256Hex(token),
            u.id,
            clientInfo(req).ip,
          ]);
          await enqueue(t, "notify", { kind: "password_reset", userId: u.id, tokenEnc: encrypt(token) });
        });
      }
    }
    reply.code(202);
    return { ok: true };
  });

  app.post("/v1/auth/password/reset", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = ResetPasswordInput.parse(req.body);
    const pw = await hashPassword(input.password);
    const userId = await s.db.tx(async (t) => {
      // Consumo atómico: el mismo link no sirve dos veces aunque lleguen dos pedidos a la vez.
      const row = await t.one<any>(
        `UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256Hex(input.token)],
      );
      if (!row) return null;
      await t.query(`UPDATE users SET password_hash = $2, password_reset_at = now() WHERE id = $1`, [row.user_id, pw]);
      // Restablecerla prueba que controla el correo: la contraseña vale también en las organizaciones que lo sumaron
      // por SSO o SCIM (ver 0029_r11_identity).
      await t.query(`UPDATE memberships SET password_allowed = true WHERE user_id = $1 AND NOT password_allowed`, [row.user_id]);
      // Se cierran todas las sesiones abiertas: si alguien tenía la contraseña vieja, queda afuera. También los tokens
      // de apps OAuth que autorizó (con la contraseña robada se podía autorizar una app propia y, con su refresh token,
      // seguir entrando después del cambio) y los desafíos de 2FA pendientes de un login con la contraseña vieja.
      await t.query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      await t.query(`DELETE FROM login_challenges WHERE user_id = $1`, [row.user_id]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
      return row.user_id as string;
    });
    if (!userId) throw new AppError(400, "invalid_token", "El link para restablecer la contraseña no es válido o ya venció");
    const u = await s.db.one<any>(`SELECT email FROM users WHERE id = $1`, [userId]);
    const { ip, userAgent } = clientInfo(req);
    const tenants = await s.db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [userId]);
    for (const m of tenants) {
      await recordAudit(s.db, {
        tenantId: m.tenant_id,
        action: "user.password_reset",
        actor: { type: "user", id: userId, label: u?.email ?? null },
        targetType: "user",
        targetId: userId,
        ip,
        userAgent,
      }).catch(() => {});
    }
    return reply.code(204).send();
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await s.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
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
    const rows = await s.db.query(`SELECT * FROM api_keys WHERE tenant_id = $1 AND oauth_client_id IS NULL ORDER BY created_at DESC`, [req.auth!.tenantId]);
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
      [id, req.auth!.tenantId, input.name, secret.slice(0, 12), sha256Hex(secret), req.auth!.userId, role, roleId],
    );
    reply.code(201);
    return { apiKey: toApiKey(row), secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", { preHandler: auth }, async (req, reply) => {
    const r = await s.db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND oauth_client_id IS NULL RETURNING id`, [
      req.params.id,
      req.auth!.tenantId,
    ]);
    if (r.length === 0) throw notFound("API key");
    return reply.code(204).send();
  });
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
