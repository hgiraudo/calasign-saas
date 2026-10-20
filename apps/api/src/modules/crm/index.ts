// CRM y ERP (Fase 6): conexiones por organización, mapeos registro → plantilla, envío desde un registro,
// write-back del estado del sobre, adjunto del PDF sellado y registro de ejecuciones con reintentos.
//
// Los trabajos van por la cola "platform" (kind "crm"); se encolan desde el outbox de evidencia
// (platform-fanout.ts) en la misma transacción que el evento.
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  CRM_KIND,
  CRM_PROVIDERS,
  CRM_PROVIDER_OBJECTS,
  CreateCrmLinkInput,
  CreateCrmMappingInput,
  CreateCrmTokenConnectionInput,
  EnvelopeFromTemplateInput,
  SendFromCrmRecordInput,
  StartCrmOAuthInput,
  UpdateCrmConnectionInput,
  UpdateCrmMappingInput,
  type CrmConnection,
  type CrmLink,
  type CrmMapping,
  type CrmObjectType,
  type CrmProvider,
  type CrmProviderInfo,
  type CrmRun,
  type SendFromCrmRecordResponse,
  type ZohoProduct,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import type { Actor } from "../../infra/evidence";
import { enqueue, isLastAttempt, type JobContext } from "../../infra/queue";
import type { BlobStore } from "../../infra/storage";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { decrypt, encrypt, iso, sha256Hex, uuidv7 } from "../../lib/util";
import { assertEnvelopeAccess, assertTemplateAccess, envelopeVisibilitySql, hasPerm, templateVisibilitySql } from "../access";
import { auditFromRequest } from "../audit";
import { authenticate, type AuthContext, type Services } from "../context";
import { idempotent, sendEnvelope } from "../envelopes";
import { ownerCanStillCreate } from "../owner-check";
import { tenantBaseUrl } from "../custom-domains";
import { insertEnvelopeFromTemplate, loadTemplateForUse, planFromTemplate } from "../templates";
import { MappingError, mapPrefill, mapRecipients, neededProperties, statusForEvidence, statusValue, webhookMatches } from "./mapping";
import {
  CrmConn,
  CrmError,
  attachSigned,
  crmRedirectUri,
  fetchRecord,
  findByIdentification,
  CRM_OAUTH_PROVIDERS,
  isOAuthProvider,
  kommoTokenUrl,
  oauthApp,
  oauthConfigured,
  oauthTokenRequest,
  testConnection,
  tokenSupported,
  validateSalesforceInstance,
  validateZohoAccounts,
  validateZohoApiDomain,
  writeStatus,
  zohoAccountsBase,
  type ConnRow,
  type CrmOAuthProvider,
} from "./providers";
import { validateKommoDomain } from "./kommo";
import { validatePipedriveDomain } from "./pipedrive";

const UUID = /^[0-9a-f-]{36}$/i;

// ───────────────────────────── Serialización ─────────────────────────────

const toConnection = (r: any): CrmConnection => ({
  id: r.id,
  provider: r.provider,
  name: r.name,
  authType: r.auth_type,
  accountLabel: r.account_label,
  active: r.active,
  createdAt: iso(r.created_at)!,
  lastSuccessAt: iso(r.last_success_at),
  lastError: r.last_error,
});

const toMapping = (r: any): CrmMapping => ({
  id: r.id,
  connectionId: r.connection_id,
  name: r.name,
  objectType: r.object_type,
  templateId: r.template_id,
  roles: r.role_map ?? [],
  prefill: r.prefill_map ?? [],
  writeBack: { attachPdf: true, ...(r.write_back ?? {}) },
  trigger: r.trigger,
  triggerConfig: r.trigger_config ?? {},
  send: r.send,
  active: r.active,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toLink = (r: any): CrmLink => ({
  id: r.id,
  connectionId: r.connection_id,
  envelopeId: r.envelope_id,
  objectType: r.object_type,
  objectId: r.object_id,
  lastStatus: r.last_status,
  pdfAttachedAt: iso(r.pdf_attached_at),
  remoteRef: r.remote_ref,
  createdAt: iso(r.created_at)!,
});

const toRun = (r: any): CrmRun => ({
  id: r.id,
  connectionId: r.connection_id,
  connectionName: r.connection_name ?? null,
  provider: r.provider ?? null,
  mappingId: r.mapping_id,
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
  if (err instanceof MappingError) return new AppError(422, err.code, err.message);
  // Datos del registro que no pasan la validación del sobre (p. ej. un correo mal cargado en el CRM): es un error del
  // registro, no del servidor. Sin esto el envío manual respondía 500 y el disparo por webhook se reintentaba en vano.
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return new AppError(422, "crm_invalid_record", `El registro tiene datos que no sirven para el sobre: ${detail}`.slice(0, 1000));
  }
  if (err instanceof CrmError) {
    if (err.authFailed) return new AppError(409, "crm_reauth_required", `La conexión ya no tiene acceso: hay que volver a conectarla (${err.message})`);
    if (err.status === 404) return new AppError(404, "crm_record_not_found", err.message);
    return new AppError(502, "crm_provider_error", err.message);
  }
  return new AppError(500, "internal_error", String((err as Error)?.message ?? err));
}

async function loadConn(db: Db, tenantId: string, id: string) {
  if (!UUID.test(id)) throw notFound("Conexión");
  const r = await db.one<any>(`SELECT * FROM crm_connections WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!r) throw notFound("Conexión");
  return r;
}

/**
 * Clave de config con la cuenta del CRM de cada conexión (Pipedrive: company_id de /users/me; Kommo: id de la cuenta de
 * /api/v4/account). La acción de Pipedrive y el widget de Kommo mandan la cuenta desde la que se abrieron.
 */
const ACCOUNT_KEY: Partial<Record<CrmProvider, string>> = { pipedrive: "companyId", kommo: "accountId" };

async function loadMapping(db: Db, tenantId: string, id: string) {
  if (!UUID.test(id)) throw notFound("Mapeo");
  const r = await db.one<any>(`SELECT * FROM crm_mappings WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!r) throw notFound("Mapeo");
  return r;
}

const open = (db: Db, row: any) => new CrmConn(row as ConnRow, db);

// ───────────────────────────── Envío desde un registro ─────────────────────────────

export interface SendCtx {
  tenantId: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
}

/** Lee el registro, arma el sobre desde la plantilla del mapeo, lo vincula y (según el mapeo) lo envía. */
export async function sendFromRecord(
  db: Db,
  ctx: SendCtx,
  mapping: any,
  objectId: string,
  opts: { send?: boolean; subject?: string; message?: string | null; runId?: string; skipIfOpen?: boolean },
): Promise<SendFromCrmRecordResponse | null> {
  const connRow = await db.one<any>(`SELECT * FROM crm_connections WHERE id = $1 AND tenant_id = $2`, [mapping.connection_id, ctx.tenantId]);
  if (!connRow) throw notFound("Conexión");
  if (!connRow.active) throw new AppError(409, "crm_connection_inactive", "La conexión está desactivada");
  if (!mapping.active) throw new AppError(409, "crm_mapping_inactive", "El mapeo está desactivado");
  if (!mapping.template_id) throw badRequest("crm_template_required", "El mapeo no tiene plantilla");
  const runId = opts.runId ?? uuidv7();
  // Con runId (envío por webhook) la ejecución ya existe y handleCrmJob ya contó el intento.
  if (!opts.runId) {
    await db.query(
      `INSERT INTO crm_runs (id, tenant_id, connection_id, mapping_id, kind, object_type, object_id, attempts, detail) VALUES ($1,$2,$3,$4,'send',$5,$6,1,$7)`,
      [runId, ctx.tenantId, connRow.id, mapping.id, mapping.object_type, objectId, JSON.stringify({ by: ctx.actor.label ?? ctx.actor.type })],
    );
  }
  try {
    const conn = open(db, connRow);
    const roles = mapping.role_map ?? [];
    const prefillMap = mapping.prefill_map ?? [];
    const record = await fetchRecord(conn, mapping.object_type, objectId, neededProperties(roles, prefillMap));
    const recipients = mapRecipients(record, roles);
    const prefill = mapPrefill(record, prefillMap);
    const l = await loadTemplateForUse(db, ctx.tenantId, mapping.template_id);
    const send = opts.send ?? mapping.send;
    const p = record.properties;
    const subjectDefault = String(record.title ?? p.dealname ?? p.Name ?? p.Deal_Name ?? p.Full_Name ?? "").trim();
    const input = EnvelopeFromTemplateInput.parse({
      templateId: mapping.template_id,
      subject: opts.subject ?? (subjectDefault ? `${l.row.subject ?? l.row.name} — ${subjectDefault}`.slice(0, 300) : undefined),
      message: opts.message,
      recipients: recipients.map((r) => ({ role: r.role, name: r.name, email: r.email, phone: r.phone, channels: r.channels })),
      prefill,
      send: false,
    });
    const plan = planFromTemplate(l, input);
    const crmMeta = { connectionId: connRow.id, provider: connRow.provider, objectType: mapping.object_type, objectId: record.id, mappingId: mapping.id };
    const out = await db.tx(async (t) => {
      if (opts.skipIfOpen) {
        // Disparo por webhook: dos eventos del mismo registro procesados a la vez (la cola corre varios trabajos en
        // paralelo) pasarían los dos el control previo y mandarían dos sobres. Con el mapeo bloqueado, el segundo
        // espera al primero y ve su sobre.
        await t.query(`SELECT id FROM crm_mappings WHERE id = $1 FOR UPDATE`, [mapping.id]);
        const openEnv = await t.one<any>(
          `SELECT l.envelope_id FROM crm_links l JOIN envelopes e ON e.id = l.envelope_id
            WHERE l.mapping_id = $1 AND l.object_id = ANY($2::text[]) AND e.status IN ('draft','sent','awaiting_certificates','finalizing') LIMIT 1`,
          [mapping.id, [...new Set([objectId, record.id])]],
        );
        if (openEnv) {
          await t.query(`UPDATE crm_runs SET status = 'succeeded', error = NULL, detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`, [
            runId,
            JSON.stringify({ skipped: "ya hay un sobre en curso para este registro", envelopeId: openEnv.envelope_id }),
          ]);
          return { envelopeId: openEnv.envelope_id as string, linkId: null as string | null, skipped: true };
        }
      }
      const envelopeId = await insertEnvelopeFromTemplate(t, ctx, l, input, plan, { crm: crmMeta });
      const linkId = uuidv7();
      // El vínculo va antes del envío: así el evento envelope.sent ya encuentra el registro para el write-back.
      await t.query(
        `INSERT INTO crm_links (id, tenant_id, connection_id, mapping_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [linkId, ctx.tenantId, connRow.id, mapping.id, envelopeId, mapping.object_type, record.id],
      );
      if (send) await sendEnvelope(t, ctx.tenantId, envelopeId, ctx.actor);
      await t.query(`UPDATE crm_runs SET status = 'succeeded', envelope_id = $2, link_id = $3, error = NULL, detail = detail || $4::jsonb, updated_at = now() WHERE id = $1`, [
        runId,
        envelopeId,
        linkId,
        JSON.stringify({ envelopeId, recipients: recipients.length, sent: send }),
      ]);
      return { envelopeId, linkId: linkId as string | null, skipped: false };
    });
    await db.query(`UPDATE crm_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [connRow.id]);
    if (out.skipped) return null; // ya había un sobre en curso (solo con skipIfOpen)
    return { envelopeId: out.envelopeId, status: send ? "sent" : "draft", linkId: out.linkId!, runId };
  } catch (err) {
    const e = asAppError(err);
    await db.query(`UPDATE crm_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [runId, e.message.slice(0, 1000)]);
    if (err instanceof CrmError) await db.query(`UPDATE crm_connections SET last_error = $2 WHERE id = $1`, [connRow.id, e.message.slice(0, 500)]);
    throw e;
  }
}

// ───────────────────────────── Outbox de evidencia → trabajos ─────────────────────────────

/** Desde platform-fanout: write-back por cada vínculo del sobre y, al completarse, búsquedas en ERP. */
export async function queueCrmEvents(db: Db, tenantId: string, envelopeId: string, evidenceType: string) {
  const status = statusForEvidence(evidenceType);
  if (!status) return;
  const any = await db.one(`SELECT 1 FROM crm_connections WHERE tenant_id = $1 AND active LIMIT 1`, [tenantId]);
  if (!any) return;
  const links = await db.query<any>(
    `SELECT l.* FROM crm_links l JOIN crm_connections c ON c.id = l.connection_id WHERE l.envelope_id = $1 AND c.active`,
    [envelopeId],
  );
  for (const l of links) await queueRun(db, { tenantId, connectionId: l.connection_id, mappingId: l.mapping_id, linkId: l.id, envelopeId, kind: "write_back", event: status, objectType: l.object_type, objectId: l.object_id }, `crm:wb:${l.id}:${status}`);
  if (status !== "completed") return;
  const env = await db.one<any>(`SELECT metadata FROM envelopes WHERE id = $1`, [envelopeId]);
  const templateId = env?.metadata?.templateId ?? null;
  const maps = await db.query<any>(
    `SELECT m.* FROM crm_mappings m JOIN crm_connections c ON c.id = m.connection_id
      WHERE m.tenant_id = $1 AND m.active AND c.active AND m.trigger = 'on_completion'
        AND NOT EXISTS (SELECT 1 FROM crm_links l WHERE l.connection_id = m.connection_id AND l.envelope_id = $2)`,
    [tenantId, envelopeId],
  );
  for (const m of maps) {
    const only = m.trigger_config?.templateId;
    if (only && only !== templateId) continue;
    await queueRun(db, { tenantId, connectionId: m.connection_id, mappingId: m.id, linkId: null, envelopeId, kind: "match", event: "completed", objectType: m.object_type, objectId: null }, `crm:match:${m.id}:${envelopeId}`);
  }
}

interface RunSpec {
  tenantId: string;
  connectionId: string;
  mappingId: string | null;
  linkId: string | null;
  envelopeId: string | null;
  kind: "write_back" | "match" | "send";
  event: string | null;
  objectType: string | null;
  objectId: string | null;
  detail?: Record<string, unknown>;
}

async function queueRun(db: Db, r: RunSpec, dedupeKey: string) {
  const id = uuidv7();
  const ins = await db.query<{ id: string }>(
    `INSERT INTO crm_runs (id, tenant_id, connection_id, mapping_id, link_id, envelope_id, kind, event, object_type, object_id, detail, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [id, r.tenantId, r.connectionId, r.mappingId, r.linkId, r.envelopeId, r.kind, r.event, r.objectType, r.objectId, JSON.stringify(r.detail ?? {}), dedupeKey],
  );
  if (ins.length) await enqueue(db, "platform", { kind: "crm", runId: id }, { dedupeKey: `crmjob:${id}` });
}

// ───────────────────────────── Trabajos ─────────────────────────────

async function signedPdf(db: Db, blobs: BlobStore, envelopeId: string) {
  const e = await db.one<any>(
    `SELECT e.subject, e.status, f.storage_key, f.sha256 FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [envelopeId],
  );
  if (!e || e.status !== "completed") return null;
  return { subject: e.subject as string, sha256: e.sha256 as string, bytes: await blobs.get(e.storage_key) };
}

const pdfName = (subject: string, envelopeId: string) => `${subject.replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 120) || "documento"} - ${envelopeId.slice(0, 8)}.pdf`;

/** Reclamo de last_status hecho por un write-back: si la escritura del estado falla de forma definitiva, se devuelve
 *  el vínculo al estado anterior (ver handleCrmJob). */
interface StatusClaim {
  linkId: string;
  previous: string | null;
  claimed: string;
  written: boolean;
}
/** runId: la ejecución guarda el valor anterior al primer reclamo (detail.claimPrevious), porque en un reintento el
 *  vínculo ya tiene el estado reclamado por el intento anterior. */
interface ClaimOut {
  runId: string;
  /** written: un intento anterior ya escribió el estado en el CRM (detail.claimWritten). */
  prior?: { previous: string | null; written: boolean };
  claim: StatusClaim | null;
}

async function writeBackAndAttach(
  db: Db,
  blobs: BlobStore,
  conn: CrmConn,
  link: any,
  mapping: any | null,
  status: string,
  claimOut?: ClaimOut,
): Promise<Record<string, unknown>> {
  const wb = { attachPdf: true, ...(mapping?.write_back ?? {}) };
  const detail: Record<string, unknown> = {};
  // Los trabajos "sent" y "completed" (o "declined"…) del mismo vínculo pueden correr a la vez (la cola procesa en
  // paralelo y reintenta): leer last_status al arrancar no alcanzaba y un "sent" podía pisar en el CRM el estado
  // final. Compare-and-set del rango sobre last_status, sin dejar una transacción abierta durante las llamadas HTTP
  // (en PGlite una transacción bloquea toda la base, y las credenciales renovadas se guardan por fuera):
  //  1. antes de escribir, se reclama el vínculo solo si su estado no tiene un rango mayor (si no, se omite);
  //  2. después de escribir, se vuelve a leer: si mientras tanto otro trabajo reclamó un estado de rango mayor, su
  //     escritura pudo llegar al CRM antes que esta, así que se reescribe ese estado (el último en llegar gana).
  //  3. si la escritura falla de forma definitiva, handleCrmJob devuelve last_status al valor anterior (solo si sigue
  //     siendo el reclamado): si no, un "sent" que nunca llegó al CRM dejaba el vínculo como si estuviera escrito.
  // El reclamo lee el valor anterior con el registro bloqueado (transacción corta, sin llamadas HTTP adentro).
  const claimed = await db.tx(async (t) => {
    const cur = await t.one<{ last_status: string | null }>(`SELECT last_status FROM crm_links WHERE id = $1 FOR UPDATE`, [link.id]);
    if (!cur || statusRank(cur.last_status) > statusRank(status)) return null;
    await t.query(`UPDATE crm_links SET last_status = $2 WHERE id = $1`, [link.id, status]);
    return { previous: cur.last_status };
  });
  if (!claimed) {
    const cur = await db.one<{ last_status: string | null }>(`SELECT last_status FROM crm_links WHERE id = $1`, [link.id]);
    return { skipped: `el registro ya tiene el estado ${cur?.last_status ?? "?"}` };
  }
  let previous = claimed.previous;
  if (claimOut?.prior) previous = claimOut.prior.previous;
  else if (claimOut) await db.query(`UPDATE crm_runs SET detail = detail || $2::jsonb WHERE id = $1`, [claimOut.runId, JSON.stringify({ claimPrevious: previous })]);
  const claim: StatusClaim = { linkId: link.id, previous, claimed: status, written: claimOut?.prior?.written ?? false };
  if (claimOut) claimOut.claim = claim;
  if (CRM_KIND[conn.provider] === "crm" && wb.statusProperty) {
    const value = statusValue(wb, status as any);
    await writeStatus(conn, link.object_type, link.object_id, wb.statusProperty, value);
    // Se guarda en la ejecución: si un reintento falla después (p. ej. al adjuntar), el CRM ya tiene este estado y
    // last_status no se tiene que devolver al anterior.
    if (claimOut && !claim.written) await db.query(`UPDATE crm_runs SET detail = detail || '{"claimWritten":true}'::jsonb WHERE id = $1`, [claimOut.runId]);
    claim.written = true;
    detail.statusWritten = { property: wb.statusProperty, value };
    const after = (await db.one<{ last_status: string | null }>(`SELECT last_status FROM crm_links WHERE id = $1`, [link.id]))?.last_status ?? null;
    if (after && statusRank(after) > statusRank(status)) {
      const finalValue = statusValue(wb, after as any);
      await writeStatus(conn, link.object_type, link.object_id, wb.statusProperty, finalValue);
      detail.statusRewritten = { property: wb.statusProperty, value: finalValue, because: after };
    }
  }
  if (status === "completed" && wb.attachPdf !== false && !link.pdf_attached_at) {
    const pdf = await signedPdf(db, blobs, link.envelope_id);
    if (pdf) {
      const ref = await attachSigned(conn, link.object_type, link.object_id, {
        fileName: pdfName(pdf.subject, link.envelope_id),
        pdf: pdf.bytes,
        subject: pdf.subject,
        envelopeId: link.envelope_id,
        sha256: pdf.sha256,
        // El dominio propio de la organización si lo tiene (como en los correos), no siempre el de la plataforma.
        url: `${await tenantBaseUrl(db, link.tenant_id)}/app/envelopes/${link.envelope_id}`,
      });
      await db.query(`UPDATE crm_links SET pdf_attached_at = now(), remote_ref = $2 WHERE id = $1`, [link.id, ref]);
      detail.attached = ref;
    }
  }
  return detail;
}

/** Rango de los estados que se escriben en el CRM: uno final (completado, rechazado, anulado, vencido) nunca se
 *  reemplaza por "sent". Entre finales gana el último evento. */
export function statusRank(s: string | null | undefined): number {
  if (!s) return 0;
  return s === "sent" ? 1 : 2;
}
const STATUS_RANK_SQL = `(CASE WHEN last_status IS NULL THEN 0 WHEN last_status = 'sent' THEN 1 ELSE 2 END)`;

/** Write-back que falló de forma definitiva sin llegar a escribir el estado: last_status vuelve al valor anterior
 *  (solo si nadie lo cambió después del reclamo) y queda registrado en la actividad. */
async function releaseClaim(db: Db, runId: string, claim: StatusClaim | null) {
  if (!claim || claim.written || claim.previous === claim.claimed) return;
  const back = await db.query(`UPDATE crm_links SET last_status = $2 WHERE id = $1 AND last_status = $3 RETURNING id`, [claim.linkId, claim.previous, claim.claimed]);
  if (back.length) {
    await db.query(`UPDATE crm_runs SET detail = detail || $2::jsonb WHERE id = $1`, [
      runId,
      JSON.stringify({ lastStatusRestored: { from: claim.claimed, to: claim.previous } }),
    ]);
  }
}

export async function handleCrmJob(d: { db: Db; blobs: BlobStore }, p: { runId: string }, job?: JobContext) {
  const { db } = d;
  const run = await db.one<any>(`SELECT * FROM crm_runs WHERE id = $1`, [p.runId]);
  if (!run || run.status === "succeeded") return;
  const connRow = run.connection_id ? await db.one<any>(`SELECT * FROM crm_connections WHERE id = $1`, [run.connection_id]) : null;
  if (!connRow || !connRow.active) {
    await db.query(`UPDATE crm_runs SET status = 'failed', error = 'conexión inexistente o desactivada', updated_at = now() WHERE id = $1`, [run.id]);
    return;
  }
  await db.query(`UPDATE crm_runs SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [run.id]);
  const conn = open(db, connRow);
  const mapping = run.mapping_id ? await db.one<any>(`SELECT * FROM crm_mappings WHERE id = $1`, [run.mapping_id]) : null;
  const claimOut: ClaimOut = {
    runId: run.id,
    prior:
      run.detail && Object.prototype.hasOwnProperty.call(run.detail, "claimPrevious")
        ? { previous: run.detail.claimPrevious ?? null, written: run.detail.claimWritten === true }
        : undefined,
    claim: null,
  };
  try {
    let detail: Record<string, unknown> = {};
    if (run.kind === "write_back") {
      const link = await db.one<any>(`SELECT * FROM crm_links WHERE id = $1`, [run.link_id]);
      if (!link) throw new Error("vínculo inexistente");
      detail = await writeBackAndAttach(db, d.blobs, conn, link, mapping, run.event, claimOut);
    } else if (run.kind === "match") {
      const ids = await db.query<any>(
        // Solo quienes firmaron: un firmante que delegó o fue reemplazado conserva su documento, y el contrato terminaba en
        // el registro de alguien que no lo firmó.
        `SELECT name, id_document_number FROM recipients
          WHERE envelope_id = $1 AND role = 'signer' AND status IN ('signed','completed') AND id_document_number IS NOT NULL ORDER BY routing_order, created_at`,
        [run.envelope_id],
      );
      let found: string | null = null;
      for (const r of ids) {
        found = await findByIdentification(conn, run.object_type, r.id_document_number);
        if (found) break;
      }
      if (!found) {
        await db.query(`UPDATE crm_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [
          run.id,
          ids.length ? `No se encontró en ${conn.provider} ningún registro con la identificación de los firmantes` : "Los firmantes no tienen documento de identidad cargado",
        ]);
        return; // no se reintenta: no va a aparecer solo
      }
      const linkId = uuidv7();
      await db.query(
        `INSERT INTO crm_links (id, tenant_id, connection_id, mapping_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id, envelope_id) DO NOTHING`,
        [linkId, run.tenant_id, conn.row.id, run.mapping_id, run.envelope_id, run.object_type, found],
      );
      const link = await db.one<any>(`SELECT * FROM crm_links WHERE connection_id = $1 AND envelope_id = $2`, [conn.row.id, run.envelope_id]);
      await db.query(`UPDATE crm_runs SET link_id = $2, object_id = $3 WHERE id = $1`, [run.id, link.id, found]);
      detail = { matched: found, ...(await writeBackAndAttach(db, d.blobs, conn, link, mapping, "completed", claimOut)) };
    } else if (run.kind === "send") {
      // Envío disparado por webhook (HubSpot).
      if (!mapping) throw new Error("mapeo inexistente");
      const openEnv = await db.one<any>(
        `SELECT l.envelope_id FROM crm_links l JOIN envelopes e ON e.id = l.envelope_id
          WHERE l.mapping_id = $1 AND l.object_id = $2 AND e.status IN ('draft','sent','awaiting_certificates','finalizing') LIMIT 1`,
        [mapping.id, run.object_id],
      );
      if (openEnv) {
        await db.query(`UPDATE crm_runs SET status = 'succeeded', detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`, [
          run.id,
          JSON.stringify({ skipped: "ya hay un sobre en curso para este registro", envelopeId: openEnv.envelope_id }),
        ]);
        return;
      }
      // El sobre queda a nombre de quien creó el mapeo (un usuario o una API key): tiene que seguir pudiendo crear
      // sobres con esa plantilla. Si no, un ex empleado (o una key revocada) seguiría "enviando" sobres y recibiendo
      // los avisos de cada contrato completado.
      const owner = {
        tenantId: run.tenant_id,
        userId: mapping.created_by_api_key ? null : mapping.created_by,
        apiKeyId: mapping.created_by_api_key ?? null,
      };
      const ownerGone = await ownerCanStillCreate(db, owner, mapping.template_id);
      if (ownerGone) throw new AppError(409, "crm_mapping_owner_gone", `${ownerGone}: hay que volver a crear el mapeo`);
      await sendFromRecord(
        db,
        { ...owner, actor: { type: "system", label: `${conn.provider} (webhook)` } },
        mapping,
        run.object_id,
        { runId: run.id, skipIfOpen: true },
      );
      await db.query(`UPDATE crm_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [conn.row.id]);
      return;
    }
    await db.query(`UPDATE crm_runs SET status = 'succeeded', error = NULL, detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify(detail)]);
    await db.query(`UPDATE crm_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [conn.row.id]);
  } catch (err) {
    const msg = asAppError(err).message.slice(0, 1000);
    await db.query(`UPDATE crm_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [run.id, msg]);
    await db.query(`UPDATE crm_connections SET last_error = $2 WHERE id = $1`, [conn.row.id, msg.slice(0, 500)]);
    // Sin acceso (token revocado) o datos que no cierran: no tiene sentido reintentar solo. sendFromRecord devuelve todo
    // como AppError: un error del proveedor o interno (5xx, p. ej. HubSpot caído) sí se reintenta.
    const permanent = (err instanceof CrmError && err.authFailed) || err instanceof MappingError || (err instanceof AppError && err.status < 500);
    // Fallo definitivo (error permanente o último intento de la cola): se suelta el reclamo de last_status.
    if (permanent || isLastAttempt(job, err)) await releaseClaim(db, run.id, claimOut.claim);
    if (permanent) return;
    throw err; // reintento con backoff de la cola
  }
}

// ───────────────────────────── Webhook de HubSpot ─────────────────────────────

/** Firma v3: base64(HMAC-SHA256(client secret, método + URI + cuerpo + timestamp)). */
export function hubspotSignatureV3(secret: string, method: string, uri: string, body: string, timestamp: string) {
  return createHmac("sha256", secret).update(`${method}${uri}${body}${timestamp}`).digest("base64");
}

// ───────────────────────────── Rutas ─────────────────────────────

interface OAuthState {
  t: string;
  u: string;
  p: CrmOAuthProvider;
  n: string;
  v: string | null;
  exp: number;
  /** Zoho: servidor de cuentas donde se inició y producto (crm o bigin). */
  a?: string;
  g?: ZohoProduct;
}

function checkMappingInput(provider: CrmProvider, objectType: CrmObjectType, trigger: string, templateId: string | null | undefined, triggerConfig: any) {
  if (!CRM_PROVIDER_OBJECTS[provider].includes(objectType)) {
    throw badRequest("crm_object_type", `${provider} admite: ${CRM_PROVIDER_OBJECTS[provider].join(", ")}`);
  }
  const kind = CRM_KIND[provider];
  if (kind === "crm" && trigger === "on_completion") throw badRequest("crm_trigger", "on_completion es para ERP (Siigo, Alegra)");
  if (kind === "erp" && trigger !== "on_completion") throw badRequest("crm_trigger", "En un ERP el mapeo se dispara al completarse el sobre (on_completion)");
  if (kind === "crm" && !templateId) throw badRequest("crm_template_required", "El mapeo necesita una plantilla");
  if (trigger === "webhook" && (provider !== "hubspot" || !triggerConfig?.property)) throw badRequest("crm_trigger", "El disparo por webhook es de HubSpot y necesita la propiedad que lo dispara");
  if (trigger === "on_completion" && provider === "alegra" && objectType === "invoice") {
    throw badRequest("crm_trigger", "Una factura de Alegra no se puede buscar por identificación: vinculala con POST /v1/crm/links");
  }
}

export async function crmRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  app.get("/v1/crm/providers", { preHandler: auth }, async () => {
    const items: CrmProviderInfo[] = CRM_PROVIDERS.map((p) => ({
      provider: p,
      kind: CRM_KIND[p],
      oauthConfigured: oauthConfigured(p),
      tokenSupported: tokenSupported(p),
      objectTypes: CRM_PROVIDER_OBJECTS[p],
    }));
    return {
      items,
      redirectUris: Object.fromEntries(CRM_OAUTH_PROVIDERS.map((p) => [p, crmRedirectUri(p)])),
      webhookUrl: `${config.appUrl}/v1/integrations/crm/hubspot/webhook`,
    };
  });

  // ───────── Conexiones ─────────

  app.get("/v1/crm/connections", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM crm_connections WHERE tenant_id = $1 ORDER BY created_at DESC`, [A(req).tenantId]);
    return { items: rows.map(toConnection) };
  });

  app.post("/v1/crm/connections", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = A(req);
    const input = CreateCrmTokenConnectionInput.parse(req.body);
    const creds =
      input.provider === "hubspot" ? { token: input.accessToken } : input.provider === "siigo" ? { username: input.username, accessKey: input.accessKey } : { email: input.email, token: input.token };
    const row: any = { id: uuidv7(), provider: input.provider, auth_type: "token", credentials_enc: encrypt(JSON.stringify(creds)), config: {} };
    const conn = new CrmConn(row, null);
    let test;
    try {
      test = await testConnection(conn);
    } catch (err) {
      throw new AppError(400, "crm_test_failed", `No se pudo conectar con ${input.provider}: ${(err as Error).message}`.slice(0, 400));
    }
    await s.db.query(
      `INSERT INTO crm_connections (id, tenant_id, provider, name, auth_type, credentials_enc, config, account_label, created_by, last_success_at)
       VALUES ($1,$2,$3,$4,'token',$5,$6,$7,$8, now())`,
      [row.id, a.tenantId, input.provider, input.name, encrypt(JSON.stringify(conn.creds)), JSON.stringify(test.config ?? {}), test.label, a.userId],
    );
    await auditFromRequest(s.db, req, a, "crm.connected", { targetType: "crm_connection", targetId: row.id, data: { provider: input.provider, name: input.name } });
    reply.code(201);
    return toConnection(await loadConn(s.db, a.tenantId, row.id));
  });

  app.post<{ Params: { provider: string } }>("/v1/crm/oauth/:provider/start", { preHandler: auth }, async (req) => {
    const a = A(req);
    const p = req.params.provider;
    if (!isOAuthProvider(p)) throw notFound("Proveedor");
    if (!oauthConfigured(p)) throw new AppError(409, "provider_not_configured", "Este proveedor no está configurado en el servidor");
    if (!a.userId) throw new AppError(403, "session_required", "Conectar una cuenta requiere iniciar sesión en la web");
    const input = StartCrmOAuthInput.parse(req.body ?? {});
    const zoho = p === "zoho" ? { accounts: zohoAccountsBase(input.region), product: input.product ?? "crm" } : null;
    const app_ = oauthApp(p, zoho ?? {});
    const verifier = app_.pkce ? randomBytes(32).toString("base64url") : null;
    const state: OAuthState = { t: a.tenantId, u: a.userId, p, n: input.name, v: verifier, exp: Date.now() + 10 * 60_000, ...(zoho ? { a: zoho.accounts, g: zoho.product } : {}) };
    const url = new URL(app_.authorizeUrl);
    url.searchParams.set("client_id", app_.clientId!);
    url.searchParams.set("redirect_uri", crmRedirectUri(p));
    url.searchParams.set("response_type", "code");
    if (app_.scope) url.searchParams.set("scope", app_.scope);
    for (const [k, v] of Object.entries(app_.authorizeParams ?? {})) url.searchParams.set(k, v);
    url.searchParams.set("state", encrypt(JSON.stringify(state)));
    if (verifier) {
      url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return { authorizeUrl: url.toString() };
  });

  // Vuelta del proveedor: el navegador trae la sesión; el estado cifrado ata la conexión a quien la inició.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; "accounts-server"?: string; referer?: string } }>(
    "/v1/crm/oauth/:provider/callback",
    { preHandler: auth },
    async (req, reply) => {
      const a = A(req);
      const back = (q: string) => reply.redirect(`/app/settings/crm?${q}`);
      // Instalación desde el Marketplace de Pipedrive: llega un code sin state (no la inició CalaSign). No se canjea
      // a ciegas (ataría a esta organización una cuenta que nadie eligió desde CalaSign): se pide conectar desde Ajustes.
      if (req.params.provider === "pipedrive" && !req.query.state && !req.query.error) return back("pipedrive_install=1");
      // Kommo igual: instalar el widget o la integración desde Kommo vuelve con code + referer y sin state.
      if (req.params.provider === "kommo" && !req.query.state && !req.query.error) return back("kommo_install=1");
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
        // Zoho multi-DC: el código solo se canjea en el accounts-server de la cuenta del usuario (que puede no ser
        // donde se inició, p. ej. empezó en zoho.com y la cuenta está en zoho.eu). Se valida que sea de Zoho.
        const zohoAccounts = st.p === "zoho" ? validateZohoAccounts(String(req.query["accounts-server"] ?? st.a ?? zohoAccountsBase())) : null;
        // Kommo: el código se canjea en el subdominio de la cuenta que vuelve en referer (validado: *.kommo.com).
        const kommoDomain = st.p === "kommo" ? validateKommoDomain(String(req.query.referer ?? "")) : null;
        const body = await oauthTokenRequest(
          st.p,
          {
            grant_type: "authorization_code",
            code: req.query.code,
            redirect_uri: crmRedirectUri(st.p),
            ...(st.v ? { code_verifier: st.v } : {}),
          },
          zohoAccounts ? `${zohoAccounts}/oauth/v2/token` : kommoDomain ? kommoTokenUrl(kommoDomain) : undefined,
        );
        const cfg: Record<string, unknown> = {};
        if (st.p === "salesforce") cfg.instanceUrl = validateSalesforceInstance(String(body.instance_url ?? ""));
        if (st.p === "zoho") {
          cfg.accountsServer = zohoAccounts;
          // Zoho no siempre devuelve api_domain (cuentas viejas de .com): www.zohoapis.<tld del accounts-server>.
          cfg.apiDomain = validateZohoApiDomain(String(body.api_domain ?? zohoAccounts!.replace("://accounts.zohocloud.", "://www.zohoapis.").replace("://accounts.zoho.", "://www.zohoapis.")));
          cfg.product = st.g ?? "crm";
        }
        // Pipedrive: cada compañía tiene su dominio de API (https://<compañía>.pipedrive.com), validado.
        if (st.p === "pipedrive") cfg.apiDomain = validatePipedriveDomain(String(body.api_domain ?? ""));
        if (st.p === "kommo") cfg.baseDomain = kommoDomain;
        const creds = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null };
        const row: any = { id: uuidv7(), provider: st.p, auth_type: "oauth", credentials_enc: encrypt(JSON.stringify(creds)), config: cfg };
        const conn = new CrmConn(row, null);
        // HubSpot: sin el portal (hub_id) el disparador por webhook de la conexión nunca se activaría; mejor fallar la
        // conexión (se puede reintentar) que guardarla rota sin aviso.
        const test = await testConnection(conn).catch((err) => {
          if (st.p === "hubspot") throw err;
          return { label: null, config: {} as Record<string, unknown> };
        });
        if (st.p === "hubspot" && !test.config?.portalId) throw new CrmError("HubSpot no informó el portal (hub_id)");
        await s.db.query(
          `INSERT INTO crm_connections (id, tenant_id, provider, name, auth_type, credentials_enc, config, account_label, created_by, last_success_at)
           VALUES ($1,$2,$3,$4,'oauth',$5,$6,$7,$8, now())`,
          [row.id, a.tenantId, st.p, st.n, encrypt(JSON.stringify(conn.creds)), JSON.stringify({ ...cfg, ...(test.config ?? {}) }), test.label, a.userId],
        );
        await auditFromRequest(s.db, req, a, "crm.connected", { targetType: "crm_connection", targetId: row.id, data: { provider: st.p, name: st.n } });
        return back(`connected=${st.p}`);
      } catch (err) {
        req.log.warn({ err: String(err) }, "no se pudo conectar el CRM");
        return back("error=token_exchange_failed");
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/crm/connections/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    const input = UpdateCrmConnectionInput.parse(req.body);
    await s.db.query(`UPDATE crm_connections SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = now() WHERE id = $1`, [r.id, input.name ?? null, input.active ?? null]);
    return toConnection(await loadConn(s.db, a.tenantId, r.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/crm/connections/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM crm_connections WHERE id = $1`, [r.id]);
    await auditFromRequest(s.db, req, a, "crm.disconnected", { targetType: "crm_connection", targetId: r.id, data: { provider: r.provider, name: r.name } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/crm/connections/:id/test", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    const r = await loadConn(s.db, a.tenantId, req.params.id);
    const conn = open(s.db, r);
    try {
      const t = await testConnection(conn);
      await s.db.query(`UPDATE crm_connections SET last_success_at = now(), last_error = NULL, account_label = COALESCE($2, account_label), config = config || $3::jsonb WHERE id = $1`, [
        r.id,
        t.label,
        JSON.stringify(t.config ?? {}),
      ]);
      return { ok: true, error: null };
    } catch (err) {
      const msg = asAppError(err).message.slice(0, 300);
      await s.db.query(`UPDATE crm_connections SET last_error = $2 WHERE id = $1`, [r.id, msg]);
      return { ok: false, error: msg };
    }
  });

  // ───────── Mapeos ─────────

  app.get<{ Querystring: { connectionId?: string; provider?: string; companyId?: string } }>("/v1/crm/mappings", { preHandler: auth }, async (req) => {
    const params: unknown[] = [A(req).tenantId];
    let where = `tenant_id = $1`;
    if (req.query.connectionId && UUID.test(req.query.connectionId)) {
      params.push(req.query.connectionId);
      where += ` AND connection_id = $2`;
    }
    // provider: solo mapeos de conexiones activas de ese proveedor (la acción de Pipedrive lista los suyos).
    if (req.query.provider && (CRM_PROVIDERS as readonly string[]).includes(req.query.provider)) {
      params.push(req.query.provider);
      let sub = `SELECT id FROM crm_connections WHERE tenant_id = $1 AND active AND provider = $${params.length}`;
      // companyId: solo conexiones de esa cuenta del CRM (las que todavía no la tienen guardada se conservan).
      const key = ACCOUNT_KEY[req.query.provider as CrmProvider];
      if (key && req.query.companyId && /^[A-Za-z0-9_-]{1,64}$/.test(req.query.companyId)) {
        params.push(req.query.companyId);
        sub += ` AND (config->>'${key}' IS NULL OR config->>'${key}' = $${params.length})`;
      }
      where += ` AND connection_id IN (${sub})`;
    }
    // Sin settings:manage (quien solo puede enviar, access.ts): solo los mapeos cuya plantilla puede usar. Los demás no
    // los puede enviar (assertTemplateAccess) y exponían la configuración ajena (destinatarios fijos con correo y teléfono).
    const a = A(req);
    if (!hasPerm(a, "settings:manage")) {
      where += ` AND template_id IN (SELECT t.id FROM templates t WHERE t.tenant_id = $1${templateVisibilitySql(a, params, "t")})`;
    }
    const rows = await s.db.query(`SELECT * FROM crm_mappings WHERE ${where} ORDER BY created_at DESC`, params);
    return { items: rows.map(toMapping) };
  });

  app.post("/v1/crm/mappings", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateCrmMappingInput.parse(req.body);
    const conn = await loadConn(s.db, a.tenantId, input.connectionId);
    checkMappingInput(conn.provider, input.objectType, input.trigger, input.templateId, input.triggerConfig);
    if (input.templateId) await assertTemplateAccess(s.db, a, input.templateId, "view");
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO crm_mappings (id, tenant_id, connection_id, name, object_type, template_id, role_map, prefill_map, write_back, trigger, trigger_config, send, active, created_by, created_by_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        a.tenantId,
        conn.id,
        input.name,
        input.objectType,
        input.templateId ?? null,
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
    await auditFromRequest(s.db, req, a, "crm.mapping_created", { targetType: "crm_mapping", targetId: id, data: { name: input.name, provider: conn.provider } });
    reply.code(201);
    return toMapping(await loadMapping(s.db, a.tenantId, id));
  });

  app.get<{ Params: { id: string } }>("/v1/crm/mappings/:id", { preHandler: auth }, async (req) => toMapping(await loadMapping(s.db, A(req).tenantId, req.params.id)));

  app.patch<{ Params: { id: string } }>("/v1/crm/mappings/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const m = await loadMapping(s.db, a.tenantId, req.params.id);
    const input = UpdateCrmMappingInput.parse(req.body);
    const conn = await loadConn(s.db, a.tenantId, m.connection_id);
    const merged = {
      objectType: input.objectType ?? m.object_type,
      trigger: input.trigger ?? m.trigger,
      templateId: input.templateId !== undefined ? input.templateId : m.template_id,
      triggerConfig: input.triggerConfig ?? m.trigger_config,
    };
    checkMappingInput(conn.provider, merged.objectType, merged.trigger, merged.templateId, merged.triggerConfig);
    if (input.templateId) await assertTemplateAccess(s.db, a, input.templateId, "view");
    await s.db.query(
      `UPDATE crm_mappings SET name = COALESCE($2, name), object_type = $3, template_id = $4, role_map = COALESCE($5::jsonb, role_map),
         prefill_map = COALESCE($6::jsonb, prefill_map), write_back = COALESCE($7::jsonb, write_back), trigger = $8, trigger_config = $9,
         send = COALESCE($10, send), active = COALESCE($11, active), updated_at = now() WHERE id = $1`,
      [
        m.id,
        input.name ?? null,
        merged.objectType,
        merged.templateId ?? null,
        input.roles ? JSON.stringify(input.roles) : null,
        input.prefill ? JSON.stringify(input.prefill) : null,
        input.writeBack ? JSON.stringify(input.writeBack) : null,
        merged.trigger,
        JSON.stringify(merged.triggerConfig ?? {}),
        input.send ?? null,
        input.active ?? null,
      ],
    );
    return toMapping(await loadMapping(s.db, a.tenantId, m.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/crm/mappings/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const m = await loadMapping(s.db, a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM crm_mappings WHERE id = $1`, [m.id]);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/crm/mappings/:id/send", { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = A(req);
    const m = await loadMapping(s.db, a.tenantId, req.params.id);
    const input = SendFromCrmRecordInput.parse(req.body);
    if (input.companyId) {
      const conn = await loadConn(s.db, a.tenantId, m.connection_id);
      const key = ACCOUNT_KEY[conn.provider as CrmProvider];
      const stored = key ? conn.config?.[key] : null;
      if (stored != null && String(stored) !== input.companyId) {
        throw new AppError(409, "company_mismatch", `El mapeo es de otra cuenta de ${conn.provider} (${stored}), no de la cuenta ${input.companyId} desde la que se envía`);
      }
    }
    if (m.template_id) await assertTemplateAccess(s.db, a, m.template_id, "view");
    // Idempotency-Key: la acción de Pipedrive, el widget de Kommo y los conectores low-code reintentan después de un
    // 504; con la misma clave y el mismo cuerpo se devuelve el sobre ya creado en lugar de crear otro.
    return idempotent(s, req, reply, async () => {
      const out = await sendFromRecord(s.db, { tenantId: a.tenantId, userId: a.userId, apiKeyId: a.apiKeyId, actor: a.actor }, m, input.objectId, input);
      return { status: 201, body: out! };
    });
  });

  // ───────── Vínculos y ejecuciones ─────────

  app.post("/v1/crm/links", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateCrmLinkInput.parse(req.body);
    const conn = await loadConn(s.db, a.tenantId, input.connectionId);
    if (!CRM_PROVIDER_OBJECTS[conn.provider as CrmProvider].includes(input.objectType)) throw badRequest("crm_object_type", `${conn.provider} admite: ${CRM_PROVIDER_OBJECTS[conn.provider as CrmProvider].join(", ")}`);
    await assertEnvelopeAccess(s.db, a, input.envelopeId, "manage");
    const id = uuidv7();
    const ins = await s.db.query(
      `INSERT INTO crm_links (id, tenant_id, connection_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (connection_id, envelope_id) DO NOTHING RETURNING id`,
      [id, a.tenantId, conn.id, input.envelopeId, input.objectType, input.objectId],
    );
    if (!ins.length) throw new AppError(409, "crm_link_exists", "El sobre ya está vinculado a un registro de esta conexión");
    // Si el sobre ya está completo, se adjunta ahora.
    const e = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [input.envelopeId]);
    if (e?.status === "completed") {
      await queueRun(s.db, { tenantId: a.tenantId, connectionId: conn.id, mappingId: null, linkId: id, envelopeId: input.envelopeId, kind: "write_back", event: "completed", objectType: input.objectType, objectId: input.objectId }, `crm:wb:${id}:completed`);
    }
    reply.code(201);
    return toLink(await s.db.one(`SELECT * FROM crm_links WHERE id = $1`, [id]));
  });

  app.get<{ Querystring: { envelopeId?: string } }>("/v1/crm/links", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!req.query.envelopeId || !UUID.test(req.query.envelopeId)) throw badRequest("envelope_required", "Indicá envelopeId");
    await assertEnvelopeAccess(s.db, a, req.query.envelopeId, "view");
    const rows = await s.db.query(`SELECT * FROM crm_links WHERE tenant_id = $1 AND envelope_id = $2 ORDER BY created_at`, [a.tenantId, req.query.envelopeId]);
    return { items: rows.map(toLink) };
  });

  app.get<{ Querystring: { connectionId?: string; envelopeId?: string; status?: string; limit?: string } }>("/v1/crm/runs", { preHandler: auth }, async (req) => {
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
    // Leer las ejecuciones no exige settings:manage (access.ts): sin ese permiso, solo las de sobres que uno puede ver
    // (como /v1/crm/links). Si no, cualquier miembro listaba las de toda la organización, con ids y errores del CRM.
    if (!hasPerm(a, "settings:manage")) {
      where += ` AND r.envelope_id IS NOT NULL AND EXISTS (SELECT 1 FROM envelopes e WHERE e.id = r.envelope_id AND e.tenant_id = r.tenant_id${envelopeVisibilitySql(a, params)})`;
    }
    params.push(Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50)));
    const rows = await s.db.query(
      `SELECT r.*, c.name AS connection_name, c.provider FROM crm_runs r LEFT JOIN crm_connections c ON c.id = r.connection_id
        WHERE ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { items: rows.map(toRun) };
  });

  app.post<{ Params: { id: string } }>("/v1/crm/runs/:id/retry", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (!UUID.test(req.params.id)) throw notFound("Ejecución");
    const r = await s.db.one<any>(`SELECT * FROM crm_runs WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!r) throw notFound("Ejecución");
    if (r.status === "succeeded") throw new AppError(409, "already_succeeded", "Ya se completó");
    if (r.kind === "test") throw new AppError(409, "not_retryable", "Esta ejecución no se reintenta");
    if (r.kind === "send" && !r.detail?.webhook) {
      throw new AppError(409, "not_retryable", "Un envío manual se vuelve a hacer desde el registro (POST /v1/crm/mappings/:id/send)");
    }
    await s.db.query(`UPDATE crm_runs SET status = 'pending', error = NULL, updated_at = now() WHERE id = $1`, [r.id]);
    await enqueue(s.db, "platform", { kind: "crm", runId: r.id }, { dedupeKey: `crmjob:${r.id}:${Date.now()}` });
    reply.code(202);
    return { queued: true };
  });

  // ───────── Webhook de HubSpot (público, firmado) ─────────

  await app.register(async (o) => {
    o.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    o.post("/v1/integrations/crm/hubspot/webhook", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const secret = process.env.HUBSPOT_CLIENT_SECRET;
      if (!secret) return reply.code(503).send({ error: { code: "not_configured", message: "HubSpot no está configurado" } });
      const raw = String(req.body ?? "");
      const ts = String(req.headers["x-hubspot-request-timestamp"] ?? "");
      const sig = String(req.headers["x-hubspot-signature-v3"] ?? "");
      const age = Math.abs(Date.now() - Number(ts));
      const expected = hubspotSignatureV3(secret, "POST", `${config.appUrl}${req.url}`, raw, ts);
      // Largo en bytes (no en caracteres): con caracteres multibyte timingSafeEqual lanzaba y respondía 500.
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      const ok = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
      if (!ts || !Number.isFinite(age) || age > 5 * 60_000 || !ok) return reply.code(401).send({ error: { code: "invalid_signature", message: "Firma inválida" } });
      let events: any[];
      try {
        events = JSON.parse(raw);
        if (!Array.isArray(events)) throw new Error("no es una lista");
      } catch {
        return reply.code(400).send({ error: { code: "invalid_json", message: "JSON inválido" } });
      }
      let queued = 0;
      for (const ev of events.slice(0, 200)) {
        if (!String(ev.subscriptionType ?? "").startsWith("deal.")) continue;
        const conns = await s.db.query<any>(`SELECT * FROM crm_connections WHERE provider = 'hubspot' AND active AND config->>'portalId' = $1`, [String(ev.portalId ?? "")]);
        for (const c of conns) {
          const maps = await s.db.query<any>(`SELECT * FROM crm_mappings WHERE connection_id = $1 AND active AND trigger = 'webhook' AND object_type = 'deal'`, [c.id]);
          for (const m of maps) {
            if (!webhookMatches(m.trigger_config ?? {}, ev.propertyName ?? null, ev.propertyValue != null ? String(ev.propertyValue) : null)) continue;
            await queueRun(
              s.db,
              { tenantId: c.tenant_id, connectionId: c.id, mappingId: m.id, linkId: null, envelopeId: null, kind: "send", event: "webhook", objectType: "deal", objectId: String(ev.objectId), detail: { webhook: true, eventId: ev.eventId ?? null } },
              `crm:hs:${ev.eventId ?? sha256Hex(JSON.stringify(ev))}:${m.id}`,
            );
            queued++;
          }
        }
      }
      return { ok: true, queued };
    });
  });
}
