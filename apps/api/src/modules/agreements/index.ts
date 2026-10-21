// Fase 6 — Plataforma de acuerdos: registro de rutas, cola "agreements" y tareas periódicas.
import type { FastifyInstance } from "fastify";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { enqueue } from "../../infra/queue";
import type { Services } from "../context";
import type { Deps } from "./common";
import { documentRoutes } from "./documents";
import { negotiationRoutes } from "./negotiations";
import { handleNoticeJob, type NoticeJob } from "./notices";
import { agreementExpirySweep, ingestEnvelope, repositoryRoutes } from "./repository";
import { agreementsRetentionSweep } from "./retention";
import { advanceRun, onEnvelopeEventForWorkflows, workflowRoutes, workflowRunsSweep } from "./workflows";

export async function agreementRoutes(app: FastifyInstance, s: Services) {
  await repositoryRoutes(app, s);
  await documentRoutes(app, s);
  await workflowRoutes(app, s);
  await negotiationRoutes(app, s);
  // Solo en local: corre el barrido de vencimientos ya (las pruebas no esperan al worker).
  if (config.environment === "local") {
    app.post("/dev/agreements/sweep", async () => ({ notified: await agreementExpirySweep({ db: s.db, blobs: s.blobs, log: app.log }) }));
  }
}

const TERMINAL = new Set(["envelope.completed", "recipient.declined", "envelope.voided", "envelope.expired"]);

/**
 * Llamado desde la evidencia (outbox, misma transacción que el evento): sobre completado → acuerdo en el
 * repositorio; sobre terminado → destrabar workflows que lo esperan.
 */
export async function queueAgreementEvents(db: Db, envelopeId: string, evidenceType: string) {
  if (!TERMINAL.has(evidenceType)) return;
  if (evidenceType === "envelope.completed") await enqueue(db, "agreements", { kind: "ingest", envelopeId }, { dedupeKey: `agr:ingest:${envelopeId}` });
  const waiting = await db.one(`SELECT 1 FROM workflow_runs WHERE status = 'waiting' AND context->'waitingEnvelope' = to_jsonb($1::text) LIMIT 1`, [envelopeId]);
  if (waiting) await enqueue(db, "agreements", { kind: "envelope_event", envelopeId });
}

type AgreementsJob = { kind: "ingest"; envelopeId: string } | { kind: "envelope_event"; envelopeId: string } | { kind: "advance"; runId: string } | NoticeJob;

export async function handleAgreementsJob(d: Deps, p: AgreementsJob, jobId?: number) {
  // Avisos por correo (vencimientos, negociaciones): jobId para no repetir a quien ya lo recibió en un reintento.
  if (p.kind === "expiry_notice" || p.kind === "negotiation_notice" || p.kind === "proposal_notice" || p.kind === "workflow_approval_notice") return handleNoticeJob(d, p, jobId);
  if (p.kind === "ingest") {
    await ingestEnvelope(d, p.envelopeId);
    // Si un workflow espera este sobre y su próximo paso actualiza el repositorio, ya encuentra el acuerdo.
    return;
  }
  if (p.kind === "envelope_event") {
    await onEnvelopeEventForWorkflows(d, p.envelopeId);
    return;
  }
  if (p.kind === "advance") await advanceRun(d, p.runId);
}

/** Tarea periódica (worker): vencimientos del repositorio, workflows trabados o vencidos y retención de datos. */
export async function agreementsSweep(d: Deps) {
  await agreementExpirySweep(d);
  await ingestBackfill(d);
  await resumeStalledRuns(d);
  await workflowRunsSweep(d);
  // Retención: datos de ejecuciones terminadas y negociaciones cerradas vencidas (retention.ts).
  await agreementsRetentionSweep(d);
}

/**
 * Runs en "running" sin movimiento hace más de 15 minutos: el avance en línea (aprobar, formulario público, iniciar,
 * reintentar) o un job murió a mitad y nadie lo volvía a encolar. advanceRun ya retoma los pasos abandonados.
 * Una vez por run y por hora (clave de dedupe).
 */
async function resumeStalledRuns(d: Deps) {
  const rows = await d.db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM workflow_runs WHERE status = 'running' AND updated_at < now() - interval '15 minutes' ORDER BY updated_at LIMIT 50`,
  );
  const hour = new Date().toISOString().slice(0, 13);
  for (const r of rows) await enqueue(d.db, "agreements", { kind: "advance", runId: r.id }, { dedupeKey: `wf-resume:${r.id}:${hour}`, tenantId: r.tenant_id });
}

/**
 * Ingestas que agotaron sus intentos (almacenamiento o clave BYOK caídos más que el backoff del job): sin esto el
 * sobre completado no llegaba nunca al repositorio. Se re-arma el mismo job (no se recorre por sobres sin acuerdo:
 * eso volvía a crear los acuerdos que alguien borró a propósito). A lo sumo una vez cada 6 horas y por 30 días.
 */
async function ingestBackfill(d: Deps) {
  const rows = await d.db.query<{ id: number }>(
    `UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL, locked_at = NULL
      WHERE id IN (SELECT id FROM jobs WHERE queue = 'agreements' AND status = 'failed' AND dedupe_key LIKE 'agr:ingest:%'
                     AND finished_at < now() - interval '6 hours' AND created_at > now() - interval '30 days'
                     -- Uno que tumbó el proceso (un PDF que lo hace caer) no se reintenta: se llevaba los jobs en curso.
                     AND COALESCE(last_error, '') NOT LIKE '%el worker se detuvo%' LIMIT 20)
      RETURNING id`,
  );
  if (rows.length) d.log.info({ jobs: rows.length }, "ingestas al repositorio re-encoladas");
}
