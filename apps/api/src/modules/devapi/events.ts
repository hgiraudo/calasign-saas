// API de eventos de la organización: GET /v1/events (polling con cursor, para reconciliar lo que los webhooks no
// entregaron) y GET /v1/events/stream (Server-Sent Events). La fuente es el registro de evidencia (envelope_events),
// el mismo que dispara los webhooks: los tipos públicos son los de los webhooks (EVIDENCE_TO_WEBHOOK).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WEBHOOK_EVENT_TYPES, type ApiEvent, type ListEventsResponse } from "@calasign/shared";
import { EVIDENCE_TO_WEBHOOK } from "../../infra/webhook-outbox";
import { badRequest } from "../../lib/errors";
import { iso, queryList } from "../../lib/util";
import { envelopeVisibilitySql } from "../access";
import { authenticate, type AuthContext, type Services } from "../context";

/**
 * Margen de asentamiento: los ids de envelope_events salen de una secuencia y una transacción que tomó un id menor
 * puede confirmarse después de otra con uno mayor. Para que un cliente que avanza el cursor no se saltee un evento,
 * no se devuelven los de los últimos segundos (las transacciones que registran evidencia son cortas).
 */
export const SETTLE_MS = 2000;
const DEFAULT_LOOKBACK_MS = 24 * 3600_000;

interface EventQuery {
  after?: string;
  since?: string;
  types?: string;
  envelope_id?: string;
  scope?: string;
  limit?: string;
}

interface Filters {
  after: string | null;
  since: string | null;
  types: string[];
  envelopeId: string | null;
  all: boolean;
}

function parseFilters(q: EventQuery, lastEventId?: string): Filters {
  const all = q.scope === "all";
  if (q.scope && q.scope !== "all" && q.scope !== "webhook") throw badRequest("validation_error", "scope: webhook o all", [{ path: "scope", message: "webhook | all" }]);
  const after = (q.after ?? lastEventId ?? "").trim() || null;
  if (after && !/^\d{1,18}$/.test(after)) throw badRequest("invalid_cursor", "Cursor inválido");
  let since: string | null = null;
  if (q.since) {
    const t = Date.parse(q.since);
    if (Number.isNaN(t)) throw badRequest("validation_error", "since: fecha inválida (ISO 8601)", [{ path: "since", message: "fecha inválida" }]);
    since = new Date(t).toISOString();
  }
  const types = queryList(q.types);
  if (!all) {
    const bad = types.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
    if (bad.length) throw badRequest("validation_error", `types desconocidos: ${bad.join(", ")}`, [{ path: "types", message: `válidos: ${WEBHOOK_EVENT_TYPES.join(", ")}` }]);
  }
  const envelopeId = q.envelope_id?.trim() || null;
  if (envelopeId && !/^[0-9a-f-]{36}$/i.test(envelopeId)) throw badRequest("validation_error", "envelope_id inválido", [{ path: "envelope_id", message: "uuid" }]);
  return { after, since, types, envelopeId, all };
}

/** Tipos de evidencia que producen alguno de los tipos públicos pedidos. */
function evidenceTypesFor(types: string[]): string[] {
  const wanted = types.length ? new Set(types) : new Set<string>(WEBHOOK_EVENT_TYPES);
  return Object.entries(EVIDENCE_TO_WEBHOOK)
    .filter(([, pub]) => pub.some((t) => wanted.has(t)))
    .map(([ev]) => ev);
}

/** Lee hasta `limit` registros de evidencia y los expande a eventos públicos. */
export async function readEvents(s: Services, a: AuthContext, f: Filters, limit: number): Promise<ListEventsResponse> {
  const params: unknown[] = [a.tenantId];
  let where = `ev.tenant_id = $1 AND ev.occurred_at <= now() - interval '${SETTLE_MS} milliseconds'`;
  where += envelopeVisibilitySql(a, params, "e");
  if (f.after) {
    params.push(f.after);
    where += ` AND ev.id > $${params.length}::bigint`;
  } else {
    params.push(f.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString());
    where += ` AND ev.occurred_at >= $${params.length}::timestamptz`;
  }
  if (!f.all) {
    params.push(evidenceTypesFor(f.types));
    where += ` AND ev.type = ANY($${params.length}::text[])`;
  } else if (f.types.length) {
    params.push(f.types);
    where += ` AND ev.type = ANY($${params.length}::text[])`;
  }
  if (f.envelopeId) {
    params.push(f.envelopeId);
    where += ` AND ev.envelope_id = $${params.length}`;
  }
  params.push(limit + 1);
  const rows = await s.db.query<any>(
    `SELECT ev.id::text AS id, ev.type, ev.occurred_at, ev.envelope_id, ev.actor_type, ev.actor_id, ev.data,
            e.subject, e.status, e.metadata
       FROM envelope_events ev JOIN envelopes e ON e.id = ev.envelope_id
      WHERE ${where} ORDER BY ev.id LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const wanted = f.types.length ? new Set(f.types) : null;
  const items: ApiEvent[] = [];
  for (const r of page) {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const recipientId =
      typeof data.recipientId === "string" ? data.recipientId : r.actor_type === "recipient" && typeof r.actor_id === "string" ? r.actor_id : null;
    const pubTypes = f.all ? [r.type] : (EVIDENCE_TO_WEBHOOK[r.type] ?? []).filter((t) => !wanted || wanted.has(t));
    pubTypes.forEach((type, i) =>
      items.push({
        id: `evt_${r.id}${pubTypes.length > 1 ? `_${i}` : ""}`,
        type,
        occurredAt: iso(r.occurred_at)!,
        envelopeId: r.envelope_id,
        recipientId,
        envelope: { id: r.envelope_id, subject: r.subject, status: r.status, metadata: r.metadata ?? {} },
        // Solo lo que también va en los webhooks (el motivo de un rechazo o anulación); con scope=all, todo el dato de evidencia.
        data: f.all ? data : typeof data.reason === "string" ? { reason: data.reason } : {},
        cursor: r.id,
      }),
    );
  }
  const last = page[page.length - 1];
  return { items, nextCursor: last ? last.id : f.after, hasMore: rows.length > limit };
}

const MAX_STREAMS_PER_TENANT = 5;
const openStreams = new Map<string, number>();

export async function eventRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  app.get<{ Querystring: EventQuery }>("/v1/events", { preHandler: auth }, async (req) => {
    const raw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 100;
    return readEvents(s, A(req), parseFilters(req.query), limit);
  });

  // Server-Sent Events: mismos filtros; retoma desde `after` o el header Last-Event-ID. La conexión se cierra sola a
  // los `max_seconds` (60..3600, por defecto 300): EventSource reconecta y sigue desde el último id.
  app.get<{ Querystring: EventQuery & { max_seconds?: string } }>("/v1/events/stream", { preHandler: auth }, async (req, reply: FastifyReply) => {
    const a = A(req);
    // El `id:` de cada mensaje es el cursor; EventSource lo devuelve en Last-Event-ID al reconectar.
    const f = parseFilters(req.query, (req.headers["last-event-id"] as string | undefined)?.trim() || undefined);
    const maxSec = Math.min(3600, Math.max(5, Math.trunc(Number(req.query.max_seconds ?? 300)) || 300));
    const n = openStreams.get(a.tenantId) ?? 0;
    if (n >= MAX_STREAMS_PER_TENANT) {
      return reply.code(429).header("retry-after", "30").send({ error: { code: "too_many_streams", message: `Máximo ${MAX_STREAMS_PER_TENANT} streams abiertos por organización` } });
    }
    openStreams.set(a.tenantId, n + 1);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    req.raw.on("close", () => (closed = true));
    // Respeta la contrapresión: con un `since` lejano y un cliente lento (o que no lee), escribir sin esperar 'drain'
    // acumulaba en memoria todo el historial de la organización durante hasta una hora. Un cliente que nunca lee no
    // retiene el stream más allá de `max_seconds`.
    const deadline = Date.now() + maxSec * 1000;
    const write = async (chunk: string) => {
      if (res.write(chunk) || closed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done(), Math.max(0, deadline - Date.now()));
        const done = () => {
          clearTimeout(timer);
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    };
    // La credencial se validó al abrir: una API key revocada o un miembro dado de baja no siguen recibiendo eventos.
    const stillAllowed = async () => {
      if (a.apiKeyId) return Boolean(await s.db.one(`SELECT 1 FROM api_keys WHERE id = $1 AND revoked_at IS NULL`, [a.apiKeyId]));
      if (a.userId) return Boolean(await s.db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, a.userId]));
      return true;
    };
    // Sin cursor ni since: el stream empieza en "ahora" (no repite las últimas 24 h como el polling).
    const filters: Filters = { ...f, since: f.after || f.since ? f.since : new Date(Date.now() - SETTLE_MS).toISOString() };
    res.write(`retry: 3000\n: calasign events\n\n`);
    let lastBeat = Date.now();
    let lastAuthCheck = Date.now();
    let endReason = "max_seconds";
    try {
      while (!closed && Date.now() < deadline) {
        if (Date.now() - lastAuthCheck > 60_000) {
          if (!(await stillAllowed())) {
            endReason = "unauthorized";
            break;
          }
          lastAuthCheck = Date.now();
        }
        const page = await readEvents(s, a, filters, 100);
        for (const ev of page.items) if (!closed && Date.now() < deadline) await write(`id: ${ev.cursor}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        if (page.nextCursor) filters.after = page.nextCursor;
        if (page.hasMore) continue;
        if (Date.now() - lastBeat > 15_000) {
          res.write(`: ping\n\n`);
          lastBeat = Date.now();
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!closed) res.write(`event: end\ndata: {"reason":"${endReason}"}\n\n`);
    } catch (err) {
      req.log.warn({ err }, "stream de eventos cortado");
    } finally {
      openStreams.set(a.tenantId, Math.max(0, (openStreams.get(a.tenantId) ?? 1) - 1));
      res.end();
    }
  });
}
