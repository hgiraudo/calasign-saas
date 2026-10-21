// Auditoría de cuenta: registro append-only de acciones administrativas (no del sobre: eso es envelope_events).
// Las acciones de otros módulos se registran con un hook onSend a partir de la ruta y su respuesta, sin tocar
// sus handlers; las de este módulo (miembros, roles, grupos, 2FA…) llaman a recordAudit directamente.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditLogEntry, AuditLogResponse } from "@calasign/shared";
import type { Db } from "../infra/db";
import { badRequest } from "../lib/errors";
import { hostOf, iso, likeContains } from "../lib/util";
import { csvBody, csvSep, localTsSql, resolveTimeZone } from "../lib/csv";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";

export interface AuditRecord {
  tenantId: string;
  action: string;
  actor: { type: "user" | "api_key" | "system" | "anonymous"; id?: string | null; label?: string | null };
  targetType?: string | null;
  targetId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(db: Db, r: AuditRecord) {
  await db.query(
    `INSERT INTO account_audit_log (tenant_id, actor_type, actor_id, actor_label, action, target_type, target_id, data, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      r.tenantId,
      r.actor.type,
      r.actor.id ?? null,
      r.actor.label ?? null,
      r.action,
      r.targetType ?? null,
      r.targetId ?? null,
      JSON.stringify(r.data ?? {}),
      r.ip ?? null,
      r.userAgent?.slice(0, 500) ?? null,
    ],
  );
}

/** Marca de que el handler ya registró la acción: el hook de ajustes (settings.changed) no la duplica. */
type AuditedRequest = FastifyRequest & { audited?: boolean; auditBefore?: Record<string, unknown> };

/** Registro a partir de un request autenticado. */
export function auditFromRequest(db: Db, req: FastifyRequest, a: AuthContext, action: string, extra: Partial<AuditRecord> = {}) {
  const { ip, userAgent } = clientInfo(req);
  (req as AuditedRequest).audited = true;
  return recordAudit(db, {
    tenantId: a.tenantId,
    action,
    actor: { type: a.actor.type === "api_key" ? "api_key" : "user", id: a.actor.id ?? null, label: a.actor.label ?? null },
    ip,
    userAgent,
    ...extra,
  });
}

/**
 * Valores que cambiaron entre dos instantáneas (solo las claves distintas): { from: {…}, to: {…} }. Para auditar
 * cambios de configuración con su valor anterior y el nuevo; las instantáneas no llevan secretos (a lo sumo un
 * booleano "cambió" o una huella).
 */
export function changedValues(before: Record<string, unknown>, after: Record<string, unknown>) {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k] ?? null;
    const a = after[k] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      from[k] = b;
      to[k] = a;
    }
  }
  return { from, to, changed: Object.keys(to) };
}

/** Ruta real del pedido (con los parámetros en lugar de ":id"), para el targetId del registro genérico. */
export function realPath(pattern: string, params: Record<string, string>) {
  return pattern.replace(/:(\w+)/g, (m, k: string) => (typeof params[k] === "string" ? params[k] : m));
}

type Extract = (ctx: { req: FastifyRequest; body: any; params: Record<string, string> }) => Partial<AuditRecord> | null;

/** Acciones de otros módulos, por "MÉTODO ruta". dedupeMinutes: no repetir la misma acción del mismo actor sobre el
 * mismo objetivo dentro de ese lapso (descargas: el editor vuelve a pedir el PDF en cada apertura). */
const ROUTE_ACTIONS: Record<string, { action: string; extract?: Extract; dedupeMinutes?: number }> = {
  // Descargas del remitente: quién se llevó el PDF firmado o un original queda en la auditoría de la organización.
  "GET /v1/envelopes/:id/signed.pdf": {
    action: "envelope.signed_pdf_downloaded",
    dedupeMinutes: 10,
    extract: ({ params }) => ({ targetType: "envelope", targetId: params.id }),
  },
  "GET /v1/envelopes/:id/documents/:documentId/file": {
    action: "envelope.document_downloaded",
    dedupeMinutes: 10,
    extract: ({ params }) => ({ targetType: "document", targetId: params.documentId, data: { envelopeId: params.id } }),
  },
  // Borrar un borrador borra también su registro de eventos: la constancia queda acá.
  "DELETE /v1/envelopes/:id": {
    action: "envelope.deleted",
    extract: ({ params, req }) => ({ targetType: "envelope", targetId: params.id, data: { subject: (req as AuditedRequest).auditBefore?.subject ?? null } }),
  },
  "POST /v1/api-keys": {
    action: "api_key.created",
    // El rol sale del pedido (la respuesta no lo trae); la política de rutas ya lo validó. Sin rol, la key es admin.
    extract: ({ body, req }) => {
      const input = (req.body ?? {}) as { role?: string; roleId?: string };
      return { targetType: "api_key", targetId: body?.apiKey?.id, data: { name: body?.apiKey?.name, role: input.role ?? "admin", roleId: input.role === "custom" ? (input.roleId ?? null) : null } };
    },
  },
  // GET /v1/reports/envelopes.csv (reports.exported) lo registra su handler (experience.ts), con filas y corte.
  "DELETE /v1/api-keys/:id": { action: "api_key.revoked", extract: ({ params }) => ({ targetType: "api_key", targetId: params.id }) },
  "POST /v1/templates": { action: "template.created", extract: ({ body }) => ({ targetType: "template", targetId: body?.template?.id, data: { name: body?.template?.name } }) },
  "POST /v1/templates/from-envelope/:envelopeId": {
    action: "template.created",
    extract: ({ body, params }) => ({ targetType: "template", targetId: body?.template?.id, data: { name: body?.template?.name, fromEnvelope: params.envelopeId } }),
  },
  "DELETE /v1/templates/:id": { action: "template.deleted", extract: ({ params }) => ({ targetType: "template", targetId: params.id }) },
  // De la URL solo el host: los integradores suelen poner un secreto en ella (?token=…) y la auditoría la ven todos los
  // administradores (y se exporta).
  "POST /v1/webhooks": {
    action: "webhook.created",
    extract: ({ body }) => ({ targetType: "webhook", targetId: body?.webhook?.id, data: { host: typeof body?.webhook?.url === "string" ? hostOf(body.webhook.url) : null } }),
  },
  "PATCH /v1/webhooks/:id": {
    action: "webhook.updated",
    extract: ({ params, req, body }) => {
      const before = (req as AuditedRequest).auditBefore?.url;
      const after = body?.url;
      // Cambio de URL: el host anterior y el nuevo (también si cambió solo la ruta o la query, con el mismo host).
      const url = typeof before === "string" && typeof after === "string" && before !== after ? { fromHost: hostOf(before), toHost: hostOf(after) } : {};
      return { targetType: "webhook", targetId: params.id, data: { fields: Object.keys((req.body as object) ?? {}), ...url } };
    },
  },
  "DELETE /v1/webhooks/:id": { action: "webhook.deleted", extract: ({ params }) => ({ targetType: "webhook", targetId: params.id }) },
  "POST /v1/webhooks/:id/rotate-secret": { action: "webhook.secret_rotated", extract: ({ params, req }) => ({ targetType: "webhook", targetId: params.id, data: { graceHours: (req.body as { graceHours?: number } | null)?.graceHours ?? 24 } }) },
  // Un formulario web publica un link que crea sobres a nombre de su dueño: quién lo creó, cambió (p. ej. el firmante
  // fijo, que recibe cada envío) o borró tiene que quedar en la auditoría, como los webhooks.
  "POST /v1/web-forms": { action: "web_form.created", extract: ({ body }) => ({ targetType: "web_form", targetId: body?.id, data: { name: body?.name, templateId: body?.templateId } }) },
  "PATCH /v1/web-forms/:id": {
    action: "web_form.updated",
    extract: ({ params, req }) => ({ targetType: "web_form", targetId: params.id, data: { fields: Object.keys((req.body as object) ?? {}) } }),
  },
  "DELETE /v1/web-forms/:id": { action: "web_form.deleted", extract: ({ params }) => ({ targetType: "web_form", targetId: params.id }) },
  // Adjuntos que subieron los firmantes: quién los descargó (como los originales y el PDF firmado).
  "GET /v1/envelopes/:id/attachments/:fieldId": {
    action: "envelope.attachment_downloaded",
    dedupeMinutes: 10,
    extract: ({ params }) => ({ targetType: "field", targetId: params.fieldId, data: { envelopeId: params.id } }),
  },
};

const AUDITED_VALUES = ["retentionDays", "require2fa", "enabled", "autoExtractMetadata", "renewalAlertDays", "monthlyTokenBudget", "frameAncestors"];

function auditValues(req: FastifyRequest): Record<string, unknown> {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const to = Object.fromEntries(AUDITED_VALUES.filter((k) => k in body).map((k) => [k, body[k]]));
  const from = (req as AuditedRequest).auditBefore;
  return { ...(Object.keys(to).length ? { to } : {}), ...(from ? { from } : {}) };
}

export function registerAuditHooks(app: FastifyInstance, s: Services) {
  app.addHook("onSend", async (req, reply, payload) => {
    try {
      const status = reply.statusCode;
      const url = req.routeOptions?.url ?? "";
      const key = `${req.method} ${url}`;
      const params = (req.params ?? {}) as Record<string, string>;

      // Ingreso: éxito (sesión creada) o fallo.
      if (key === "POST /v1/auth/login") {
        const { ip, userAgent } = clientInfo(req);
        if (status === 200) {
          const body = parse(payload);
          if (body?.user?.id && body?.tenant?.id) {
            await recordAudit(s.db, { tenantId: body.tenant.id, action: "auth.login", actor: { type: "user", id: body.user.id, label: body.user.email }, ip, userAgent });
          }
        } else if (status === 401) {
          const email = String((req.body as any)?.email ?? "").toLowerCase().trim();
          const u = email ? await s.db.one<any>(`SELECT id FROM users WHERE lower(email) = $1`, [email]) : null;
          if (u) {
            const tenants = await s.db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [u.id]);
            for (const t of tenants) {
              await recordAudit(s.db, { tenantId: t.tenant_id, action: "auth.login_failed", actor: { type: "anonymous", id: u.id, label: email }, ip, userAgent, data: { reason: "bad_password" } });
            }
          }
        }
        return payload;
      }

      if (status >= 300 || !req.auth) return payload;
      if (url.startsWith("/v1/settings/") && req.method !== "GET") {
        // El handler ya dejó su propio registro (p. ej. settings.evidence_updated, byok.enabled): no se duplica.
        if ((req as AuditedRequest).audited) return payload;
        await auditFromRequest(s.db, req, req.auth, "settings.changed", {
          targetType: "settings",
          // La ruta real (p. ej. "scim/tokens/<id>"), no el patrón con ":id".
          targetId: realPath(url, params).replace("/v1/settings/", ""),
          data: {
            method: req.method,
            fields: req.body && typeof req.body === "object" ? Object.keys(req.body as object) : [],
            // Valores de los ajustes sensibles (no secretos): sin ellos no se sabía, p. ej., que alguien bajó la retención a
            // 1 día (y borró originales) y la volvió a subir. "from": el valor anterior, si el handler lo dejó.
            ...auditValues(req),
          },
        });
        return payload;
      }
      const def = ROUTE_ACTIONS[key];
      if (def) {
        const extra = def.extract?.({ req, body: parse(payload), params }) ?? {};
        if (def.dedupeMinutes) {
          const a = req.auth;
          const recent = await s.db.one(
            `SELECT 1 FROM account_audit_log
              WHERE tenant_id = $1 AND action = $2 AND actor_id IS NOT DISTINCT FROM $3 AND target_id IS NOT DISTINCT FROM $4
                AND occurred_at > now() - make_interval(mins => $5) LIMIT 1`,
            [a.tenantId, def.action, a.actor.id ?? null, extra.targetId ?? null, def.dedupeMinutes],
          );
          if (recent) return payload;
        }
        await auditFromRequest(s.db, req, req.auth, def.action, extra ?? {});
      }
    } catch (err) {
      req.log.error({ err }, "no se pudo registrar la auditoría");
    }
    return payload;
  });
}

function parse(payload: unknown): any {
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ───────────────────────────── Consulta ─────────────────────────────

interface AuditQuery {
  action?: string;
  actor?: string;
  targetType?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
  /** CSV: separador ("," o ";") y zona horaria de la columna occurred_at_local. */
  sep?: string;
  tz?: string;
  /** CSV: continuar un export truncado a partir de (sin incluir) la fila con este id (el de la última exportada). */
  beforeId?: string;
}

/** Fecha del filtro; una inválida es un 400 (no un error interno). */
function qDate(v: string, name: string) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid_query", `'${name}' no es una fecha válida`);
  return d.toISOString();
}

function buildWhere(tenantId: string, q: AuditQuery) {
  const params: unknown[] = [tenantId];
  let where = `tenant_id = $1`;
  // Una clave repetida (?action=a&action=b) llega como array: `.endsWith` respondía 500.
  if (q.action !== undefined && typeof q.action !== "string") throw badRequest("invalid_query", "'action' admite un solo valor");
  if (q.actor !== undefined && typeof q.actor !== "string") throw badRequest("invalid_query", "'actor' admite un solo valor");
  if (q.action) {
    params.push(q.action.endsWith("*") ? q.action.slice(0, -1) + "%" : q.action);
    where += q.action.endsWith("*") ? ` AND action LIKE $${params.length}` : ` AND action = $${params.length}`;
  }
  if (q.actor) {
    // Texto en la etiqueta o id EXACTO del actor (como dice la documentación): con el mismo parámetro "%…%" el id
    // nunca coincidía y filtrar por el id de un usuario o una API key no devolvía nada.
    // % y _ del texto se buscan literales.
    params.push(likeContains(q.actor), q.actor);
    where += ` AND (actor_label ILIKE $${params.length - 1} ESCAPE '\\' OR actor_id = $${params.length})`;
  }
  if (q.targetType) {
    params.push(q.targetType);
    where += ` AND target_type = $${params.length}`;
  }
  if (q.from) {
    params.push(qDate(q.from, "from"));
    where += ` AND occurred_at >= $${params.length}::timestamptz`;
  }
  if (q.to) {
    params.push(qDate(q.to, "to"));
    where += ` AND occurred_at <= $${params.length}::timestamptz`;
  }
  return { params, where };
}

const toEntry = (r: any): AuditLogEntry => ({
  id: Number(r.id),
  occurredAt: iso(r.occurred_at)!,
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorLabel: r.actor_label,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  data: r.data ?? {},
  ip: r.ip,
  userAgent: r.user_agent,
});

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Evita la inyección de fórmulas al abrir el CSV en una planilla.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

const CSV_MAX_ROWS = 50_000;

export async function auditRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get<{ Querystring: AuditQuery }>("/v1/audit-log", { preHandler: auth }, async (req): Promise<AuditLogResponse> => {
    const { params, where: w0 } = buildWhere(req.auth!.tenantId, req.query);
    let where = w0;
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50));
    if (req.query.cursor) {
      const cur = Number(Buffer.from(req.query.cursor, "base64url").toString());
      if (!Number.isSafeInteger(cur)) throw badRequest("invalid_cursor", "Cursor inválido");
      params.push(cur);
      where += ` AND id < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = await s.db.query<any>(`SELECT * FROM account_audit_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toEntry),
      nextCursor: rows.length > limit ? Buffer.from(String(page[page.length - 1].id)).toString("base64url") : null,
    };
  });

  app.get<{ Querystring: AuditQuery }>("/v1/audit-log.csv", { preHandler: auth }, async (req, reply) => {
    const sep = csvSep(req.query.sep);
    const tz = await resolveTimeZone(s.db, req.query.tz);
    const { params, where: w0 } = buildWhere(req.auth!.tenantId, req.query);
    let where = w0;
    // Sufijo del nombre del archivo en una continuación: cada parte se descarga con un nombre distinto (si no, el
    // navegador las numeraba "(1)", "(2)" o pisaba la anterior).
    let partSuffix = "";
    // Continuación de un export truncado: las filas estrictamente anteriores a (occurred_at, id) de esa fila, en el mismo
    // orden. Con el par (y no solo con "to=<fecha>") no se saltean ni repiten filas con el mismo instante; la fecha se
    // toma de la base (precisión de microsegundos, que el ISO del CSV no tiene).
    if (req.query.beforeId !== undefined) {
      const b = typeof req.query.beforeId === "string" && /^\d{1,18}$/.test(req.query.beforeId) ? Number(req.query.beforeId) : NaN;
      if (!Number.isSafeInteger(b)) throw badRequest("invalid_query", "'beforeId' tiene que ser el id de una fila del registro");
      const ref = await s.db.one<any>(`SELECT 1 FROM account_audit_log WHERE id = $1 AND tenant_id = $2`, [b, req.auth!.tenantId]);
      if (!ref) throw badRequest("invalid_query", "'beforeId' no corresponde a una fila del registro de esta organización");
      params.push(b);
      partSuffix = `-desde-${b}`;
      where += ` AND (occurred_at, id) < (SELECT occurred_at, id FROM account_audit_log WHERE id = $${params.length})`;
    }
    let local = "";
    if (tz) {
      params.push(tz);
      local = `, ${localTsSql("occurred_at", `$${params.length}::text`)} AS occurred_local`;
      // Zona usada en occurred_at_local (una desconocida cae a UTC).
      reply.header("x-time-zone", tz);
    }
    // Una fila de más para saber si se cortó: el corte se avisa (header X-Truncated y fila final), no es silencioso.
    const all = await s.db.query<any>(`SELECT *${local} FROM account_audit_log WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${CSV_MAX_ROWS + 1}`, params);
    const truncated = all.length > CSV_MAX_ROWS;
    const rows = truncated ? all.slice(0, CSV_MAX_ROWS) : all;
    // occurred_at sigue en ISO UTC (compatibilidad); con tz se agrega occurred_at_local al final.
    const header = ["id", "occurred_at", "action", "actor_type", "actor_id", "actor_label", "target_type", "target_id", "ip", "user_agent", "data"];
    if (tz) header.push("occurred_at_local");
    const lines = [header.join(sep)];
    for (const raw of rows) {
      const r = toEntry(raw);
      const cells: unknown[] = [r.id, r.occurredAt, r.action, r.actorType, r.actorId, r.actorLabel, r.targetType, r.targetId, r.ip, r.userAgent, r.data];
      if (tz) cells.push(raw.occurred_local);
      lines.push(cells.map(csvCell).join(sep));
    }
    if (truncated) {
      const last = rows[rows.length - 1];
      lines.push(
        ["", "", `TRUNCADO: se exportaron las ${CSV_MAX_ROWS} filas más recientes; hay más. Para el resto, acotá las fechas o continuá la exportación con los mismos filtros y beforeId=${last.id}.`]
          .map(csvCell)
          .join(sep),
      );
      reply.header("x-truncated", "true").header("x-next-before-id", String(last.id));
    }
    await auditFromRequest(s.db, req, req.auth!, "audit.exported", { data: { rows: rows.length, truncated, filters: req.query } });
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="auditoria-${new Date().toISOString().slice(0, 10)}${partSuffix}.csv"`)
      .header("cache-control", "private, no-store");
    return csvBody(lines);
  });
}
