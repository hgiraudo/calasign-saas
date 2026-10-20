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
  | { kind: "proposal_notice"; negotiationId: string; proposalId: string };

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

/** Manda el aviso a cada destinatario; si alguno falla, el job se reintenta (sin repetir los que salieron). */
async function sendAll(d: Deps, tenantId: string, kind: AgreementTemplateKind, targets: Target[], base: Omit<TemplateVars, "recipientName">, jobId?: number) {
  const wl = await resolveBrand(d.db, tenantId, null);
  const sendAs = await senderFor(d.db, wl);
  const errors: string[] = [];
  for (const u of targets) {
    if (!u.email) continue;
    const locale = normLocale(u.locale);
    const m = render(kind, locale, { ...base, ...u.vars, recipientName: u.name, link: u.link }, mailBranding(wl, null, locale));
    const out = await sendTracked(
      d.db,
      { tenantId, template: kind, jobId, log: d.log },
      { channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link: u.link, locale, tenantId, from: sendAs.from, replyTo: sendAs.replyTo, dkim: sendAs.dkim },
    );
    if (out.status === "failed") errors.push(out.error);
  }
  // Sin destinos en el error (termina en jobs.last_error y en los logs).
  if (errors.length) throw new Error(`no se pudo avisar (${errors.length}): ${errors.join("; ")}`);
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
