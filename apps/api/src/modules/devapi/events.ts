// API de eventos de la organización: GET /v1/events (polling con cursor, para reconciliar lo que los webhooks no
// entregaron) y GET /v1/events/stream (Server-Sent Events). La fuente es el registro de evidencia (envelope_events),
// el mismo que dispara los webhooks: los tipos públicos son los de los webhooks (EVIDENCE_TO_WEBHOOK).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WEBHOOK_EVENT_TYPES, type ApiEvent, type ListEventsResponse } from "@calasign/shared";
import { EVIDENCE_TO_WEBHOOK } from "../../infra/webhook-outbox";
import { badRequest } from "../../lib/errors";
import { bearerToken, iso, queryList, sha256Hex } from "../../lib/util";
import { envelopeVisibilitySql, loadAccess, type AccessInfo } from "../access";
import { tenantPlan } from "../billing/plans";
import { webhookEventId } from "../webhooks";
import { authenticate, sessionAliveSql, sessionCookieToken, type AuthContext, type Services } from "../context";
import { isOAuthAccessToken, resolveAccessToken, restrictAccessToScopes } from "../oauth-tokens";

/**
 * Orden del cursor. Los ids de envelope_events salen de una secuencia y una transacción que tomó un id menor puede
 * confirmarse después de otra con uno mayor: un cursor por id podía dejar eventos atrás. Por eso cada registro recibe
 * una posición (`pos`) recién cuando ya es visible (su transacción se confirmó). La asigna un solo secuenciador a la vez
 * (lock de transacción), en bloques que se confirman en orden: lo que se confirma después siempre recibe una posición
 * mayor y queda delante del cursor, por mucho que tarde una transacción y sin depender de relojes.
 * `pos` es un dato de la tabla, así que sobrevive a un dump/restore o a un cambio de cluster (Blue/Green). Tampoco se
 * confía solo en la secuencia (la replicación lógica no la copia): cada bloque arranca después del máximo guardado.
 * Cursor: "p<pos>". Se aceptan los anteriores ("<tx>.<id>" de 0048 y el id solo), que se traducen al registro que nombran.
 */
const CURSOR_RE = /^p(\d{1,18})$/;
const TX_CURSOR_RE = /^\d{1,20}\.(\d{1,18})$/;
const LEGACY_CURSOR_RE = /^\d{1,18}$/;
const SEQUENCER_LOCK = 72_010_048; // clave del lock de transacción del secuenciador
const SEQUENCER_BATCH = 5000;
const SEQUENCER_MAX_BATCHES = 40;
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
  /** Cursor tal como llegó (validado); se resuelve a una posición en resolveCursor. */
  after: string | null;
  since: string | null;
  types: string[];
  envelopeId: string | null;
  all: boolean;
}

function parseFilters(q: EventQuery, lastEventId?: string): Filters {
  // Una clave repetida (?after=1&after=2) llega como array: `.trim()` respondía 500 (como en audit.ts).
  for (const k of ["after", "since", "envelope_id", "scope"] as const) {
    if (q[k] !== undefined && typeof q[k] !== "string")
      throw badRequest("validation_error", `${k} admite un solo valor`, [{ path: k, message: "un solo valor" }]);
  }
  const all = q.scope === "all";
  if (q.scope && q.scope !== "all" && q.scope !== "webhook")
    throw badRequest("validation_error", "scope: webhook o all", [{ path: "scope", message: "webhook | all" }]);
  // Last-Event-ID primero: EventSource reconecta con la MISMA URL, así que con `?after=X` en ella cada reconexión (a los
  // max_seconds) volvía a empezar en X y repetía todo lo ya entregado; el header trae el último id recibido.
  const after = (lastEventId ?? q.after ?? "").trim() || null;
  if (after && !CURSOR_RE.test(after) && !TX_CURSOR_RE.test(after) && !LEGACY_CURSOR_RE.test(after))
    throw badRequest("invalid_cursor", "Cursor inválido");
  let since: string | null = null;
  if (q.since) {
    const t = Date.parse(q.since);
    if (Number.isNaN(t)) throw badRequest("validation_error", "since: fecha inválida (ISO 8601)", [{ path: "since", message: "fecha inválida" }]);
    since = new Date(t).toISOString();
  }
  const types = queryList(q.types);
  if (!all) {
    const bad = types.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
    if (bad.length)
      throw badRequest("validation_error", `types desconocidos: ${bad.join(", ")}`, [
        { path: "types", message: `válidos: ${WEBHOOK_EVENT_TYPES.join(", ")}` },
      ]);
  }
  const envelopeId = q.envelope_id?.trim() || null;
  if (envelopeId && !/^[0-9a-f-]{36}$/i.test(envelopeId))
    throw badRequest("validation_error", "envelope_id inválido", [{ path: "envelope_id", message: "uuid" }]);
  return { after, since, types, envelopeId, all };
}

/** Tipos de evidencia que producen alguno de los tipos públicos pedidos. */
function evidenceTypesFor(types: string[]): string[] {
  const wanted = types.length ? new Set(types) : new Set<string>(WEBHOOK_EVENT_TYPES);
  return Object.entries(EVIDENCE_TO_WEBHOOK)
    .filter(([, pub]) => pub.some((t) => wanted.has(t)))
    .map(([ev]) => ev);
}

/**
 * Secuenciador: da posición, en orden de id, a los registros ya confirmados que no la tienen. Si otro lo está
 * corriendo no espera: se lee lo que ya está confirmado y el próximo pedido toma el resto.
 */
export async function assignEventPositions(s: Services): Promise<void> {
  // Solo se corre al leer la API, así que entre lecturas se acumulan registros sin posición de TODAS las organizaciones.
  // Un solo bloque de SEQUENCER_BATCH dejaba el resto para después: un stream que arranca en "ahora" (currentCursor)
  // repetía luego como nuevos los registros anteriores que seguían sin posición, y el polling con `since` no veía los
  // recientes. Se asignan bloques hasta ponerse al día (con tope, por si se escribe más rápido de lo que se asigna).
  for (let i = 0; i < SEQUENCER_MAX_BATCHES; i++) {
    if (!(await s.db.one(`SELECT 1 FROM envelope_events WHERE pos IS NULL LIMIT 1`))) return;
    if ((await assignPositionBlock(s)) < SEQUENCER_BATCH) return;
  }
}

/** Un bloque del secuenciador. Devuelve cuántos registros posicionó (0 si otro tiene el lock). */
async function assignPositionBlock(s: Services): Promise<number> {
  return s.db.tx(async (t) => {
    const lock = await t.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [SEQUENCER_LOCK]);
    if (!lock?.ok) return 0;
    const pending = await t.query<{ id: string }>(
      // Orden por la columna numérica: con el alias de texto, ORDER BY id ordenaba "10" antes que "3".
      `SELECT ev.id::text AS id FROM envelope_events ev
        WHERE ev.pos IS NULL ORDER BY ev.id LIMIT ${SEQUENCER_BATCH}`,
    );
    if (!pending.length) return 0;
    // El bloque arranca después de lo guardado aunque la secuencia haya quedado atrás (restore, replicación lógica).
    const base = await t.one<{ b: string }>(
      `SELECT GREATEST(nextval('envelope_events_pos_seq'), (SELECT COALESCE(max(pos), 0) + 1 FROM envelope_events))::text AS b`,
    );
    const first = BigInt(base!.b);
    const last = first + BigInt(pending.length) - 1n;
    await t.query(`SELECT setval('envelope_events_pos_seq', $1::bigint)`, [last.toString()]);
    await t.query(
      `UPDATE envelope_events ev SET pos = $2::bigint + n.ord - 1
         FROM unnest($1::bigint[]) WITH ORDINALITY AS n(id, ord) WHERE ev.id = n.id`,
      [pending.map((r) => r.id), first.toString()],
    );
    return pending.length;
  });
}

/** Posición de un cursor. Los anteriores a "p<pos>" se traducen al registro (id) que nombran. */
async function resolveCursor(s: Services, tenantId: string, cursor: string): Promise<string> {
  const m = CURSOR_RE.exec(cursor);
  if (m) return m[1];
  const id = TX_CURSOR_RE.exec(cursor)?.[1] ?? cursor;
  const r = await s.db.one<{ pos: string | null }>(
    `SELECT pos::text AS pos FROM envelope_events WHERE tenant_id = $1 AND id <= $2::bigint AND pos IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [tenantId, id],
  );
  return r?.pos ?? "0";
}

/** Cursor de "ahora": la última posición asignada de la organización (lo que se asiente después va delante). */
export async function currentCursor(s: Services, tenantId: string): Promise<string> {
  await assignEventPositions(s);
  const r = await s.db.one<{ pos: string | null }>(`SELECT max(pos)::text AS pos FROM envelope_events WHERE tenant_id = $1`, [tenantId]);
  return `p${r?.pos ?? "0"}`;
}

/** Lee hasta `limit` registros de evidencia y los expande a eventos públicos. */
export async function readEvents(s: Services, a: AuthContext, f: Filters, limit: number): Promise<ListEventsResponse> {
  await assignEventPositions(s);
  const params: unknown[] = [a.tenantId];
  let where = `ev.tenant_id = $1 AND ev.pos IS NOT NULL`;
  where += envelopeVisibilitySql(a, params, "e");
  if (f.after) {
    params.push(await resolveCursor(s, a.tenantId, f.after));
    where += ` AND ev.pos > $${params.length}::bigint`;
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
    `SELECT ev.id::text AS id, ev.pos::text AS pos, ev.seq, ev.type, ev.occurred_at, ev.envelope_id, ev.actor_type, ev.actor_id, ev.data,
            e.subject, e.status, e.metadata
       FROM envelope_events ev JOIN envelopes e ON e.id = ev.envelope_id
      WHERE ${where} ORDER BY ev.pos LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const wanted = f.types.length ? new Set(f.types) : null;
  const items: ApiEvent[] = [];
  for (const r of page) {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const recipientId =
      typeof data.recipientId === "string" ? data.recipientId : r.actor_type === "recipient" && typeof r.actor_id === "string" ? r.actor_id : null;
    const allTypes = f.all ? [r.type] : (EVIDENCE_TO_WEBHOOK[r.type] ?? []);
    for (const [i, type] of allTypes.entries()) {
      if (!f.all && wanted && !wanted.has(type)) continue;
      items.push({
        // El mismo id que el evento de los webhooks (UUIDv5 de sobre, seq y tipo): un integrador que recibe los dos
        // canales deduplica por `id`. No depende de los filtros (un recipient.declined da recipient.declined y
        // envelope.declined, cada uno con su id, pidiendo uno solo o los dos). El cursor es aparte.
        id: webhookEventId(r.envelope_id, Number(r.seq), type),
        // Obsoleto (transición): el id anterior al 2026-10-20, para quien guardó ids viejos. TODO: quitar.
        legacyId: `evt_${r.id}${allTypes.length > 1 ? `_${i}` : ""}`,
        type,
        occurredAt: iso(r.occurred_at)!,
        envelopeId: r.envelope_id,
        recipientId,
        envelope: { id: r.envelope_id, subject: r.subject, status: r.status, metadata: r.metadata ?? {} },
        // Solo lo que también va en los webhooks (el motivo de un rechazo o anulación); con scope=all, todo el dato de evidencia.
        data: f.all ? data : typeof data.reason === "string" ? { reason: data.reason } : {},
        cursor: `p${r.pos}`,
      });
    }
  }
  const last = page[page.length - 1];
  return { items, nextCursor: last ? `p${last.pos}` : f.after, hasMore: rows.length > limit };
}

const MAX_STREAMS_PER_TENANT = 5;
const openStreams = new Map<string, number>();

export async function eventRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  // Apagado: app.close() espera a que terminen las conexiones abiertas, y un stream SSE dura hasta `max_seconds` (hasta
  // una hora): systemd mataba el proceso a los 90 s sin que el cliente recibiera el cierre. En preClose (antes de dejar
  // de aceptar conexiones y de esperar las abiertas) cada stream termina con `event: end` (reason "shutdown") y su
  // último `id:`: EventSource reconecta contra la instancia nueva y retoma desde ahí.
  let shuttingDown = false;
  const stopOnShutdown = new Set<() => void>();
  app.addHook("preClose", async () => {
    shuttingDown = true;
    for (const stop of stopOnShutdown) stop();
  });

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
    const startAfter = f.after || f.since ? f.after : await currentCursor(s, a.tenantId);
    const maxSec = Math.min(3600, Math.max(60, Math.trunc(Number(req.query.max_seconds ?? 300)) || 300));
    if (shuttingDown) {
      return reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: { code: "shutting_down", message: "El servidor se está reiniciando" } });
    }
    const n = openStreams.get(a.tenantId) ?? 0;
    if (n >= MAX_STREAMS_PER_TENANT) {
      return reply
        .code(429)
        .header("retry-after", "30")
        .send({ error: { code: "too_many_streams", message: `Máximo ${MAX_STREAMS_PER_TENANT} streams abiertos por organización` } });
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
    // Despierta la espera en curso (el sleep entre lecturas o un 'drain' pendiente) cuando el servidor se apaga.
    let wake = () => {};
    const onShutdown = () => wake();
    stopOnShutdown.add(onShutdown);
    // Respeta la contrapresión: con un `since` lejano y un cliente lento (o que no lee), escribir sin esperar 'drain'
    // acumulaba en memoria todo el historial de la organización durante hasta una hora. Un cliente que nunca lee no
    // retiene el stream más allá de `max_seconds`.
    const deadline = Date.now() + maxSec * 1000;
    const write = async (chunk: string) => {
      if (res.write(chunk) || closed) return;
      if (shuttingDown) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => done(), Math.max(0, deadline - Date.now()));
        const done = () => {
          clearTimeout(timer);
          res.off("drain", done);
          res.off("close", done);
          wake = () => {};
          resolve();
        };
        wake = done;
        res.on("drain", done);
        res.on("close", done);
      });
    };
    // La credencial se validó al abrir: una API key revocada o un miembro dado de baja no siguen recibiendo eventos.
    // Tampoco un access token OAuth vencido (dura 1 h, como el stream más largo) o revocado (él o su app), ni una
    // sesión cerrada: antes el stream seguía hasta `max_seconds` con esa credencial ya inválida.
    const bearer = bearerToken(req.headers.authorization);
    const oauthToken = bearer && isOAuthAccessToken(bearer) ? bearer : null;
    const sessionToken = bearer ? null : (sessionCookieToken(req) ?? null);
    const stillAllowed = async () => {
      if (oauthToken && !(await resolveAccessToken(s.db, oauthToken))) return false;
      if (
        sessionToken &&
        !(await s.db.one(`SELECT 1 FROM sessions s WHERE s.token_hash = $1 AND ${sessionAliveSql("s")}`, [sha256Hex(sessionToken)]))
      )
        return false;
      if (a.apiKeyId && !(await s.db.one(`SELECT 1 FROM api_keys WHERE id = $1 AND revoked_at IS NULL`, [a.apiKeyId]))) return false;
      if (!a.apiKeyId && a.userId && !(await s.db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, a.userId])))
        return false;
      // Plan: el acceso por API (key u OAuth) pudo salir del plan; el polling ya respondía 402 y el stream seguía.
      if ((a.apiKeyId || a.oauth) && !(await tenantPlan(s.db, a.tenantId)).plan.features.includes("api")) return false;
      // Permisos: un cambio de rol (o de su rol personalizado o grupos) corta el stream; al reconectar rige el acceso nuevo.
      if (a.access) {
        const fresh: AuthContext = { ...a, access: await loadAccess(s.db, a) };
        restrictAccessToScopes(fresh);
        if (accessKey(fresh.access!) !== accessKey(a.access)) return false;
      }
      return true;
    };
    // Sin cursor ni since: el stream empieza en "ahora" (no repite las últimas 24 h como el polling). Se usa el cursor
    // del último registro asentado, no una hora: una transacción abierta desde antes igual llega cuando se confirma.
    const filters: Filters = { ...f, after: startAfter };
    // Último cursor entregado entero al cliente. Va también como `id:` al abrir y en el evento `end`: si no llegaba
    // ningún evento antes del corte (max_seconds o la red), EventSource reconectaba sin Last-Event-ID, el stream volvía
    // a empezar en "ahora" y se perdía lo asentado entre la última lectura y la reconexión.
    let delivered = startAfter;
    res.write(`retry: 3000\n${delivered ? `id: ${delivered}\n` : ""}: calasign events\n\n`);
    let lastBeat = Date.now();
    let lastAuthCheck = Date.now();
    let endReason = "max_seconds";
    try {
      while (!closed && !shuttingDown && Date.now() < deadline) {
        if (Date.now() - lastAuthCheck > 60_000) {
          if (!(await stillAllowed())) {
            endReason = "unauthorized";
            break;
          }
          lastAuthCheck = Date.now();
        }
        const page = await readEvents(s, a, filters, 100);
        // Un registro de evidencia puede dar dos eventos con el mismo cursor (recipient.declined + envelope.declined): el
        // `id:` va solo en el último. Si no, un corte entre los dos (max_seconds) dejaba Last-Event-ID en ese cursor y al
        // reconectar el segundo no llegaba nunca; así se repite el primero (mismo `id` de evento, deduplicable).
        let complete = true;
        for (let i = 0; i < page.items.length; i++) {
          const ev = page.items[i];
          if (closed || shuttingDown || Date.now() >= deadline) {
            complete = false;
            break;
          }
          const lastOfRow = page.items[i + 1]?.cursor !== ev.cursor;
          await write(`${lastOfRow ? `id: ${ev.cursor}\n` : ""}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          if (lastOfRow) delivered = ev.cursor;
        }
        if (page.nextCursor) filters.after = page.nextCursor;
        if (complete && page.nextCursor) delivered = page.nextCursor;
        if (page.hasMore) continue;
        if (Date.now() - lastBeat > 15_000) {
          res.write(`: ping\n\n`);
          lastBeat = Date.now();
        }
        await new Promise<void>((r) => {
          const t = setTimeout(() => done(), 1000);
          const done = () => {
            clearTimeout(t);
            wake = () => {};
            r();
          };
          wake = done;
        });
      }
      if (shuttingDown) endReason = "shutdown";
      if (!closed) res.write(`${delivered ? `id: ${delivered}\n` : ""}event: end\ndata: {"reason":"${endReason}"}\n\n`);
    } catch (err) {
      req.log.warn({ err }, "stream de eventos cortado");
    } finally {
      stopOnShutdown.delete(onShutdown);
      openStreams.set(a.tenantId, Math.max(0, (openStreams.get(a.tenantId) ?? 1) - 1));
      res.end();
    }
  });
}

/** Lo que decide qué eventos ve una credencial (para notar un cambio de rol con el stream abierto). */
function accessKey(x: AccessInfo) {
  return JSON.stringify([x.role, x.roleId, [...x.permissions].sort(), [...x.groupIds].sort()]);
}
