// Conectores HRIS y CLM: conexiones por organización (clave de API u OAuth), flujos registro → plantilla, envío
// desde un registro (a mano, por API o por webhook del sistema de origen) y, con cada evento del sobre, la vuelta:
// PDF sellado + certificado de evidencia al legajo/registro y estado en un campo. Mismo diseño que crm/ (vínculos,
// ejecuciones con reintentos por la cola "platform", kind "connector"). Ver docs/CONECTORES.md.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  CONNECTOR_CATEGORY,
  CONNECTOR_CREDENTIAL_FIELDS,

  CONNECTOR_PROVIDERS,
  CONNECTOR_PROVIDER_OBJECTS,
  CreateConnectorConnectionInput,
  CreateConnectorFlowInput,
  EnvelopeFromTemplateInput,
  SendFromConnectorInput,
  StartConnectorOAuthInput,
  UpdateConnectorConnectionInput,
  UpdateConnectorFlowInput,
  type ConnectorConnection,
  type ConnectorFlow,
  type ConnectorLink,
  type ConnectorObjectType,
  type ConnectorProvider,
  type ConnectorProviderInfo,
  type ConnectorRun,
  type SendFromConnectorResponse,
} from "@calasign/shared";
import { InvalidPdfError, preparePdfUpload } from "@calasign/pdf";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import { enqueue } from "../../infra/queue";
import type { BlobStore } from "../../infra/storage";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { decrypt, encrypt, iso, sha256Hex, uuidv7 } from "../../lib/util";
import { assertEnvelopeAccess, assertTemplateAccess, envelopeVisibilitySql, hasPerm } from "../access";
import { auditFromRequest } from "../audit";
import { authenticate, type AuthContext, type Services } from "../context";
import { sendEnvelope } from "../envelopes";
import { ownerCanStillCreate } from "../owner-check";
import { insertEnvelopeFromTemplate, loadTemplateForUse, planFromTemplate } from "../templates";
import { MappingError, mapPrefill, mapRecipients, neededProperties, statusForEvidence, statusValue } from "../crm/mapping";
import { statusRank } from "../crm";
import { evidenceCertificate, loadSignedBundle } from "./evidence-file";
import {
  Conn,
  ConnectorError,
  OAUTH_PROVIDERS,
  acceptsEvidenceFile,
  connectorRedirectUri,
  deliverFile,
  fetchDocument,
  fetchRecord,
  normalizeCredentials,
  oauthApp,
  oauthConfigured,
  oauthTokenRequest,
  parseWebhook,
  searchRecords,
  supportsStatus,
  testConnection,
  writeStatus,
  type ConnRow,
  type OAuthProvider,
} from "./providers";

const UUID = /^[0-9a-f-]{36}$/i;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const webhookUrl = (token: string) => `${config.appUrl}/v1/integrations/connectors/hook/${token}`;
const newWebhookToken = () => {
  const token = `cshk_${randomBytes(24).toString("base64url")}`;
  return { hash: hashToken(token), enc: encrypt(token) };
};

// ───────────────────────────── Serialización ─────────────────────────────

const toConnection = (r: any): ConnectorConnection => ({
  id: r.id,
  provider: r.provider,
  category: r.category,
  name: r.name,
  authType: r.auth_type,
  accountLabel: r.account_label,
  active: r.active,
  webhookUrl: webhookUrl(decrypt(r.webhook_token_enc)),
  createdAt: iso(r.created_at)!,
  lastSuccessAt: iso(r.last_success_at),
  lastError: r.last_error,
});

const toFlow = (r: any): ConnectorFlow => ({
  id: r.id,
  connectionId: r.connection_id,
  name: r.name,
  objectType: r.object_type,
  templateId: r.template_id,
  documentSource: r.document_source,
  roles: r.role_map ?? [],
  prefill: r.prefill_map ?? [],
  writeBack: { uploadSigned: true, uploadEvidence: false, ...(r.write_back ?? {}) },
  trigger: r.trigger,
  triggerConfig: r.trigger_config ?? {},
  send: r.send,
  active: r.active,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toLink = (r: any): ConnectorLink => ({
  id: r.id,
  connectionId: r.connection_id,
  flowId: r.flow_id,
  envelopeId: r.envelope_id,
  objectType: r.object_type,
  objectId: r.object_id,
  lastStatus: r.last_status,
  deliveredAt: iso(r.delivered_at),
  remoteRef: r.remote_ref,
  createdAt: iso(r.created_at)!,
});

const toRun = (r: any): ConnectorRun => ({
  id: r.id,
  connectionId: r.connection_id,
  connectionName: r.connection_name ?? null,
  provider: r.provider ?? null,
  flowId: r.flow_id,
  envelopeId: r.envelope_id,
  kind: r.kind,
  event: r.event,
  objectType: r.object_type,
  objectId: r.object_id,
  status: r.status,
  attempts: r.attempts,
  detail: r.detail ?? {},
  error: r.error,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

// ───────────────────────────── Errores ─────────────────────────────

function asAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof MappingError) return new AppError(422, err.code.replace(/^crm_/, "connector_"), err.message);
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return new AppError(422, "connector_invalid_record", `El registro tiene datos que no sirven para el sobre: ${detail}`.slice(0, 1000));
  }
  if (err instanceof InvalidPdfError) return new AppError(422, "connector_invalid_document", `El documento del sistema de origen no es un PDF válido: ${err.message}`);
  if (err instanceof ConnectorError) {
    if (err.authFailed) return new AppError(409, "connector_reauth_required", `La conexión ya no tiene acceso: hay que volver a conectarla (${err.message})`);
    if (err.status === 404) return new AppError(404, "connector_record_not_found", err.message);
    if (err.status === 400 || err.status === 422) return new AppError(422, "connector_invalid", err.message);
    return new AppError(502, "connector_provider_error", err.message);
  }
  return new AppError(500, "internal_error", String((err as Error)?.message ?? err));
}

const permanent = (err: unknown) =>
  (err instanceof ConnectorError && (err.authFailed || err.status === 422)) || err instanceof MappingError || (err instanceof AppError && err.status < 500);

async function loadConn(db: Db, tenantId: string, id: string) {
  if (!UUID.test(id)) throw notFound("Conexión");
  const r = await db.one<any>(`SELECT * FROM connector_connections WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!r) throw notFound("Conexión");
  return r;
}

async function loadFlow(db: Db, tenantId: string, id: string) {
  if (!UUID.test(id)) throw notFound("Flujo");
  const r = await db.one<any>(`SELECT * FROM connector_flows WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!r) throw notFound("Flujo");
  return r;
}

const open = (db: Db, row: any) => new Conn(row as ConnRow, db);

// ───────────────────────────── Envío desde un registro ─────────────────────────────

export interface SendCtx {
  tenantId: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
}

const OPEN_STATUSES = `('draft','sent','awaiting_certificates','finalizing')`;

/** Lee el registro, arma el sobre con la plantilla del flujo (y el documento de origen si corresponde) y lo vincula. */
export async function sendFromConnector(
  d: { db: Db; blobs: BlobStore },
  ctx: SendCtx,
  flow: any,
  recordId: string,
  opts: { send?: boolean; subject?: string; message?: string | null; runId?: string; skipIfOpen?: boolean },
): Promise<SendFromConnectorResponse | null> {
  const { db } = d;
  const connRow = await db.one<any>(`SELECT * FROM connector_connections WHERE id = $1 AND tenant_id = $2`, [flow.connection_id, ctx.tenantId]);
  if (!connRow) throw notFound("Conexión");
  if (!connRow.active) throw new AppError(409, "connector_connection_inactive", "La conexión está desactivada");
  if (!flow.active) throw new AppError(409, "connector_flow_inactive", "El flujo está desactivado");
  if (!flow.template_id) throw badRequest("connector_template_required", "El flujo no tiene plantilla (¿se borró?)");
  const runId = opts.runId ?? uuidv7();
  if (!opts.runId) {
    await db.query(
      `INSERT INTO connector_runs (id, tenant_id, connection_id, flow_id, kind, object_type, object_id, attempts, detail) VALUES ($1,$2,$3,$4,'send',$5,$6,1,$7)`,
      [runId, ctx.tenantId, connRow.id, flow.id, flow.object_type, recordId, JSON.stringify({ by: ctx.actor.label ?? ctx.actor.type })],
    );
  }
  let storedKey: string | null = null;
  try {
    const conn = open(db, connRow);
    const roles = flow.role_map ?? [];
    const prefillMap = flow.prefill_map ?? [];
    const record = await fetchRecord(conn, flow.object_type, recordId, neededProperties(roles, prefillMap));
    const recipients = mapRecipients(record, roles);
    const prefill = mapPrefill(record, prefillMap);
    const l = await loadTemplateForUse(db, ctx.tenantId, flow.template_id);
    const send = opts.send ?? flow.send;
    const input = EnvelopeFromTemplateInput.parse({
      templateId: flow.template_id,
      subject: opts.subject ?? (record.title ? `${l.row.subject ?? l.row.name} — ${record.title}`.slice(0, 300) : undefined),
      message: opts.message,
      recipients: recipients.map((r) => ({ role: r.role, name: r.name, email: r.email, phone: r.phone, channels: r.channels })),
      prefill,
      send: false,
    });
    const plan = planFromTemplate(l, input);
    // Documento de origen (CLM): se normaliza y se guarda antes de la transacción, como una subida normal.
    let source: { name: string; key: string; fileId: string; sha: string; uploadedSha: string; info: any; bytes: Uint8Array } | null = null;
    if (flow.document_source === "record") {
      const doc = await fetchDocument(conn, flow.object_type, record.id, record);
      const { info, bytes } = await preparePdfUpload(doc.bytes);
      const fileId = uuidv7();
      source = { name: doc.name.slice(0, 200), key: `tenants/${ctx.tenantId}/connectors/${fileId}.pdf`, fileId, sha: sha256Hex(bytes), uploadedSha: sha256Hex(doc.bytes), info, bytes };
      await d.blobs.put(source.key, bytes, "application/pdf");
      storedKey = source.key;
    }
    const meta = { connectionId: connRow.id, provider: connRow.provider, objectType: flow.object_type, objectId: record.id, flowId: flow.id };
    const work = () =>
      db.tx(async (t) => {
        if (opts.skipIfOpen) {
          // Varios eventos del mismo registro en paralelo: con el flujo bloqueado, el segundo ve el sobre del primero.
          await t.query(`SELECT id FROM connector_flows WHERE id = $1 FOR UPDATE`, [flow.id]);
          const openEnv = await t.one<any>(
            `SELECT l.envelope_id FROM connector_links l JOIN envelopes e ON e.id = l.envelope_id
              WHERE l.flow_id = $1 AND l.object_id = ANY($2::text[]) AND e.status IN ${OPEN_STATUSES} LIMIT 1`,
            [flow.id, [...new Set([recordId, record.id])]],
          );
          if (openEnv) {
            await t.query(`UPDATE connector_runs SET status = 'succeeded', error = NULL, detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`, [
              runId,
              JSON.stringify({ skipped: "ya hay un sobre en curso para este registro", envelopeId: openEnv.envelope_id }),
            ]);
            return { envelopeId: openEnv.envelope_id as string, linkId: null as string | null, skipped: true };
          }
        }
        const envelopeId = await insertEnvelopeFromTemplate(t, ctx, l, input, plan, { connector: meta });
        if (source) {
          // El contrato del sistema de origen va primero; la plantilla aporta la hoja de firmas.
          const pos = await t.one<any>(`SELECT COALESCE(MIN(position), 1) - 1 AS p FROM documents WHERE envelope_id = $1`, [envelopeId]);
          await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)`, [
            source.fileId,
            ctx.tenantId,
            source.key,
            source.bytes.length,
            source.sha,
          ]);
          const docId = uuidv7();
          await t.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
            docId,
            ctx.tenantId,
            envelopeId,
            pos.p,
            source.name,
            source.fileId,
            source.info.pageCount,
            JSON.stringify(source.info.pages),
          ]);
          await appendEvent(t, {
            tenantId: ctx.tenantId,
            envelopeId,
            type: "document.added",
            actor: ctx.actor,
            data: { documentId: docId, name: source.name, sha256: source.sha, uploadedSha256: source.uploadedSha, pages: source.info.pageCount, source: connRow.provider },
          });
        }
        const linkId = uuidv7();
        // El vínculo va antes del envío: así el evento envelope.sent ya encuentra el registro.
        await t.query(`INSERT INTO connector_links (id, tenant_id, connection_id, flow_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          linkId,
          ctx.tenantId,
          connRow.id,
          flow.id,
          envelopeId,
          flow.object_type,
          record.id,
        ]);
        if (send) await sendEnvelope(t, ctx.tenantId, envelopeId, ctx.actor);
        await t.query(`UPDATE connector_runs SET status = 'succeeded', envelope_id = $2, error = NULL, detail = detail || $3::jsonb, updated_at = now() WHERE id = $1`, [
          runId,
          envelopeId,
          JSON.stringify({ envelopeId, linkId, recipients: recipients.length, sent: send, sourceDocument: Boolean(source) }),
        ]);
        return { envelopeId, linkId: linkId as string | null, skipped: false };
      });
    const out = await work();
    if (out.skipped && source) await d.blobs.delete(source.key).catch(() => {});
    storedKey = null;
    await db.query(`UPDATE connector_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [connRow.id]);
    if (out.skipped) return null;
    return { envelopeId: out.envelopeId, status: send ? "sent" : "draft", linkId: out.linkId!, runId };
  } catch (err) {
    if (storedKey) await d.blobs.delete(storedKey).catch(() => {});
    const e = asAppError(err);
    await db.query(`UPDATE connector_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [runId, e.message.slice(0, 1000)]);
    if (err instanceof ConnectorError) await db.query(`UPDATE connector_connections SET last_error = $2 WHERE id = $1`, [connRow.id, e.message.slice(0, 500)]);
    throw e;
  }
}

// ───────────────────────────── Outbox de evidencia → trabajos ─────────────────────────────

/** Desde platform-fanout: una vuelta (estado/archivos) por cada vínculo del sobre. */
export async function queueConnectorEvents(db: Db, tenantId: string, envelopeId: string, evidenceType: string) {
  const status = statusForEvidence(evidenceType);
  if (!status) return;
  const links = await db.query<any>(
    `SELECT l.* FROM connector_links l JOIN connector_connections c ON c.id = l.connection_id WHERE l.envelope_id = $1 AND l.tenant_id = $2 AND c.active`,
    [envelopeId, tenantId],
  );
  for (const l of links) {
    await queueRun(db, { tenantId, connectionId: l.connection_id, flowId: l.flow_id, linkId: l.id, envelopeId, kind: "write_back", event: status, objectType: l.object_type, objectId: l.object_id }, `cn:wb:${l.id}:${status}`);
  }
}

interface RunSpec {
  tenantId: string;
  connectionId: string;
  flowId: string | null;
  linkId: string | null;
  envelopeId: string | null;
  kind: "write_back" | "send";
  event: string | null;
  objectType: string | null;
  objectId: string | null;
  detail?: Record<string, unknown>;
}

async function queueRun(db: Db, r: RunSpec, dedupeKey: string) {
  const id = uuidv7();
  const ins = await db.query<{ id: string }>(
    `INSERT INTO connector_runs (id, tenant_id, connection_id, flow_id, link_id, envelope_id, kind, event, object_type, object_id, detail, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [id, r.tenantId, r.connectionId, r.flowId, r.linkId, r.envelopeId, r.kind, r.event, r.objectType, r.objectId, JSON.stringify(r.detail ?? {}), dedupeKey],
  );
  if (ins.length) await enqueue(db, "platform", { kind: "connector", runId: id }, { dedupeKey: `cnjob:${id}` });
  return ins.length > 0;
}

// ───────────────────────────── Trabajos ─────────────────────────────

async function writeBack(d: { db: Db; blobs: BlobStore }, conn: Conn, link: any, flow: any | null, status: string): Promise<Record<string, unknown>> {
  const { db } = d;
  const wb = { uploadSigned: true, uploadEvidence: false, ...(flow?.write_back ?? {}) };
  const detail: Record<string, unknown> = {};
  // Los trabajos "sent" y "completed" del mismo vínculo pueden correr a la vez (la cola procesa en paralelo): leer
  // last_status al arrancar no alcanzaba y un "sent" podía pisar el estado final (y quedar como last_status). Como en
  // crm/index.ts: se reclama el vínculo por rango antes de escribir y, después, si otro reclamó uno mayor, se reescribe.
  const claimed = await db.one(`UPDATE connector_links SET last_status = $2 WHERE id = $1 AND ${LINK_RANK_SQL} <= $3 RETURNING id`, [
    link.id,
    status,
    statusRank(status),
  ]);
  if (!claimed) {
    const cur = await db.one<{ last_status: string | null }>(`SELECT last_status FROM connector_links WHERE id = $1`, [link.id]);
    return { skipped: `el registro ya tiene el estado ${cur?.last_status ?? "?"}` };
  }
  const objectType = link.object_type as ConnectorObjectType;
  if (status === "completed" && !link.delivered_at) {
    const bundle = await loadSignedBundle(db, d.blobs, link.envelope_id);
    if (bundle) {
      const refs: string[] = [];
      if (wb.uploadSigned !== false) {
        // El PDF ya entregado en un intento anterior no se vuelve a subir (falló la evidencia o el estado).
        let signedRef: string | null = link.signed_ref;
        if (!signedRef) {
          signedRef = await deliverFile(conn, objectType, link.object_id, { name: `${bundle.baseName}.pdf`, bytes: bundle.pdf, contentType: "application/pdf" }, wb.folder, "signed");
          await db.query(`UPDATE connector_links SET signed_ref = $2 WHERE id = $1`, [link.id, signedRef]);
        }
        refs.push(signedRef);
      }
      if (wb.uploadEvidence) {
        if (acceptsEvidenceFile(conn.provider, objectType)) {
          const ev = await evidenceCertificate(db, link.envelope_id);
          refs.push(await deliverFile(conn, objectType, link.object_id, { name: `${bundle.baseName} - evidencia.json`, bytes: ev, contentType: "application/json" }, wb.folder, "evidence"));
        } else detail.evidence = `${conn.provider} (${objectType}) no recibe archivos adicionales: la evidencia va dentro del PDF sellado`;
      }
      await db.query(`UPDATE connector_links SET delivered_at = now(), remote_ref = $2 WHERE id = $1`, [link.id, refs.join(" ") || null]);
      detail.delivered = refs;
    }
  }
  if (wb.statusProperty && supportsStatus(conn.provider, objectType)) {
    const value = statusValue(wb, status as any);
    await writeStatus(conn, objectType, link.object_id, wb.statusProperty, value);
    detail.statusWritten = { property: wb.statusProperty, value };
    const after = (await db.one<{ last_status: string | null }>(`SELECT last_status FROM connector_links WHERE id = $1`, [link.id]))?.last_status ?? null;
    if (after && statusRank(after) > statusRank(status)) {
      const finalValue = statusValue(wb, after as any);
      await writeStatus(conn, objectType, link.object_id, wb.statusProperty, finalValue);
      detail.statusRewritten = { property: wb.statusProperty, value: finalValue, because: after };
    }
  }
  return detail;
}

const LINK_RANK_SQL = `(CASE WHEN last_status IS NULL THEN 0 WHEN last_status = 'sent' THEN 1 ELSE 2 END)`;

export async function handleConnectorJob(d: { db: Db; blobs: BlobStore }, p: { runId: string }) {
  const { db } = d;
  const run = await db.one<any>(`SELECT * FROM connector_runs WHERE id = $1`, [p.runId]);
  if (!run || run.status === "succeeded") return;
  const connRow = run.connection_id ? await db.one<any>(`SELECT * FROM connector_connections WHERE id = $1`, [run.connection_id]) : null;
  if (!connRow || !connRow.active) {
    await db.query(`UPDATE connector_runs SET status = 'failed', error = 'conexión inexistente o desactivada', updated_at = now() WHERE id = $1`, [run.id]);
    return;
  }
  await db.query(`UPDATE connector_runs SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [run.id]);
  const conn = open(db, connRow);
  const flow = run.flow_id ? await db.one<any>(`SELECT * FROM connector_flows WHERE id = $1`, [run.flow_id]) : null;
  try {
    if (run.kind === "write_back") {
      const link = await db.one<any>(`SELECT * FROM connector_links WHERE id = $1`, [run.link_id]);
      if (!link) throw new AppError(409, "connector_link_missing", "vínculo inexistente");
      const detail = await writeBack(d, conn, link, flow, run.event);
      await db.query(`UPDATE connector_runs SET status = 'succeeded', error = NULL, detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify(detail)]);
    } else {
      // Envío disparado por webhook del sistema de origen.
      if (!flow) throw new AppError(409, "connector_flow_missing", "flujo inexistente");
      // El sobre queda a nombre de quien creó el flujo: si ya no puede crear sobres con esa plantilla, no se envía.
      const owner = { tenantId: run.tenant_id, userId: flow.created_by_api_key ? null : flow.created_by, apiKeyId: flow.created_by_api_key ?? null };
      const ownerGone = await ownerCanStillCreate(db, owner, flow.template_id);
      if (ownerGone) throw new AppError(409, "connector_flow_owner_gone", `${ownerGone}: hay que volver a crear el flujo`);
      await sendFromConnector(d, { ...owner, actor: { type: "system", label: `${conn.provider} (webhook)` } }, flow, run.object_id, { runId: run.id, skipIfOpen: true });
    }
    await db.query(`UPDATE connector_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [conn.row.id]);
  } catch (err) {
    const msg = asAppError(err).message.slice(0, 1000);
    await db.query(`UPDATE connector_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [run.id, msg]);
    await db.query(`UPDATE connector_connections SET last_error = $2 WHERE id = $1`, [conn.row.id, msg.slice(0, 500)]);
    // Sin acceso o datos que no cierran: no se reintenta solo (queda el error visible y el reintento manual).
    if (permanent(err)) return;
    throw err;
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

interface OAuthState {
  t: string;
  u: string;
  p: OAuthProvider;
  n: string;
  r: string | null;
  v: string;
  exp: number;
}

function checkFlowInput(provider: ConnectorProvider, objectType: ConnectorObjectType, documentSource: string, wb: any) {
  if (!CONNECTOR_PROVIDER_OBJECTS[provider].includes(objectType)) {
    throw badRequest("connector_object_type", `${provider} admite: ${CONNECTOR_PROVIDER_OBJECTS[provider].join(", ")}`);
  }
  if (documentSource === "record" && !((provider === "ironclad" && objectType === "workflow") || provider === "juro")) {
    throw badRequest("connector_document_source", "El documento de origen solo existe en workflows de Ironclad y contratos de Juro");
  }
  if (wb?.statusProperty && !supportsStatus(provider, objectType)) {
    throw badRequest("connector_status_unsupported", `${provider} (${objectType}) no admite escribir el estado en un campo`);
  }
}

export async function connectorRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  const d = { db: s.db, blobs: s.blobs };

  app.get("/v1/connectors/providers", { preHandler: auth }, async () => {
    const items: ConnectorProviderInfo[] = CONNECTOR_PROVIDERS.map((p) => ({
      provider: p,
      category: CONNECTOR_CATEGORY[p],
      objectTypes: CONNECTOR_PROVIDER_OBJECTS[p],
      oauthSupported: OAUTH_PROVIDERS.includes(p),
      oauthConfigured: oauthConfigured(p),
      credentialFields: CONNECTOR_CREDENTIAL_FIELDS[p],
    }));
    return { items, redirectUris: Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, connectorRedirectUri(p as OAuthProvider)])) };
  });

  // ───────── Conexiones ─────────

  app.get("/v1/connectors/connections", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM connector_connections WHERE tenant_id = $1 ORDER BY created_at DESC`, [A(req).tenantId]);
    return { items: rows.map(toConnection) };
  });

  app.post("/v1/connectors/connections", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = A(req);
    const input = CreateConnectorConnectionInput.parse(req.body);
    let norm;
    try {
      norm = normalizeCredentials(input.provider, input.credentials);
    } catch (err) {
      throw badRequest("connector_credentials", (err as Error).message);
    }
    const row: any = { id: uuidv7(), provider: input.provider, auth_type: "api_key", credentials_enc: encrypt(JSON.stringify(norm.creds)), config: norm.config };
    let test;
    try {
      test = await testConnection(new Conn(row, null));
    } catch (err) {
      throw new AppError(400, "connector_test_failed", `No se pudo conectar con ${input.provider}: ${(err as Error).message}`.slice(0, 400));
    }
    const hook = newWebhookToken();
    await s.db.query(
      `INSERT INTO connector_connections (id, tenant_id, provider, category, name, auth_type, credentials_enc, config, account_label, webhook_token_hash, webhook_token_enc, created_by, last_success_at)
       VALUES ($1,$2,$3,$4,$5,'api_key',$6,$7,$8,$9,$10,$11, now())`,
      [row.id, a.tenantId, input.provider, CONNECTOR_CATEGORY[input.provider], input.name, row.credentials_enc, JSON.stringify(norm.config), test.label, hook.hash, hook.enc, a.userId],
    );
    await auditFromRequest(s.db, req, a, "connector.connected", { targetType: "connector_connection", targetId: row.id, data: { provider: input.provider, name: input.name } });
    reply.code(201);
    return toConnection(await loadConn(s.db, a.tenantId, row.id));
  });

  app.post<{ Params: { provider: string } }>("/v1/connectors/oauth/:provider/start", { preHandler: auth }, async (req) => {
    const a = A(req);
    const p = req.params.provider as OAuthProvider;
    if (!OAUTH_PROVIDERS.includes(p)) throw notFound("Proveedor");
    if (!oauthConfigured(p)) throw new AppError(409, "provider_not_configured", "Este proveedor no está configurado en el servidor");
    if (!a.userId) throw new AppError(403, "session_required", "Conectar una cuenta requiere iniciar sesión en la web");
    const input = StartConnectorOAuthInput.parse(req.body ?? {});
    const region = p === "ironclad" ? input.region ?? "na1" : null;
    const cfg = oauthApp(p, region);
    // PKCE S256 siempre (Ironclad y Factorial lo aceptan; un proveedor que no lo use lo ignora).
    const verifier = randomBytes(32).toString("base64url");
    const state: OAuthState = { t: a.tenantId, u: a.userId, p, n: input.name, r: region, v: verifier, exp: Date.now() + 10 * 60_000 };
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set("client_id", cfg.clientId!);
    url.searchParams.set("redirect_uri", connectorRedirectUri(p));
    url.searchParams.set("response_type", "code");
    if (cfg.scope) url.searchParams.set("scope", cfg.scope);
    url.searchParams.set("state", encrypt(JSON.stringify(state)));
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizeUrl: url.toString() };
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/connectors/oauth/:provider/callback",
    { preHandler: auth },
    async (req, reply) => {
      const a = A(req);
      const back = (q: string) => reply.redirect(`/app/settings/connectors?${q}`);
      let st: OAuthState;
      try {
        st = JSON.parse(decrypt(String(req.query.state ?? "")));
      } catch {
        return back("error=invalid_state");
      }
      if (st.p !== req.params.provider || st.exp < Date.now() || st.u !== a.userId || st.t !== a.tenantId) return back("error=invalid_state");
      if (!hasPerm(a, "settings:manage")) return back("error=forbidden");
      if (req.query.error || !req.query.code) return back(`error=${encodeURIComponent(req.query.error ?? "no_code")}`);
      try {
        const body = await oauthTokenRequest(st.p, st.r, { grant_type: "authorization_code", code: req.query.code, redirect_uri: connectorRedirectUri(st.p), code_verifier: st.v });
        const creds = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null };
        const cfg: Record<string, unknown> = st.p === "ironclad" ? { region: st.r ?? "na1" } : {};
        const row: any = { id: uuidv7(), provider: st.p, auth_type: "oauth", credentials_enc: encrypt(JSON.stringify(creds)), config: cfg };
        const conn = new Conn(row, null);
        const test = await testConnection(conn).catch(() => ({ label: null }));
        const hook = newWebhookToken();
        await s.db.query(
          `INSERT INTO connector_connections (id, tenant_id, provider, category, name, auth_type, credentials_enc, config, account_label, webhook_token_hash, webhook_token_enc, created_by, last_success_at)
           VALUES ($1,$2,$3,$4,$5,'oauth',$6,$7,$8,$9,$10,$11, now())`,
          [row.id, a.tenantId, st.p, CONNECTOR_CATEGORY[st.p], st.n, encrypt(JSON.stringify(conn.creds)), JSON.stringify(cfg), test.label, hook.hash, hook.enc, a.userId],
        );
        await auditFromRequest(s.db, req, a, "connector.connected", { targetType: "connector_connection", targetId: row.id, data: { provider: st.p, name: st.n } });
        return back(`connected=${st.p}`);
      } catch (err) {
        req.log.warn({ err: String(err) }, "no se pudo conectar el conector");
        return back("error=token_exchange_failed");
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/connectors/connections/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    const input = UpdateConnectorConnectionInput.parse(req.body);
    await s.db.query(`UPDATE connector_connections SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = now() WHERE id = $1`, [r.id, input.name ?? null, input.active ?? null]);
    return toConnection(await loadConn(s.db, a.tenantId, r.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/connectors/connections/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM connector_connections WHERE id = $1`, [r.id]);
    await auditFromRequest(s.db, req, a, "connector.disconnected", { targetType: "connector_connection", targetId: r.id, data: { provider: r.provider, name: r.name } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/connectors/connections/:id/test", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    try {
      const t = await testConnection(open(s.db, r));
      await s.db.query(`UPDATE connector_connections SET last_success_at = now(), last_error = NULL, account_label = COALESCE($2, account_label) WHERE id = $1`, [r.id, t.label]);
      return { ok: true, error: null };
    } catch (err) {
      const msg = asAppError(err).message.slice(0, 300);
      await s.db.query(`UPDATE connector_connections SET last_error = $2 WHERE id = $1`, [r.id, msg]);
      return { ok: false, error: msg };
    }
  });

  app.post<{ Params: { id: string } }>("/v1/connectors/connections/:id/rotate-webhook", { preHandler: auth }, async (req) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    const hook = newWebhookToken();
    await s.db.query(`UPDATE connector_connections SET webhook_token_hash = $2, webhook_token_enc = $3, updated_at = now() WHERE id = $1`, [r.id, hook.hash, hook.enc]);
    await auditFromRequest(s.db, req, a, "connector.webhook_rotated", { targetType: "connector_connection", targetId: r.id, data: { provider: r.provider } });
    return toConnection(await loadConn(s.db, a.tenantId, r.id));
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; objectType?: string } }>(
    "/v1/connectors/connections/:id/records",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const a = A(req);
      const r = await loadConn(s.db, a.tenantId, req.params.id);
      const objectType = (req.query.objectType ?? CONNECTOR_PROVIDER_OBJECTS[r.provider as ConnectorProvider][0]) as ConnectorObjectType;
      if (!CONNECTOR_PROVIDER_OBJECTS[r.provider as ConnectorProvider].includes(objectType)) throw badRequest("connector_object_type", "Tipo de registro no admitido");
      try {
        return { items: await searchRecords(open(s.db, r), objectType, String(req.query.q ?? "").slice(0, 100)) };
      } catch (err) {
        throw asAppError(err);
      }
    },
  );

  // ───────── Flujos ─────────

  app.get<{ Querystring: { connectionId?: string } }>("/v1/connectors/flows", { preHandler: auth }, async (req) => {
    const params: unknown[] = [A(req).tenantId];
    let where = `tenant_id = $1`;
    if (req.query.connectionId && UUID.test(req.query.connectionId)) {
      params.push(req.query.connectionId);
      where += ` AND connection_id = $2`;
    }
    const rows = await s.db.query(`SELECT * FROM connector_flows WHERE ${where} ORDER BY created_at DESC`, params);
    return { items: rows.map(toFlow) };
  });

  app.post("/v1/connectors/flows", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateConnectorFlowInput.parse(req.body);
    const conn = await loadConn(s.db, a.tenantId, input.connectionId);
    checkFlowInput(conn.provider, input.objectType, input.documentSource, input.writeBack);
    await assertTemplateAccess(s.db, a, input.templateId, "view");
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO connector_flows (id, tenant_id, connection_id, name, object_type, template_id, document_source, role_map, prefill_map, write_back, trigger, trigger_config, send, active, created_by, created_by_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        a.tenantId,
        conn.id,
        input.name,
        input.objectType,
        input.templateId,
        input.documentSource,
        JSON.stringify(input.roles),
        JSON.stringify(input.prefill),
        JSON.stringify(input.writeBack),
        input.trigger,
        JSON.stringify(input.triggerConfig),
        input.send,
        input.active,
        a.userId,
        a.apiKeyId,
      ],
    );
    await auditFromRequest(s.db, req, a, "connector.flow_created", { targetType: "connector_flow", targetId: id, data: { name: input.name, provider: conn.provider } });
    reply.code(201);
    return toFlow(await loadFlow(s.db, a.tenantId, id));
  });

  app.get<{ Params: { id: string } }>("/v1/connectors/flows/:id", { preHandler: auth }, async (req) => toFlow(await loadFlow(s.db, A(req).tenantId, req.params.id)));

  app.patch<{ Params: { id: string } }>("/v1/connectors/flows/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const f = await loadFlow(s.db, a.tenantId, req.params.id);
    const input = UpdateConnectorFlowInput.parse(req.body);
    const conn = await loadConn(s.db, a.tenantId, f.connection_id);
    const objectType = input.objectType ?? f.object_type;
    const documentSource = input.documentSource ?? f.document_source;
    checkFlowInput(conn.provider, objectType, documentSource, input.writeBack ?? f.write_back);
    if (input.templateId) await assertTemplateAccess(s.db, a, input.templateId, "view");
    await s.db.query(
      `UPDATE connector_flows SET name = COALESCE($2, name), object_type = $3, template_id = COALESCE($4, template_id), document_source = $5,
         role_map = COALESCE($6::jsonb, role_map), prefill_map = COALESCE($7::jsonb, prefill_map), write_back = COALESCE($8::jsonb, write_back),
         trigger = COALESCE($9, trigger), trigger_config = COALESCE($10::jsonb, trigger_config), send = COALESCE($11, send), active = COALESCE($12, active), updated_at = now()
       WHERE id = $1`,
      [
        f.id,
        input.name ?? null,
        objectType,
        input.templateId ?? null,
        documentSource,
        input.roles ? JSON.stringify(input.roles) : null,
        input.prefill ? JSON.stringify(input.prefill) : null,
        input.writeBack ? JSON.stringify(input.writeBack) : null,
        input.trigger ?? null,
        input.triggerConfig ? JSON.stringify(input.triggerConfig) : null,
        input.send ?? null,
        input.active ?? null,
      ],
    );
    return toFlow(await loadFlow(s.db, a.tenantId, f.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/connectors/flows/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const f = await loadFlow(s.db, a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM connector_flows WHERE id = $1`, [f.id]);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/connectors/flows/:id/send", { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = A(req);
    const f = await loadFlow(s.db, a.tenantId, req.params.id);
    const input = SendFromConnectorInput.parse(req.body);
    if (f.template_id) await assertTemplateAccess(s.db, a, f.template_id, "view");
    const out = await sendFromConnector(d, { tenantId: a.tenantId, userId: a.userId, apiKeyId: a.apiKeyId, actor: a.actor }, f, input.recordId, input);
    reply.code(201);
    return out!;
  });

  // ───────── Vínculos y ejecuciones ─────────

  app.get<{ Querystring: { envelopeId?: string } }>("/v1/connectors/links", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!req.query.envelopeId || !UUID.test(req.query.envelopeId)) throw badRequest("envelope_required", "Indicá envelopeId");
    await assertEnvelopeAccess(s.db, a, req.query.envelopeId, "view");
    const rows = await s.db.query(`SELECT * FROM connector_links WHERE tenant_id = $1 AND envelope_id = $2 ORDER BY created_at`, [a.tenantId, req.query.envelopeId]);
    return { items: rows.map(toLink) };
  });

  app.get<{ Querystring: { connectionId?: string; envelopeId?: string; status?: string; limit?: string } }>("/v1/connectors/runs", { preHandler: auth }, async (req) => {
    const a = A(req);
    const params: unknown[] = [a.tenantId];
    let where = `r.tenant_id = $1`;
    if (req.query.connectionId && UUID.test(req.query.connectionId)) {
      params.push(req.query.connectionId);
      where += ` AND r.connection_id = $${params.length}`;
    }
    if (req.query.envelopeId && UUID.test(req.query.envelopeId)) {
      params.push(req.query.envelopeId);
      where += ` AND r.envelope_id = $${params.length}`;
    }
    if (req.query.status && ["pending", "succeeded", "failed"].includes(req.query.status)) {
      params.push(req.query.status);
      where += ` AND r.status = $${params.length}`;
    }
    // Sin settings:manage, solo las ejecuciones de sobres que uno puede ver (como /v1/crm/runs).
    if (!hasPerm(a, "settings:manage")) {
      where += ` AND r.envelope_id IS NOT NULL AND EXISTS (SELECT 1 FROM envelopes e WHERE e.id = r.envelope_id AND e.tenant_id = r.tenant_id${envelopeVisibilitySql(a, params)})`;
    }
    params.push(Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50)));
    const rows = await s.db.query(
      `SELECT r.*, c.name AS connection_name, c.provider FROM connector_runs r LEFT JOIN connector_connections c ON c.id = r.connection_id
        WHERE ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { items: rows.map(toRun) };
  });

  app.post<{ Params: { id: string } }>("/v1/connectors/runs/:id/retry", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (!UUID.test(req.params.id)) throw notFound("Ejecución");
    const r = await s.db.one<any>(`SELECT * FROM connector_runs WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!r) throw notFound("Ejecución");
    if (r.status === "succeeded") throw new AppError(409, "already_succeeded", "Ya se completó");
    if (r.kind === "send" && !r.detail?.webhook) throw new AppError(409, "not_retryable", "Un envío manual se vuelve a hacer desde el registro (POST /v1/connectors/flows/:id/send)");
    await s.db.query(`UPDATE connector_runs SET status = 'pending', error = NULL, updated_at = now() WHERE id = $1`, [r.id]);
    await enqueue(s.db, "platform", { kind: "connector", runId: r.id }, { dedupeKey: `cnjob:${r.id}:${Date.now()}` });
    reply.code(202);
    return { queued: true };
  });

  // ───────── Webhook del sistema de origen (público; el secreto va en la URL) ─────────

  app.post<{ Params: { token: string } }>(
    "/v1/integrations/connectors/hook/:token",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } }, bodyLimit: 512 * 1024 },
    async (req, reply) => {
      const token = String(req.params.token ?? "");
      const c = token.startsWith("cshk_") ? await s.db.one<any>(`SELECT * FROM connector_connections WHERE webhook_token_hash = $1`, [hashToken(token)]) : null;
      if (!c) return reply.code(404).send({ error: { code: "not_found", message: "Webhook inexistente" } });
      if (!c.active) return reply.code(409).send({ error: { code: "connector_connection_inactive", message: "La conexión está desactivada" } });
      const events = parseWebhook(c.provider, req.body);
      if (!events.length) return { ok: true, queued: 0 };
      const flows = await s.db.query<any>(`SELECT * FROM connector_flows WHERE connection_id = $1 AND active AND trigger = 'webhook'`, [c.id]);
      // Reentregas del mismo cuerpo no duplican: la clave incluye el hash del cuerpo.
      const bodyHash = sha256Hex(JSON.stringify(req.body ?? null)).slice(0, 32);
      let queued = 0;
      for (const ev of events) {
        for (const f of flows) {
          if (ev.objectType && ev.objectType !== f.object_type && CONNECTOR_PROVIDER_OBJECTS[c.provider as ConnectorProvider].length > 1) continue;
          const want = f.trigger_config?.event;
          if (want && String(ev.event ?? "").toLowerCase() !== String(want).toLowerCase()) continue;
          const ok = await queueRun(
            s.db,
            { tenantId: c.tenant_id, connectionId: c.id, flowId: f.id, linkId: null, envelopeId: null, kind: "send", event: ev.event ?? "webhook", objectType: f.object_type, objectId: ev.recordId, detail: { webhook: true } },
            `cn:hook:${f.id}:${ev.recordId}:${bodyHash}`,
          );
          if (ok) queued++;
        }
      }
      return { ok: true, queued };
    },
  );
}

