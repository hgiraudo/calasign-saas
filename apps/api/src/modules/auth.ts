import type { FastifyInstance } from "fastify";
import { CreateApiKeyInput, LoginInput, SignupInput, type ApiKey, type MeResponse } from "@calasign/shared";
import { conflict, notFound, unauthorized } from "../lib/errors";
import { hashPassword, iso, randomToken, sha256Hex, slugify, uuidv7, verifyPassword } from "../lib/util";
import { config } from "../config";
import { SESSION_COOKIE, authenticate, clientInfo, type Services } from "./context";
import { createTwoFactorChallenge } from "./teams";
import { passwordLoginTenant } from "./identity/sso";
import { AppError } from "../lib/errors";

const SESSION_DAYS = 14;

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
    await s.db.tx(async (t) => {
      let slug = slugify(input.organization);
      if (await t.one(`SELECT 1 FROM tenants WHERE slug = $1`, [slug])) slug = `${slug}-${tenantId.slice(-6)}`;
      await t.query(`INSERT INTO tenants (id, slug, name, default_locale, cell) VALUES ($1,$2,$3,$4,$5)`, [
        tenantId,
        slug,
        input.organization,
        locale,
        config.environment,
      ]);
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
    if (!u || !ok) throw unauthorized();
    // SSO obligatorio (Fase 5): se entra a la primera organización que admite contraseña.
    const pick = await passwordLoginTenant(s.db, u.id);
    if (!pick) throw unauthorized();
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

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await s.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.code(204).send();
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
    const secret = `cs_${config.environment === "prod" ? "live" : "test"}_${randomToken(24)}`;
    const id = uuidv7();
    const row = await s.db.one(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, req.auth!.tenantId, input.name, secret.slice(0, 12), sha256Hex(secret), req.auth!.userId],
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
    reply.code(204).send();
  });
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
