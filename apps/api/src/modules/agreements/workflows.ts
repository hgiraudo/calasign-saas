// Workflows sin código (tipo "Maestro", acotado): lista ordenada de pasos — recolectar datos, aprobación
// interna, generar documento, enviar a firmar, esperar la firma, llamar a un servicio, actualizar el repositorio.
//
// Ejecución: cada paso se "reclama" en una transacción corta, el efecto (render, HTTP) corre fuera de
// transacción y el resultado se registra en otra transacción corta. Así nunca se bloquea la base durante
// una llamada externa, y dos workers no ejecutan el mismo paso.
import { envelopeBaseUrl } from "../white-label/brand";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApprovalDecisionInput,
  StartWorkflowInput,
  SubmitCollectInput,
  UpdateWorkflowInput,
  WorkflowInput,
  type CollectField,
  type PublicWorkflowRun,
  type PublicWorkflowStart,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import { enqueue } from "../../infra/queue";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { BUMP_UPDATED_AT, decrypt, encrypt, hmacSign, iso, queryList, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { rateLimitIpKey } from "../../lib/ip";
import { hasPerm, requirePerm } from "../access";
import { auditFromRequest } from "../audit";
import { authenticate, clientInfo, type AuthContext, type Services } from "../context";
import { deleteBlobsQuietly, deleteFilesIfUnused } from "../file-cleanup";
import { requireFeature, tenantPlan } from "../billing/plans";
import { MIN_FILL_MS, publicStartsCapReached, publicTenantCapReached } from "../public-intake";
import { captchaSiteKey, verifyTurnstile } from "../webforms";
import { isPlatformHost, tenantForHost } from "../custom-domains";
import { enqueueWorkflowApprovalNotice } from "./notices";
import { ownerCanStillCreate } from "../owner-check";
import { tenantBaseUrl } from "../custom-domains";
import { assertPublicDestination, safeRequest, signPayload } from "../webhooks";
import { getPath, interpolate, interpolateValue, refreshSearchVector, setPath, toIsoDate, toNumberOrNull, type Deps } from "./common";
import { agreementMetaFromMapping, createEnvelopeFromPdf, insertFileRow, renderDocument, storeGeneratedPdf } from "./documents";
import { ingestEnvelope } from "./repository";

const MAX_STEP_ATTEMPTS = 3;
const STALE_CLAIM_MS = 10 * 60_000;

/** Error definitivo: el paso falla sin reintentos (datos faltantes, plantilla inexistente, etc.). */
class StepFailure extends Error {}
/** Error transitorio: se reintenta con backoff. */
export class RetryableStepError extends Error {}

interface RunContext {
  data: Record<string, unknown>;
  documents: Record<string, any>;
  envelopes: Record<string, any>;
  http: Record<string, unknown>;
  waitingEnvelope?: string | null;
  /** Rutas de los datos que el formulario público completó con un correo. */
  collectEmailPaths?: string[];
  /** Los PDFs generados ya se borraron (run terminado sin usarlos): no se puede reintentar un envío con ellos. */
  documentsCleaned?: boolean;
  /** Por ruta de correo del formulario público: desde dónde se completó (va a la evidencia de recipient.self_registered). */
  collectEmailSources?: Record<string, { ip: string | null; userAgent: string | null }>;
  /**
   * Por id de sobre: los correos de sus firmantes autoservicio, fijados al enviarlo (con los datos de ese momento).
   * La página pública ofrece el link solo a esos: no depende de la clave del sobre (dos pasos con la misma clave) ni
   * de un formulario completado después del envío.
   */
  selfServiceSigners?: Record<string, string[]>;
}

const MAX_PUBLIC_RUNS_PER_HOUR = 60;
/** Un run esperando un formulario sin actividad durante este tiempo se cancela (barrido). */
export const COLLECT_IDLE_DAYS = 7;
/** Un run fallado sin actividad durante este tiempo pierde sus PDFs generados que no usó ningún sobre. */
const FAILED_DOCS_RETENTION_DAYS = 30;
/** Correo de un destinatario que es exactamente una variable ({{cliente.email}}). */
const SELF_SERVICE_EMAIL = /^\s*\{\{\s*([A-Za-z_@][\w.@]*)\s*\}\}\s*$/;

type StepResult =
  | {
      kind: "complete";
      output: Record<string, unknown>;
      patch?: (c: RunContext) => void;
      tx?: (t: Db, c: RunContext) => Promise<Record<string, unknown> | void>;
      /** Archivos ya subidos que registra `tx`: se borran si el resultado no se confirma. */
      blobKeys?: string[];
    }
  | { kind: "wait"; output?: Record<string, unknown>; patch?: (c: RunContext) => void; approvalNotice?: boolean }
  | { kind: "fail"; error: string; runStatus: "failed" | "rejected" };

// ───────────────────────────── Mapeo ─────────────────────────────

async function toWorkflow(db: Db, r: any, withSecret: boolean): Promise<Workflow & { signingSecret?: string }> {
  const counts = await db.one<any>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('running','waiting'))::int AS running FROM workflow_runs WHERE workflow_id = $1`,
    [r.id],
  );
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    active: r.active,
    publicStart: r.public_start,
    publicUrl: r.public_start && r.public_slug ? `${await tenantBaseUrl(db, r.tenant_id)}/wf/${r.public_slug}` : null,
    // Los encabezados de las llamadas a servicios suelen llevar credenciales (Authorization, API keys): como el secreto
    // de firma, solo los ve quien administra los workflows.
    steps: withSecret ? r.steps : redactStepSecrets(r.steps),
    runs: { total: counts?.total ?? 0, running: counts?.running ?? 0 },
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    ...(withSecret ? { signingSecret: decrypt(r.signing_secret_enc) } : {}),
  };
}

function startedByMe(a: AuthContext, r: any) {
  return (a.userId != null && r.started_by === a.userId) || (a.apiKeyId != null && r.started_by_api_key === a.apiKeyId);
}

/**
 * ¿Ve los datos de la ejecución (context, salidas de los pasos, sobres generados, link de recolección)? Quien la inició,
 * quien tiene que aprobar un paso (necesita los datos para decidir) y quien ve todos los sobres. Quien solo administra
 * plantillas (templates:manage) la ve para cancelarla o reintentarla, pero no los datos que cargó otra persona o el
 * formulario público, ni los links a sus sobres.
 */
export function seesRunData(a: AuthContext, r: { started_by?: string | null; started_by_api_key?: string | null; steps: WorkflowStep[] }) {
  if (startedByMe(a, r)) return true;
  if (hasPerm(a, "envelopes:view_all") || hasPerm(a, "envelopes:manage_all")) return true;
  return a.userId != null && r.steps.some((st) => st.type === "approval" && st.config.approverUserId === a.userId);
}

/** Error de un paso HTTP sin el cuerpo de la respuesta ni el detalle de la conexión (vista redactada). */
export function redactedHttpError(error: string | null | undefined): string | null {
  if (!error) return error ?? null;
  const m = /HTTP (\d{3})\b/.exec(error);
  if (m) return `El servicio respondió HTTP ${m[1]}`;
  if (error.startsWith("No se pudo conectar")) return "No se pudo conectar";
  return "La llamada HTTP falló";
}

async function toRun(db: Db, r: any, a?: AuthContext): Promise<WorkflowRun> {
  const wf = await db.one<any>(`SELECT name FROM workflows WHERE id = $1`, [r.workflow_id]);
  const steps = await db.query<any>(`SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY idx`, [r.id]);
  const defs: WorkflowStep[] = r.steps;
  const base = await tenantBaseUrl(db, r.tenant_id);
  const hasCollect = defs.some((x) => x.type === "collect_data");
  const redacted = Boolean(a && !seesRunData(a, r));
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: wf?.name ?? "",
    status: r.status,
    currentStep: r.current_step,
    context: redacted
      ? { data: {}, documents: {}, envelopes: {}, http: {} }
      : { data: r.context.data ?? {}, documents: summarizeDocs(r.context.documents ?? {}), envelopes: r.context.envelopes ?? {}, http: r.context.http ?? {} },
    steps: steps.map((st) => {
      const def = defs[st.idx];
      return {
        index: st.idx,
        stepId: st.step_id,
        type: st.type,
        name: st.name,
        status: st.status,
        attempts: st.attempts,
        // Salidas (respuestas HTTP, valores recolectados, id del sobre generado): con los datos de la ejecución.
        output: redacted ? null : st.output,
        // El error de un paso HTTP lleva el cuerpo de la respuesta externa (o el detalle de la conexión): redactado,
        // solo el código HTTP.
        error: redacted && st.type === "http_request" ? redactedHttpError(st.error) : st.error,
        startedAt: iso(st.started_at),
        finishedAt: iso(st.finished_at),
        ...(def?.type === "approval" && st.status === "waiting" && a ? { canDecide: canDecide(a, def) } : {}),
      };
    }),
    startedBy: r.started_by_label,
    // El enlace público lleva al formulario y, después, al link de firma de quien lo completa: solo para quien puede
    // administrar el run (como cancelar o reintentar), no para el aprobador ni quien solo puede ver.
    collectUrl: a && !redacted && (startedByMe(a, r) || hasPerm(a, "templates:manage")) && hasCollect && r.public_token_enc && ["running", "waiting"].includes(r.status) ? `${base}/w/${decrypt(r.public_token_enc)}` : null,
    // Cancelar y reintentar: quien lo inició o quien administra plantillas (lo mismo que exige la API).
    canManage: Boolean(a && (startedByMe(a, r) || hasPerm(a, "templates:manage"))),
    ...(redacted ? { redacted: true } : {}),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const MASKED_HEADER = "••••••";

function redactStepSecrets(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((st) =>
    st.type === "http_request" && st.config.headers
      ? { ...st, config: { ...st.config, headers: Object.fromEntries(Object.keys(st.config.headers).map((k) => [k, MASKED_HEADER])) } }
      : st,
  );
}

/**
 * Un encabezado que vuelve enmascarado (pasos leídos del listado, que siempre enmascara) conserva el valor guardado del
 * mismo paso: si no, guardar esos pasos reemplazaba la credencial por "••••••" y las llamadas empezaban a fallar.
 */
function restoreMaskedHeaders(steps: WorkflowStep[], prev: WorkflowStep[]): WorkflowStep[] {
  const prevById = new Map(prev.map((st) => [st.id, st]));
  return steps.map((st) => {
    if (st.type !== "http_request" || !st.config.headers) return st;
    const old = prevById.get(st.id);
    const oldHeaders = old?.type === "http_request" ? old.config.headers ?? {} : {};
    const headers = Object.fromEntries(
      Object.entries(st.config.headers).map(([k, v]) => [k, v === MASKED_HEADER && Object.prototype.hasOwnProperty.call(oldHeaders, k) ? oldHeaders[k] : v]),
    );
    return { ...st, config: { ...st.config, headers } };
  });
}

function summarizeDocs(docs: Record<string, any>) {
  return Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, { fileId: v.fileId, sha256: v.sha256, pages: v.info?.pageCount ?? null, name: v.name }]));
}

function canDecide(a: AuthContext, def: Extract<WorkflowStep, { type: "approval" }>) {
  return a.userId === def.config.approverUserId || hasPerm(a, "envelopes:manage_all");
}

// ───────────────────────────── Motor ─────────────────────────────

/** Ejecuta pasos hasta que el run espera, termina o falla. Lanza RetryableStepError si hay que reintentar. */
export async function advanceRun(d: Deps, runId: string): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const claim = await d.db.tx(async (t) => {
      const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [runId]);
      if (!run || run.status !== "running") return null;
      const steps: WorkflowStep[] = run.steps;
      if (run.current_step >= steps.length) {
        await t.query(`UPDATE workflow_runs SET status = 'completed', updated_at = now() WHERE id = $1`, [runId]);
        return { done: true as const, completed: true };
      }
      const st = await t.one<any>(`SELECT * FROM workflow_run_steps WHERE run_id = $1 AND idx = $2`, [runId, run.current_step]);
      if (st.status === "running" && st.started_at && Date.now() - new Date(st.started_at).getTime() < STALE_CLAIM_MS) return null;
      const upd = await t.one<any>(
        `UPDATE workflow_run_steps SET status = 'running', attempts = attempts + 1, started_at = now(), error = NULL WHERE run_id = $1 AND idx = $2 RETURNING attempts`,
        [runId, run.current_step],
      );
      await t.query(`UPDATE workflow_runs SET version = version + 1, updated_at = now() WHERE id = $1`, [runId]);
      return { done: false as const, completed: false, run, step: steps[run.current_step], index: run.current_step as number, attempts: upd.attempts as number };
    });
    if (!claim) return;
    if (claim.done) {
      // Terminó: los PDFs generados que no salieron en un sobre ya no los usa nadie.
      if (claim.completed) await cleanupRunDocuments(d, runId);
      return;
    }

    // Error del paso (al ejecutarlo o al confirmar su resultado): falla definitiva o reintento. Sin registrarlo, el paso
    // quedaba 'running' y el run trabado para siempre (p. ej. un sobre que no se pudo crear por el límite del plan).
    const stepFailed = async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const final = err instanceof StepFailure || claim.attempts >= MAX_STEP_ATTEMPTS;
      await d.db.tx(async (t) => {
        const run = await t.one<any>(`SELECT status, current_step FROM workflow_runs WHERE id = $1 FOR UPDATE`, [runId]);
        if (run?.status !== "running" || run.current_step !== claim.index) return;
        if (final) {
          await t.query(`UPDATE workflow_run_steps SET status = 'failed', error = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [runId, claim.index, message.slice(0, 2000)]);
          await t.query(`UPDATE workflow_runs SET status = 'failed', updated_at = now() WHERE id = $1`, [runId]);
        } else {
          await t.query(`UPDATE workflow_run_steps SET status = 'pending', error = $3 WHERE run_id = $1 AND idx = $2`, [runId, claim.index, message.slice(0, 2000)]);
        }
      });
      d.log.warn({ runId, step: claim.index, attempts: claim.attempts, final, err: message }, "paso de workflow con error");
      if (!final) throw new RetryableStepError(message);
    };

    let result: StepResult;
    try {
      result = await executeStep(d, claim.run, claim.step, claim.index);
    } catch (err) {
      await stepFailed(err);
      return;
    }

    let continueLoop = false;
    let committed = false;
    let ended = false;
    try {
      await d.db.tx(async (t) => {
        const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [runId]);
        if (!run || run.status !== "running" || run.current_step !== claim.index) return; // cancelado mientras tanto
        committed = true;
        const ctx: RunContext = run.context;
        if (result.kind === "fail") {
          await t.query(`UPDATE workflow_run_steps SET status = 'failed', error = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [runId, claim.index, result.error]);
          await t.query(`UPDATE workflow_runs SET status = $2, updated_at = now() WHERE id = $1`, [runId, result.runStatus]);
          ended = true;
          return;
        }
        result.patch?.(ctx);
        let output = result.output ?? {};
        if (result.kind === "complete") {
          if (result.tx) output = { ...output, ...((await result.tx(t, ctx)) ?? {}) };
          await t.query(`UPDATE workflow_run_steps SET status = 'completed', output = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [
            runId,
            claim.index,
            JSON.stringify(output),
          ]);
          await t.query(`UPDATE workflow_runs SET context = $2, current_step = current_step + 1, updated_at = now() WHERE id = $1`, [runId, JSON.stringify(ctx)]);
          continueLoop = true;
          return;
        }
        // Espera
        await t.query(`UPDATE workflow_run_steps SET status = 'waiting', output = $3 WHERE run_id = $1 AND idx = $2`, [runId, claim.index, JSON.stringify(output)]);
        await t.query(`UPDATE workflow_runs SET context = $2, status = 'waiting', updated_at = now() WHERE id = $1`, [runId, JSON.stringify(ctx)]);
        // Aviso a quien aprueba: por la cola, en esta misma transacción (outbox), con marca, idioma, supresiones y
        // reintentos (notices.ts). Antes salía con deliver() directo después de confirmar y un error se perdía.
        if (result.approvalNotice) await enqueueWorkflowApprovalNotice(t, runId, claim.index, claim.attempts);
        // Esperando un sobre que ya terminó (el evento llegó antes): se resuelve en el acto. FOR SHARE: si el sobre
        // termina en paralelo, su transacción (que lo bloquea antes de registrar el evento) y esta se ordenan; sin el
        // lock, esta leía el estado anterior y el evento todavía no veía el run en 'waiting', y el run quedaba esperando
        // para siempre.
        if (ctx.waitingEnvelope) {
          const env = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR SHARE`, [ctx.waitingEnvelope]);
          if (env && ["completed", "declined", "voided", "expired"].includes(env.status)) {
            await resolveEnvelopeWait(t, runId, ctx.waitingEnvelope, env.status);
            continueLoop = env.status === "completed";
            ended = env.status !== "completed";
          }
        }
      });
    } catch (err) {
      if (result.kind === "complete" && result.blobKeys?.length) await deleteBlobsQuietly(d.blobs, result.blobKeys);
      await stepFailed(err);
      return;
    }
    // Run cancelado (o el paso ya no era el actual) antes de confirmar: los archivos que subió el paso no los referencia nada.
    if (!committed && result.kind === "complete" && result.blobKeys?.length) await deleteBlobsQuietly(d.blobs, result.blobKeys);
    if (ended) await cleanupRunDocuments(d, runId);
    if (!continueLoop) return;
  }
}

/** Resuelve la espera de un run por un sobre (dentro de una transacción con el run bloqueado). */
async function resolveEnvelopeWait(t: Db, runId: string, envelopeId: string, status: string) {
  const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1`, [runId]);
  if (!run || run.status !== "waiting" || run.context?.waitingEnvelope !== envelopeId) return false;
  const ctx: RunContext = run.context;
  ctx.waitingEnvelope = null;
  if (status === "completed") {
    await t.query(`UPDATE workflow_run_steps SET status = 'completed', output = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [
      runId,
      run.current_step,
      JSON.stringify({ envelopeId, status }),
    ]);
    await t.query(`UPDATE workflow_runs SET status = 'running', context = $2, current_step = current_step + 1, updated_at = now() WHERE id = $1`, [
      runId,
      JSON.stringify(ctx),
    ]);
  } else {
    await t.query(`UPDATE workflow_run_steps SET status = 'failed', error = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [
      runId,
      run.current_step,
      `El sobre terminó como "${status}"`,
    ]);
    await t.query(`UPDATE workflow_runs SET status = 'failed', context = $2, updated_at = now() WHERE id = $1`, [runId, JSON.stringify(ctx)]);
  }
  return true;
}

/**
 * Anula los sobres del run que siguen en curso (al cancelarlo o cuando un aprobador lo rechaza). También los que ya no
 * figuran en el contexto: dos pasos con la misma clave de sobre dejan solo el último.
 */
async function voidRunEnvelopes(t: Db, run: any, actor: Actor, reason: string) {
  const envIds = new Set(Object.values((run.context?.envelopes ?? {}) as Record<string, { envelopeId: string }>).map((e) => e.envelopeId));
  for (const x of await t.query<any>(`SELECT id FROM envelopes WHERE tenant_id = $1 AND metadata->>'workflowRunId' = $2`, [run.tenant_id, run.id])) envIds.add(x.id);
  for (const envelopeId of envIds) {
    const env = await t.one<any>(`SELECT id, tenant_id, status FROM envelopes WHERE id = $1 FOR UPDATE`, [envelopeId]);
    if (env?.status !== "sent" && env?.status !== "awaiting_certificates") continue;
    await t.query(`UPDATE envelopes SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [env.id, reason]);
    await appendEvent(t, { tenantId: env.tenant_id, envelopeId: env.id, type: "envelope.voided", actor, data: { reason, workflowRunId: run.id } });
    const notified = await t.query<any>(
      `SELECT r.id FROM recipients r WHERE r.envelope_id = $1 AND (r.status IN ('sent','viewed')
         OR EXISTS (SELECT 1 FROM certificate_signatures c WHERE c.recipient_id = r.id AND c.status = 'pending'))`,
      [env.id],
    );
    for (const r of notified) await enqueue(t, "notify", { kind: "voided", envelopeId: env.id, recipientId: r.id, tenantId: env.tenant_id });
  }
}

/** Ids de archivo de los PDFs que generó un run (contexto). */
function runDocumentFileIds(ctx: RunContext | null | undefined): string[] {
  return Object.values((ctx?.documents ?? {}) as Record<string, { fileId?: string }>)
    .map((x) => x?.fileId)
    .filter((x): x is string => typeof x === "string");
}

/**
 * Run terminado sin más uso de sus PDFs generados (completado, cancelado, rechazado, vencido o con la espera de un sobre
 * fallida): se borran los que no usa ningún sobre (deleteFileIfUnused conserva los que referencia un documento por la
 * clave foránea). Fuera de transacción. Un run fallado reintentable no pasa por acá (el reintento los necesita): lo
 * cubre el barrido de runs fallados viejos.
 */
export async function cleanupRunDocuments(d: Deps, runId: string) {
  try {
    const run = await d.db.one<any>(`SELECT status, context FROM workflow_runs WHERE id = $1`, [runId]);
    if (!run || ["running", "waiting"].includes(run.status)) return;
    const ids = runDocumentFileIds(run.context);
    if (!ids.length || run.context?.documentsCleaned) return;
    // La marca va antes (un reintento del run la ve y no usa documentos que se están borrando). Un borrado que falla en
    // el almacenamiento no se pierde: deleteFileIfUnused conserva la fila y lo anota en pending_file_deletions, que el
    // barrido reintenta.
    await d.db.query(`UPDATE workflow_runs SET context = context || '{"documentsCleaned": true}'::jsonb WHERE id = $1 AND status NOT IN ('running','waiting')`, [runId]);
    await deleteFilesIfUnused(d.db, d.blobs, ids);
  } catch (err) {
    d.log.warn({ runId, err: String(err) }, "no se pudieron borrar los documentos generados del run");
  }
}

/**
 * Cancela runs (dentro de una transacción): pasos pendientes cancelados y sobres en curso anulados. `reason` va al paso
 * actual (p. ej. vencido sin completar). Devuelve los ids cancelados (para borrar después sus documentos).
 */
async function cancelRunsTx(t: Db, runIds: string[], actor: Actor, reason: string): Promise<string[]> {
  const done: string[] = [];
  for (const id of runIds) {
    const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [id]);
    if (!run || !["running", "waiting"].includes(run.status)) continue;
    await t.query(`UPDATE workflow_runs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await t.query(`UPDATE workflow_run_steps SET status = 'cancelled', error = $3, finished_at = now() WHERE run_id = $1 AND idx = $2 AND status IN ('pending','running','waiting')`, [
      id,
      run.current_step,
      reason,
    ]);
    await t.query(`UPDATE workflow_run_steps SET status = 'cancelled', finished_at = now() WHERE run_id = $1 AND status IN ('pending','running','waiting')`, [id]);
    await voidRunEnvelopes(t, run, actor, reason);
    done.push(id);
  }
  return done;
}

/** SQL: el run espera un paso de recolección de datos (formulario). */
const WAITING_COLLECT_SQL = `r.status = 'waiting' AND r.steps -> r.current_step ->> 'type' = 'collect_data'`;
/** SQL: run iniciado por el link público (como isPublicRun). */
const PUBLIC_RUN_SQL = `r.started_by IS NULL AND r.started_by_api_key IS NULL`;

/**
 * Barrido: runs del link PÚBLICO esperando un formulario sin actividad hace COLLECT_IDLE_DAYS días se cancelan (antes
 * quedaban esperando para siempre y bloqueaban borrar el workflow), y los PDFs de runs fallados sin actividad hace
 * FAILED_DOCS_RETENTION_DAYS días se borran. Los runs iniciados por una persona o una API key no vencen solos (ni se
 * anulan sus sobres): los cancela quien los inició.
 */
export async function workflowRunsSweep(d: Deps) {
  const idle = await d.db.query<{ id: string }>(
    `SELECT r.id FROM workflow_runs r WHERE ${WAITING_COLLECT_SQL} AND ${PUBLIC_RUN_SQL} AND r.updated_at < now() - make_interval(days => $1) ORDER BY r.updated_at LIMIT 100`,
    [COLLECT_IDLE_DAYS],
  );
  const actor: Actor = { type: "system", label: "Workflow: vencido sin completar" };
  for (const r of idle) {
    try {
      const cancelled = await d.db.tx(async (t) => {
        const cur = await t.one<any>(`SELECT r.id FROM workflow_runs r WHERE r.id = $1 AND ${WAITING_COLLECT_SQL} AND ${PUBLIC_RUN_SQL} AND r.updated_at < now() - make_interval(days => $2) FOR UPDATE`, [
          r.id,
          COLLECT_IDLE_DAYS,
        ]);
        if (!cur) return [];
        return cancelRunsTx(t, [r.id], actor, `Venció: ${COLLECT_IDLE_DAYS} días sin completar el formulario`);
      });
      for (const id of cancelled) await cleanupRunDocuments(d, id);
    } catch (err) {
      d.log.error({ runId: r.id, err: String(err) }, "no se pudo vencer el run");
    }
  }
  const failed = await d.db.query<{ id: string; context: RunContext }>(
    `SELECT id, context FROM workflow_runs WHERE status = 'failed' AND updated_at < now() - make_interval(days => $1)
       AND context -> 'documents' <> '{}'::jsonb AND NOT COALESCE((context ->> 'documentsCleaned')::boolean, false) LIMIT 100`,
    [FAILED_DOCS_RETENTION_DAYS],
  );
  for (const r of failed) {
    const upd = await d.db.query(
      `UPDATE workflow_runs SET context = context || '{"documentsCleaned": true}'::jsonb WHERE id = $1 AND status = 'failed' AND updated_at < now() - make_interval(days => $2) RETURNING id`,
      [r.id, FAILED_DOCS_RETENTION_DAYS],
    );
    if (upd.length) await deleteFilesIfUnused(d.db, d.blobs, runDocumentFileIds(r.context));
  }
  return { expired: idle.length, cleaned: failed.length };
}

/** Evento de un sobre (completado, rechazado, anulado, vencido): destraba los runs que lo esperan. */
export async function onEnvelopeEventForWorkflows(d: Deps, envelopeId: string) {
  const env = await d.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envelopeId]);
  if (!env || !["completed", "declined", "voided", "expired"].includes(env.status)) return;
  const runs = await d.db.query<any>(`SELECT id FROM workflow_runs WHERE status = 'waiting' AND context->'waitingEnvelope' = to_jsonb($1::text)`, [envelopeId]);
  for (const r of runs) {
    const failed = await d.db.tx(async (t) => {
      await t.query(`SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE`, [r.id]);
      const resolved = await resolveEnvelopeWait(t, r.id, envelopeId, env.status);
      const resumed = resolved && env.status === "completed";
      // En la misma transacción que lo pasa a "running": si el proceso caía entre las dos, el run quedaba trabado.
      if (resumed) await enqueue(t, "agreements", { kind: "advance", runId: r.id });
      return resolved && !resumed;
    });
    if (failed) await cleanupRunDocuments(d, r.id);
  }
}

async function executeStep(d: Deps, run: any, step: WorkflowStep, index: number): Promise<StepResult> {
  const ctx: RunContext = run.context;
  const data = ctx.data ?? {};
  const wf = await d.db.one<any>(`SELECT name, created_by, created_by_api_key, signing_secret_enc FROM workflows WHERE id = $1`, [run.workflow_id]);
  const tenant = await d.db.one<any>(`SELECT default_locale, name FROM tenants WHERE id = $1`, [run.tenant_id]);
  const locale = tenant?.default_locale ?? "es";
  const actor: Actor = { type: "system", label: `Workflow: ${wf?.name ?? ""}` };

  switch (step.type) {
    case "collect_data":
      return { kind: "wait", output: { title: step.config.title } };

    case "approval": {
      const approver = await d.db.one<any>(
        `SELECT u.id, u.name, u.email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 WHERE u.id = $1`,
        [step.config.approverUserId, run.tenant_id],
      );
      if (!approver) throw new StepFailure("La persona que debe aprobar ya no es miembro de la organización");
      return { kind: "wait", output: { approver: approver.name }, approvalNotice: true };
    }

    case "generate_document": {
      const tpl = await d.db.one<any>(`SELECT * FROM document_templates WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [
        step.config.documentTemplateId,
        run.tenant_id,
      ]);
      if (!tpl) throw new StepFailure("La plantilla de documento no existe o fue archivada");
      const doc = await renderDocument(d.db, run.tenant_id, { source: tpl.source, data, locale: tpl.locale, title: interpolate(tpl.agreement_mapping?.title, data, tpl.locale) || tpl.name }).catch(
        (e) => {
          // Solo los errores de la plantilla o los datos son definitivos; uno de la base (cláusulas, marca) se reintenta.
          if (e instanceof AppError) throw new StepFailure(e.message);
          throw e;
        },
      );
      if (doc.missingClauses.length) throw new StepFailure(`Cláusulas inexistentes: ${doc.missingClauses.join(", ")}`);
      if (doc.missing.length && !step.config.allowMissing) throw new StepFailure(`Faltan datos: ${doc.missing.join(", ")}`);
      const file = await storeGeneratedPdf(d.blobs, run.tenant_id, doc.pdf);
      const entry = {
        ...file,
        marks: doc.marks,
        name: `${tpl.name}.pdf`,
        documentTemplateId: tpl.id,
        agreement: agreementMetaFromMapping(tpl.agreement_mapping, data, tpl.locale),
        locale: tpl.locale,
        // Constancia de la versión de la plantilla y de las cláusulas con que se generó (va a la metadata del sobre).
        provenance: doc.provenance,
        templateRoles: doc.templateRoles,
      };
      return {
        kind: "complete",
        output: { fileId: file.fileId, sha256: file.sha256, pages: file.info.pageCount, missing: doc.missing },
        blobKeys: [file.key],
        tx: async (t) => {
          await insertFileRow(t, run.tenant_id, file);
        },
        patch: (c) => {
          c.documents = { ...(c.documents ?? {}), [step.config.output]: entry };
        },
      };
    }

    case "send_for_signature": {
      if (ctx.documentsCleaned) throw new StepFailure("Los documentos generados de esta ejecución ya se eliminaron: iniciá una nueva ejecución");
      const doc = ctx.documents?.[step.config.document];
      if (!doc) throw new StepFailure(`No hay un documento generado con la clave "${step.config.document}"`);
      const recipients = step.config.recipients.map((r) => {
        const email = interpolate(r.email, data, locale).trim().toLowerCase() || null;
        const phone = interpolate(r.phone, data, locale).replace(/[^\d+]/g, "") || null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StepFailure(`Correo inválido para ${r.role}: ${email}`);
        return {
          role: r.role,
          name: interpolate(r.name, data, locale).trim() || r.role,
          email,
          phone,
          channels: r.channels ?? (email ? ["email" as const] : ["whatsapp" as const]),
          cc: r.cc ?? false,
        };
      });
      // Firmantes autoservicio de este sobre: su correo es exactamente una variable que ya completó el formulario público
      // (no una copia, que no firma). Se fija ahora, con los datos con que sale el sobre.
      const collected = new Set(ctx.collectEmailPaths ?? []);
      // Correo → desde dónde lo escribió quien usó el link público (IP y navegador del formulario).
      const selfSource = new Map<string, { ip: string | null; userAgent: string | null }>();
      const selfService = [
        ...new Set(
          step.config.recipients.flatMap((r, i) => {
            const m = SELF_SERVICE_EMAIL.exec(r.email ?? "");
            const email = recipients[i].email;
            if (!r.cc && m && collected.has(m[1]) && email) {
              const src = ctx.collectEmailSources?.[m[1]];
              if (src && !selfSource.has(email.toLowerCase())) selfSource.set(email.toLowerCase(), src);
              return [email];
            }
            return [];
          }),
        ),
      ];
      const { userId, apiKeyId } = runOwner(run, wf);
      // El sobre sale a nombre de ese dueño: tiene que seguir pudiendo crear sobres (miembro, o key sin revocar, con
      // envelopes:create). Si no, un workflow público seguiría enviando en nombre de alguien que ya dejó la organización.
      const ownerProblem = await ownerCanStillCreate(d.db, { tenantId: run.tenant_id, userId, apiKeyId }, null);
      if (ownerProblem) throw new StepFailure(ownerProblem);
      return {
        kind: "complete",
        output: {},
        tx: async (t, c) => {
          const envelopeId = await createEnvelopeFromPdf(
            t,
            { tenantId: run.tenant_id, userId, apiKeyId, actor },
            {
              file: doc,
              fileName: doc.name ?? "documento.pdf",
              subject: interpolate(step.config.subject, data, locale),
              message: step.config.message ? interpolate(step.config.message, data, locale) : null,
              locale: doc.locale ?? locale,
              recipients,
              marks: doc.marks ?? [],
              templateRoles: doc.templateRoles ?? [],
              metadata: {
                workflowId: run.workflow_id,
                workflowRunId: run.id,
                ...(doc.documentTemplateId ? { documentTemplateId: doc.documentTemplateId } : {}),
                ...(doc.provenance ? { documentProvenance: doc.provenance } : {}),
                ...(doc.agreement ? { agreement: doc.agreement } : {}),
              },
              send: true,
              // Firma condicional ({{#if garante}}{{firma:Garante}}{{/if}}) que no salió: ese firmante no se agrega.
              onSkippedRoles: (roles) => d.log.warn({ runId: run.id, roles }, "workflow: firmantes sin marcas en el documento generado, no se agregaron al sobre"),
            },
          ).catch((e) => {
            if (e instanceof AppError) throw new StepFailure(e.message);
            throw e;
          });
          // Ejecución iniciada desde el link público: el firmante autoservicio (su correo es exactamente un campo de correo
          // del formulario) queda como autorregistrado, como en los formularios web: no recibe invitaciones ni
          // recordatorios hasta validar su correo y ve el link en pantalla. Solo si le toca firmar ya y su correo es único
          // en el sobre (si no, la pantalla no le muestra el link y quedaría sin forma de firmar, o se silenciaría a un
          // firmante fijo de la organización con el mismo correo). El resto se avisa normalmente: el tope de ejecuciones
          // por hora limita el abuso.
          if (!run.started_by && !run.started_by_api_key && selfService.length) {
            const marked = await t.query<{ id: string; name: string; email: string }>(
              `UPDATE recipients r SET self_registered = true
                WHERE r.envelope_id = $1 AND lower(r.email) = ANY($2::text[]) AND r.status IN ('sent','viewed')
                  AND (SELECT count(*) FROM recipients x WHERE x.envelope_id = r.envelope_id AND lower(x.email) = lower(r.email)) = 1
                RETURNING r.id, r.name, r.email`,
              [envelopeId, selfService.map((x) => x.toLowerCase())],
            );
            // Como en los formularios web: la evidencia deja constancia de que el correo lo escribió quien usó el link
            // público (no está verificado).
            for (const m of marked) {
              await appendEvent(t, {
                tenantId: run.tenant_id,
                envelopeId,
                type: "recipient.self_registered",
                actor: {
                  type: "recipient",
                  id: m.id,
                  label: `${m.name} <${m.email}>`,
                  ip: selfSource.get(m.email.toLowerCase())?.ip ?? null,
                  userAgent: selfSource.get(m.email.toLowerCase())?.userAgent ?? null,
                },
                data: { workflowRunId: run.id, workflowId: run.workflow_id ?? null },
              });
            }
          }
          c.envelopes = { ...(c.envelopes ?? {}), [step.config.envelopeKey]: { envelopeId } };
          c.selfServiceSigners = { ...(c.selfServiceSigners ?? {}), [envelopeId]: selfService };
          return { envelopeId };
        },
      };
    }

    case "wait_for_completion": {
      const envId = ctx.envelopes?.[step.config.envelopeKey]?.envelopeId;
      if (!envId) throw new StepFailure(`No hay un sobre con la clave "${step.config.envelopeKey}"`);
      const env = await d.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envId]);
      if (env?.status === "completed") return { kind: "complete", output: { envelopeId: envId, status: "completed" } };
      if (!env || ["declined", "voided", "expired"].includes(env.status)) return { kind: "fail", error: `El sobre terminó como "${env?.status ?? "inexistente"}"`, runStatus: "failed" };
      return { kind: "wait", output: { envelopeId: envId }, patch: (c) => (c.waitingEnvelope = envId) };
    }

    case "http_request": {
      const url = checkOutboundUrl(step.config.url);
      await assertPublicDestination(url).catch((e) => {
        throw new StepFailure(String(e instanceof Error ? e.message : e));
      });
      const body = step.config.bodyTemplate
        ? renderJsonTemplate(step.config.bodyTemplate, { ...data, run: { id: run.id, workflowId: run.workflow_id }, envelopes: ctx.envelopes ?? {} })
        : JSON.stringify({
            event: "workflow.step",
            run: { id: run.id, workflowId: run.workflow_id, workflowName: wf?.name, step: { index, name: step.name } },
            data,
            documents: summarizeDocs(ctx.documents ?? {}),
            envelopes: ctx.envelopes ?? {},
          });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.config.headers ?? {})) {
        if (/^(host|content-length|connection|transfer-encoding)$/i.test(k)) continue;
        headers[k] = interpolate(v, data, locale);
      }
      headers["content-type"] = "application/json";
      headers["user-agent"] = "CalaSign-Workflows/1";
      headers["CalaSign-Signature"] = signPayload(decrypt(wf.signing_secret_enc), body);
      headers["CalaSign-Workflow-Run"] = run.id;
      let res: { status: number; body: Buffer };
      try {
        // safeRequest valida el destino en la misma resolución DNS que usa la conexión y no sigue redirecciones.
        res = await safeRequest(url, { method: step.config.method ?? "POST", headers, body, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
      } catch (e) {
        throw new Error(`No se pudo conectar: ${e instanceof Error ? e.message : String(e)}`);
      }
      const text = res.body.toString("utf8").slice(0, 65_536);
      if (res.status < 200 || res.status >= 300) throw new Error(`El servicio respondió HTTP ${res.status}: ${text.slice(0, 200)}`);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return {
        kind: "complete",
        output: { status: res.status, response: text.slice(0, 500) },
        patch: (c) => {
          if (step.config.saveAs) c.http = { ...(c.http ?? {}), [step.config.saveAs]: parsed ?? text.slice(0, 2000) };
        },
      };
    }

    case "update_repository": {
      const envId = ctx.envelopes?.[step.config.envelopeKey]?.envelopeId;
      if (!envId) throw new StepFailure(`No hay un sobre con la clave "${step.config.envelopeKey}"`);
      const agreementId = await ingestEnvelope(d, envId);
      if (!agreementId) throw new StepFailure("El sobre todavía no está completo: agregá antes un paso «Esperar la firma»");
      const sets: string[] = [];
      const params: unknown[] = [agreementId];
      const set = (col: string, v: unknown, cast = "") => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (step.config.title) set("title", interpolate(step.config.title, data, locale).slice(0, 300) || "Acuerdo");
      // Etiquetas y metadatos se fusionan en SQL con lo que haya al confirmar (no con una lectura previa sin lock): un
      // cambio simultáneo desde la web o desde otro run no se pierde.
      if (step.config.tags?.length) {
        params.push(step.config.tags.map((x) => interpolate(x, data, locale)).filter(Boolean));
        sets.push(
          `tags = ARRAY(SELECT x FROM unnest(COALESCE(tags, ARRAY[]::text[]) || $${params.length}::text[]) WITH ORDINALITY AS u(x, o) GROUP BY x ORDER BY min(o))`,
        );
      }
      if (step.config.expiryDate) {
        const dt = toIsoDate(interpolateValue(step.config.expiryDate, data, locale), locale);
        if (dt) set("expiry_date", dt, "::date");
      }
      if (step.config.value) {
        const n = toNumberOrNull(interpolateValue(step.config.value, data, locale), locale);
        if (n !== null) set("value", n);
      }
      // Solo un código ISO 4217 (tres letras); otra cosa ("$", "pesos", una variable vacía) se descarta.
      if (step.config.currency) {
        const cur = interpolate(step.config.currency, data, locale).trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(cur)) set("currency", cur);
      }
      if (step.config.metadata) {
        const m: Record<string, string> = {};
        for (const [k, v] of Object.entries(step.config.metadata)) m[k] = interpolate(v, data, locale);
        params.push(JSON.stringify(m));
        sets.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${params.length}::jsonb`);
      }
      return {
        kind: "complete",
        output: { agreementId },
        tx: async (t) => {
          if (sets.length) await t.query(`UPDATE agreements SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
          await refreshSearchVector(t, agreementId);
        },
      };
    }
  }
}

/**
 * A nombre de quién salen los sobres de un run: quien lo inició (persona o API key) o, si se inició por el link
 * público, quien creó el workflow (persona o API key).
 */
function runOwner(run: any, wf: any): { userId: string | null; apiKeyId: string | null } {
  if (run.started_by) return { userId: run.started_by, apiKeyId: null };
  if (run.started_by_api_key) return { userId: null, apiKeyId: run.started_by_api_key };
  if (wf?.created_by) return { userId: wf.created_by, apiKeyId: null };
  return { userId: null, apiKeyId: wf?.created_by_api_key ?? null };
}

/** El inicio público de workflows es un link público como los formularios web: exige la misma funcionalidad del plan. */
async function publicPlanAllows(db: Db, tenantId: string): Promise<boolean> {
  return (await tenantPlan(db, tenantId)).plan.features.includes("web_forms");
}

/** Run iniciado por el link público (no por una persona ni una API key). */
const isPublicRun = (run: any) => !run.started_by && !run.started_by_api_key;

/**
 * Si desde el paso `from` algún envío a firmar usa un PDF generado ANTES de `from` (no vuelto a generar en el medio):
 * con los documentos del run ya borrados, ese envío no puede salir.
 */
export function needsGeneratedDocuments(steps: WorkflowStep[], from: number): boolean {
  const regenerated = new Set<string>();
  for (const st of steps.slice(from)) {
    if (st.type === "generate_document") regenerated.add(st.config.output);
    if (st.type === "send_for_signature" && !regenerated.has(st.config.document)) return true;
  }
  return false;
}

/** Un workflow público que envía a firmar no se ofrece si su creador ya no puede crear sobres. */
async function publicOwnerProblem(db: Db, wf: any): Promise<string | null> {
  if (!(wf.steps as WorkflowStep[]).some((st) => st.type === "send_for_signature")) return null;
  return ownerCanStillCreate(db, { tenantId: wf.tenant_id, ...runOwner({}, wf) }, null);
}

function checkOutboundUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StepFailure("URL inválida");
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  const local = config.environment === "local";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localHost && local)) throw new StepFailure("La URL debe ser https");
  if (u.username || u.password) throw new StepFailure("La URL no puede llevar credenciales");
  if (localHost && !local) throw new StepFailure("No se permiten destinos locales");
  return u.toString();
}

/** JSON con {{ruta}}: cada variable se reemplaza por su valor JSON (texto con comillas, números, objetos). */
export function renderJsonTemplate(tpl: string, data: unknown): string {
  const out = tpl.replace(/\{\{\s*([A-Za-z_@][\w.@]*)\s*\}\}/g, (_m, path: string) => JSON.stringify(getPath(data, path) ?? null));
  try {
    return JSON.stringify(JSON.parse(out));
  } catch {
    throw new StepFailure("El cuerpo de la llamada no es un JSON válido una vez completadas las variables");
  }
}

// ───────────────────────────── Altas ─────────────────────────────

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateSteps(steps: WorkflowStep[]) {
  const ids = new Set<string>();
  const outputs = new Set<string>();
  const envKeys = new Set<string>();
  steps.forEach((st, i) => {
    if (ids.has(st.id)) throw badRequest("duplicate_step", `Paso ${i + 1}: id repetido`);
    ids.add(st.id);
    // setPath rechaza estas claves (contaminación de prototipos): un formulario con una de ellas daba 500 en cada envío.
    if (st.type === "collect_data") {
      const bad = [st.config.target, ...st.config.fields.map((f) => f.key)].find((k) => k && RESERVED_KEYS.has(k));
      if (bad) throw badRequest("invalid_step", `Paso ${i + 1}: "${bad}" no se puede usar como clave`);
    }
    if (st.type === "generate_document") outputs.add(st.config.output);
    if (st.type === "send_for_signature") {
      if (!outputs.has(st.config.document)) throw badRequest("invalid_step", `Paso ${i + 1}: no hay un documento "${st.config.document}" generado antes`);
      envKeys.add(st.config.envelopeKey);
    }
    if ((st.type === "wait_for_completion" || st.type === "update_repository") && !envKeys.has(st.config.envelopeKey)) {
      throw badRequest("invalid_step", `Paso ${i + 1}: no hay un sobre "${st.config.envelopeKey}" enviado antes`);
    }
  });
}

async function createRun(
  db: Db,
  wf: any,
  p: { data: Record<string, unknown>; startedBy: string | null; startedByApiKey?: string | null; startedByLabel: string; actor: Actor },
): Promise<{ runId: string; token: string | null }> {
  const steps: WorkflowStep[] = wf.steps;
  const runId = uuidv7();
  const token = steps.some((st) => st.type === "collect_data") ? randomToken() : null;
  await db.tx(async (t) => {
    // Si lo borraron después de cargarlo, 404 (antes: violación de FK, 500).
    const isPublic = !p.startedBy && !p.startedByApiKey;
    const chargesAtStart = isPublic && steps[0]?.type !== "collect_data";
    if (!(await t.one(`SELECT 1 FROM workflows WHERE id = $1 ${isPublic ? "FOR UPDATE" : "FOR KEY SHARE"}`, [wf.id]))) throw notFound("Workflow");
    // Link público: como los formularios web, un tope de ejecuciones por hora (cada una puede mandar sobres y consume
    // la cuota del plan).
    if (isPublic) {
      const recent = await t.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id = $1 AND started_by IS NULL AND started_by_api_key IS NULL AND created_at > now() - interval '1 hour'`,
        [wf.id],
      );
      if ((recent?.n ?? 0) >= MAX_PUBLIC_RUNS_PER_HOUR) throw new AppError(429, "workflow_rate_limited", "Demasiadas ejecuciones de este workflow: probá más tarde");
      // Por organización (con su lock; último lock: workflow → organización, como los formularios): inicios por hora,
      // completen o no el formulario (tope alto), y el cupo compartido con los formularios web, que cuenta solo los
      // runs que hacen trabajo. Un run que empieza con un formulario lo gasta al completarlo (envío del paso); si el
      // primer paso es otro (genera documentos, manda sobres, llama a una URL), arranca solo y lo gasta ahora, aunque
      // tenga un formulario más adelante.
      if (await publicStartsCapReached(t, wf.tenant_id)) throw new AppError(429, "workflow_rate_limited", "Demasiadas ejecuciones de este workflow: probá más tarde");
      if (chargesAtStart && (await publicTenantCapReached(t, wf.tenant_id))) throw new AppError(429, "workflow_rate_limited", "Demasiadas ejecuciones de este workflow: probá más tarde");
    }
    await t.query(
      `INSERT INTO workflow_runs (id, tenant_id, workflow_id, steps, context, started_by, started_by_label, public_token_hash, public_token_enc, started_by_api_key, public_collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        runId,
        wf.tenant_id,
        wf.id,
        JSON.stringify(steps),
        JSON.stringify({ data: p.data, documents: {}, envelopes: {}, http: {} }),
        p.startedBy,
        p.startedByLabel,
        token ? sha256Hex(token) : null,
        token ? encrypt(token) : null,
        p.startedByApiKey ?? null,
        chargesAtStart ? new Date() : null,
      ],
    );
    for (const [idx, st] of steps.entries()) {
      await t.query(`INSERT INTO workflow_run_steps (run_id, idx, step_id, type, name) VALUES ($1,$2,$3,$4,$5)`, [runId, idx, st.id, st.type, st.name]);
    }
  });
  return { runId, token };
}

/** Avance en línea (para devolver el estado actualizado); si un paso pide reintento, queda encolado. */
async function advanceNow(d: Deps, runId: string) {
  try {
    await advanceRun(d, runId);
  } catch (err) {
    if (err instanceof RetryableStepError) await enqueue(d.db, "agreements", { kind: "advance", runId }, { runAt: new Date(Date.now() + 10_000) });
    else throw err;
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function workflowRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  const deps: Deps = { db: s.db, blobs: s.blobs, log: app.log };

  async function loadWorkflow(a: AuthContext, id: string) {
    const r = await s.db.one<any>(`SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2`, [id, a.tenantId]);
    if (!r) throw notFound("Workflow");
    return r;
  }

  /**
   * Quién inició la ejecución: la persona (sesión) o la API key. Las iniciadas por el link público no son de nadie.
   * Se compara solo con un id presente: una API key no tiene usuario y un run público no tiene started_by, y
   * `null === null` hacía que cualquier API key viera, cancelara o reintentara esas ejecuciones.
   */
  async function loadRun(a: AuthContext, id: string) {
    const r = await s.db.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 AND tenant_id = $2`, [id, a.tenantId]);
    if (!r) throw notFound("Ejecución");
    const mine =
      startedByMe(a, r) || (a.userId != null && (r.steps as WorkflowStep[]).some((st) => st.type === "approval" && st.config.approverUserId === a.userId));
    // envelopes:manage_all también: canDecide le permite decidir cualquier aprobación, y sin verla no podía.
    if (!mine && !hasPerm(a, "templates:manage") && !hasPerm(a, "envelopes:view_all") && !hasPerm(a, "envelopes:manage_all")) throw notFound("Ejecución");
    return r;
  }

  async function checkApprovers(tenantId: string, steps: WorkflowStep[]) {
    for (const st of steps) {
      if (st.type !== "approval") continue;
      const m = await s.db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, st.config.approverUserId]);
      if (!m) throw badRequest("invalid_approver", `Paso "${st.name}": la persona que aprueba no es miembro de la organización`);
    }
    for (const st of steps) {
      if (st.type !== "generate_document") continue;
      const t = await s.db.one(`SELECT 1 FROM document_templates WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [st.config.documentTemplateId, tenantId]);
      if (!t) throw badRequest("invalid_template", `Paso "${st.name}": la plantilla de documento no existe`);
    }
  }

  app.get("/v1/workflows", { preHandler: auth }, async (req) => {
    const a = A(req);
    const rows = await s.db.query(`SELECT * FROM workflows WHERE tenant_id = $1 ORDER BY updated_at DESC`, [a.tenantId]);
    return { items: await Promise.all(rows.map((r) => toWorkflow(s.db, r, false))) };
  });

  app.post("/v1/workflows", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const input = WorkflowInput.parse(req.body);
    if (input.publicStart) requireFeature((await tenantPlan(s.db, a.tenantId)).plan, "web_forms", "El inicio público de workflows");
    validateSteps(input.steps as WorkflowStep[]);
    await checkApprovers(a.tenantId, input.steps as WorkflowStep[]);
    const row = await s.db.one(
      `INSERT INTO workflows (id, tenant_id, name, description, active, public_start, public_slug, steps, signing_secret_enc, created_by, created_by_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        uuidv7(),
        a.tenantId,
        input.name,
        input.description ?? null,
        input.active ?? true,
        input.publicStart ?? false,
        input.publicStart ? randomBytes(9).toString("base64url") : null,
        JSON.stringify(input.steps),
        encrypt(`wfsec_${randomToken(24)}`),
        a.userId,
        a.userId ? null : a.apiKeyId,
      ],
    );
    await auditFromRequest(s.db, req, a, "workflow.created", { targetType: "workflow", targetId: (row as any).id, data: { name: input.name } });
    reply.code(201);
    return toWorkflow(s.db, row, true);
  });

  app.get<{ Params: { id: string } }>("/v1/workflows/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    return toWorkflow(s.db, await loadWorkflow(a, req.params.id), hasPerm(a, "templates:manage"));
  });

  app.patch<{ Params: { id: string } }>("/v1/workflows/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const cur = await loadWorkflow(a, req.params.id);
    const input = UpdateWorkflowInput.parse(req.body);
    const steps = input.steps ? restoreMaskedHeaders(input.steps as WorkflowStep[], cur.steps as WorkflowStep[]) : (cur.steps as WorkflowStep[]);
    validateSteps(steps);
    if (input.steps) await checkApprovers(a.tenantId, steps);
    const publicStart = input.publicStart ?? cur.public_start;
    const active = input.active ?? cur.active;
    // Publicar o activar un link público exige el plan (como los formularios web). Solo al pasar de false a true: tras
    // una baja de plan, editar el nombre o los pasos de un workflow que ya estaba publicado no se bloquea (el link
    // igual no se ofrece sin el plan), y despublicarlo o desactivarlo tampoco.
    if (publicStart && active && (!cur.public_start || !cur.active)) requireFeature((await tenantPlan(s.db, a.tenantId)).plan, "web_forms", "El inicio público de workflows");
    const actor = a.actor;
    const { row, cancelled } = await s.db.tx(async (t) => {
      const row = await t.one<any>(
        `UPDATE workflows SET name = $2, description = $3, active = $4, public_start = $5, public_slug = $6, steps = $7, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          cur.id,
          input.name ?? cur.name,
          input.description !== undefined ? input.description : cur.description,
          active,
          publicStart,
          publicStart ? cur.public_slug ?? randomBytes(9).toString("base64url") : cur.public_slug,
          JSON.stringify(steps),
        ],
      );
      // Desactivado o despublicado: las ejecuciones del link público que esperan su formulario se cancelan (si no,
      // quien tiene el link seguía pudiendo completarlo y mandar sobres, o quedaban esperando para siempre).
      let cancelled: string[] = [];
      if (!active || !publicStart) {
        const waiting = await t.query<{ id: string }>(
          `SELECT r.id FROM workflow_runs r WHERE r.workflow_id = $1 AND ${PUBLIC_RUN_SQL} AND ${WAITING_COLLECT_SQL}`,
          [cur.id],
        );
        cancelled = await cancelRunsTx(t, waiting.map((x) => x.id), actor, !active ? "Workflow desactivado" : "Workflow despublicado");
      }
      return { row, cancelled };
    });
    for (const id of cancelled) await cleanupRunDocuments(deps, id);
    await auditFromRequest(s.db, req, a, "workflow.updated", {
      targetType: "workflow",
      targetId: cur.id,
      data: { fields: Object.keys((req.body as object) ?? {}), ...(cancelled.length ? { publicRunsCancelled: cancelled.length } : {}) },
    });
    return toWorkflow(s.db, row, true);
  });

  app.delete<{ Params: { id: string } }>("/v1/workflows/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const cur = await loadWorkflow(a, req.params.id);
    // Con el workflow bloqueado: un run que arranca a la vez (su INSERT toma un lock sobre esta fila) termina antes del
    // chequeo y lo frena, en vez de que el borrado en cascada se lleve un run que quizá ya mandó un sobre.
    const fileIds = await s.db.tx(async (t) => {
      await t.query(`SELECT id FROM workflows WHERE id = $1 FOR UPDATE`, [cur.id]);
      const active = await t.one(`SELECT 1 FROM workflow_runs WHERE workflow_id = $1 AND status IN ('running','waiting') LIMIT 1`, [cur.id]);
      // Desactivar el workflow solo cancela las del link público que esperan su formulario; las iniciadas por una persona
      // o una API key siguen hasta terminar o cancelarlas.
      if (active) throw conflict("runs_in_progress", "Hay ejecuciones en curso: cancelalas (desactivar el workflow solo cancela las del link público que esperan su formulario)");
      // Los PDFs generados de sus runs (el borrado en cascada se lleva los runs, que eran lo único que los citaba).
      const runs = await t.query<{ context: RunContext }>(`SELECT context FROM workflow_runs WHERE workflow_id = $1`, [cur.id]);
      await t.query(`DELETE FROM workflows WHERE id = $1`, [cur.id]);
      return runs.flatMap((r) => runDocumentFileIds(r.context));
    });
    // Después de confirmar y fuera de transacción: los que salieron en un sobre se conservan (clave foránea).
    if (fileIds.length) await deleteFilesIfUnused(s.db, s.blobs, fileIds).catch((err) => req.log.warn({ workflowId: cur.id, err: String(err) }, "no se pudieron borrar los documentos de los runs"));
    await auditFromRequest(s.db, req, a, "workflow.deleted", { targetType: "workflow", targetId: cur.id, data: { name: cur.name } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/workflows/:id/runs", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const wf = await loadWorkflow(a, req.params.id);
    if (!wf.active) throw conflict("inactive", "El workflow está desactivado");
    const input = StartWorkflowInput.parse(req.body ?? {});
    const { runId } = await createRun(s.db, wf, {
      data: input.data,
      startedBy: a.userId,
      startedByApiKey: a.userId ? null : a.apiKeyId,
      startedByLabel: a.actor.label ?? "API",
      actor: a.actor,
    });
    await advanceNow(deps, runId);
    reply.code(201);
    return toRun(s.db, await s.db.one(`SELECT * FROM workflow_runs WHERE id = $1`, [runId]), a);
  });

  app.get<{ Querystring: { workflowId?: string; status?: string } }>("/v1/workflow-runs", { preHandler: auth }, async (req) => {
    const a = A(req);
    const params: unknown[] = [a.tenantId];
    let where = `r.tenant_id = $1`;
    if (req.query.workflowId) {
      params.push(req.query.workflowId);
      where += ` AND r.workflow_id = $${params.length}`;
    }
    const statuses = queryList(req.query.status);
    if (statuses.length) {
      params.push(statuses);
      where += ` AND r.status = ANY($${params.length})`;
    }
    if (!hasPerm(a, "templates:manage") && !hasPerm(a, "envelopes:view_all") && !hasPerm(a, "envelopes:manage_all")) {
      if (a.userId) {
        params.push(a.userId);
        where += ` AND (r.started_by = $${params.length} OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.steps) st WHERE st->'config'->>'approverUserId' = $${params.length}::text))`;
      } else {
        params.push(a.apiKeyId);
        where += ` AND r.started_by_api_key = $${params.length}`;
      }
    }
    const rows = await s.db.query(`SELECT r.* FROM workflow_runs r WHERE ${where} ORDER BY r.created_at DESC LIMIT 100`, params);
    return { items: await Promise.all(rows.map((r) => toRun(s.db, r, a))) };
  });

  app.get<{ Params: { id: string } }>("/v1/workflow-runs/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    return toRun(s.db, await loadRun(a, req.params.id), a);
  });

  app.post<{ Params: { id: string; index: string } }>("/v1/workflow-runs/:id/steps/:index/decision", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = ApprovalDecisionInput.parse(req.body);
    const run0 = await loadRun(a, req.params.id);
    const index = Number(req.params.index);
    const def = (run0.steps as WorkflowStep[])[index];
    if (!def || def.type !== "approval") throw notFound("Paso de aprobación");
    if (!canDecide(a, def)) throw forbidden("Solo la persona asignada puede aprobar este paso");
    await s.db.tx(async (t) => {
      const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [run0.id]);
      const st = await t.one<any>(`SELECT status FROM workflow_run_steps WHERE run_id = $1 AND idx = $2`, [run.id, index]);
      if (run.status !== "waiting" || run.current_step !== index || st.status !== "waiting") throw conflict("not_waiting", "Este paso no está esperando una decisión");
      const output = { decision: input.approve ? "approved" : "rejected", by: a.actor.label, comment: input.comment ?? null, at: new Date().toISOString() };
      await t.query(`UPDATE workflow_run_steps SET status = $3, output = $4, finished_at = now() WHERE run_id = $1 AND idx = $2`, [
        run.id,
        index,
        input.approve ? "completed" : "failed",
        JSON.stringify(output),
      ]);
      if (input.approve) await t.query(`UPDATE workflow_runs SET status = 'running', current_step = current_step + 1, updated_at = now() WHERE id = $1`, [run.id]);
      else {
        await t.query(`UPDATE workflow_runs SET status = 'rejected', updated_at = now() WHERE id = $1`, [run.id]);
        // Rechazado: los sobres que el run ya había enviado no siguen en firma.
        await voidRunEnvelopes(t, run, a.actor, "Workflow rechazado");
      }
    });
    await auditFromRequest(s.db, req, a, input.approve ? "workflow.step_approved" : "workflow.step_rejected", { targetType: "workflow_run", targetId: run0.id });
    if (input.approve) await advanceNow(deps, run0.id);
    else await cleanupRunDocuments(deps, run0.id);
    return toRun(s.db, await s.db.one(`SELECT * FROM workflow_runs WHERE id = $1`, [run0.id]), a);
  });

  app.post<{ Params: { id: string } }>("/v1/workflow-runs/:id/cancel", { preHandler: auth }, async (req) => {
    const a = A(req);
    const run0 = await loadRun(a, req.params.id);
    if (!startedByMe(a, run0) && !hasPerm(a, "templates:manage")) throw forbidden();
    await s.db.tx(async (t) => {
      const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [run0.id]);
      // Un run fallado también se puede cancelar: es la forma de anular los sobres que dejó en firma.
      if (!["running", "waiting", "failed"].includes(run.status)) throw conflict("not_active", "La ejecución ya terminó");
      await t.query(`UPDATE workflow_runs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [run.id]);
      await t.query(`UPDATE workflow_run_steps SET status = 'cancelled', finished_at = now() WHERE run_id = $1 AND status IN ('pending','running','waiting')`, [run.id]);
      await voidRunEnvelopes(t, run, a.actor, "Workflow cancelado");
    });
    await auditFromRequest(s.db, req, a, "workflow.run_cancelled", { targetType: "workflow_run", targetId: run0.id });
    await cleanupRunDocuments(deps, run0.id);
    return toRun(s.db, await s.db.one(`SELECT * FROM workflow_runs WHERE id = $1`, [run0.id]), a);
  });

  app.post<{ Params: { id: string } }>("/v1/workflow-runs/:id/retry", { preHandler: auth }, async (req) => {
    const a = A(req);
    const run0 = await loadRun(a, req.params.id);
    if (!startedByMe(a, run0) && !hasPerm(a, "templates:manage")) throw forbidden();
    await s.db.tx(async (t) => {
      const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [run0.id]);
      const st = await t.one<any>(`SELECT * FROM workflow_run_steps WHERE run_id = $1 AND idx = $2`, [run.id, run.current_step]);
      if (run.status !== "failed" || st?.status !== "failed") throw conflict("not_failed", "Solo se reintenta una ejecución con un paso fallido");
      if (st.type === "approval" || st.type === "wait_for_completion") throw conflict("not_retryable", "Este paso no se puede reintentar: iniciá una nueva ejecución");
      if (run.context?.documentsCleaned) {
        // Solo si algún paso pendiente envía un PDF generado antes (ya borrado). Si no, el reintento sigue: los
        // documentos borrados salen del contexto (los que usó un sobre siguen en el sobre).
        if (needsGeneratedDocuments(run.steps as WorkflowStep[], run.current_step)) {
          throw conflict("not_retryable", "Los documentos generados de esta ejecución ya se eliminaron: iniciá una nueva ejecución");
        }
        await t.query(`UPDATE workflow_runs SET context = (context - 'documentsCleaned') || '{"documents": {}}'::jsonb WHERE id = $1`, [run.id]);
      }
      await t.query(`UPDATE workflow_run_steps SET status = 'pending', attempts = 0, error = NULL, finished_at = NULL WHERE run_id = $1 AND idx = $2`, [run.id, run.current_step]);
      await t.query(`UPDATE workflow_runs SET status = 'running', updated_at = now() WHERE id = $1`, [run.id]);
    });
    await advanceNow(deps, run0.id);
    return toRun(s.db, await s.db.one(`SELECT * FROM workflow_runs WHERE id = $1`, [run0.id]), a);
  });

  // ───────── Público: iniciar desde un link y completar los pasos de datos ─────────

  const rl = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get<{ Params: { slug: string } }>("/v1/public/workflows/:slug", rl, async (req): Promise<PublicWorkflowStart> => {
    const wf = await s.db.one<any>(`SELECT w.*, t.name AS org FROM workflows w JOIN tenants t ON t.id = w.tenant_id WHERE w.public_slug = $1 AND w.public_start`, [req.params.slug]);
    // Sin el plan vigente (formularios web), el link no se ofrece.
    if (!wf || !wf.active || !(await publicPlanAllows(s.db, wf.tenant_id)) || (await publicOwnerProblem(s.db, wf))) throw notFound("Workflow");
    return { workflowName: wf.name, organizationName: wf.org, description: wf.description, captchaSiteKey: captchaSiteKey() };
  });

  // Por IP, y en IPv6 por /64 (como los formularios web).
  const ipKey = (req: FastifyRequest) => rateLimitIpKey(req.ip);
  app.post<{ Params: { slug: string } }>("/v1/public/workflows/:slug/start", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: ipKey } } }, async (req, reply) => {
    const body = (req.body ?? {}) as { website?: string; captchaToken?: unknown };
    if (body.website) throw badRequest("rejected", "No se pudo iniciar");
    const wf = await s.db.one<any>(`SELECT * FROM workflows WHERE public_slug = $1 AND public_start`, [req.params.slug]);
    if (!wf || !wf.active || !(await publicPlanAllows(s.db, wf.tenant_id)) || (await publicOwnerProblem(s.db, wf))) throw notFound("Workflow");
    // Desafío anti-bots (como los formularios web): cada inicio crea una ejecución que puede mandar sobres.
    if (captchaSiteKey()) {
      const hostOk = async (h: string) => isPlatformHost(h) || (await tenantForHost(s.db, h)) === wf.tenant_id;
      const cap = await verifyTurnstile(typeof body.captchaToken === "string" ? body.captchaToken.slice(0, 4096) : null, req.ip, hostOk);
      if (!cap.ok) {
        if (cap.reason === "network") req.log.error({ workflowId: wf.id, detail: cap.detail }, "workflow público: no se pudo consultar a Turnstile");
        else if (cap.reason !== "missing") req.log.warn({ workflowId: wf.id, reason: cap.reason, detail: cap.detail }, "workflow público: desafío Turnstile rechazado");
        throw new AppError(400, "captcha_failed", "No se pudo verificar que no sos un robot: completá la verificación y volvé a intentar");
      }
    }
    const { ip } = clientInfo(req);
    const { runId, token } = await createRun(s.db, wf, { data: {}, startedBy: null, startedByLabel: `Link público (${ip ?? "?"})`, actor: { type: "system", label: "Link público" } });
    await advanceNow(deps, runId);
    reply.code(201);
    const fresh = await s.db.one<any>(`SELECT public_token_enc FROM workflow_runs WHERE id = $1`, [runId]);
    return { token: token ?? (fresh?.public_token_enc ? decrypt(fresh.public_token_enc) : null), runId };
  });

  async function loadPublicRun(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("Ejecución");
    const run = await s.db.one<any>(`SELECT * FROM workflow_runs WHERE public_token_hash = $1`, [sha256Hex(token)]);
    if (!run) throw notFound("Ejecución");
    return run;
  }

  async function publicView(run: any): Promise<PublicWorkflowRun> {
    const wf = await s.db.one<any>(`SELECT name FROM workflows WHERE id = $1`, [run.workflow_id]);
    const org = await s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [run.tenant_id]);
    const def = (run.steps as WorkflowStep[])[run.current_step];
    const step =
      run.status === "waiting" && def?.type === "collect_data"
        ? { index: run.current_step, name: def.name, title: def.config.title, description: def.config.description ?? null, fields: def.config.fields as CollectField[] }
        : null;
    // Link de firma para quien completó los datos (si el sobre del run lo tiene como firmante).
    let signingUrl: string | null = null;
    // Solo se entrega el link de un firmante cuyo correo es exactamente una variable que completó el propio formulario
    // ({{cliente.email}} con cliente.email cargado en un paso de recolección). Si no, quien completa el formulario
    // podría escribir el correo de un firmante fijo, o de uno que vino en los datos con que se inició el run (por
    // ejemplo, alguien de la organización), en cualquier campo de correo y recibir su link de firma.
    const collected = new Set<string>(run.context?.collectEmailPaths ?? []);
    const runEnvelopes = (run.context?.envelopes ?? {}) as Record<string, { envelopeId: string }>;
    // Por sobre: los correos de sus firmantes autoservicio. Solo firmantes (una copia con {{cliente.email}} no firma: si
    // contara, quien escribe ahí el correo de un firmante fijo recibía el link de ese firmante), y solo en el sobre de
    // ese paso (en otro sobre del run, el mismo correo puede ser el de un firmante fijo).
    const selfByEnvelope = new Map<string, Set<string>>();
    // Los sobres enviados registran sus firmantes autoservicio al salir (selfServiceSigners).
    const recorded = (run.context?.selfServiceSigners ?? {}) as Record<string, string[]>;
    for (const [envId, list] of Object.entries(recorded)) if (list.length) selfByEnvelope.set(envId, new Set(list));
    // Runs anteriores a ese registro: se reconstruye con los pasos. Una clave de sobre usada por dos pasos queda afuera:
    // el contexto solo guarda el último sobre, y los firmantes autoservicio del primer paso se atribuían al segundo
    // (donde ese correo podía ser el de un firmante fijo).
    const sendSteps = (run.steps as WorkflowStep[]).filter((st): st is Extract<WorkflowStep, { type: "send_for_signature" }> => st.type === "send_for_signature");
    const keyUses = new Map<string, number>();
    for (const st of sendSteps) keyUses.set(st.config.envelopeKey, (keyUses.get(st.config.envelopeKey) ?? 0) + 1);
    for (const st of sendSteps) {
      const envId = runEnvelopes[st.config.envelopeKey]?.envelopeId;
      if (!envId || Object.prototype.hasOwnProperty.call(recorded, envId) || keyUses.get(st.config.envelopeKey) !== 1) continue;
      for (const r of st.config.recipients) {
        if (r.cc) continue;
        const m = SELF_SERVICE_EMAIL.exec(r.email ?? "");
        if (!m || !collected.has(m[1])) continue;
        const v = getPath(run.context?.data ?? {}, m[1]);
        if (typeof v !== "string" || !v.trim()) continue;
        if (!selfByEnvelope.has(envId)) selfByEnvelope.set(envId, new Set());
        selfByEnvelope.get(envId)!.add(v.trim().toLowerCase());
      }
    }
    const emails = [...new Set([...selfByEnvelope.values()].flatMap((x) => [...x]))];
    const envIds = [...selfByEnvelope.keys()];
    if (emails.length && envIds.length) {
      // Por correo, solo si ese correo es de UN firmante del sobre: si quien completa el formulario escribe el correo de un
      // firmante fijo, el sobre queda con dos firmantes con el mismo correo (mismo orden de firma) y el primero podía ser
      // el fijo. Se cuenta por sobre: el mismo firmante autoservicio en dos sobres del run sigue recibiendo su link.
      const rows = await s.db.query<any>(
        `SELECT r.envelope_id, lower(r.email) AS email, r.access_token_enc, r.status, e.status AS envelope_status FROM recipients r JOIN envelopes e ON e.id = r.envelope_id
         WHERE r.envelope_id = ANY($1) AND lower(r.email) = ANY($2) AND r.role = 'signer' AND r.status NOT IN ('delegated','reassigned')
         ORDER BY r.routing_order`,
        [envIds, emails],
      );
      const k = (x: any) => `${x.envelope_id}|${x.email}`;
      const count = new Map<string, number>();
      for (const x of rows) count.set(k(x), (count.get(k(x)) ?? 0) + 1);
      const r = rows.find(
        (x) =>
          selfByEnvelope.get(x.envelope_id)?.has(x.email) &&
          count.get(k(x)) === 1 &&
          ["sent", "viewed"].includes(x.status) &&
          x.envelope_status === "sent" &&
          x.access_token_enc,
      );
      // Con el dominio del sobre (sub-marca), como los avisos.
      if (r) signingUrl = `${await envelopeBaseUrl(s.db, run.tenant_id, r.envelope_id)}/s/${decrypt(r.access_token_enc)}`;
    }
    return { runId: run.id, workflowName: wf?.name ?? "", organizationName: org?.name ?? "", status: run.status, step, signingUrl };
  }

  app.get<{ Params: { token: string } }>("/v1/public/workflow-runs/:token", rl, async (req) => publicView(await loadPublicRun(req.params.token)));

  /**
   * Si el link de un run todavía acepta datos. Run iniciado por el link público: workflow activo, publicado y con el
   * plan (se revalida en cada envío, no solo al iniciar). Run iniciado por una persona o una API key: sigue aunque el
   * workflow se desactive después (desactivar frena nuevos inicios y cancela solo los runs públicos en espera).
   */
  async function assertRunAcceptsInput(db: Db, run: any, lock = false) {
    const wf = await db.one<any>(`SELECT active, public_start, tenant_id FROM workflows WHERE id = $1${lock ? " FOR SHARE" : ""}`, [run.workflow_id]);
    if (!wf) throw new AppError(410, "workflow_inactive", "Este formulario ya no está disponible");
    if (isPublicRun(run) && (!wf.active || !wf.public_start || !(await publicPlanAllows(db, wf.tenant_id)))) {
      throw new AppError(410, "workflow_inactive", "Este formulario ya no está disponible");
    }
  }

  app.post<{ Params: { token: string; index: string } }>("/v1/public/workflow-runs/:token/steps/:index", { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: ipKey } } }, async (req) => {
    const input = SubmitCollectInput.parse(req.body);
    if (input.website) throw badRequest("rejected", "No se pudo enviar");
    const run0 = await loadPublicRun(req.params.token);
    const index = Number(req.params.index);
    const def = (run0.steps as WorkflowStep[])[index];
    if (!def || def.type !== "collect_data") throw notFound("Paso");
    await assertRunAcceptsInput(s.db, run0);
    // Validación por campo.
    const values: Record<string, unknown> = {};
    const errors: { path: string; message: string }[] = [];
    for (const f of def.config.fields) {
      // Solo claves propias: un campo "toString" o "valueOf" sin valor leía la función heredada y `.trim()` daba 500.
      const raw = (Object.hasOwn(input.values, f.key) ? input.values[f.key] : "").trim();
      if (!raw) {
        if (f.required) errors.push({ path: f.key, message: `${f.label}: obligatorio` });
        continue;
      }
      if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) errors.push({ path: f.key, message: `${f.label}: correo inválido` });
      else if (f.type === "number" && toNumberOrNull(raw) === null) errors.push({ path: f.key, message: `${f.label}: número inválido` });
      else if (f.type === "date" && !toIsoDate(raw)) errors.push({ path: f.key, message: `${f.label}: fecha inválida` });
      else if (f.type === "select" && !(f.options ?? []).includes(raw)) errors.push({ path: f.key, message: `${f.label}: opción inválida` });
      values[f.key] = f.type === "number" ? toNumberOrNull(raw) : f.type === "date" ? toIsoDate(raw) : f.type === "email" ? raw.toLowerCase() : raw;
    }
    if (errors.length) throw new AppError(400, "validation_error", errors.map((e) => e.message).join("; "), errors);
    // Huella de quien lo completa (run público con correo): HMAC de workflow + correo + IP (en IPv6, el /64).
    const emailField = def.config.fields.find((f) => f.type === "email" && typeof values[f.key] === "string");
    const submitter =
      isPublicRun(run0) && emailField ? hmacSign("workflow-submitter", `${run0.workflow_id}\n${String(values[emailField.key])}\n${rateLimitIpKey(req.ip)}`) : null;
    await s.db.tx(async (t) => {
      // Primero el workflow (FOR SHARE) y después el run, en el mismo orden que la desactivación (que cancela estos
      // runs): una desactivación simultánea no se cruza con el envío.
      await assertRunAcceptsInput(t, run0, true);
      const run = await t.one<any>(`SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE`, [run0.id]);
      const st = await t.one<any>(`SELECT status, started_at FROM workflow_run_steps WHERE run_id = $1 AND idx = $2`, [run.id, index]);
      if (run.status !== "waiting" || run.current_step !== index || st.status !== "waiting") throw conflict("not_waiting", "Este formulario ya fue completado");
      // Tiempo mínimo de llenado desde que el formulario quedó esperando (un humano tarda más; un bot, menos), solo en
      // runs del link público: el link de un run interno lo recibe alguien elegido por quien lo inició. El paso es de un
      // solo uso (queda completado), así que no hace falta otro token de formulario.
      if (isPublicRun(run) && st.started_at && Date.now() - new Date(st.started_at).getTime() < MIN_FILL_MS) {
        throw new AppError(422, "too_fast", "Esperá unos segundos y volvé a enviar");
      }
      if (submitter) {
        // El mismo correo desde la misma IP en el mismo workflow hace poco (otra ejecución): no se acepta otro (cada uno
        // puede crear y mandar sobres). Una ejecución cancelada o rechazada no cuenta. Con un lock por huella: dos envíos
        // simultáneos de dos runs distintos no pasan los dos el chequeo (orden: workflow → run → huella → organización).
        await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`wf-submitter:${submitter}`]);
        const W = config.webForms;
        const dup = await t.one(
          `SELECT 1 FROM workflow_runs WHERE workflow_id = $1 AND public_submitter = $2 AND id <> $3 AND status NOT IN ('cancelled','rejected')
             AND updated_at > now() - make_interval(mins => $4) LIMIT 1`,
          [run.workflow_id, submitter, run.id, W.dedupeMinutes],
        );
        if (dup) {
          throw new AppError(429, "form_recent_submission", "Ya recibimos un envío igual hace unos minutos: revisá la pestaña donde completaste el formulario o probá más tarde", {
            retryAfterSeconds: W.dedupeMinutes * 60,
          });
        }
        await t.query(`UPDATE workflow_runs SET public_submitter = $2 WHERE id = $1`, [run.id, submitter]);
      }
      // Run público que completa su primer formulario: recién ahora gasta el cupo de la organización (compartido con los
      // formularios web); los inicios sin completar no lo gastan.
      if (isPublicRun(run) && !run.public_collected_at) {
        if (await publicTenantCapReached(t, run.tenant_id)) throw new AppError(429, "workflow_rate_limited", "Demasiados envíos en esta organización: probá más tarde");
        await t.query(`UPDATE workflow_runs SET public_collected_at = now() WHERE id = $1`, [run.id]);
      }
      const ctx: RunContext = run.context;
      ctx.data ??= {};
      for (const [k, v] of Object.entries(values)) setPath(ctx.data, def.config.target ? `${def.config.target}.${k}` : k, v);
      const emailPaths = def.config.fields
        .filter((f) => f.type === "email" && typeof values[f.key] === "string")
        .map((f) => (def.config.target ? `${def.config.target}.${f.key}` : f.key));
      ctx.collectEmailPaths = [...new Set([...(ctx.collectEmailPaths ?? []), ...emailPaths])];
      const source = clientInfo(req);
      ctx.collectEmailSources = { ...(ctx.collectEmailSources ?? {}), ...Object.fromEntries(emailPaths.map((p) => [p, source])) };
      await t.query(`UPDATE workflow_run_steps SET status = 'completed', output = $3, finished_at = now() WHERE run_id = $1 AND idx = $2`, [
        run.id,
        index,
        JSON.stringify({ fields: Object.keys(values) }),
      ]);
      await t.query(`UPDATE workflow_runs SET status = 'running', context = $2, current_step = current_step + 1, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify(ctx)]);
    });
    await advanceNow(deps, run0.id);
    return publicView(await s.db.one(`SELECT * FROM workflow_runs WHERE id = $1`, [run0.id]));
  });
}
