// Marca blanca: resolución de la marca efectiva (organización + sub-marca), URLs de sus archivos y textos.
// La marca por defecto vive en tenants.branding.whiteLabel (con el color/pie/logo históricos como respaldo) y las
// sub-marcas en la tabla brands; una sub-marca hereda de la marca por defecto todo lo que no define.
import {
  BRAND_ASSET_KINDS,
  customCssProblem,
  FONT_FAMILY_RE,
  googleFontCssUrl,
  themeToCss,
  verifyPageTheme,
  withoutProtectedTexts,
  type BrandAssetKind,
  type BrandConfigInput,
  type BrandLinks,
  type Locale,
  type PublicBrandTheme,
  type ResolvedBrandTheme,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { decrypt } from "../../lib/util";
import { brandText, PLATFORM_NAME, type MailBranding, type TemplateKind } from "../../notifications/templates";
import { tenantBaseUrl, tenantForHost } from "../custom-domains";

export const DEFAULT_BRAND = "default";

export interface AssetRef {
  fileId: string;
  contentType: string;
}
export type BrandAssetRefs = Partial<Record<BrandAssetKind, AssetRef | null>>;

/** Lo que se guarda en tenants.branding (las claves históricas siguen funcionando). */
export interface StoredTenantBranding {
  primaryColor?: string | null;
  emailFooter?: string | null;
  logoFileId?: string | null;
  logoContentType?: string | null;
  whiteLabel?: BrandConfigInput;
  whiteLabelAssets?: BrandAssetRefs;
  whiteLabelUpdatedAt?: string;
}

export interface ResolvedBrand {
  tenantId: string;
  tenantSlug: string;
  /** null: la marca por defecto de la organización. */
  brandId: string | null;
  /** Clave pública: id de la sub-marca o slug de la organización. */
  key: string;
  /** Nombre de la sub-marca o de la organización (el que se configura). */
  label: string;
  /** Nombre que ven los firmantes. */
  name: string;
  orgName: string;
  productName: string | null;
  whiteLabel: boolean;
  theme: ResolvedBrandTheme;
  customCss: string | null;
  links: BrandLinks;
  email: { fromName: string | null; fromEmail: string | null; replyTo: string | null; footer: string | null };
  templates: NonNullable<BrandConfigInput["templates"]>;
  texts: NonNullable<BrandConfigInput["texts"]>;
  smsSenderId: string | null;
  assets: BrandAssetRefs;
  baseUrl: string;
  /** Configuración propia (sin herencia) tal como se guardó. */
  ownConfig: BrandConfigInput;
  ownAssets: BrandAssetRefs;
  updatedAt: string | null;
}

// ───────────────────────────── Combinación ─────────────────────────────

const pick = <T>(over: T | null | undefined, base: T | null | undefined): T | null => (over !== undefined && over !== null && (over as unknown) !== "" ? over : base ?? null);

/** Sub-marca sobre la marca por defecto: lo que la sub-marca no define (null o ausente) se hereda. */
export function mergeConfig(base: BrandConfigInput, over: BrandConfigInput): BrandConfigInput {
  const theme = { ...(base.theme ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over.theme ?? {})) if (v !== null && v !== undefined) theme[k] = v;
  const links = { ...(base.links ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over.links ?? {})) if (v) links[k] = v;
  const email = { ...(base.email ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over.email ?? {})) if (v) email[k] = v;
  // Por campo (asunto, cuerpo, botón): una sub-marca que solo cambia el asunto hereda el cuerpo y el botón de la
  // organización (antes el objeto del idioma reemplazaba al de la organización entero y volvían los de la plataforma).
  const templates: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const src of [base.templates ?? {}, over.templates ?? {}])
    for (const [ev, byLocale] of Object.entries(src))
      for (const [l, tpl] of Object.entries(byLocale ?? {})) {
        const cur = ((templates[ev] ??= {})[l] ??= {});
        for (const [k, v] of Object.entries(tpl ?? {})) if (v !== null && v !== undefined && v !== "") cur[k] = v;
      }
  const texts: Record<string, Record<string, string>> = {};
  for (const src of [base.texts ?? {}, over.texts ?? {}])
    for (const [l, map] of Object.entries(src)) texts[l] = { ...(texts[l] ?? {}), ...(map ?? {}) };
  return {
    displayName: pick(over.displayName, base.displayName),
    productName: pick(over.productName, base.productName),
    hidePoweredBy: over.hidePoweredBy ?? base.hidePoweredBy ?? false,
    theme: theme as BrandConfigInput["theme"],
    customCss: [base.customCss, over.customCss].filter(Boolean).join("\n") || null,
    links: links as BrandConfigInput["links"],
    email: email as BrandConfigInput["email"],
    templates: templates as BrandConfigInput["templates"],
    texts: texts as BrandConfigInput["texts"],
    sms: { senderId: pick(over.sms?.senderId, base.sms?.senderId) },
  };
}

/** Configuración de la marca por defecto: la guardada + los campos históricos (color, pie, logo) como respaldo. */
export function defaultConfigOf(b: StoredTenantBranding): { config: BrandConfigInput; assets: BrandAssetRefs } {
  const wl = b.whiteLabel ?? {};
  const config: BrandConfigInput = {
    ...wl,
    theme: { ...(wl.theme ?? {}), primaryColor: wl.theme?.primaryColor ?? b.primaryColor ?? null },
    email: { ...(wl.email ?? {}), footer: wl.email?.footer ?? b.emailFooter ?? null },
  };
  const assets: BrandAssetRefs = { ...(b.whiteLabelAssets ?? {}) };
  if (b.logoFileId && b.logoContentType) assets.logo = { fileId: b.logoFileId, contentType: b.logoContentType };
  else delete assets.logo;
  return { config, assets };
}

// ───────────────────────────── Resolución ─────────────────────────────

/** URL base de los links de una marca: dominio verificado de la sub-marca, el de la organización o el de la plataforma. */
export async function brandBaseUrl(db: Db, tenantId: string, brandId: string | null | undefined): Promise<string> {
  if (brandId) {
    const d = await db.one<{ domain: string }>(`SELECT domain FROM brand_domains WHERE brand_id = $1 AND tenant_id = $2 AND status = 'verified'`, [brandId, tenantId]);
    if (d) return `https://${d.domain}`;
  }
  return tenantBaseUrl(db, tenantId);
}

/** URL base de los links de un sobre (según su marca). */
export async function envelopeBaseUrl(db: Db, tenantId: string, envelopeId: string): Promise<string> {
  const e = await db.one<{ brand_id: string | null }>(`SELECT brand_id FROM envelopes WHERE id = $1 AND tenant_id = $2`, [envelopeId, tenantId]);
  return brandBaseUrl(db, tenantId, e?.brand_id ?? null);
}

/** Marca dueña del Host (dominio de una sub-marca o dominio propio de la organización), o null. */
export async function brandForHost(db: Db, host: string | undefined): Promise<{ tenantId: string; brandId: string | null } | null> {
  // Sin el punto final, como tenantForHost y signerHostTenant: "firmas.marca.com." es el mismo dominio (el aislamiento de
  // sesión ya lo trataba así) y sin esto se servía la marca de la plataforma en el dominio de la sub-marca.
  const h = (host ?? "").split(":")[0].toLowerCase().replace(/\.+$/, "");
  if (!h || h === "localhost" || h === "127.0.0.1") return null;
  const b = await db.one<{ tenant_id: string; brand_id: string }>(`SELECT tenant_id, brand_id FROM brand_domains WHERE domain = $1 AND status = 'verified'`, [h]);
  if (b) return { tenantId: b.tenant_id, brandId: b.brand_id };
  const t = await tenantForHost(db, h);
  return t ? { tenantId: t, brandId: null } : null;
}

/**
 * Marca efectiva. `override`: configuración propia sin guardar (vista previa) en lugar de la guardada de esa marca.
 */
export async function resolveBrand(db: Db, tenantId: string, brandId?: string | null, opts: { override?: BrandConfigInput } = {}): Promise<ResolvedBrand> {
  const t = await db.one<{ slug: string; name: string; branding: StoredTenantBranding | null }>(`SELECT slug, name, branding FROM tenants WHERE id = $1`, [tenantId]);
  const stored = t?.branding ?? {};
  const isSub = Boolean(brandId && /^[0-9a-f-]{36}$/i.test(brandId));
  const def = defaultConfigOf(!isSub && opts.override ? { ...stored, whiteLabel: opts.override } : stored);
  let cfg = def.config;
  let assets = def.assets;
  let own = def.config;
  let ownAssets = def.assets;
  let label = t?.name ?? "";
  let id: string | null = null;
  let updatedAt = t?.branding?.whiteLabelUpdatedAt ?? null;
  if (isSub) {
    const row = await db.one<any>(`SELECT * FROM brands WHERE id = $1 AND tenant_id = $2`, [brandId, tenantId]);
    if (row) {
      id = row.id;
      label = row.name;
      own = opts.override ?? row.config ?? {};
      ownAssets = row.assets ?? {};
      cfg = mergeConfig(def.config, own);
      // Los archivos de la sub-marca reemplazan a los de la organización; los que no tiene se heredan.
      assets = { ...def.assets };
      for (const k of BRAND_ASSET_KINDS) if (ownAssets[k]) assets[k] = ownAssets[k];
      updatedAt = new Date(row.updated_at).toISOString();
    }
  }
  const th = cfg.theme ?? {};
  const theme: ResolvedBrandTheme = {
    primaryColor: th.primaryColor ?? null,
    secondaryColor: th.secondaryColor ?? null,
    backgroundColor: th.backgroundColor ?? null,
    textColor: th.textColor ?? null,
    buttonColor: th.buttonColor ?? null,
    buttonTextColor: th.buttonTextColor ?? null,
    headerTextColor: th.headerTextColor ?? null,
    borderRadius: th.borderRadius ?? null,
    fontFamily: th.fontFamily && FONT_FAMILY_RE.test(th.fontFamily) ? th.fontFamily : null,
    fontSource: th.fontSource ?? (th.fontFamily ? (assets.font ? "upload" : "google") : null),
  };
  const css = cfg.customCss && !customCssProblem(cfg.customCss) ? cfg.customCss : null;
  return {
    tenantId,
    tenantSlug: t?.slug ?? "",
    brandId: id,
    key: id ?? t?.slug ?? "",
    label,
    name: cfg.displayName || (id ? label : t?.name ?? ""),
    orgName: t?.name ?? "",
    productName: cfg.productName ?? null,
    whiteLabel: Boolean(cfg.hidePoweredBy),
    theme,
    customCss: css,
    links: {
      websiteUrl: cfg.links?.websiteUrl ?? null,
      supportUrl: cfg.links?.supportUrl ?? null,
      privacyUrl: cfg.links?.privacyUrl ?? null,
      termsUrl: cfg.links?.termsUrl ?? null,
    },
    email: {
      fromName: cfg.email?.fromName ?? null,
      fromEmail: cfg.email?.fromEmail ?? null,
      replyTo: cfg.email?.replyTo ?? null,
      footer: cfg.email?.footer ?? null,
    },
    templates: cfg.templates ?? {},
    texts: cfg.texts ?? {},
    // Remitente alfanumérico de SMS: solo para organizaciones autorizadas (SMS_ALPHANUMERIC_ALLOWED_TENANTS). Sin
    // verificar, cualquiera podía mandar los códigos como "BANCO" o el nombre de otra marca; el resto usa TWILIO_FROM.
    smsSenderId: cfg.sms?.senderId && smsAlphanumericAllowed(tenantId) ? cfg.sms.senderId : null,
    assets,
    baseUrl: await brandBaseUrl(db, tenantId, id),
    ownConfig: own,
    ownAssets,
    updatedAt,
  };
}

/** Si la organización puede usar un remitente alfanumérico propio en los SMS (lista blanca de configuración). */
export function smsAlphanumericAllowed(tenantId: string): boolean {
  return config.sms.alphanumericAllowedTenants.includes(tenantId);
}

/** Marca de un sobre (su sub-marca, o la de la organización). */
export function brandForEnvelope(db: Db, e: { tenant_id: string; brand_id?: string | null }): Promise<ResolvedBrand> {
  return resolveBrand(db, e.tenant_id, e.brand_id ?? null);
}

// ───────────────────────────── Textos y nombres ─────────────────────────────

/** Nombre del producto a mostrar: el propio, el de la marca (marca blanca total) o el de la plataforma. */
export function productLabel(b: Pick<ResolvedBrand, "productName" | "whiteLabel" | "name">): string {
  return b.productName || (b.whiteLabel ? b.name : PLATFORM_NAME);
}

/** ¿Hay que esconder el nombre de la plataforma? */
export function rebrands(b: Pick<ResolvedBrand, "productName" | "whiteLabel">): boolean {
  return Boolean(b.productName) || b.whiteLabel;
}

/** Reemplaza el nombre de la plataforma en un texto que ve un firmante. */
export function brandize(s: string, b: ResolvedBrand): string {
  return brandText(s, { productName: b.productName, hidePoweredBy: b.whiteLabel, brandName: b.name, supportUrl: b.links.supportUrl });
}

// ───────────────────────────── Archivos ─────────────────────────────

export function assetPath(b: Pick<ResolvedBrand, "key" | "assets">, kind: BrandAssetKind): string | null {
  const a = b.assets[kind];
  if (!a) return null;
  return `/v1/public/brand-assets/${encodeURIComponent(b.key)}/${kind}?v=${a.fileId.slice(-8)}`;
}

/** Tema público para la web. `absolute`: URLs con el dominio de la marca (correos, PDF). */
export function publicTheme(b: ResolvedBrand, opts: { absolute?: boolean; verify?: boolean; withPageCss?: boolean } = {}): PublicBrandTheme {
  const abs = (p: string | null) => (p && opts.absolute ? `${b.baseUrl}${p}` : p);
  const fontPath = assetPath(b, "font");
  const fontFace =
    b.theme.fontSource === "upload" && fontPath && b.theme.fontFamily
      ? `@font-face{font-family:"${b.theme.fontFamily}";src:url("${fontPath}");font-display:swap}`
      : null;
  // Página pública de verificación (`verify`): solo barra, botones y fuente, sin el CSS propio (con él una marca podía
  // ocultar el "✕" y mostrar un "✓" para un PDF adulterado).
  const fullCss = [themeToCss(b.theme, { fontFace }), b.customCss ?? ""].filter(Boolean).join("\n");
  const css = opts.verify ? themeToCss(verifyPageTheme(b.theme), { fontFace }) : fullCss;
  const texts: PublicBrandTheme["texts"] = {};
  // Sin los textos del veredicto de la verificación (configuraciones guardadas antes de que el esquema los rechazara).
  for (const [l, m] of Object.entries(b.texts)) {
    const own = withoutProtectedTexts(m);
    if (own && Object.keys(own).length) texts[l as Locale] = own;
  }
  return {
    brandId: b.brandId ?? DEFAULT_BRAND,
    name: b.name,
    productName: b.productName,
    whiteLabel: b.whiteLabel,
    theme: b.theme,
    css,
    // index.html de /verify: el CSS completo para restaurarlo al salir navegando (la web nunca lo aplica en /verify).
    ...(opts.verify && opts.withPageCss ? { pageCss: fullCss } : {}),
    links: b.links,
    logoUrl: abs(assetPath(b, "logo")),
    logoDarkUrl: abs(assetPath(b, "logoDark")),
    faviconUrl: abs(assetPath(b, "favicon")),
    fontUrl: abs(fontPath),
    fontCssUrl: b.theme.fontSource === "google" && b.theme.fontFamily ? googleFontCssUrl(b.theme.fontFamily) : null,
    texts,
  };
}

/** Marca para el HTML de los correos (los clientes de correo no muestran SVG: solo PNG/JPG). */
export function mailBranding(b: ResolvedBrand, kind: TemplateKind | "otp_code" | null, locale: string): MailBranding {
  const logo = b.assets.logo && b.assets.logo.contentType !== "image/svg+xml" ? `${b.baseUrl}${assetPath(b, "logo")}` : null;
  const tplByLocale = kind ? (b.templates as Record<string, Record<string, MailBranding["template"]>>)[kind] : null;
  return {
    primaryColor: b.theme.primaryColor,
    secondaryColor: b.theme.secondaryColor,
    buttonColor: b.theme.buttonColor,
    buttonTextColor: b.theme.buttonTextColor,
    backgroundColor: b.theme.backgroundColor,
    textColor: b.theme.textColor,
    borderRadius: b.theme.borderRadius,
    fontFamily: b.theme.fontSource === "system" ? null : b.theme.fontFamily,
    fontCssUrl: b.theme.fontSource === "google" && b.theme.fontFamily ? googleFontCssUrl(b.theme.fontFamily) : null,
    logoUrl: logo,
    footer: b.email.footer,
    productName: b.productName,
    hidePoweredBy: b.whiteLabel,
    brandName: rebrands(b) ? b.name : null,
    supportUrl: b.links.supportUrl,
    template: tplByLocale?.[locale] ?? null,
  };
}

// ───────────────────────────── Remitente ─────────────────────────────

const addressOf = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from;
const quoteName = (n: string) => `"${n.replace(/["\\\r\n]/g, "")}"`;

export interface BrandSender {
  from: string;
  replyTo: string | null;
  dkim: { domainName: string; keySelector: string; privateKey: string } | null;
  customDomain: boolean;
  warning: string | null;
}

/**
 * Remitente de los correos de una marca:
 * - con una dirección en un dominio de correo verificado: esa dirección, firmada con DKIM;
 * - si no: la dirección de la plataforma (o MAIL_FROM_WHITE_LABEL en marca blanca total) con el nombre de la marca.
 */
export async function senderFor(db: Db, b: ResolvedBrand): Promise<BrandSender> {
  const name = b.email.fromName || (rebrands(b) ? productLabel(b) : null);
  let warning: string | null = null;
  if (b.email.fromEmail) {
    const domain = b.email.fromEmail.split("@")[1] ?? "";
    const d = await db.one<any>(`SELECT * FROM email_domains WHERE tenant_id = $1 AND domain = $2`, [b.tenantId, domain]);
    if (d?.status === "verified") {
      return {
        from: `${quoteName(name || b.name)} <${b.email.fromEmail}>`,
        replyTo: b.email.replyTo,
        dkim: { domainName: domain, keySelector: d.dkim_selector, privateKey: decrypt(d.dkim_private_key_enc) },
        customDomain: true,
        warning: null,
      };
    }
    warning = `El dominio ${domain} no está verificado: los correos salen desde la dirección de la plataforma`;
  }
  const base = b.whiteLabel && config.mail.whiteLabelFrom ? config.mail.whiteLabelFrom : config.mail.from;
  return {
    from: name ? `${quoteName(name)} <${addressOf(base)}>` : base,
    // Sin dominio propio, las respuestas van a la dirección elegida (si hay) en vez de a la casilla no-reply.
    replyTo: b.email.replyTo ?? b.email.fromEmail ?? null,
    dkim: null,
    customDomain: false,
    warning,
  };
}
