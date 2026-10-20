// Avisos por correo de la plataforma de acuerdos (vencimientos y negociaciones), por la cola "agreements": con
// reintentos, sin repetir a quien ya lo recibió (sendTracked con el id del job), con la marca de la organización
// (remitente, colores, logo) y en el idioma de cada destinatario.
import type { Db } from "../../infra/db";
import { enqueue } from "../../infra/queue";
import { decrypt } from "../../lib/util";
import { sendTracked } from "../../notifications/outbound";
import { normLocale, render, type AgreementTemplateKind, type TemplateVars } from "../../notifications/templates";
import { tenantBaseUrl } from "../custom-domains";
import { mailBranding, resolveBrand, senderFor } from "../white-label/brand";
import type { Deps } from "./common";

export type NoticeJob =
  | { kind: "expiry_notice"; agreementId: string; expiryDate: string }
  | { kind: "negotiation_notice"; negotiationId: string; event: "invite" | "version"; version: number; summary?: string | null; acceptedKey?: string | null }
  | { kind: "proposal_notice"; negotiationId: string; proposalId: string }
  | { kind: "workflow_approval_notice"; runId: string; stepIndex: number; attempt: number };

/** Clave de dedupe del aviso de vencimiento (la misma que arma el barrido en SQL). */
export const expiryNoticeKey = (agreementId: string, expiryDate: string) => `agr:expiry:${agreementId}:${expiryDate}`;

/** Encola el aviso a las contrapartes de una negociación (dentro de la transacción del cambio: outbox). */
export async function enqueueNegotiationNotice(t: Db, negotiationId: string, event: "invite" | "version", version: number, extra: { summary?: string | null; acceptedKey?: string | null } = {}) {
  await enqueue(
    t,
    "agreements",
    { kind: "negotiation_notice", negotiationId, event, version, summary: extra.summary ?? null, acceptedKey: extra.acceptedKey ?? null } satisfies NoticeJob,
    { dedupeKey: `neg:${event}:${negotiationId}:${version}` },
  );
}

/**
 * Encola el aviso a quien aprueba un paso de un workflow (en la transacción que deja el paso esperando: outbox).
 * `attempt`: el intento del paso (un reintento del mismo paso vuelve a avisar; un job repetido del mismo intento, no).
 */
export async function enqueueWorkflowApprovalNotice(t: Db, runId: string, stepIndex: number, attempt: number) {
  await enqueue(t, "agreements", { kind: "workflow_approval_notice", runId, stepIndex, attempt } satisfies NoticeJob, {
    dedupeKey: `wf:approval:${runId}:${stepIndex}:${attempt}`,
  });
}

/** Encola el aviso al remitente de una propuesta de cambio de una contraparte. */
export async function enqueueProposalNotice(t: Db, negotiationId: string, proposalId: string) {
  await enqueue(t, "agreements", { kind: "proposal_notice", negotiationId, proposalId } satisfies NoticeJob, { dedupeKey: `neg:proposal:${proposalId}` });
}

const ACCEPTED = {
  es: (k: string) => `Se aceptó el cambio propuesto en ${k}.`,
  "pt-BR": (k: string) => `A mudança proposta em ${k} foi aceita.`,
  en: (k: string) => `The proposed change to ${k} was accepted.`,
} as const;
const CLAUSE = { es: (k: string) => `la cláusula ${k}`, "pt-BR": (k: string) => `a cláusula ${k}`, en: (k: string) => `clause ${k}` } as const;

interface Target {
  email: string;
  name: string;
  locale: string | null;
  link: string;
  vars: Partial<TemplateVars>;
}

/**
 * Manda el aviso a cada destinatario. Solo un fallo transitorio (red, 4xx de SMTP, 429/5xx) hace reintentar el job
 * (sin repetir los que ya salieron, por el id del job); uno permanente (dirección inexistente, 550) se registra y no se
 * reintenta: si no, el job fallaba siempre y el aviso se volvía a encolar y reenviar a los demás todos los días.
 * `sameNotice`: payload (contención jsonb) de los jobs que son "el mismo aviso" (p. ej. mismo acuerdo y vencimiento):
 * un destino que ya lo recibió por un job anterior no lo recibe otra vez.
 */
async function sendAll(
  d: Deps,
  tenantId: string,
  kind: AgreementTemplateKind,
  targets: Target[],
  base: Omit<TemplateVars, "recipientName">,
  jobId?: number,
  sameNotice?: Record<string, unknown>,
) {
  const wl = await resolveBrand(d.db, tenantId, null);
  const sendAs = await senderFor(d.db, wl);
  const transient: string[] = [];
  let permanent = 0;
  for (const u of targets) {
    if (!u.email) continue;
    if (sameNotice && (await alreadyNotified(d.db, tenantId, kind, u.email, sameNotice, jobId))) continue;
    const locale = normLocale(u.locale);
    const m = render(kind, locale, { ...base, ...u.vars, recipientName: u.name, link: u.link }, mailBranding(wl, null, locale));
    const out = await sendTracked(
      d.db,
      { tenantId, template: kind, jobId, log: d.log },
      { channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link: u.link, locale, tenantId, from: sendAs.from, replyTo: sendAs.replyTo, dkim: sendAs.dkim },
    );
    if (out.status === "failed") {
      if (out.transient) transient.push(out.error);
      else permanent++;
    }
  }
  if (permanent) d.log.warn({ tenantId, template: kind, failed: permanent }, "aviso no entregado a algunos destinos (error permanente, no se reintenta)");
  // Sin destinos en el error (termina en jobs.last_error y en los logs).
  if (transient.length) throw new Error(`no se pudo avisar (${transient.length}): ${transient.join("; ")}`);
}

/**
 * Si un job anterior del mismo aviso ya se lo mandó (o lo dejó en curso) a ese destino. Acotado a los últimos 60 días
 * (los reintentos de un aviso caen mucho antes) y con el índice parcial notifications_job_dest_idx (0076).
 */
async function alreadyNotified(db: Db, tenantId: string, kind: string, email: string, sameNotice: Record<string, unknown>, jobId?: number) {
  return Boolean(
    await db.one(
      `SELECT 1 FROM notifications n JOIN jobs j ON j.id = n.job_id
        WHERE n.tenant_id = $1 AND n.template = $2 AND n.channel = 'email' AND n.destination = $3
          AND n.job_id IS NOT NULL AND n.created_at > now() - interval '60 days'
          AND n.status IN ('queued','sent','bounced','complained') AND j.queue = 'agreements' AND j.payload @> $4::jsonb
          AND j.id IS DISTINCT FROM $5::bigint
        LIMIT 1`,
      [tenantId, kind, email, JSON.stringify(sameNotice), jobId ?? null],
    ),
  );
}

/** Responsables de un acuerdo o negociación: el dueño si sigue en la organización; si no, los propietarios. */
async function staffFor(db: Db, tenantId: string, userId: string | null) {
  let to = userId
    ? await db.query<any>(`SELECT u.email, u.name, u.locale FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 WHERE u.id = $1`, [userId, tenantId])
    : [];
  if (!to.length) {
    to = await db.query<any>(`SELECT u.email, u.name, u.locale FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role = 'owner'`, [tenantId]);
  }
  return to as { email: string; name: string; locale: string | null }[];
}

export async function handleNoticeJob(d: Deps, p: NoticeJob, jobId?: number) {
  if (p.kind === "expiry_notice") return expiryNotice(d, p, jobId);
  if (p.kind === "workflow_approval_notice") return workflowApprovalNotice(d, p, jobId);
  if (p.kind === "negotiation_notice") return negotiationNotice(d, p, jobId);
  return proposalNotice(d, p, jobId);
}

async function expiryNotice(d: Deps, p: Extract<NoticeJob, { kind: "expiry_notice" }>, jobId?: number) {
  const a = await d.db.one<any>(
    `SELECT id, tenant_id, title, owner_user_id, expiry_date::text AS expiry, (expiry_date - current_date) AS days_left, status,
            (expiry_notified_for IS NOT NULL AND expiry_notified_for = expiry_date) AS notified
       FROM agreements WHERE id = $1`,
    [p.agreementId],
  );
  // Ya no aplica: borrado, dado de baja, vencimiento cambiado (el nuevo tiene su propio aviso) o ya avisado.
  if (!a || a.status !== "active" || a.expiry !== p.expiryDate || a.notified) return;
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [a.tenant_id]);
  const link = `${await tenantBaseUrl(d.db, a.tenant_id)}/app/agreements/${a.id}`;
  const to = await staffFor(d.db, a.tenant_id, a.owner_user_id);
  await sendAll(
    d,
    a.tenant_id,
    "agreement_expiry",
    to.map((u) => ({ ...u, link, vars: {} })),
    { senderName: org?.name ?? "", organizationName: org?.name ?? "", subject: a.title, date: a.expiry, days: Number(a.days_left) },
    jobId,
    // Mismo acuerdo y vencimiento: un job re-encolado al día siguiente no repite a quien ya lo recibió.
    { kind: "expiry_notice", agreementId: a.id, expiryDate: p.expiryDate },
  );
  // Recién ahora (todos los avisos salieron): marcado como avisado para este vencimiento.
  await d.db.query(`UPDATE agreements SET expiry_notified_for = expiry_date WHERE id = $1 AND expiry_date::text = $2`, [a.id, p.expiryDate]);
}

async function negotiationNotice(d: Deps, p: Extract<NoticeJob, { kind: "negotiation_notice" }>, jobId?: number) {
  const n = await d.db.one<any>(`SELECT * FROM negotiations WHERE id = $1`, [p.negotiationId]);
  // Cerrada mientras esperaba en la cola, o ya hay otra versión (su propio aviso la anuncia).
  if (!n || n.status !== "open" || (p.event === "version" && n.current_version !== p.version)) return;
  const parts = await d.db.query<any>(`SELECT * FROM negotiation_participants WHERE negotiation_id = $1`, [n.id]);
  const base = await tenantBaseUrl(d.db, n.tenant_id);
  const wl = await resolveBrand(d.db, n.tenant_id, null);
  const locale = normLocale(n.template_locale);
  const detail = p.acceptedKey ? ACCEPTED[locale](p.acceptedKey) : p.summary || null;
  await sendAll(
    d,
    n.tenant_id,
    p.event === "invite" ? "negotiation_invite" : "negotiation_version",
    // Las contrapartes no tienen idioma propio: el del documento que se negocia.
    parts.map((x) => ({ email: x.email, name: x.name, locale, link: `${base}/n/${decrypt(x.token_enc)}`, vars: {} })),
    { senderName: wl.name, organizationName: wl.name, subject: n.title, message: p.event === "invite" ? n.message : null, detail },
    jobId,
  );
}

async function proposalNotice(d: Deps, p: Extract<NoticeJob, { kind: "proposal_notice" }>, jobId?: number) {
  const n = await d.db.one<any>(`SELECT * FROM negotiations WHERE id = $1`, [p.negotiationId]);
  const pr = await d.db.one<any>(`SELECT * FROM negotiation_proposals WHERE id = $1 AND negotiation_id = $2`, [p.proposalId, p.negotiationId]);
  if (!n || !pr || n.status !== "open" || pr.status !== "pending") return;
  const link = `${await tenantBaseUrl(d.db, n.tenant_id)}/app/negotiations/${n.id}`;
  const to = await staffFor(d.db, n.tenant_id, n.created_by);
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [n.tenant_id]);
  await sendAll(
    d,
    n.tenant_id,
    "negotiation_proposal",
    to.map((u) => ({ ...u, link, vars: { detail: pr.kind === "variable" ? pr.key : CLAUSE[normLocale(u.locale)](pr.key) } })),
    { senderName: pr.author_name, organizationName: org?.name ?? "", subject: n.title },
    jobId,
  );
}

async function workflowApprovalNotice(d: Deps, p: Extract<NoticeJob, { kind: "workflow_approval_notice" }>, jobId?: number) {
  const run = await d.db.one<any>(`SELECT id, tenant_id, workflow_id, status, current_step, steps FROM workflow_runs WHERE id = $1`, [p.runId]);
  // Ya se decidió, se canceló o venció mientras esperaba en la cola: no hace falta avisar.
  if (!run || run.status !== "waiting" || run.current_step !== p.stepIndex) return;
  const step = (run.steps ?? [])[p.stepIndex];
  if (step?.type !== "approval") return;
  const approver = await d.db.one<any>(
    `SELECT u.email, u.name, u.locale FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 WHERE u.id = $1`,
    [step.config?.approverUserId, run.tenant_id],
  );
  if (!approver) return;
  const wf = await d.db.one<any>(`SELECT name FROM workflows WHERE id = $1`, [run.workflow_id]);
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [run.tenant_id]);
  const link = `${await tenantBaseUrl(d.db, run.tenant_id)}/app/workflow-runs/${run.id}`;
  await sendAll(
    d,
    run.tenant_id,
    "workflow_approval",
    [{ email: approver.email, name: approver.name, locale: approver.locale, link, vars: {} }],
    { senderName: org?.name ?? "", organizationName: org?.name ?? "", subject: wf?.name ?? "workflow", detail: step.name ?? "", message: step.config?.message || null },
    jobId,
    { kind: "workflow_approval_notice", runId: p.runId, stepIndex: p.stepIndex, attempt: p.attempt },
  );
}
