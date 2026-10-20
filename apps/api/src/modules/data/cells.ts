// Celdas: lista pública para el alta, directorio global tenant → celda y enrutamiento. Si este proceso no
// atiende la celda de la organización (SERVED_CELLS), los pedidos autenticados o de firma se responden con
// 421 y la URL del despliegue que sí la atiende. Con un solo despliegue que atiende todas las celdas
// (el caso actual) el enrutamiento no consulta nada.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CellInfo, CellsResponse } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { CELL_CATALOG, cellById, cells, defaultCell, isConfiguredCell, servedCells, servesAllCells } from "../../infra/cells";
import { badRequest } from "../../lib/errors";
import { sha256Hex } from "../../lib/util";
import { SESSION_COOKIE, type Services } from "../context";
import { signerTokenHash } from "../signer-token";

export function publicCells(): CellInfo[] {
  const configured = cells();
  const out: CellInfo[] = configured.map((c) => ({ id: c.id, label: c.label, region: c.region, available: true, default: c.default }));
  for (const c of CELL_CATALOG) if (!out.some((x) => x.id === c.id)) out.push({ id: c.id, label: c.label, region: c.region, available: false, default: false });
  return out;
}

/** Celda para una organización nueva: la pedida (si está configurada) o la por defecto. */
export function cellForSignup(requested: string | undefined | null): string {
  if (!requested) return defaultCell().id;
  if (!isConfiguredCell(requested)) {
    const known = CELL_CATALOG.some((c) => c.id === requested);
    throw badRequest("cell_unavailable", known ? "Esa región todavía no está disponible (próximamente)" : "Región desconocida");
  }
  return requested;
}

/** Alta en el directorio global (en la misma transacción que crea la organización). */
export async function registerTenantCell(db: Db, tenantId: string, slug: string, cell: string) {
  await db.query(`INSERT INTO tenant_directory (tenant_id, cell, slug) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET cell = EXCLUDED.cell, slug = EXCLUDED.slug`, [
    tenantId,
    cell,
    slug,
  ]);
}

/** Celda de una organización según el directorio (ids viejos caen en la por defecto). */
export async function cellOfTenant(db: Db, tenantId: string): Promise<string> {
  const r = await db.one<any>(`SELECT COALESCE(d.cell, t.cell) AS cell FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  return cellById(r?.cell).id;
}

const SIGNING_RE = /^\/(?:v1\/signing|s|embed)\/([A-Za-z0-9_-]{20,100})(?:[/?]|$)/;

/** Organización detrás de un pedido: API key / token OAuth / sesión / link de firma. null si no se sabe. */
export async function tenantOfRequest(db: Db, req: FastifyRequest): Promise<string | null> {
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const h = sha256Hex(authz.slice(7).trim());
    const k = await db.one<any>(`SELECT tenant_id FROM api_keys WHERE key_hash = $1`, [h]);
    if (k) return k.tenant_id;
    const o = await db.one<any>(`SELECT tenant_id FROM oauth_tokens WHERE token_hash = $1`, [h]).catch(() => null);
    if (o) return o.tenant_id;
    return null;
  }
  const m = SIGNING_RE.exec(req.url);
  if (m) {
    // El link permanente o un token de sesión del canje embebido (signer-token.ts).
    const hash = await signerTokenHash(db, m[1]);
    const r = hash ? await db.one<any>(`SELECT tenant_id FROM recipients WHERE access_token_hash = $1`, [hash]) : null;
    if (r) return r.tenant_id;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) {
    const sess = await db.one<any>(`SELECT tenant_id FROM sessions WHERE token_hash = $1`, [sha256Hex(cookie)]);
    if (sess) return sess.tenant_id;
  }
  return null;
}

/** Decide si el pedido tiene que ir a otra celda. null = lo atiende este proceso. */
export async function misdirectedCell(db: Db, req: FastifyRequest): Promise<{ cell: string; baseUrl: string | null } | null> {
  if (servesAllCells()) return null;
  const tenantId = await tenantOfRequest(db, req);
  if (!tenantId) return null;
  const cell = await cellOfTenant(db, tenantId);
  if (servedCells().has(cell)) return null;
  return { cell, baseUrl: cellById(cell).baseUrl };
}

export async function cellRoutes(app: FastifyInstance, s: Services) {
  app.get("/v1/public/cells", async (): Promise<CellsResponse> => ({ items: publicCells() }));

  app.addHook("onRequest", async (req, reply) => {
    if (servesAllCells()) return;
    if (req.url.startsWith("/v1/public/") || req.url === "/healthz") return;
    const wrong = await misdirectedCell(s.db, req);
    if (!wrong) return;
    if (wrong.baseUrl) reply.header("location", `${wrong.baseUrl}${req.url}`);
    return reply.code(421).send({
      error: { code: "wrong_cell", message: "Los datos de esta organización están en otra región", details: { cell: wrong.cell, baseUrl: wrong.baseUrl } },
    });
  });
}
