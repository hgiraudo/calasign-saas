// Planes: plan efectivo de la organización, uso del mes y control central de límites (402 plan_limit).
import type { FastifyRequest } from "fastify";
import { PLANS, PLAN_IDS, type BillingUsage, type PlanDefinition, type PlanFeature, type PlanId, type PlanLimitDetails } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError } from "../../lib/errors";
import type { AuthContext } from "../context";

export const UPGRADE_URL = "/app/settings/billing";

export function planById(id: string | null | undefined): PlanDefinition {
  return PLANS[(PLAN_IDS as readonly string[]).includes(id ?? "") ? (id as PlanId) : config.billing.defaultPlan];
}

export async function tenantPlan(db: Db, tenantId: string): Promise<{ plan: PlanDefinition; isDefault: boolean }> {
  const t = await db.one<{ billing_plan: string | null }>(`SELECT billing_plan FROM tenants WHERE id = $1`, [tenantId]);
  return { plan: planById(t?.billing_plan ?? null), isDefault: !t?.billing_plan };
}

/** Primer plan (en orden) que incluye la funcionalidad o el cupo pedido. */
function suggest(pred: (p: PlanDefinition) => boolean): PlanId | null {
  for (const id of PLAN_IDS) if (pred(PLANS[id])) return id;
  return null;
}

export function planLimitError(message: string, details: Omit<PlanLimitDetails, "upgradeUrl">): AppError {
  return new AppError(402, "plan_limit", message, { ...details, upgradeUrl: UPGRADE_URL });
}

export function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function envelopesSentThisMonth(db: Db, tenantId: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM envelopes WHERE tenant_id = $1 AND sent_at >= $2`,
    [tenantId, monthStart().toISOString()],
  );
  return Number(r?.n ?? 0);
}

/** Cupo de sobres del mes. Se llama dentro de la transacción de envío (sendEnvelope), así cubre web, API, masivo y formularios. */
export async function enforceEnvelopeQuota(db: Db, tenantId: string) {
  const { plan } = await tenantPlan(db, tenantId);
  if (plan.envelopesPerMonth === null) return;
  // Corre dentro de la transacción de envío: el lock de la organización serializa envíos concurrentes.
  await db.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
  const used = await envelopesSentThisMonth(db, tenantId);
  if (used >= plan.envelopesPerMonth) {
    throw planLimitError(`Llegaste al límite de ${plan.envelopesPerMonth} sobres por mes del plan ${plan.name}`, {
      plan: plan.id,
      limit: "envelopes_per_month",
      used,
      max: plan.envelopesPerMonth,
      suggestedPlan: suggest((p) => p.envelopesPerMonth === null || p.envelopesPerMonth > plan.envelopesPerMonth!),
    });
  }
}

/**
 * Miembros más invitaciones pendientes. `exceptPendingEmail`: no cuenta la invitación pendiente de ese correo (al
 * reenviarla, la nueva la reemplaza y no suma un usuario).
 */
export async function usersCount(db: Db, tenantId: string, exceptPendingEmail?: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    `SELECT (SELECT count(*) FROM memberships WHERE tenant_id = $1)::int
          + (SELECT count(*) FROM invitations WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
               AND ($2::text IS NULL OR lower(email) <> lower($2)))::int AS n`,
    [tenantId, exceptPendingEmail ?? null],
  );
  return Number(r?.n ?? 0);
}

/**
 * Cupo de usuarios para una invitación nueva. Se llama otra vez dentro de la transacción de la invitación, con la
 * organización bloqueada: dos invitaciones simultáneas no superan el cupo.
 */
export async function assertInvitationCapacity(db: Db, tenantId: string, email: string) {
  const { plan } = await tenantPlan(db, tenantId);
  if (plan.users === null) return;
  const used = await usersCount(db, tenantId, email);
  if (used >= plan.users) {
    throw planLimitError(`El plan ${plan.name} permite hasta ${plan.users} usuario(s)`, {
      plan: plan.id,
      limit: "users",
      used,
      max: plan.users,
      suggestedPlan: suggest((p) => p.users === null || p.users > plan.users!),
    });
  }
}

export function requireFeature(plan: PlanDefinition, feature: PlanFeature, label: string) {
  if (plan.features.includes(feature)) return;
  throw planLimitError(`${label} no está incluido en el plan ${plan.name}`, {
    plan: plan.id,
    feature,
    suggestedPlan: suggest((p) => p.features.includes(feature)),
  });
}

/**
 * PATCH /v1/settings/branding que pone un color o un pie de correo DISTINTOS de los guardados (lo demás: renombrar,
 * quitarlos o volver a mandar los vigentes). La web manda siempre el color y el pie actuales junto con el nombre: si
 * se comparaba solo con "viene un valor", una organización que bajó de plan con color o pie guardados no podía
 * renombrarse sin borrarlos antes.
 */
async function addsBranding(db: Db, tenantId: string, body: unknown): Promise<boolean> {
  const b = (body ?? {}) as { primaryColor?: unknown; emailFooter?: unknown };
  // Normalizados como los guarda branding.ts (color en minúsculas, pie sin espacios en los bordes).
  const color = typeof b.primaryColor === "string" ? b.primaryColor.trim().toLowerCase() : b.primaryColor;
  const footer = typeof b.emailFooter === "string" ? b.emailFooter.trim() : b.emailFooter;
  const set = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (!set(color) && !set(footer)) return false;
  const t = await db.one<{ branding: { primaryColor?: string | null; emailFooter?: string | null } | null }>(`SELECT branding FROM tenants WHERE id = $1`, [tenantId]);
  const cur = t?.branding ?? {};
  return (set(color) && color !== (cur.primaryColor ?? null)) || (set(footer) && footer !== (cur.emailFooter ?? null));
}

/** Funcionalidad que exige cada ruta de escritura (las lecturas siempre se permiten: se puede ver y desactivar lo existente). */
function featureForRoute(url: string, method: string, body: unknown): { feature: PlanFeature; label: string } | null {
  if (method === "GET" || method === "HEAD") return null;
  // Quitar o apagar lo existente tampoco exige el plan: al bajar de plan la configuración sigue en uso (SSO exigido,
  // tokens SCIM vigentes, dominio propio en los links) y sin esto no se podía revocar un token SCIM, quitar el dominio
  // ni dejar de exigir SSO sin volver a pagar.
  if (method === "DELETE") return null;
  if (url === "/v1/settings/sso" && (body as { enabled?: unknown } | null)?.enabled === false) return null;
  // Lo mismo con la marca: renombrar la organización (el nombre está en este PATCH) o quitar el color y el pie no es
  // marca propia. Sin esto, en Free no se podía corregir el nombre de la organización y, al bajar de plan, el color y el
  // pie seguían en la página del firmante y los correos sin poder quitarlos.
  // (Si pone color o pie nuevos lo decide enforcePlanForRequest con addsBranding, que mira lo guardado.)
  if (url === "/v1/settings/branding" && method === "PATCH") return null;
  if (url === "/v1/bulk-sends" || url === "/v1/bulk-sends/validate") return { feature: "bulk_send", label: "El envío masivo" };
  if (url === "/v1/web-forms") return { feature: "web_forms", label: "Los formularios web" };
  if (url === "/v1/webhooks") return { feature: "webhooks", label: "Los webhooks" };
  if (url.startsWith("/v1/settings/branding")) return { feature: "branding", label: "La marca propia" };
  if (url.startsWith("/v1/settings/sso")) return { feature: "sso", label: "El inicio de sesión único (SSO)" };
  if (url.startsWith("/v1/settings/scim")) return { feature: "scim", label: "El aprovisionamiento SCIM" };
  if (url === "/v1/domains") return { feature: "custom_domain", label: "El dominio propio" };
  if (url === "/v1/envelopes/:id/payment") return { feature: "payments", label: "El cobro al firmar" };
  if (url === "/v1/api-keys" || url === "/v1/oauth/apps") return { feature: "api", label: "El acceso por API" };
  return null;
}

/** Rutas que siempre se permiten (para poder ver el plan y mejorarlo). */
const ALWAYS_ALLOWED = /^\/v1\/(billing|me)(\/|$)/;

/**
 * Control central por plan. Lo llama enforceRoutePolicy (access.ts) para toda ruta autenticada.
 * - Acceso por API (API key / OAuth / MCP) exige la funcionalidad "api".
 * - Algunas rutas de escritura exigen su funcionalidad.
 * - Las invitaciones respetan el máximo de usuarios.
 */
export async function enforcePlanForRequest(db: Db, req: FastifyRequest, a: AuthContext) {
  const url = req.routeOptions?.url ?? req.url.split("?")[0];
  if (ALWAYS_ALLOWED.test(url)) return;
  const { plan } = await tenantPlan(db, a.tenantId);
  if (a.apiKeyId || a.oauth) requireFeature(plan, "api", "El acceso por API");
  const f = featureForRoute(url, req.method, req.body);
  if (f) requireFeature(plan, f.feature, f.label);
  if (url === "/v1/settings/branding" && req.method === "PATCH" && (await addsBranding(db, a.tenantId, req.body))) {
    requireFeature(plan, "branding", "La marca propia");
  }
  if (url === "/v1/invitations" && req.method === "POST" && plan.users !== null) {
    // Reenviar la invitación pendiente de un correo la reemplaza: no suma un usuario (antes daba 402 con el cupo lleno).
    const email = typeof (req.body as any)?.email === "string" ? (req.body as any).email : "";
    await assertInvitationCapacity(db, a.tenantId, email);
  }
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const r = await db.one<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [name]);
  return Boolean(r?.t);
}

/** Uso del mes en curso. Se calcula de las tablas de negocio (no hay contadores que se puedan desincronizar). */
export async function usageThisMonth(db: Db, tenantId: string): Promise<BillingUsage> {
  const start = monthStart();
  const period = start.toISOString().slice(0, 7);
  const [envelopesSent, users, msgs] = await Promise.all([
    envelopesSentThisMonth(db, tenantId),
    usersCount(db, tenantId),
    db.query<{ channel: string; n: number }>(
      `SELECT channel, count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND status = 'sent' AND created_at >= $2 GROUP BY channel`,
      [tenantId, start.toISOString()],
    ),
  ]);
  const by = (c: string) => Number(msgs.find((m) => m.channel === c)?.n ?? 0);
  let kycChecks = 0;
  if (await tableExists(db, "identity_verifications")) {
    const r = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_verifications WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, start.toISOString()],
    );
    kycChecks = Number(r?.n ?? 0);
  }
  let aiTokens: number | null = null;
  if (await tableExists(db, "ai_usage")) {
    try {
      const r = await db.one<{ n: number }>(
        `SELECT COALESCE(sum(input_tokens + output_tokens), 0)::bigint AS n FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, start.toISOString()],
      );
      aiTokens = Number(r?.n ?? 0);
    } catch {
      aiTokens = null;
    }
  }
  return { period, envelopesSent, users, messages: { whatsapp: by("whatsapp"), sms: by("sms"), email: by("email"), telegram: by("telegram") }, kycChecks, aiTokens };
}
