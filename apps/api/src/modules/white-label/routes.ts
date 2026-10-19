// Marca blanca: API de marcas (la de la organización = "default" y sub-marcas), archivos, vista previa, dominios web de
// sub-marcas, dominios de correo (SPF/DKIM) y tema público para la web. Ver docs/MARCA-BLANCA.md.
import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BRAND_ASSET_KINDS,
  BRAND_ASSET_MAX_BYTES,
  BrandConfigInput,
  BrandPreviewInput,
  CreateBrandInput,
  customCssProblem,
  SetDomainInput,
  UpdateBrandInput,
  type Brand,
  type BrandAssetKind,
  type BrandDomain,
  type BrandEmailPreview,
  type EmailDomain,
  type EmailDomainRecord,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { encrypt, iso, randomToken, sha256Hex, slugify, uuidv7 } from "../../lib/util";
import { render, type TemplateKind } from "../../notifications/templates";
import { auditFromRequest, recordAudit } from "../audit";
import { authenticate, type AuthContext, type Services } from "../context";
import { requireFeature, tenantPlan } from "../billing/plans";
import { invalidateDomainCache, resolveTxt, routesToPlatform } from "../custom-domains";
import { deleteFileIfUnused, discardBlobsOnFailure } from "../file-cleanup";
import {
  brandForHost,
  DEFAULT_BRAND,
  mailBranding,
  publicTheme,
  resolveBrand,
  senderFor,
  type BrandAssetRefs,
  type ResolvedBrand,
  type StoredTenantBranding,
} from "./brand";
import { OTP_MESSAGES } from "./otp-text";

const isLocalEnv = () => config.environment === "local";
const appHost = () => new URL(config.appUrl).hostname.toLowerCase();
const platformRoot = () => appHost().split(".").slice(-2).join(".");

// Registros DNS con nombres neutros (sin la marca de la plataforma): los ve el administrador del cliente final.
const brandTxtName = (d: string) => `_brand-verify.${d}`;
const brandTxtValue = (t: string) => `brand-verify=${t}`;
const mailTxtName = (d: string) => `_mail-verify.${d}`;
const mailTxtValue = (t: string) => `mail-verify=${t}`;

// ───────────────────────────── Plan ─────────────────────────────

/** Lo que es marca blanca (no simple marca): ocultar la plataforma, textos/plantillas, remitente, sub-marcas, dominios. */
function usesWhiteLabel(c: BrandConfigInput): boolean {
  return Boolean(
    c.hidePoweredBy ||
      c.productName ||
      c.customCss ||
      c.email?.fromEmail ||
      c.sms?.senderId ||
      Object.values(c.templates ?? {}).some((x) => x && Object.keys(x).length) ||
      Object.values(c.texts ?? {}).some((x) => x && Object.keys(x).length),
  );
}

async function requireWhiteLabel(db: Db, tenantId: string) {
  const { plan } = await tenantPlan(db, tenantId);
  requireFeature(plan, "white_label", "La marca blanca");
}

async function requireBranding(db: Db, tenantId: string) {
  const { plan } = await tenantPlan(db, tenantId);
  requireFeature(plan, "branding", "La marca propia");
}

// ───────────────────────────── Validación ─────────────────────────────

async function validateConfig(db: Db, tenantId: string, c: BrandConfigInput) {
  if (c.customCss) {
    const p = customCssProblem(c.customCss);
    if (p) throw badRequest("invalid_css", `CSS propio: ${p}`);
  }
  if (c.email?.fromEmail) {
    const domain = c.email.fromEmail.split("@")[1];
    const d = await db.one(`SELECT 1 FROM email_domains WHERE tenant_id = $1 AND domain = $2`, [tenantId, domain]);
    if (!d) throw badRequest("email_domain_required", `Agregá y verificá el dominio de correo ${domain} antes de usarlo como remitente`);
  }
}

// ───────────────────────────── Salida ─────────────────────────────

function domainToApi(r: any): BrandDomain {
  return {
    domain: r.domain,
    status: r.status,
    txtName: brandTxtName(r.domain),
    txtValue: brandTxtValue(r.verification_token),
    cnameTarget: appHost(),
    verifiedAt: iso(r.verified_at),
    lastCheckedAt: iso(r.last_checked_at),
    lastError: r.last_error,
  };
}

async function toApi(db: Db, b: ResolvedBrand): Promise<Brand> {
  const theme = publicTheme(b);
  const sender = await senderFor(db, b);
  const dom = b.brandId ? await db.one<any>(`SELECT * FROM brand_domains WHERE brand_id = $1`, [b.brandId]) : null;
  const own = publicTheme({ ...b, assets: b.ownAssets });
  return {
    id: b.brandId ?? DEFAULT_BRAND,
    name: b.label,
    slug: b.key,
    isDefault: !b.brandId,
    config: b.ownConfig,
    assets: { logoUrl: own.logoUrl, logoDarkUrl: own.logoDarkUrl, faviconUrl: own.faviconUrl, fontUrl: own.fontUrl },
    emailSender: { from: sender.from, replyTo: sender.replyTo, customDomain: sender.customDomain, warning: sender.warning },
    domain: dom ? domainToApi(dom) : null,
    baseUrl: b.baseUrl,
    effective: theme,
    updatedAt: b.updatedAt,
  };
}

async function loadBrand(db: Db, tenantId: string, id: string, override?: BrandConfigInput): Promise<ResolvedBrand> {
  if (id === DEFAULT_BRAND) return resolveBrand(db, tenantId, null, { override });
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Marca");
  const row = await db.one(`SELECT 1 FROM brands WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!row) throw notFound("Marca");
  return resolveBrand(db, tenantId, id, { override });
}

/** Valida el brandId de un sobre (de la organización). Lo usan las rutas de sobres. */
export async function applyEnvelopeBrand(db: Db, tenantId: string, envelopeId: string, brandId: string | null | undefined) {
  if (brandId === undefined) return;
  if (brandId !== null) {
    const ok = await db.one(`SELECT 1 FROM brands WHERE id = $1 AND tenant_id = $2`, [brandId, tenantId]);
    if (!ok) throw badRequest("invalid_brand", "La marca no existe en esta organización");
  }
  await db.query(`UPDATE envelopes SET brand_id = $2 WHERE id = $1 AND tenant_id = $3`, [envelopeId, brandId, tenantId]);
}

// ───────────────────────────── Archivos ─────────────────────────────

function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
  const sig = buf.subarray(0, 4).toString("latin1");
  if (sig === "wOF2") return "font/woff2";
  if (sig === "wOFF") return "font/woff";
  if (sig === "OTTO") return "font/otf";
  if (sig === "\x00\x01\x00\x00" || sig === "true") return "font/ttf";
  const head = buf.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

const unsafeSvg = (svg: string) => /<script|on[a-z]+\s*=|javascript:|<foreignObject|xlink:href\s*=\s*["'](?!#)|href\s*=\s*["'](?!#)|<!ENTITY/i.test(svg);

function allowedType(kind: BrandAssetKind, type: string): boolean {
  if (kind === "font") return type.startsWith("font/");
  if (kind === "favicon") return ["image/png", "image/svg+xml", "image/x-icon"].includes(type);
  return ["image/png", "image/jpeg", "image/svg+xml"].includes(type);
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

/** Lee y escribe las referencias a archivos de una marca (default: tenants.branding; sub-marca: brands.assets). */
async function setAsset(db: Db, tenantId: string, brandId: string, kind: BrandAssetKind, ref: { fileId: string; contentType: string } | null): Promise<string | null> {
  if (brandId === DEFAULT_BRAND) {
    const cur = await db.one<{ branding: StoredTenantBranding }>(`SELECT branding FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    const b = cur?.branding ?? {};
    if (kind === "logo") {
      // El logo de la marca por defecto es el histórico (lo usan también /v1/settings/branding y los formularios web).
      const prev = b.logoFileId ?? null;
      await db.query(`UPDATE tenants SET branding = COALESCE(branding,'{}'::jsonb) || $2::jsonb WHERE id = $1`, [
        tenantId,
        JSON.stringify({ logoFileId: ref?.fileId ?? null, logoContentType: ref?.contentType ?? null }),
      ]);
      return prev;
    }
    const assets: BrandAssetRefs = { ...(b.whiteLabelAssets ?? {}) };
    const prev = assets[kind]?.fileId ?? null;
    assets[kind] = ref;
    await db.query(`UPDATE tenants SET branding = COALESCE(branding,'{}'::jsonb) || $2::jsonb WHERE id = $1`, [tenantId, JSON.stringify({ whiteLabelAssets: assets })]);
    return prev;
  }
  const row = await db.one<any>(`SELECT assets FROM brands WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [brandId, tenantId]);
  if (!row) throw notFound("Marca");
  const assets: BrandAssetRefs = { ...(row.assets ?? {}) };
  const prev = assets[kind]?.fileId ?? null;
  assets[kind] = ref;
  await db.query(`UPDATE brands SET assets = $2, updated_at = now() WHERE id = $1`, [brandId, JSON.stringify(assets)]);
  return prev;
}

// ───────────────────────────── Dominios de correo ─────────────────────────────

function emailDomainRecords(r: any, found?: { own: boolean; dkim: boolean; spf: boolean | null; dmarc: boolean | null }): EmailDomainRecord[] {
  const recs: EmailDomainRecord[] = [
    { purpose: "ownership", type: "TXT", name: mailTxtName(r.domain), value: mailTxtValue(r.verification_token), ok: found?.own ?? null, required: true },
    { purpose: "dkim", type: "TXT", name: `${r.dkim_selector}._domainkey.${r.domain}`, value: `v=DKIM1; k=rsa; p=${r.dkim_public_key}`, ok: found?.dkim ?? null, required: true },
  ];
  if (config.mail.spfInclude) {
    recs.push({ purpose: "spf", type: "TXT", name: r.domain, value: `v=spf1 include:${config.mail.spfInclude} ~all`, ok: found?.spf ?? r.spf_ok ?? null, required: false });
  }
  recs.push({ purpose: "dmarc", type: "TXT", name: `_dmarc.${r.domain}`, value: "v=DMARC1; p=none;", ok: found?.dmarc ?? r.dmarc_ok ?? null, required: false });
  return recs;
}

function emailDomainToApi(r: any, found?: Parameters<typeof emailDomainRecords>[1]): EmailDomain {
  return {
    domain: r.domain,
    status: r.status,
    records: emailDomainRecords(r, found),
    verifiedAt: iso(r.verified_at),
    lastCheckedAt: iso(r.last_checked_at),
    lastError: r.last_error,
  };
}

/**
 * Consulta los registros del dominio de correo. `strict`: un error de DNS en el TXT de propiedad o en el de DKIM se
 * propaga en vez de contar como "no publicado" (la re-verificación periódica no desverifica por una falla de la consulta).
 */
async function checkEmailDomain(r: any, opts: { strict?: boolean } = {}) {
  const clean = (vs: string[]) => vs.map((v) => v.replace(/\s+/g, " ").trim());
  const txt = async (n: string) => clean(await resolveTxt(n).catch(() => [] as string[]));
  const required = async (n: string) => (opts.strict ? clean(await resolveTxt(n)) : txt(n));
  const [own, dkim, root, dmarc] = await Promise.all([
    required(mailTxtName(r.domain)),
    required(`${r.dkim_selector}._domainkey.${r.domain}`),
    txt(r.domain),
    txt(`_dmarc.${r.domain}`),
  ]);
  const found = {
    own: own.includes(mailTxtValue(r.verification_token)),
    dkim: dkim.some((v) => v.replace(/\s/g, "").includes(`p=${r.dkim_public_key}`)),
    spf: config.mail.spfInclude ? root.some((v) => v.startsWith("v=spf1") && v.includes(`include:${config.mail.spfInclude}`)) : null,
    dmarc: dmarc.some((v) => v.startsWith("v=DMARC1")),
  };
  return found;
}

// ───────────────────────────── Re-verificación periódica ─────────────────────────────

/**
 * Dominios web de sub-marcas y dominios de correo verificados: se vuelven a consultar cada 6 h. Un dominio que dejó de
 * estar publicado (o de apuntar a la plataforma) vuelve a "pendiente" a la segunda falta seguida (a la cuarta si son errores de
 * DNS): los links pasan al
 * dominio de la organización y los correos a la dirección de la plataforma.
 */
export async function recheckWhiteLabelDomains(d: { db: Db; log: { warn(o: object, m?: string): void } }) {
  const brands = await d.db.query<any>(
    `SELECT * FROM brand_domains WHERE status = 'verified' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '6 hours') ORDER BY last_checked_at NULLS FIRST LIMIT 20`,
  );
  for (const r of brands) {
    let ok = false;
    // Como en custom-domains.ts: una falta (TXT o CNAME) suma 2 y un error de DNS 1, y se baja con 4. Antes un error
    // contaba como falta y una caída de los resolvers (SERVFAIL, timeout) de 12 h desverificaba todas las sub-marcas.
    let points = 2;
    try {
      ok = (await resolveTxt(brandTxtName(r.domain))).includes(brandTxtValue(r.verification_token)) && (isLocalEnv() || (await routesToPlatform(r.domain)));
    } catch (e) {
      points = 1;
      d.log.warn({ domain: r.domain, err: String(e) }, "no se pudo re-verificar el dominio de la marca");
    }
    const failures = ok ? 0 : Number(r.recheck_failures ?? 0) + points;
    if (failures >= 4) {
      await d.db.query(`UPDATE brand_domains SET status = 'pending', recheck_failures = 0, last_checked_at = now(), last_error = $2 WHERE id = $1`, [
        r.id,
        "Re-verificación: el registro TXT o el CNAME ya no están publicados",
      ]);
      invalidateDomainCache();
      await recordAudit(d.db, { tenantId: r.tenant_id, action: "brand.domain_unverified", actor: { type: "system", label: "Re-verificación de dominio" }, targetType: "domain", targetId: r.domain });
    } else {
      await d.db.query(`UPDATE brand_domains SET recheck_failures = $2, last_checked_at = now(), last_error = $3 WHERE id = $1`, [r.id, failures, ok ? null : "Re-verificación fallida"]);
    }
  }
  const mails = await d.db.query<any>(
    `SELECT * FROM email_domains WHERE status = 'verified' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '6 hours') ORDER BY last_checked_at NULLS FIRST LIMIT 20`,
  );
  for (const r of mails) {
    // Con strict: si el DNS no responde, f es null y el dominio sigue verificado (antes una sola consulta fallida lo
    // pasaba a pendiente y los correos de la marca salían con la dirección de la plataforma).
    const f = await checkEmailDomain(r, { strict: true }).catch((e) => {
      d.log.warn({ domain: r.domain, err: String(e) }, "no se pudo re-verificar el dominio de correo");
      return null;
    });
    if (f && (!f.own || !f.dkim)) {
      await d.db.query(`UPDATE email_domains SET status = 'pending', last_checked_at = now(), last_error = $2 WHERE id = $1`, [r.id, "Re-verificación: falta el TXT de propiedad o la clave DKIM"]);
    } else if (f) {
      await d.db.query(`UPDATE email_domains SET last_checked_at = now(), spf_ok = $2, dmarc_ok = $3 WHERE id = $1`, [r.id, f.spf, f.dmarc]);
    } else {
      await d.db.query(`UPDATE email_domains SET last_checked_at = now() WHERE id = $1`, [r.id]);
    }
  }
}

const isDirectLoopback = (req: FastifyRequest) => {
  const ra = req.socket.remoteAddress ?? "";
  return (ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1") && !req.headers["x-forwarded-for"];
};

function assertClaimable(domain: string) {
  for (const root of new Set([platformRoot(), "calasign.com", "calasign.io"])) {
    if (domain === appHost() || domain === root || domain.endsWith(`.${root}`)) throw badRequest("reserved_domain", `No se pueden usar dominios de ${root}`);
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function whiteLabelRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest): AuthContext => req.auth!;
  type P = { Params: { id: string; kind?: string; domain?: string } };

  app.get("/v1/settings/brands", { preHandler: auth }, async (req) => {
    const a = A(req);
    const rows = await s.db.query<{ id: string }>(`SELECT id FROM brands WHERE tenant_id = $1 ORDER BY lower(name)`, [a.tenantId]);
    const items = [await toApi(s.db, await resolveBrand(s.db, a.tenantId, null))];
    for (const r of rows) items.push(await toApi(s.db, await resolveBrand(s.db, a.tenantId, r.id)));
    return { items };
  });

  app.post("/v1/settings/brands", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await requireWhiteLabel(s.db, a.tenantId);
    const input = CreateBrandInput.parse(req.body);
    if (input.config) await validateConfig(s.db, a.tenantId, input.config);
    const id = uuidv7();
    const slug = `${slugify(input.name).slice(0, 40) || "marca"}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    try {
      await s.db.query(`INSERT INTO brands (id, tenant_id, name, slug, config) VALUES ($1,$2,$3,$4,$5)`, [id, a.tenantId, input.name, slug, JSON.stringify(input.config ?? {})]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("brand_exists", "Ya hay una marca con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "brand.created", { targetType: "brand", targetId: id, data: { name: input.name } });
    return reply.code(201).send(await toApi(s.db, await resolveBrand(s.db, a.tenantId, id)));
  });

  app.get<P>("/v1/settings/brands/:id", { preHandler: auth }, async (req) => toApi(s.db, await loadBrand(s.db, A(req).tenantId, req.params.id)));

  app.put<P>("/v1/settings/brands/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateBrandInput.parse(req.body);
    const cur = await loadBrand(s.db, a.tenantId, req.params.id);
    await requireBranding(s.db, a.tenantId);
    if (usesWhiteLabel(input.config) || cur.brandId) await requireWhiteLabel(s.db, a.tenantId);
    await validateConfig(s.db, a.tenantId, input.config);
    if (!cur.brandId) {
      // La marca por defecto también actualiza los campos históricos (los leen /v1/settings/branding y otros módulos).
      await s.db.query(`UPDATE tenants SET branding = COALESCE(branding,'{}'::jsonb) || $2::jsonb WHERE id = $1`, [
        a.tenantId,
        JSON.stringify({
          whiteLabel: input.config,
          whiteLabelUpdatedAt: new Date().toISOString(),
          primaryColor: input.config.theme?.primaryColor?.toLowerCase() ?? null,
          emailFooter: input.config.email?.footer?.trim() || null,
        }),
      ]);
    } else {
      try {
        await s.db.query(`UPDATE brands SET config = $3, name = COALESCE($4, name), updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
          cur.brandId,
          a.tenantId,
          JSON.stringify(input.config),
          input.name ?? null,
        ]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw conflict("brand_exists", "Ya hay una marca con ese nombre");
        throw e;
      }
    }
    await auditFromRequest(s.db, req, a, "brand.updated", { targetType: "brand", targetId: cur.brandId ?? DEFAULT_BRAND });
    return toApi(s.db, await loadBrand(s.db, a.tenantId, req.params.id));
  });

  app.delete<P>("/v1/settings/brands/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (req.params.id === DEFAULT_BRAND) throw badRequest("default_brand", "La marca de la organización no se puede borrar");
    const b = await loadBrand(s.db, a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM brands WHERE id = $1 AND tenant_id = $2`, [b.brandId, a.tenantId]);
    invalidateDomainCache();
    for (const k of BRAND_ASSET_KINDS) await deleteFileIfUnused(s.db, s.blobs, b.ownAssets[k]?.fileId).catch(() => {});
    await auditFromRequest(s.db, req, a, "brand.deleted", { targetType: "brand", targetId: b.brandId! });
    return reply.code(204).send();
  });

  // Vista previa: correo de un evento o el tema, con la configuración sin guardar combinada con la guardada.
  app.post<P>("/v1/settings/brands/:id/preview", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = BrandPreviewInput.parse(req.body ?? {});
    if (input.config?.customCss) {
      const p = customCssProblem(input.config.customCss);
      if (p) throw badRequest("invalid_css", `CSS propio: ${p}`);
    }
    const b = await loadBrand(s.db, a.tenantId, req.params.id, input.config);
    if (input.kind === "theme") return { theme: publicTheme(b) };
    const vars = {
      recipientName: "Ana Pérez",
      senderName: "Juan García",
      organizationName: b.name,
      subject: input.locale === "en" ? "Service agreement" : input.locale === "pt-BR" ? "Contrato de serviços" : "Contrato de servicios",
      message: input.locale === "en" ? "Hi Ana, please sign before Friday." : input.locale === "pt-BR" ? "Olá Ana, assine antes de sexta." : "Hola Ana, firmalo antes del viernes.",
      link: `${b.baseUrl}/s/EJEMPLO`,
      reason: "—",
      declinedBy: "Ana Pérez",
    };
    const sender = await senderFor(s.db, b);
    if (input.event === "otp_code") {
      const m = OTP_MESSAGES(b, input.locale, "123456", vars.subject);
      return { subject: m.subject, text: m.text, html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${m.text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`, from: sender.from } satisfies BrandEmailPreview;
    }
    const m = render(input.event as TemplateKind, input.locale, vars, mailBranding(b, input.event as TemplateKind, input.locale));
    return { subject: m.subject, html: m.html, text: m.text, from: sender.from } satisfies BrandEmailPreview;
  });

  app.post<P>("/v1/settings/brands/:id/assets/:kind", { preHandler: auth }, async (req) => {
    const a = A(req);
    const kind = req.params.kind as BrandAssetKind;
    if (!(BRAND_ASSET_KINDS as readonly string[]).includes(kind)) throw notFound("Tipo de archivo");
    const b = await loadBrand(s.db, a.tenantId, req.params.id);
    await requireBranding(s.db, a.tenantId);
    if (kind !== "logo" || b.brandId) await requireWhiteLabel(s.db, a.tenantId);
    const max = BRAND_ASSET_MAX_BYTES[kind];
    const file = await req.file({ limits: { fileSize: max } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, "file_too_large", `El archivo supera los ${Math.round(max / 1024)} KB`);
    const type = sniff(buf);
    if (!type || !allowedType(kind, type)) throw badRequest("invalid_asset", kind === "font" ? "La fuente tiene que ser WOFF2, WOFF, TTF u OTF" : "Formato de imagen no admitido");
    if (type === "image/svg+xml" && unsafeSvg(buf.toString("utf8"))) throw badRequest("invalid_asset", "El SVG contiene scripts o referencias externas");
    const fileId = uuidv7();
    const key = `tenants/${a.tenantId}/branding/${fileId}.${EXT[type]}`;
    await s.blobs.put(key, buf, type);
    const prev = await discardBlobsOnFailure(s.blobs, [key], () =>
      s.db.tx(async (t) => {
        await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'logo',$3,$4,$5,$6)`, [
          fileId,
          a.tenantId,
          key,
          type,
          buf.length,
          sha256Hex(buf),
        ]);
        return setAsset(t, a.tenantId, req.params.id, kind, { fileId, contentType: type });
      }),
    );
    await deleteFileIfUnused(s.db, s.blobs, prev).catch(() => {});
    return toApi(s.db, await loadBrand(s.db, a.tenantId, req.params.id));
  });

  app.delete<P>("/v1/settings/brands/:id/assets/:kind", { preHandler: auth }, async (req) => {
    const a = A(req);
    const kind = req.params.kind as BrandAssetKind;
    if (!(BRAND_ASSET_KINDS as readonly string[]).includes(kind)) throw notFound("Tipo de archivo");
    await loadBrand(s.db, a.tenantId, req.params.id);
    const prev = await s.db.tx((t) => setAsset(t, a.tenantId, req.params.id, kind, null));
    await deleteFileIfUnused(s.db, s.blobs, prev).catch(() => {});
    return toApi(s.db, await loadBrand(s.db, a.tenantId, req.params.id));
  });

  // ───────── Dominio web de una sub-marca ─────────

  app.put<P>("/v1/settings/brands/:id/domain", { preHandler: auth }, async (req) => {
    const a = A(req);
    await requireWhiteLabel(s.db, a.tenantId);
    if (req.params.id === DEFAULT_BRAND) throw badRequest("use_custom_domain", "La marca de la organización usa Ajustes → Dominio propio (/v1/domains)");
    const b = await loadBrand(s.db, a.tenantId, req.params.id);
    const { domain } = SetDomainInput.parse(req.body);
    assertClaimable(domain);
    const taken =
      (await s.db.one(`SELECT 1 FROM brand_domains WHERE domain = $1 AND status = 'verified' AND brand_id <> $2`, [domain, b.brandId])) ??
      (await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [domain]));
    if (taken) throw conflict("domain_taken", "Ese dominio ya está en uso");
    const cur = await s.db.one<any>(`SELECT * FROM brand_domains WHERE brand_id = $1`, [b.brandId]);
    if (cur?.domain !== domain) {
      await s.db.tx(async (t) => {
        await t.query(`DELETE FROM brand_domains WHERE brand_id = $1`, [b.brandId]);
        await t.query(`INSERT INTO brand_domains (id, tenant_id, brand_id, domain, verification_token) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), a.tenantId, b.brandId, domain, randomToken(18)]);
      });
      invalidateDomainCache();
      await auditFromRequest(s.db, req, a, "brand.domain_set", { targetType: "domain", targetId: domain });
    }
    return { domain: domainToApi(await s.db.one<any>(`SELECT * FROM brand_domains WHERE brand_id = $1`, [b.brandId])) };
  });

  app.post<P>("/v1/settings/brands/:id/domain/verify", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    const b = await loadBrand(s.db, a.tenantId, req.params.id);
    const r = b.brandId ? await s.db.one<any>(`SELECT * FROM brand_domains WHERE brand_id = $1`, [b.brandId]) : null;
    if (!r) throw notFound("Dominio");
    let ok = false;
    let error: string | null = null;
    try {
      const values = await resolveTxt(brandTxtName(r.domain));
      ok = values.includes(brandTxtValue(r.verification_token));
      if (!ok) error = `No se encontró el registro TXT ${brandTxtName(r.domain)}`;
    } catch (e) {
      error = `No se pudo consultar el DNS: ${String((e as Error).message ?? e)}`;
    }
    if (ok && !isLocalEnv() && !(await routesToPlatform(r.domain).catch(() => false))) {
      ok = false;
      error = `El dominio todavía no apunta a la plataforma: creá el CNAME ${r.domain} → ${appHost()}`;
    }
    if (ok && (await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [r.domain]))) {
      ok = false;
      error = "Ese dominio ya está en uso";
    }
    try {
      await s.db.query(
        `UPDATE brand_domains SET status = CASE WHEN $2 THEN 'verified' ELSE status END, verified_at = CASE WHEN $2 AND verified_at IS NULL THEN now() ELSE verified_at END,
           last_checked_at = now(), last_error = $3, recheck_failures = CASE WHEN $2 THEN 0 ELSE recheck_failures END WHERE id = $1`,
        // Un intento fallido no pone el contador en cero: si no, reintentar a mano mantenía verificado para siempre un
        // dominio que la re-verificación ya estaba por bajar (como en custom-domains.ts).
        [r.id, ok, error],
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e;
      ok = false;
      await s.db.query(`UPDATE brand_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1`, [r.id, "Ese dominio ya lo verificó otra organización"]);
    }
    invalidateDomainCache();
    if (ok) await auditFromRequest(s.db, req, a, "brand.domain_verified", { targetType: "domain", targetId: r.domain });
    return { domain: domainToApi(await s.db.one<any>(`SELECT * FROM brand_domains WHERE id = $1`, [r.id])) };
  });

  app.delete<P>("/v1/settings/brands/:id/domain", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const b = await loadBrand(s.db, a.tenantId, req.params.id);
    if (b.brandId) await s.db.query(`DELETE FROM brand_domains WHERE brand_id = $1`, [b.brandId]);
    invalidateDomainCache();
    return reply.code(204).send();
  });

  // ───────── Dominios de correo (remitente propio) ─────────

  app.get("/v1/settings/email-domains", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(`SELECT * FROM email_domains WHERE tenant_id = $1 ORDER BY domain`, [A(req).tenantId]);
    return { items: rows.map((r) => emailDomainToApi(r)) };
  });

  app.post("/v1/settings/email-domains", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await requireWhiteLabel(s.db, a.tenantId);
    const { domain } = SetDomainInput.parse(req.body);
    assertClaimable(domain);
    const existing = await s.db.one<any>(`SELECT * FROM email_domains WHERE tenant_id = $1 AND domain = $2`, [a.tenantId, domain]);
    if (existing) return emailDomainToApi(existing);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const selector = `s${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "1"}`;
    await s.db.query(
      `INSERT INTO email_domains (id, tenant_id, domain, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), a.tenantId, domain, randomToken(18), selector, pub, encrypt(priv)],
    );
    await auditFromRequest(s.db, req, a, "email_domain.added", { targetType: "domain", targetId: domain });
    return reply.code(201).send(emailDomainToApi(await s.db.one<any>(`SELECT * FROM email_domains WHERE tenant_id = $1 AND domain = $2`, [a.tenantId, domain])));
  });

  app.post<P>("/v1/settings/email-domains/:domain/verify", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    const r = await s.db.one<any>(`SELECT * FROM email_domains WHERE tenant_id = $1 AND domain = $2`, [a.tenantId, String(req.params.domain).toLowerCase()]);
    if (!r) throw notFound("Dominio de correo");
    const f = await checkEmailDomain(r);
    let ok = f.own && f.dkim;
    const error = ok ? null : !f.own ? `Falta el TXT ${mailTxtName(r.domain)}` : `Falta la clave DKIM ${r.dkim_selector}._domainkey.${r.domain}`;
    try {
      await s.db.query(
        `UPDATE email_domains SET status = CASE WHEN $2 THEN 'verified' ELSE 'pending' END, verified_at = CASE WHEN $2 AND verified_at IS NULL THEN now() ELSE verified_at END,
           spf_ok = $3, dmarc_ok = $4, last_checked_at = now(), last_error = $5 WHERE id = $1`,
        [r.id, ok, f.spf, f.dmarc, error],
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e;
      // Lo verificó otra organización: no quedó verificado (ni se audita como tal).
      ok = false;
      await s.db.query(`UPDATE email_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1`, [r.id, "Ese dominio ya lo verificó otra organización"]);
    }
    if (ok) await auditFromRequest(s.db, req, a, "email_domain.verified", { targetType: "domain", targetId: r.domain });
    return emailDomainToApi(await s.db.one<any>(`SELECT * FROM email_domains WHERE id = $1`, [r.id]), f);
  });

  app.delete<P>("/v1/settings/email-domains/:domain", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await s.db.one<any>(`DELETE FROM email_domains WHERE tenant_id = $1 AND domain = $2 RETURNING domain`, [a.tenantId, String(req.params.domain).toLowerCase()]);
    if (r) await auditFromRequest(s.db, req, a, "email_domain.removed", { targetType: "domain", targetId: r.domain });
    return reply.code(204).send();
  });

  // ───────── Público ─────────

  /**
   * Tema de la marca para la web: por ?b= (id de sub-marca o slug de la organización, lo usa el link de verificación
   * del certificado) o por el Host (dominio propio). 404 si no hay marca: la web usa la de la plataforma.
   */
  app.get<{ Querystring: { b?: string } }>("/v1/public/brand-theme", async (req, reply) => {
    const found = await brandFromKeyOrHost(s.db, req.query.b, req.headers.host);
    if (!found) return reply.code(404).send({ error: { code: "not_found", message: "Sin marca" } });
    reply.header("cache-control", "public, max-age=60");
    return publicTheme(await resolveBrand(s.db, found.tenantId, found.brandId));
  });

  app.get<{ Params: { key: string; kind: string } }>("/v1/public/brand-assets/:key/:kind", async (req, reply) => {
    const kind = req.params.kind as BrandAssetKind;
    if (!(BRAND_ASSET_KINDS as readonly string[]).includes(kind)) throw notFound("Archivo");
    const found = await brandFromKeyOrHost(s.db, req.params.key, undefined);
    if (!found) throw notFound("Archivo");
    const b = await resolveBrand(s.db, found.tenantId, found.brandId);
    const ref = b.assets[kind];
    if (!ref) throw notFound("Archivo");
    const f = await s.db.one<any>(`SELECT storage_key, content_type FROM files WHERE id = $1 AND tenant_id = $2`, [ref.fileId, found.tenantId]);
    if (!f) throw notFound("Archivo");
    reply
      .header("content-type", f.content_type)
      .header("cache-control", "public, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .header("access-control-allow-origin", "*")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(Buffer.from(await s.blobs.get(f.storage_key)));
  });

  // Caddy (on_demand_tls → ask): dominios propios de organizaciones Y de sub-marcas. Reemplaza a /internal/tls-allowed.
  app.get<{ Querystring: { domain?: string } }>("/internal/tls-allowed-brand", async (req, reply) => {
    if (!isDirectLoopback(req)) return reply.code(404).send();
    const d = String(req.query.domain ?? "").toLowerCase();
    if (d && d === appHost()) return reply.code(200).send("ok");
    const r = d
      ? ((await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [d])) ??
        (await s.db.one(`SELECT 1 FROM brand_domains WHERE domain = $1 AND status = 'verified'`, [d])))
      : null;
    return reply.code(r ? 200 : 404).send(r ? "ok" : "");
  });

  // En el dominio de una sub-marca valen los mismos ganchos que en un dominio propio (custom-domains.ts): sin sesión de
  // cuenta y sin links de firma de OTRAS organizaciones.
}

/** Marca por clave pública (id de sub-marca o slug de organización) o, sin clave, por el Host. */
export async function brandFromKeyOrHost(db: Db, key: string | undefined, host: string | undefined): Promise<{ tenantId: string; brandId: string | null } | null> {
  if (key) {
    if (/^[0-9a-f-]{36}$/i.test(key)) {
      const b = await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM brands WHERE id = $1`, [key]);
      if (b) return { tenantId: b.tenant_id, brandId: key };
    }
    const t = await db.one<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [key]);
    if (t) return { tenantId: t.id, brandId: null };
    return null;
  }
  return brandForHost(db, host);
}
