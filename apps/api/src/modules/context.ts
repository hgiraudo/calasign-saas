import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";
import type { Actor } from "../infra/evidence";
import { sha256Hex } from "../lib/util";
import { unauthorized } from "../lib/errors";

export interface Services {
  db: Db;
  blobs: BlobStore;
}

export interface AuthContext {
  tenantId: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = "cs_session";

export function clientInfo(req: FastifyRequest) {
  return { ip: req.ip ?? null, userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null };
}

/** Resuelve sesión (cookie) o API key (Bearer). */
export function authenticate(s: Services) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const { ip, userAgent } = clientInfo(req);
    const authz = req.headers.authorization;
    if (authz?.startsWith("Bearer ")) {
      const key = authz.slice(7).trim();
      const row = await s.db.one<any>(
        `SELECT id, tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
        [sha256Hex(key)],
      );
      if (!row) throw unauthorized();
      s.db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
      req.auth = {
        tenantId: row.tenant_id,
        userId: null,
        apiKeyId: row.id,
        actor: { type: "api_key", id: row.id, label: `API key: ${row.name}`, ip, userAgent },
      };
      return;
    }
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const row = await s.db.one<any>(
      `SELECT s.user_id, s.tenant_id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    if (!row) throw unauthorized();
    req.auth = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      apiKeyId: null,
      actor: { type: "user", id: row.user_id, label: `${row.name} <${row.email}>`, ip, userAgent },
    };
  };
}
