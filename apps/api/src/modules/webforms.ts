// Formularios web públicos (PowerForms, Fase 4): un link /f/:slug creado desde una plantilla, donde
// cualquiera se registra (nombre y correo), se crea su sobre y entra directo a firmar.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  SubmitWebFormInput,
  UpdateWebFormInput,
  WebFormInput,
  type PublicWebForm,
  type SubmitWebFormResponse,
  type WebForm,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { decrypt, encrypt, iso, slugify, uuidv7 } from "../lib/util";
import { getTenantBranding } from "./branding";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { setFrameAncestors } from "./embed";
import { sendEnvelope } from "./envelopes";
import { insertEnvelopeFromTemplate, loadTemplateForUse, planFromTemplate, type LoadedTemplate } from "./templates";

/** Tiempo mínimo entre abrir el formulario y enviarlo (un humano tarda más; un bot, menos). */
const MIN_FILL_MS = 2500;
const MAX_FILL_MS = 2 * 3600_000;

type FormRow = any;

function toWebForm(r: FormRow, templateName: string): WebForm {
  return {
    id: r.id,
    slug: r.slug,
    url: `${config.appUrl}/f/${r.slug}`,
    name: r.name,
    description: r.description,
    templateId: r.template_id,
    templateName,
    signerRoleId: r.signer_role_id,
    fixedRecipients: (r.fixed_recipients ?? []).map((x: any) => ({
      roleId: x.roleId,
      name: x.name,
      email: x.email ?? null,
      phone: x.phone ?? null,
      channels: x.channels ?? ["email"],
      locale: x.locale ?? null,
    })),
    prefill: r.prefill ?? {},
    active: r.active,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: iso(r.expires_at),
    requireOtp: r.require_otp,
    embeddable: r.embeddable,
    collectPhone: r.collect_phone,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

function availability(r: FormRow): PublicWebForm["unavailableReason"] {
  if (!r.active) return "inactive";
  if (r.expires_at && new Date(r.expires_at) <= new Date()) return "expired";
  if (r.max_uses != null && r.uses >= r.max_uses) return "exhausted";
  return null;
}

/** Arma el pedido "sobre desde plantilla" para quien completa el formulario. */
function buildInput(form: FormRow, signer: { name: string; email: string; phone?: string | null; locale?: string }) {
  return {
    templateId: form.template_id,
    locale: signer.locale as "es" | "pt-BR" | "en" | undefined,
    recipients: [
      ...(form.fixed_recipients ?? []).map((x: any) => ({ ...x, channels: x.channels ?? ["email"] })),
      { roleId: form.signer_role_id, name: signer.name, email: signer.email, phone: signer.phone ?? null, channels: ["email"] as ("email" | "whatsapp" | "telegram")[], locale: signer.locale ?? null },
    ],
    prefill: form.prefill ?? {},
    send: false,
  };
}

/** Valida la configuración del formulario contra su plantilla (roles y prellenado). */
function checkConfig(l: LoadedTemplate, form: { template_id: string; signer_role_id: string; fixed_recipients: any[]; prefill: Record<string, string> }) {
  const role = l.tpl.roles.find((r) => r.id === form.signer_role_id);
  if (!role) throw badRequest("invalid_role", "El rol de quien completa el formulario no existe en la plantilla");
  if (role.role !== "signer") throw badRequest("invalid_role", "Quien completa el formulario tiene que ser un rol firmante");
  if (form.fixed_recipients.some((x) => x.roleId === form.signer_role_id)) {
    throw badRequest("invalid_role", "El rol de quien completa el formulario no puede tener un destinatario fijo");
  }
  try {
    planFromTemplate(l, buildInput(form, { name: "Validación", email: "validacion@example.com" }) as any);
  } catch (e) {
    throw badRequest("invalid_form", `La plantilla no queda completa con esta configuración: ${(e as Error).message}`);
  }
}

async function uniqueSlug(db: Db, name: string) {
  for (let i = 0; i < 5; i++) {
    const slug = `${slugify(name).slice(0, 32)}-${randomBytes(3).toString("hex")}`;
    if (!(await db.one(`SELECT 1 FROM web_forms WHERE slug = $1`, [slug]))) return slug;
  }
  return randomBytes(8).toString("hex");
}

export async function webFormRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type P = { Params: { id: string } };

  const load = async (tenantId: string, id: string) => {
    const r = await s.db.one<any>(
      `SELECT w.*, t.name AS template_name FROM web_forms w JOIN templates t ON t.id = w.template_id WHERE w.id = $1 AND w.tenant_id = $2`,
      [id, tenantId],
    );
    if (!r) throw notFound("Formulario");
    return r;
  };

  // ───────── Administración (remitente) ─────────

  app.get("/v1/web-forms", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT w.*, t.name AS template_name FROM web_forms w JOIN templates t ON t.id = w.template_id WHERE w.tenant_id = $1 ORDER BY w.created_at DESC`,
      [A(req).tenantId],
    );
    return { items: rows.map((r) => toWebForm(r, r.template_name)) };
  });

  app.post("/v1/web-forms", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = WebFormInput.parse(req.body);
    const l = await loadTemplateForUse(s.db, a.tenantId, input.templateId);
    const row = { template_id: input.templateId, signer_role_id: input.signerRoleId, fixed_recipients: input.fixedRecipients, prefill: input.prefill ?? {} };
    checkConfig(l, row);
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO web_forms (id, tenant_id, template_id, slug, name, description, signer_role_id, fixed_recipients, prefill, active, max_uses,
         expires_at, require_otp, embeddable, collect_phone, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        a.tenantId,
        input.templateId,
        await uniqueSlug(s.db, input.name),
        input.name,
        input.description ?? null,
        input.signerRoleId,
        JSON.stringify(input.fixedRecipients),
        JSON.stringify(input.prefill ?? {}),
        input.active,
        input.maxUses ?? null,
        input.expiresAt ?? null,
        input.requireOtp,
        input.embeddable,
        input.collectPhone,
        a.userId,
      ],
    );
    reply.code(201);
    const r = await load(a.tenantId, id);
    return toWebForm(r, r.template_name);
  });

  app.get<P>("/v1/web-forms/:id", { preHandler: auth }, async (req) => {
    const r = await load(A(req).tenantId, req.params.id);
    return toWebForm(r, r.template_name);
  });

  app.patch<P>("/v1/web-forms/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateWebFormInput.parse(req.body);
    const cur = await load(a.tenantId, req.params.id);
    const next = {
      template_id: cur.template_id,
      signer_role_id: input.signerRoleId ?? cur.signer_role_id,
      fixed_recipients: input.fixedRecipients ?? cur.fixed_recipients,
      prefill: input.prefill ?? cur.prefill,
    };
    if (input.signerRoleId || input.fixedRecipients || input.prefill) checkConfig(await loadTemplateForUse(s.db, a.tenantId, cur.template_id), next);
    const has = (k: keyof typeof input) => input[k] !== undefined;
    await s.db.query(
      `UPDATE web_forms SET name = $2, description = $3, signer_role_id = $4, fixed_recipients = $5, prefill = $6, active = $7,
         max_uses = $8, expires_at = $9, require_otp = $10, embeddable = $11, collect_phone = $12, updated_at = now()
       WHERE id = $1`,
      [
        cur.id,
        input.name ?? cur.name,
        has("description") ? input.description ?? null : cur.description,
        next.signer_role_id,
        JSON.stringify(next.fixed_recipients),
        JSON.stringify(next.prefill),
        input.active ?? cur.active,
        has("maxUses") ? input.maxUses ?? null : cur.max_uses,
        has("expiresAt") ? input.expiresAt ?? null : cur.expires_at,
        input.requireOtp ?? cur.require_otp,
        input.embeddable ?? cur.embeddable,
        input.collectPhone ?? cur.collect_phone,
      ],
    );
    const r = await load(a.tenantId, cur.id);
    return toWebForm(r, r.template_name);
  });

  app.delete<P>("/v1/web-forms/:id", { preHandler: auth }, async (req, reply) => {
    const r = await s.db.query(`DELETE FROM web_forms WHERE id = $1 AND tenant_id = $2 RETURNING id`, [req.params.id, A(req).tenantId]);
    if (!r.length) throw notFound("Formulario");
    reply.code(204).send();
  });

  app.get<P>("/v1/web-forms/:id/envelopes", { preHandler: auth }, async (req) => {
    const a = A(req);
    await load(a.tenantId, req.params.id);
    const envs = await s.db.query<any>(
      `SELECT * FROM envelopes WHERE tenant_id = $1 AND metadata->>'webFormId' = $2 ORDER BY created_at DESC LIMIT 200`,
      [a.tenantId, req.params.id],
    );
    const ids = envs.map((e) => e.id);
    const recips = ids.length
      ? await s.db.query<any>(`SELECT envelope_id, name, email, status, role FROM recipients WHERE envelope_id = ANY($1) ORDER BY routing_order, created_at`, [ids])
      : [];
    return {
      items: envs.map((e) => ({
        id: e.id,
        subject: e.subject,
        status: e.status,
        createdAt: iso(e.created_at),
        completedAt: iso(e.completed_at),
        recipients: recips.filter((r) => r.envelope_id === e.id).map((r) => ({ name: r.name, email: r.email, status: r.status, role: r.role })),
      })),
    };
  });

  // ───────── Público ─────────

  const publicRl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.get<{ Params: { slug: string } }>("/v1/public/forms/:slug", publicRl, async (req): Promise<PublicWebForm> => {
    const r = await s.db.one<any>(`SELECT * FROM web_forms WHERE slug = $1`, [req.params.slug]);
    if (!r) throw notFound("Formulario");
    const [org, brand, tpl] = await Promise.all([
      s.db.one<any>(`SELECT name, default_locale FROM tenants WHERE id = $1`, [r.tenant_id]),
      getTenantBranding(s.db, r.tenant_id),
      s.db.one<any>(`SELECT locale FROM templates WHERE id = $1`, [r.template_id]),
    ]);
    const reason = availability(r);
    const logoPath = brand.logoUrl ? new URL(brand.logoUrl).pathname + new URL(brand.logoUrl).search : null;
    return {
      slug: r.slug,
      name: r.name,
      description: r.description,
      organizationName: org?.name ?? "",
      branding: brand.primaryColor || logoPath ? { primaryColor: brand.primaryColor, logoUrl: logoPath } : null,
      available: reason === null,
      unavailableReason: reason,
      requireOtp: r.require_otp,
      collectPhone: r.collect_phone,
      locale: tpl?.locale ?? org?.default_locale ?? "es",
      formToken: encrypt(JSON.stringify({ s: r.slug, t: Date.now() })),
    };
  });

  app.post<{ Params: { slug: string } }>(
    "/v1/public/forms/:slug/submit",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply): Promise<SubmitWebFormResponse> => {
      const input = SubmitWebFormInput.parse(req.body);
      // Protección básica contra bots: trampa invisible + tiempo de llenado + token firmado del formulario.
      if (input.website) throw new AppError(422, "rejected", "No se pudo procesar el formulario");
      let tok: { s: string; t: number };
      try {
        tok = JSON.parse(decrypt(input.formToken));
      } catch {
        throw badRequest("invalid_form_token", "El formulario venció: recargá la página");
      }
      const age = Date.now() - tok.t;
      if (tok.s !== req.params.slug || age > MAX_FILL_MS) throw badRequest("invalid_form_token", "El formulario venció: recargá la página");
      if (age < MIN_FILL_MS) throw new AppError(422, "too_fast", "Esperá unos segundos y volvé a enviar");

      const form = await s.db.one<any>(`SELECT * FROM web_forms WHERE slug = $1`, [req.params.slug]);
      if (!form) throw notFound("Formulario");
      const reason = availability(form);
      if (reason) throw new AppError(410, `form_${reason}`, "Este formulario ya no está disponible");
      if (form.collect_phone && !input.phone) throw badRequest("phone_required", "El teléfono es obligatorio");

      const loaded = await loadTemplateForUse(s.db, form.tenant_id, form.template_id);
      const fromTpl = buildInput(form, { name: input.name, email: input.email, phone: input.phone, locale: input.locale });
      let plan;
      try {
        plan = planFromTemplate(loaded, fromTpl as any);
      } catch (e) {
        throw conflict("form_misconfigured", `El formulario no está bien configurado: ${(e as Error).message}`);
      }
      const { ip, userAgent } = clientInfo(req);
      const actor: Actor = { type: "system", label: `Formulario web: ${form.name}`, ip, userAgent };
      let signerRecipientId = "";
      const envId = await s.db.tx(async (t) => {
        const locked = await t.one<any>(`SELECT * FROM web_forms WHERE id = $1 FOR UPDATE`, [form.id]);
        if (availability(locked)) throw new AppError(410, "form_unavailable", "Este formulario ya no está disponible");
        const id = await insertEnvelopeFromTemplate(
          t,
          { tenantId: form.tenant_id, userId: form.created_by, apiKeyId: null, actor },
          loaded,
          fromTpl as any,
          plan,
          { webFormId: form.id, webFormName: form.name },
          (byRole) => (signerRecipientId = byRole.get(form.signer_role_id) ?? ""),
        );
        if (form.require_otp) await t.query(`UPDATE recipients SET auth_method = 'otp_email' WHERE id = $1`, [signerRecipientId]);
        await appendEvent(t, {
          tenantId: form.tenant_id,
          envelopeId: id,
          type: "recipient.self_registered",
          actor: { type: "recipient", id: signerRecipientId, label: `${input.name} <${input.email}>`, ip, userAgent },
          data: { webFormId: form.id, webFormName: form.name, slug: form.slug, otp: form.require_otp },
        });
        await sendEnvelope(t, form.tenant_id, id, actor);
        await t.query(`UPDATE web_forms SET uses = uses + 1, updated_at = now() WHERE id = $1`, [form.id]);
        return id;
      });
      const r = await s.db.one<any>(`SELECT access_token_enc FROM recipients WHERE id = $1`, [signerRecipientId]);
      reply.code(201);
      return { envelopeId: envId, signingPath: `/s/${decrypt(r.access_token_enc)}${input.embed && form.embeddable ? "?embed=1" : ""}` };
    },
  );

  // Formularios embebibles: /f/:slug?embed=1 se puede enmarcar desde los orígenes autorizados de la organización.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET") return payload;
    const m = /^\/f\/([a-z0-9-]{3,80})(?:\?(.*))?$/.exec(req.url);
    if (!m) return payload;
    const form = await s.db.one<any>(`SELECT tenant_id, embeddable FROM web_forms WHERE slug = $1`, [m[1]]);
    if (form?.embeddable && /(?:^|&)embed=1(?:&|$)/.test(m[2] ?? "")) {
      const t = await s.db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [form.tenant_id]);
      setFrameAncestors(reply, t?.embed_frame_ancestors ?? []);
    }
    return payload;
  });
}

