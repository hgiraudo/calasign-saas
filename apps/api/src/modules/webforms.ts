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
  type WebFormInactiveCode,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { decrypt, encrypt, iso, sha256Hex, slugify, uuidv7 } from "../lib/util";
import { getTenantBranding } from "./branding";
import { assertTemplateAccess, envelopeVisibilitySql, hasPerm, templateVisibilitySql } from "./access";
import { ownerProblem } from "./owner-check";
import { tenantPlan } from "./billing/plans";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { setFrameAncestors } from "./embed";
import { sendEnvelope } from "./envelopes";
import { insertEnvelopeFromTemplate, loadTemplateForUse, planFromTemplate, type LoadedTemplate } from "./templates";
import { tenantBaseUrl } from "./custom-domains";

/** Tiempo mínimo entre abrir el formulario y enviarlo (un humano tarda más; un bot, menos). */
const MAX_SUBMISSIONS_PER_HOUR = 60;
const MIN_FILL_MS = 2500;
const MAX_FILL_MS = 2 * 3600_000;

type FormRow = any;

type FormProblem = { code: WebFormInactiveCode; message: string };

function toWebForm(r: FormRow, templateName: string, base: string, problem: FormProblem | null): WebForm {
  return {
    id: r.id,
    slug: r.slug,
    url: `${base}/f/${r.slug}`,
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
    ownerInactiveReason: problem?.message ?? null,
    ownerInactiveCode: problem?.code ?? null,
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
    // El idioma de quien completa el formulario es solo el suyo (va en su destinatario): el sobre (certificado, avisos
    // a los destinatarios fijos sin idioma propio) sigue con el de la plantilla u organización.
    recipients: [
      ...(form.fixed_recipients ?? []).map((x: any) => ({ ...x, channels: x.channels ?? ["email"] })),
      { roleId: form.signer_role_id, name: signer.name, email: signer.email, phone: signer.phone ?? null, channels: ["email"] as ("email" | "whatsapp" | "telegram")[], locale: signer.locale ?? null },
    ],
    prefill: form.prefill ?? {},
    send: false,
  };
}

/**
 * Los sobres de un formulario son de quien lo creó: cambiarlo (p. ej. poner otro firmante fijo, que recibe cada envío)
 * o borrarlo es como operar sobre sus sobres, así que lo hace quien lo creó o quien administra todos los sobres.
 */
function assertCanManageForm(a: AuthContext, form: FormRow) {
  if (hasPerm(a, "envelopes:manage_all")) return;
  if (a.apiKeyId ? form.created_by_api_key === a.apiKeyId : a.userId && form.created_by === a.userId) return;
  throw forbidden("Solo quien creó el formulario (o quien administra todos los sobres) puede modificarlo");
}

/** Valida la configuración del formulario contra su plantilla (roles y prellenado). */
function checkConfig(l: LoadedTemplate, form: { template_id: string; signer_role_id: string; fixed_recipients: any[]; prefill: Record<string, string> }) {
  const role = l.tpl.roles.find((r) => r.id === form.signer_role_id);
  if (!role) throw badRequest("invalid_role", "El rol de quien completa el formulario no existe en la plantilla");
  if (role.role !== "signer") throw badRequest("invalid_role", "Quien completa el formulario tiene que ser un rol firmante");
  // Y le tiene que tocar firmar primero: quien completa un formulario se registra solo (no se le mandan avisos hasta
  // validar su correo), así que si firma después de otros nunca recibía el link y el sobre vencía.
  const first = Math.min(...l.tpl.roles.filter((r) => r.role !== "cc").map((r) => r.routingOrder));
  if (role.routingOrder > first) {
    throw badRequest("invalid_role", "Quien completa el formulario tiene que firmar primero (su rol tiene que estar en el primer turno de la plantilla)");
  }
  if (form.fixed_recipients.some((x) => x.roleId === form.signer_role_id)) {
    throw badRequest("invalid_role", "El rol de quien completa el formulario no puede tener un destinatario fijo");
  }
  try {
    planFromTemplate(l, buildInput(form, { name: "Validación", email: "validacion@example.com" }) as any);
  } catch (e) {
    throw badRequest("invalid_form", `La plantilla no queda completa con esta configuración: ${(e as Error).message}`);
  }
}

/**
 * Un formulario embebible con código: quien lo completa firma dentro del iframe (?embed=1), donde la cookie de la
 * sesión del código no se guarda, y quedaba pidiendo el código sin fin.
 */
function assertEmbeddableWithoutOtp(embeddable: unknown, requireOtp: unknown) {
  if (embeddable && requireOtp) throw badRequest("invalid_form", "Un formulario embebible no puede pedir código por correo (dentro de un iframe la verificación no se conserva)");
}

/** Dueño de los sobres del formulario: el usuario o la API key que lo creó. */
const formOwner = (form: FormRow) => ({ tenantId: form.tenant_id as string, userId: (form.created_by ?? null) as string | null, apiKeyId: (form.created_by_api_key ?? null) as string | null });

/**
 * Por qué un formulario activo no crea sobres: el plan de la organización ya no incluye formularios web (bajó de plan:
 * sin esto, los formularios existentes seguían creando sobres desde la página pública), o quien lo configuró ya no
 * puede crearlos. null si está habilitado. Lo usan la página pública, el envío y la consola (mismo criterio).
 */
async function formProblem(db: Db, r: FormRow, planFeatures?: readonly string[]): Promise<FormProblem | null> {
  const features = planFeatures ?? (await tenantPlan(db, r.tenant_id)).plan.features;
  return (await accessProblem(db, r, features)) ?? configProblem(db, r);
}

/** Plan y dueño (sin la configuración de cada formulario): lo que comparten los formularios de un mismo dueño y plantilla. */
async function accessProblem(db: Db, r: FormRow, planFeatures: readonly string[]): Promise<FormProblem | null> {
  if (!planFeatures.includes("web_forms")) return { code: "plan_feature", message: "El plan actual de la organización no incluye formularios web" };
  if (r.created_by_api_key && !planFeatures.includes("api")) {
    return { code: "plan_feature", message: "El plan actual de la organización no incluye el acceso por API (el formulario lo creó una API key)" };
  }
  return ownerProblem(db, formOwner(r), r.template_id);
}

/**
 * La plantilla pudo cambiar después de publicar el formulario (rol que pasó a aprobador o copia, campos o roles que ya
 * no cierran con el prellenado): la página pública y la consola lo muestran no disponible, como lo rechaza el envío.
 */
async function configProblem(db: Db, r: FormRow, templates?: Map<string, Promise<any>>): Promise<FormProblem | null> {
  try {
    let tpl = templates?.get(r.template_id);
    if (!tpl) {
      tpl = loadTemplateForUse(db, r.tenant_id, r.template_id);
      tpl.catch(() => {});
      templates?.set(r.template_id, tpl);
    }
    checkConfig(await tpl, r as any);
    return null;
  } catch (e) {
    return { code: "misconfigured", message: `El formulario ya no coincide con su plantilla: ${(e as Error).message}` };
  }
}

/**
 * Estado para la administración: el mismo chequeo que hace la página pública. Sin esto, un formulario que no crea
 * sobres figuraba "activo" en la consola mientras el público lo veía no disponible. Se calcula una vez por dueño y
 * plantilla (en un listado, varios formularios suelen compartirlos).
 */
async function formStates(db: Db, tenantId: string, rows: FormRow[]): Promise<Map<string, FormProblem | null>> {
  const planFeatures = (await tenantPlan(db, tenantId)).plan.features;
  const memo = new Map<string, Promise<FormProblem | null>>();
  const templates = new Map<string, Promise<any>>();
  const out = new Map<string, FormProblem | null>();
  for (const r of rows) {
    const o = formOwner(r);
    const k = `${o.userId ?? ""}|${o.apiKeyId ?? ""}|${r.template_id}`;
    if (!memo.has(k)) memo.set(k, accessProblem(db, r, planFeatures));
    // La configuración es de cada formulario (no del dueño ni de la plantilla): se mira aparte, con la plantilla cargada una vez.
    out.set(r.id, (await memo.get(k)!) ?? (await configProblem(db, r, templates)));
  }
  return out;
}

async function webFormOut(db: Db, r: FormRow, base?: string): Promise<WebForm> {
  const problem = (await formStates(db, r.tenant_id, [r])).get(r.id) ?? null;
  return toWebForm(r, r.template_name, base ?? (await tenantBaseUrl(db, r.tenant_id)), problem);
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
    // Como al crearlo: los formularios de una plantilla restringida solo los ve quien puede ver la plantilla.
    const params: unknown[] = [A(req).tenantId];
    const visible = templateVisibilitySql(A(req), params);
    const rows = await s.db.query<any>(
      `SELECT w.*, t.name AS template_name FROM web_forms w JOIN templates t ON t.id = w.template_id WHERE w.tenant_id = $1${visible} ORDER BY w.created_at DESC`,
      params,
    );
    const base = await tenantBaseUrl(s.db, req.auth!.tenantId);
    const owners = await formStates(s.db, req.auth!.tenantId, rows);
    return { items: rows.map((r) => toWebForm(r, r.template_name, base, owners.get(r.id) ?? null)) };
  });

  app.post("/v1/web-forms", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = WebFormInput.parse(req.body);
    // Una plantilla restringida no se puede publicar sin poder verla.
    await assertTemplateAccess(s.db, a, input.templateId, "view");
    const l = await loadTemplateForUse(s.db, a.tenantId, input.templateId);
    const row = { template_id: input.templateId, signer_role_id: input.signerRoleId, fixed_recipients: input.fixedRecipients, prefill: input.prefill ?? {} };
    checkConfig(l, row);
    assertEmbeddableWithoutOtp(input.embeddable, input.requireOtp);
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO web_forms (id, tenant_id, template_id, slug, name, description, signer_role_id, fixed_recipients, prefill, active, max_uses,
         expires_at, require_otp, embeddable, collect_phone, created_by, created_by_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        a.apiKeyId,
      ],
    );
    reply.code(201);
    const r = await load(a.tenantId, id);
    return webFormOut(s.db, r);
  });

  app.get<P>("/v1/web-forms/:id", { preHandler: auth }, async (req) => {
    const r = await load(A(req).tenantId, req.params.id);
    await assertTemplateAccess(s.db, A(req), r.template_id, "view");
    return webFormOut(s.db, r);
  });

  app.patch<P>("/v1/web-forms/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateWebFormInput.parse(req.body);
    const cur = await load(a.tenantId, req.params.id);
    assertCanManageForm(a, cur);
    // Igual que al crearlo: no se modifica un formulario de una plantilla restringida que no se puede ver.
    await assertTemplateAccess(s.db, a, cur.template_id, "view");
    const next = {
      template_id: cur.template_id,
      signer_role_id: input.signerRoleId ?? cur.signer_role_id,
      fixed_recipients: input.fixedRecipients ?? cur.fixed_recipients,
      prefill: input.prefill ?? cur.prefill,
    };
    if (input.signerRoleId || input.fixedRecipients || input.prefill) checkConfig(await loadTemplateForUse(s.db, a.tenantId, cur.template_id), next);
    // Solo si el pedido toca esas opciones: un formulario viejo con las dos se puede seguir pausando o editando.
    if (input.embeddable !== undefined || input.requireOtp !== undefined) {
      assertEmbeddableWithoutOtp(input.embeddable ?? cur.embeddable, input.requireOtp ?? cur.require_otp);
    }
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
    return webFormOut(s.db, r);
  });

  app.delete<P>("/v1/web-forms/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const cur = await load(a.tenantId, req.params.id);
    assertCanManageForm(a, cur);
    await assertTemplateAccess(s.db, a, cur.template_id, "view");
    await s.db.query(`DELETE FROM web_forms WHERE id = $1 AND tenant_id = $2`, [cur.id, a.tenantId]);
    return reply.code(204).send();
  });

  app.get<P>("/v1/web-forms/:id/envelopes", { preHandler: auth }, async (req) => {
    const a = A(req);
    await load(a.tenantId, req.params.id);
    // Los sobres del formulario son de quien lo creó: cada uno ve solo los que puede ver en el listado de sobres.
    const params: unknown[] = [a.tenantId, req.params.id];
    const visible = envelopeVisibilitySql(a, params);
    const envs = await s.db.query<any>(
      `SELECT * FROM envelopes e WHERE e.tenant_id = $1 AND e.metadata->>'webFormId' = $2${visible} ORDER BY e.created_at DESC LIMIT 200`,
      params,
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
    // Si quien lo creó ya no puede crear sobres (dejó la organización, perdió el permiso, key revocada) o el plan ya
    // no incluye formularios web, no se ofrece.
    const reason = availability(r) ?? ((await formProblem(s.db, r)) ? "inactive" : null);
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
      // Token vencido o ajeno: no hace falta recargar la página (se perderían los datos cargados). La web pide un token
      // nuevo (GET del formulario) y vuelve a enviar pasados MIN_FILL_MS; el código es estable y el texto lo traduce la web.
      const expiredToken = () =>
        new AppError(400, "invalid_form_token", "El formulario venció: volvé a enviarlo en unos segundos", { retryAfterSeconds: Math.ceil(MIN_FILL_MS / 1000) });
      let tok: { s: string; t: number };
      try {
        tok = JSON.parse(decrypt(input.formToken));
      } catch {
        throw expiredToken();
      }
      const age = Date.now() - tok.t;
      if (tok.s !== req.params.slug || age > MAX_FILL_MS) throw expiredToken();
      if (age < MIN_FILL_MS) throw new AppError(422, "too_fast", "Esperá unos segundos y volvé a enviar");

      const form = await s.db.one<any>(`SELECT * FROM web_forms WHERE slug = $1`, [req.params.slug]);
      if (!form) throw notFound("Formulario");
      const reason = availability(form);
      if (reason) throw new AppError(410, `form_${reason}`, "Este formulario ya no está disponible");
      // Los sobres se crean a nombre de quien lo configuró: si ya no puede crearlos (o el plan ya no incluye
      // formularios web), el formulario no los crea.
      const problem = await formProblem(s.db, form);
      if (problem) {
        req.log.warn({ webFormId: form.id, reason: problem.code }, "formulario web no habilitado");
        throw new AppError(410, "form_inactive", "Este formulario ya no está disponible");
      }
      if (form.collect_phone && !input.phone) throw badRequest("phone_required", "El teléfono es obligatorio");

      const loaded = await loadTemplateForUse(s.db, form.tenant_id, form.template_id);
      // La plantilla pudo cambiar después de publicar el formulario (p. ej. el rol pasó a aprobador o copia): sin esto,
      // quien completa el formulario sin verificar quedaba como aprobador o recibía la copia final sin firmar.
      try {
        checkConfig(loaded, form);
      } catch (e) {
        req.log.warn({ webFormId: form.id, err: String(e) }, "formulario web mal configurado");
        throw conflict("form_misconfigured", "Este formulario no está disponible");
      }
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
        if (!locked || availability(locked)) throw new AppError(410, "form_unavailable", "Este formulario ya no está disponible");
        // Un envío por token (si la transacción falla, el token vuelve a servir).
        const fresh = await t.query(`INSERT INTO web_form_token_uses (token_hash) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [sha256Hex(input.formToken)]);
        if (!fresh.length) throw expiredToken();
        // Tope por formulario: cada envío crea y manda un sobre (y consume la cuota del plan de la organización).
        const recent = await t.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM envelopes WHERE tenant_id = $1 AND metadata->>'webFormId' = $2 AND created_at > now() - interval '1 hour'`,
          [form.tenant_id, form.id],
        );
        if ((recent?.n ?? 0) >= MAX_SUBMISSIONS_PER_HOUR) throw new AppError(429, "form_rate_limited", "Demasiados envíos de este formulario: probá más tarde");
        const id = await insertEnvelopeFromTemplate(
          t,
          { ...formOwner(form), actor },
          loaded,
          fromTpl as any,
          plan,
          { webFormId: form.id, webFormName: form.name },
          (byRole) => (signerRecipientId = byRole.get(form.signer_role_id) ?? ""),
        );
        // El correo lo escribió quien completa el formulario y no está verificado: no recibe invitaciones ni
        // recordatorios (evita usar el formulario para mandar correos a terceros). Con OTP por correo, la invitación
        // de respaldo sale recién cuando valida el código; la copia final después de firmar sale igual.
        await t.query(`UPDATE recipients SET self_registered = true WHERE id = $1`, [signerRecipientId]);
        if (form.require_otp) await t.query(`UPDATE recipients SET auth_method = 'otp_email' WHERE id = $1`, [signerRecipientId]);
        await appendEvent(t, {
          tenantId: form.tenant_id,
          envelopeId: id,
          type: "recipient.self_registered",
          actor: { type: "recipient", id: signerRecipientId, label: `${input.name} <${input.email}>`, ip, userAgent },
          data: { webFormId: form.id, webFormName: form.name, slug: form.slug, otp: form.require_otp },
        });
        // Sin cuota del plan: a quien completa el formulario (anónimo) no se le muestran el plan ni el uso de la organización.
        await sendEnvelope(t, form.tenant_id, id, actor).catch((e) => {
          if (e instanceof AppError && e.code === "plan_limit") {
            req.log.warn({ webFormId: form.id }, "formulario web: la organización llegó al límite de su plan");
            throw new AppError(410, "form_inactive", "Este formulario ya no está disponible");
          }
          throw e;
        });
        await t.query(`UPDATE web_forms SET uses = uses + 1, updated_at = now() WHERE id = $1`, [form.id]);
        return id;
      });
      const r = await s.db.one<any>(`SELECT access_token_enc FROM recipients WHERE id = $1`, [signerRecipientId]);
      reply.code(201);
      return { envelopeId: envId, signingPath: `/s/${decrypt(r.access_token_enc)}${input.embed && form.embeddable && !form.require_otp ? "?embed=1" : ""}` };
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

