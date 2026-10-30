// Celdas: lista pública para el alta, directorio global tenant → celda y enrutamiento. Si este proceso no
// atiende la celda de la organización (SERVED_CELLS), los pedidos autenticados o de firma se responden con
// 421 y la URL del despliegue que sí la atiende. Con un solo despliegue que atiende todas las celdas
// (el caso actual) el enrutamiento no consulta nada.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CellInfo, CellsResponse } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { CELL_CATALOG, cells, defaultCell, effectiveCellId, isConfiguredCell, servedCells, servesAllCells } from "../../infra/cells";
import { badRequest } from "../../lib/errors";
import { bearerToken, sha256Hex } from "../../lib/util";
import { sessionCookieToken, type Services } from "../context";
import { signerTokenHash } from "../signer-token";

export function publicCells(): CellInfo[] {
  const where = (id: string) => {
    const c = CELL_CATALOG.find((x) => x.id === id);
    return { country: c?.country ?? null, city: c?.city ?? null, area: c?.area ?? null };
  };
  const configured = cells();
  const out: CellInfo[] = configured.map((c) => ({
    id: c.id,
    label: c.label,
    region: c.region,
    ...where(c.id),
    available: true,
    default: c.default,
  }));
  // Las del catálogo que este despliegue no atiende (available: false; la web igual las ofrece), en el orden del catálogo.
  for (const c of CELL_CATALOG)
    if (!out.some((x) => x.id === c.id))
      out.push({ id: c.id, label: c.label, region: c.region, country: c.country, city: c.city, area: c.area, available: false, default: false });
  return out;
}

/**
 * Celda para una organización nueva y la región que pidió. Una región configurada se respeta. Una del catálogo que
 * este despliegue todavía no tiene configurada se acepta (pedido del usuario del 30-Oct-2026: el alta ofrece todas
 * como disponibles): la organización queda en la celda por defecto y `requested` guarda la que eligió, para migrarla
 * cuando exista (tenants.requested_cell). Una región fuera del catálogo da 400.
 */
export function cellForSignup(requested: string | undefined | null): { cell: string; requested: string | null } {
  if (!requested) return { cell: defaultCell().id, requested: null };
  if (isConfiguredCell(requested)) return { cell: requested, requested: null };
  if (CELL_CATALOG.some((c) => c.id === requested)) return { cell: defaultCell().id, requested };
  throw badRequest("cell_unavailable", "Región desconocida: elegí una de las que lista GET /v1/public/cells");
}

/** Alta en el directorio global (en la misma transacción que crea la organización). */
export async function registerTenantCell(db: Db, tenantId: string, slug: string, cell: string) {
  await db.query(
    `INSERT INTO tenant_directory (tenant_id, cell, slug) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET cell = EXCLUDED.cell, slug = EXCLUDED.slug`,
    [tenantId, cell, slug],
  );
}

/**
 * Celda de una organización según el directorio. Los ids viejos ("local", "dev") son la por defecto; un id que no está
 * configurado en este despliegue se devuelve tal cual (no cae en la por defecto: ver misdirectedCell).
 */
export async function cellOfTenant(db: Db, tenantId: string): Promise<string> {
  const r = await db.one<any>(
    `SELECT COALESCE(d.cell, t.cell) AS cell FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id WHERE t.id = $1`,
    [tenantId],
  );
  return effectiveCellId(r?.cell);
}

const SIGNING_RE = /^\/(?:v1\/signing|s|embed)\/([A-Za-z0-9_-]{20,100})(?:[/?]|$)/;

/**
 * Rutas públicas que no traen sesión ni token de firma pero sí identifican a la organización: formularios web (slug),
 * negociaciones (token de la contraparte), workflows con inicio público (slug) y sus ejecuciones (token), y el pase
 * de firma del celular (token).
 */
const PUBLIC_FORM_RE = /^\/v1\/public\/forms\/([^/?]{1,200})(?:[/?]|$)/;
const PUBLIC_NEGOTIATION_RE = /^\/v1\/public\/negotiations\/([A-Za-z0-9_-]{20,100})(?:[/?]|$)/;
const PUBLIC_WORKFLOW_RE = /^\/v1\/public\/workflows\/([^/?]{1,200})(?:[/?]|$)/;
const PUBLIC_RUN_RE = /^\/v1\/public\/workflow-runs\/([A-Za-z0-9_-]{20,100})(?:[/?]|$)/;
const PUBLIC_HANDOFF_RE = /^\/v1\/public\/signature-handoffs\/([A-Za-z0-9_-]{20,100})(?:[/?]|$)/;

/** Rutas públicas que no dependen de la organización (o la resuelven por el Host): nunca se redirigen. */
export function cellExemptPath(url: string): boolean {
  const path = url.split("?")[0];
  return (
    path === "/healthz" ||
    path === "/v1/public/cells" ||
    path === "/v1/public/brand-theme" ||
    path === "/v1/public/host-branding" ||
    path.startsWith("/v1/public/brand-assets/")
  );
}

const decodeSeg = (x: string) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return null;
  }
};

async function tenantOfPublicPath(db: Db, url: string): Promise<string | null> {
  let m = PUBLIC_FORM_RE.exec(url);
  if (m) {
    const slug = decodeSeg(m[1]);
    return slug ? ((await db.one<any>(`SELECT tenant_id FROM web_forms WHERE slug = $1`, [slug]))?.tenant_id ?? null) : null;
  }
  m = PUBLIC_NEGOTIATION_RE.exec(url);
  if (m) {
    const r = await db.one<any>(
      `SELECT n.tenant_id FROM negotiation_participants p JOIN negotiations n ON n.id = p.negotiation_id WHERE p.token_hash = $1`,
      [sha256Hex(m[1])],
    );
    return r?.tenant_id ?? null;
  }
  m = PUBLIC_WORKFLOW_RE.exec(url);
  if (m) {
    const slug = decodeSeg(m[1]);
    return slug ? ((await db.one<any>(`SELECT tenant_id FROM workflows WHERE public_slug = $1`, [slug]))?.tenant_id ?? null) : null;
  }
  m = PUBLIC_RUN_RE.exec(url);
  if (m) return (await db.one<any>(`SELECT tenant_id FROM workflow_runs WHERE public_token_hash = $1`, [sha256Hex(m[1])]))?.tenant_id ?? null;
  // Pase de firma del celular (signature-handoff.ts): la organización del firmante que lo pidió.
  m = PUBLIC_HANDOFF_RE.exec(url);
  if (m)
    return (
      (await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM signature_handoffs WHERE token_hash = $1`, [sha256Hex(m[1])]))?.tenant_id ?? null
    );
  return null;
}

/** Organización detrás de un pedido: API key / token OAuth / sesión / link de firma. null si no se sabe. */
export async function tenantOfRequest(db: Db, req: FastifyRequest): Promise<string | null> {
  const bearer = bearerToken(req.headers.authorization);
  if (bearer) {
    const h = sha256Hex(bearer);
    const k = await db.one<any>(`SELECT tenant_id FROM api_keys WHERE key_hash = $1`, [h]);
    if (k) return k.tenant_id;
    const o = await db.one<any>(`SELECT tenant_id FROM oauth_tokens WHERE token_hash = $1`, [h]).catch(() => null);
    if (o) return o.tenant_id;
    return null;
  }
  if (req.url.startsWith("/v1/public/")) return tenantOfPublicPath(db, req.url);
  const m = SIGNING_RE.exec(req.url);
  if (m) {
    // El link permanente o un token de sesión del canje embebido (signer-token.ts).
    const hash = await signerTokenHash(db, m[1]);
    const r = hash ? await db.one<any>(`SELECT tenant_id FROM recipients WHERE access_token_hash = $1`, [hash]) : null;
    if (r) return r.tenant_id;
  }
  const cookie = sessionCookieToken(req);
  if (cookie) {
    const sess = await db.one<any>(`SELECT tenant_id FROM sessions WHERE token_hash = $1`, [sha256Hex(cookie)]);
    if (sess) return sess.tenant_id;
  }
  return null;
}

/**
 * Decide si el pedido tiene que ir a otra celda. null = lo atiende este proceso. `unconfigured`: la celda de la
 * organización no está configurada en este despliegue (no se sabe adónde mandarlo): se responde 503, nunca se atiende
 * con la celda por defecto.
 */
export async function misdirectedCell(db: Db, req: FastifyRequest): Promise<{ cell: string; baseUrl: string | null; unconfigured?: true } | null> {
  if (servesAllCells()) return null;
  const tenantId = await tenantOfRequest(db, req);
  if (!tenantId) return null;
  const cell = await cellOfTenant(db, tenantId);
  if (servedCells().has(cell)) return null;
  const conf = cells().find((c) => c.id === cell);
  if (!conf) return { cell, baseUrl: null, unconfigured: true };
  return { cell, baseUrl: conf.baseUrl };
}

export async function cellRoutes(app: FastifyInstance, s: Services) {
  app.get("/v1/public/cells", async (): Promise<CellsResponse> => ({ items: publicCells() }));

  app.addHook("onRequest", async (req, reply) => {
    if (servesAllCells()) return;
    // Solo la lista de celdas y la marca (por Host o por clave pública) quedan afuera: los formularios, negociaciones y
    // workflows públicos identifican a su organización (slug o token) y se redirigen como los links de firma.
    if (cellExemptPath(req.url)) return;
    const wrong = await misdirectedCell(s.db, req);
    if (!wrong) return;
    if (wrong.baseUrl) reply.header("location", `${wrong.baseUrl}${req.url}`);
    return reply.code(wrong.unconfigured ? 503 : 421).send({
      error: {
        code: "wrong_cell",
        message: "Los datos de esta organización están en otra región",
        details: { cell: wrong.cell, baseUrl: wrong.baseUrl },
      },
    });
  });
}
