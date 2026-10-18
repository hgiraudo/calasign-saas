// Fase 6 — Plataforma de acuerdos: registro de rutas, cola "agreements" y tareas periódicas.
import type { FastifyInstance } from "fastify";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { enqueue } from "../../infra/queue";
import type { Services } from "../context";
import type { Deps } from "./common";
import { documentRoutes } from "./documents";
import { negotiationRoutes } from "./negotiations";
import { agreementExpirySweep, ingestEnvelope, repositoryRoutes } from "./repository";
import { advanceRun, onEnvelopeEventForWorkflows, workflowRoutes } from "./workflows";

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
  const waiting = await db.one(`SELECT 1 FROM workflow_runs WHERE status = 'waiting' AND context->>'waitingEnvelope' = $1 LIMIT 1`, [envelopeId]);
  if (waiting) await enqueue(db, "agreements", { kind: "envelope_event", envelopeId });
}

type AgreementsJob = { kind: "ingest"; envelopeId: string } | { kind: "envelope_event"; envelopeId: string } | { kind: "advance"; runId: string };

export async function handleAgreementsJob(d: Deps, p: AgreementsJob) {
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

/** Tarea periódica (worker): vencimientos del repositorio. */
export async function agreementsSweep(d: Deps) {
  await agreementExpirySweep(d);
}
