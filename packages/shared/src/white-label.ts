// Marca blanca: tema completo, textos, correos, dominios y sub-marcas por organización.
// La configuración de la marca por defecto vive en tenants.branding (junto al color/logo/pie históricos) y la de cada
// sub-marca (organización revendedora con varios clientes) en la tabla brands. Ver docs/MARCA-BLANCA.md.
import { z } from "zod";
import { LOCALES } from "./api";
import { HEX_COLOR } from "./productivity";

// ───────────────────────────── Eventos de correo y variables ─────────────────────────────

/** Correos (y SMS de código) cuyas plantillas puede reescribir la organización. */
export const BRAND_MESSAGE_EVENTS = [
  "invite",
  "reminder",
  "expiry_warning",
  "certificate_request",
  "completed",
  "declined",
  "voided",
  "sender_completed",
  "sender_declined",
  "finalize_failed",
  "otp_code",
] as const;
export type BrandMessageEvent = (typeof BRAND_MESSAGE_EVENTS)[number];

/** Variables disponibles en las plantillas: {{recipientName}}, {{link}}, … */
export const BRAND_TEMPLATE_VARIABLES = [
  "recipientName",
  "senderName",
  "organizationName",
  "subject",
  "message",
  "link",
  "reason",
  "declinedBy",
  "productName",
  "supportUrl",
  "code",
] as const;
export type BrandTemplateVariable = (typeof BRAND_TEMPLATE_VARIABLES)[number];

/** Reemplaza {{variable}} (con o sin espacios). Las desconocidas quedan vacías. */
export function fillTemplate(tpl: string, vars: Partial<Record<string, string | null | undefined>>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}

// ───────────────────────────── Esquemas de entrada ─────────────────────────────

const color = z.string().regex(HEX_COLOR, "color en formato #RRGGBB").nullable().optional();
/** Nombre de familia de Google Fonts o de la fuente subida (letras, números y espacios). */
export const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/;
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//i.test(u) || /^mailto:/i.test(u), "tiene que empezar con https:// o mailto:")
  .nullable()
  .optional();
/** Nombre visible sin caracteres que rompan un encabezado de correo. */
const displayName = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[<>"\r\n\\]/.test(s), 'sin < > " \\ ni saltos de línea')
    .nullable()
    .optional();

export const BrandThemeInput = z
  .object({
    /** Barra superior, encabezados y certificado. */
    primaryColor: color,
    /** Acentos: links, progreso, foco. */
    secondaryColor: color,
    backgroundColor: color,
    textColor: color,
    /** Botón principal (Firmar, Finalizar). */
    buttonColor: color,
    buttonTextColor: color,
    /** Texto sobre la barra superior. */
    headerTextColor: color,
    /** Radio de bordes en px (botones, tarjetas). */
    borderRadius: z.number().int().min(0).max(24).nullable().optional(),
    fontFamily: z.string().trim().regex(FONT_FAMILY_RE, "solo letras, números y espacios").nullable().optional(),
    /** system: pila del sistema; google: Google Fonts; upload: la fuente subida (woff2/woff/ttf/otf). */
    fontSource: z.enum(["system", "google", "upload"]).nullable().optional(),
  })
  .strict();
export type BrandThemeInput = z.infer<typeof BrandThemeInput>;

export const BrandLinksInput = z.object({ websiteUrl: httpsUrl, supportUrl: httpsUrl, privacyUrl: httpsUrl, termsUrl: httpsUrl }).strict();
export type BrandLinksInput = z.infer<typeof BrandLinksInput>;

export const BrandEmailInput = z
  .object({
    /** Nombre del remitente ("Firmas ACME"). */
    fromName: displayName(100),
    /** Dirección del remitente: tiene que estar en un dominio de correo verificado de la organización. */
    fromEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    replyTo: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    /** Pie de los correos (reemplaza al pie de la plataforma si la marca oculta "Powered by"). */
    footer: z.string().max(1000).nullable().optional(),
  })
  .strict();
export type BrandEmailInput = z.infer<typeof BrandEmailInput>;

export const BrandTemplateInput = z
  .object({
    subject: z.string().max(300).nullable().optional(),
    /** Texto plano con {{variables}}; cada línea en blanco separa párrafos. */
    body: z.string().max(10_000).nullable().optional(),
    /** Texto del botón. */
    cta: z.string().max(60).nullable().optional(),
  })
  .strict();
export type BrandTemplateInput = z.infer<typeof BrandTemplateInput>;

const localeRecord = <T extends z.ZodTypeAny>(v: T) =>
  z.object(Object.fromEntries(LOCALES.map((l) => [l, v.optional()])) as Record<(typeof LOCALES)[number], z.ZodOptional<T>>).strict();

export const TEXT_KEY_RE = /^[a-zA-Z0-9_.-]{1,80}$/;

/** Textos de la página de verificación que una marca sí puede cambiar (título e introducción). */
export const VERIFY_TEXT_KEYS_ALLOWED: readonly string[] = ["verify.title", "verify.text"];

/**
 * Textos que una marca NO puede reemplazar: el veredicto y los datos de la verificación pública (verify.*: válido, no
 * coincide, cadena rota, tabla del sobre…) y el reporte técnico de validación del PDF (val.*). Con un texto propio, una
 * marca podía hacer que /verify?b=<marca> dijera "Documento válido ✓" para un PDF adulterado.
 */
export function isProtectedTextKey(key: string): boolean {
  if (key.startsWith("val.")) return true;
  return key.startsWith("verify.") && !VERIFY_TEXT_KEYS_ALLOWED.includes(key);
}

/** Quita de los textos propios las claves protegidas (para configuraciones guardadas antes de la validación). */
export function withoutProtectedTexts<T extends Record<string, string> | undefined>(m: T): T {
  if (!m) return m;
  return Object.fromEntries(Object.entries(m).filter(([k]) => !isProtectedTextKey(k))) as T;
}

/** La configuración sin textos protegidos (por idioma; los idiomas que quedan vacíos se quitan). */
export function withoutProtectedConfigTexts<T extends { texts?: Partial<Record<string, Record<string, string> | undefined>> }>(cfg: T): T {
  if (!cfg?.texts) return cfg;
  const texts: Record<string, Record<string, string>> = {};
  for (const [l, m] of Object.entries(cfg.texts)) {
    const own = withoutProtectedTexts(m);
    if (own && Object.keys(own).length) texts[l] = own;
  }
  return { ...cfg, texts };
}

/**
 * Textos propios de un idioma. Las claves protegidas (isProtectedTextKey) se DESCARTAN en vez de rechazarse: la consola
 * reenvía la configuración completa al guardar y una marca con claves verify.* / val.* guardadas antes de la validación
 * no podía guardar nada (400). No se aplican en ningún caso (ver withoutProtectedTexts al leer).
 */
const TextOverrides = z
  .record(z.string().regex(TEXT_KEY_RE), z.string().max(1000))
  .refine((r) => Object.keys(r).length <= 500, "máximo 500 textos por idioma")
  .transform((r) => withoutProtectedTexts(r));

export const BrandConfigInput = z
  .object({
    /** Nombre que ven firmantes y destinatarios (por defecto, el de la organización). */
    displayName: displayName(120),
    /** Nombre del producto: reemplaza a la marca de la plataforma en textos, correos, PDF y título de la página. */
    productName: displayName(60),
    /** Marca blanca total: sin "Powered by" ni menciones a la plataforma en nada que vea un firmante. */
    hidePoweredBy: z.boolean().optional(),
    theme: BrandThemeInput.optional(),
    /** CSS propio (sin url(), @import ni barras invertidas). Se aplica a firmante y embebido (no a la verificación pública). */
    customCss: z.string().max(20_000).nullable().optional(),
    links: BrandLinksInput.optional(),
    email: BrandEmailInput.optional(),
    templates: z
      .object(
        Object.fromEntries(BRAND_MESSAGE_EVENTS.map((e) => [e, localeRecord(BrandTemplateInput).optional()])) as Record<
          BrandMessageEvent,
          z.ZodOptional<ReturnType<typeof localeRecord<typeof BrandTemplateInput>>>
        >,
      )
      .strict()
      .optional(),
    /** Textos de la interfaz por idioma: { "es": { "sign.doneTitle": "¡Listo!" } }. */
    texts: localeRecord(TextOverrides).optional(),
    sms: z
      .object({
        senderId: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9 ]{1,11}$/, "hasta 11 letras o números")
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrandConfigInput = z.infer<typeof BrandConfigInput>;

export const CreateBrandInput = z.object({
  name: z.string().trim().min(2).max(120),
  config: BrandConfigInput.optional(),
});
export type CreateBrandInput = z.infer<typeof CreateBrandInput>;

export const UpdateBrandInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  config: BrandConfigInput,
});
export type UpdateBrandInput = z.infer<typeof UpdateBrandInput>;

export const BRAND_ASSET_KINDS = ["logo", "logoDark", "favicon", "font"] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];
export const BRAND_IMAGE_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"] as const;
export const BRAND_FONT_TYPES = ["font/woff2", "font/woff", "font/ttf", "font/otf"] as const;
export const BRAND_ASSET_MAX_BYTES = { logo: 200 * 1024, logoDark: 200 * 1024, favicon: 100 * 1024, font: 600 * 1024 } as const;

export const BrandPreviewInput = z.object({
  kind: z.enum(["email", "theme"]).default("email"),
  event: z.enum(BRAND_MESSAGE_EVENTS).default("invite"),
  locale: z.enum(LOCALES).default("es"),
  /** Configuración sin guardar: se combina con la guardada. */
  config: BrandConfigInput.optional(),
});
export type BrandPreviewInput = z.infer<typeof BrandPreviewInput>;

export const SetDomainInput = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "dominio inválido"),
});
export type SetDomainInput = z.infer<typeof SetDomainInput>;

// ───────────────────────────── Salidas ─────────────────────────────

export interface ResolvedBrandTheme {
  primaryColor: string | null;
  secondaryColor: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  buttonColor: string | null;
  buttonTextColor: string | null;
  headerTextColor: string | null;
  borderRadius: number | null;
  fontFamily: string | null;
  fontSource: "system" | "google" | "upload" | null;
}

export interface BrandLinks {
  websiteUrl: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
}

/** Lo que necesita la web para pintar la marca (firmante, verificación, embebido, login en un dominio propio). */
export interface PublicBrandTheme {
  /** "default" para la marca de la organización, o el id de la sub-marca. */
  brandId: string;
  /** Nombre que ven los firmantes. */
  name: string;
  /** Nombre del producto (null: el de la plataforma). */
  productName: string | null;
  /** Marca blanca total: no se muestra "Powered by" ni la marca de la plataforma. */
  whiteLabel: boolean;
  theme: ResolvedBrandTheme;
  /** CSS listo para inyectar: variables del tema + CSS propio saneado (en /verify, el tema restringido). */
  css: string;
  /**
   * Solo en el tema que el servidor inyecta en /verify (donde `css` es el restringido): el CSS completo de la marca, para
   * que la web lo restaure al salir de /verify navegando dentro de la aplicación. En /verify nunca se aplica.
   */
  pageCss?: string;
  links: BrandLinks;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  fontUrl: string | null;
  /** Hoja de estilos de Google Fonts (si el tema usa una). */
  fontCssUrl: string | null;
  texts: Partial<Record<(typeof LOCALES)[number], Record<string, string>>>;
}

export interface BrandAssets {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  fontUrl: string | null;
}

export interface BrandDomain {
  domain: string;
  status: "pending" | "verified";
  txtName: string;
  txtValue: string;
  cnameTarget: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /**
   * Si este entorno sirve los dominios propios (CUSTOM_DOMAINS_SERVING). En false el dominio se puede verificar, pero
   * los links siguen usando el dominio de la plataforma.
   */
  servingEnabled: boolean;
  /** Aviso para mostrar cuando servingEnabled es false (null si no hay nada que avisar). */
  notice: string | null;
}

export interface Brand {
  /** "default" o uuid. */
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  config: BrandConfigInput;
  assets: BrandAssets;
  /** Remitente efectivo de los correos y si usa un dominio verificado. */
  emailSender: { from: string; replyTo: string | null; customDomain: boolean; warning: string | null };
  /** Dominio propio de la sub-marca (la marca por defecto usa el de Ajustes → Dominio propio). */
  domain: BrandDomain | null;
  /** URL base de los links de esta marca. */
  baseUrl: string;
  effective: PublicBrandTheme;
  updatedAt: string | null;
}

export interface BrandList {
  items: Brand[];
}

export interface BrandEmailPreview {
  subject: string;
  html: string;
  text: string;
  from: string;
}

export interface EmailDomainRecord {
  purpose: "ownership" | "dkim" | "spf" | "dmarc";
  type: "TXT";
  name: string;
  value: string;
  ok: boolean | null;
  required: boolean;
}

export interface EmailDomain {
  domain: string;
  status: "pending" | "verified";
  records: EmailDomainRecord[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  /** Último error de la verificación por DNS. */
  lastError: string | null;
  /** Amazon SES rechazó el dominio como remitente (identidad sin verificar): los correos salen desde la plataforma. */
  sesIdentityError?: string | null;
  sesIdentityErrorAt?: string | null;
}

// ───────────────────────────── CSS del tema ─────────────────────────────

const shade = (hex: string, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (amount < 0 ? c * amount : (255 - c) * amount))));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, "0")).join("")}`;
};
const okColor = (c: string | null | undefined): c is string => typeof c === "string" && HEX_COLOR.test(c);

/** Luminancia relativa WCAG 2.x de un color #rrggbb (0 = negro, 1 = blanco). */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relación de contraste WCAG entre dos colores #rrggbb (de 1 a 21; texto normal AA pide 4.5). */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Blanco o casi negro (#0f172a), lo que contraste más con el fondo. */
export function contrastText(hex: string): string {
  // Se elige el de mayor contraste (con el umbral 0.4 de antes, colores medios quedaban con blanco por debajo de 4.5:1).
  return contrastRatio(hex, "#0f172a") > contrastRatio(hex, "#ffffff") ? "#0f172a" : "#ffffff";
}

/**
 * El color oscurecido de a poco hasta llegar a `min`:1 contra `against` (por defecto, blanco). Si ya cumple, el mismo
 * color. Sirve para usar un color de marca claro como texto (enlaces, avisos) sobre fondo blanco.
 */
export function darkenToContrast(hex: string, min = 4.5, against = "#ffffff"): string {
  let c = hex.toLowerCase();
  for (let i = 0; i < 40 && contrastRatio(c, against) < min; i++) c = shade(c, -0.06);
  return c;
}

/**
 * Fondo de hover de .btn-primary para un texto `fg` sobre `bg`: oscurecido (`amount`) como siempre, salvo que eso baje
 * el contraste del texto por debajo de 4.5:1 (texto oscuro sobre un color medio: oscurecer el fondo lo acerca al
 * texto); entonces se aclara, que lo aleja.
 */
function buttonHoverBg(bg: string, fg: string, amount: number): string {
  const dark = shade(bg, -amount);
  const dc = contrastRatio(fg, dark);
  if (dc >= 4.5 || dc >= contrastRatio(fg, bg)) return dark;
  const light = shade(bg, amount);
  return contrastRatio(fg, light) > dc ? light : dark;
}

export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Variables y reglas CSS del tema (las mismas en el servidor, la web y la vista previa). */
/**
 * Tema de la página pública de verificación: solo la barra (color y texto), los botones y la fuente. Sin el fondo ni el
 * color del texto (podían ocultar el resultado) y nunca el CSS propio.
 */
export function verifyPageTheme(t: Partial<ResolvedBrandTheme>): Partial<ResolvedBrandTheme> {
  const { primaryColor, headerTextColor, buttonColor, buttonTextColor, fontFamily, fontSource } = t;
  return { primaryColor, headerTextColor, buttonColor, buttonTextColor, fontFamily, fontSource };
}

export function themeToCss(t: Partial<ResolvedBrandTheme>, opts: { fontFace?: string | null } = {}): string {
  const vars: string[] = [];
  const rules: string[] = [];
  const btn = okColor(t.buttonColor) ? t.buttonColor : null;
  if (okColor(t.primaryColor)) {
    // --navy-2 es solo el hover de .btn-primary (styles.css): sin color de botón propio, el botón usa el principal y su
    // texto (propio o calculado) tiene que seguir leyéndose en hover.
    const btnFg = okColor(t.buttonTextColor) ? t.buttonTextColor : contrastText(t.primaryColor);
    const hover = btn ? shade(t.primaryColor, -0.15) : buttonHoverBg(t.primaryColor, btnFg, 0.15);
    vars.push(`--navy:${t.primaryColor}`, `--navy-2:${hover}`, `--brand-primary:${t.primaryColor}`);
    const head = okColor(t.headerTextColor) ? t.headerTextColor : contrastText(t.primaryColor);
    rules.push(`.signer-bar,.topbar,.brand-preview-bar{background:${t.primaryColor};color:${head}}`, `.logo{color:${t.primaryColor}}`);
    // El número del paso actual va sobre el color principal (--navy): texto blanco o oscuro según contraste.
    rules.push(`.stepper li.current .step-n{color:${contrastText(t.primaryColor)}}`);
  } else if (okColor(t.headerTextColor)) {
    rules.push(`.signer-bar,.topbar{color:${t.headerTextColor}}`);
  }
  if (okColor(t.secondaryColor))
    vars.push(
      `--teal:${t.secondaryColor}`,
      // --teal-dark es texto (enlaces, .hint) y fondo de texto blanco: al menos 4.5:1 contra blanco.
      `--teal-dark:${darkenToContrast(shade(t.secondaryColor, -0.15))}`,
      `--brand-secondary:${t.secondaryColor}`,
    );
  if (okColor(t.backgroundColor)) {
    vars.push(`--bg:${t.backgroundColor}`);
    rules.push(`.signer,body{background:${t.backgroundColor}}`);
  }
  if (okColor(t.textColor)) vars.push(`--text:${t.textColor}`);
  if (btn) {
    const fg = okColor(t.buttonTextColor) ? t.buttonTextColor : contrastText(btn);
    const hover = buttonHoverBg(btn, fg, 0.12);
    // El color del texto también en hover: si ni aclarando llega a 4.5:1, el calculado contra el fondo de hover.
    const hoverFg = !okColor(t.buttonTextColor) && contrastRatio(fg, hover) < 4.5 ? contrastText(hover) : fg;
    rules.push(
      `.btn-primary{background:${btn};border-color:${btn};color:${fg}}`,
      `.btn-primary:hover{background:${hover};border-color:${hover};color:${hoverFg}}`,
    );
  } else if (okColor(t.buttonTextColor)) {
    rules.push(`.btn-primary{color:${t.buttonTextColor}}`);
  } else if (okColor(t.primaryColor)) {
    // Sin color de botón, .btn-primary usa el principal (--navy): el texto blanco fijo no se leía sobre uno claro. El
    // hover (--navy-2) se calculó arriba para este mismo texto; el color va también en :hover por si no alcanza.
    const fg = contrastText(t.primaryColor);
    const hover = buttonHoverBg(t.primaryColor, fg, 0.15);
    const hoverFg = contrastRatio(fg, hover) < 4.5 ? contrastText(hover) : fg;
    rules.push(`.btn-primary{color:${fg}}`, `.btn-primary:hover{color:${hoverFg}}`);
  }
  if (typeof t.borderRadius === "number" && t.borderRadius >= 0 && t.borderRadius <= 24) {
    vars.push(`--radius:${t.borderRadius}px`);
    rules.push(`.btn,.card,input,select,textarea{border-radius:${t.borderRadius}px}`);
  }
  if (t.fontFamily && FONT_FAMILY_RE.test(t.fontFamily) && t.fontSource !== "system") vars.push(`--font:"${t.fontFamily}", ${FONT_STACK}`);
  const out = [opts.fontFace ?? "", vars.length ? `:root{${vars.join(";")}}` : "", ...rules].filter(Boolean).join("\n");
  return out;
}

export const CUSTOM_CSS_PROBLEMS = ["too_long", "backslash", "lt", "url", "import", "external_image", "expression"] as const;
export type CustomCssProblem = (typeof CUSTOM_CSS_PROBLEMS)[number];

/** Motivo en castellano de cada código (lo usa la API en sus mensajes; la web traduce el código). */
const CUSTOM_CSS_PROBLEM_TEXT: Record<CustomCssProblem, string> = {
  too_long: "el CSS supera los 20 000 caracteres",
  backslash: "no se permiten barras invertidas (\\)",
  lt: "no se permite el carácter <",
  url: "no se permite url(): usá el logo, el favicon o la fuente subidos",
  import: "no se permite @import",
  external_image: "no se permiten imágenes externas",
  expression: "contiene expresiones no permitidas",
};

export function customCssProblemText(code: CustomCssProblem): string {
  return CUSTOM_CSS_PROBLEM_TEXT[code];
}

/**
 * CSS propio saneado. Se rechaza (no se corrige) lo que permite cargar recursos externos o escapar del <style>:
 * url(), @import, image-set(), barras invertidas (escapes que esconden lo anterior), "</" y expresiones viejas de IE.
 * Devuelve el código del motivo del rechazo o null.
 */
export function customCssProblem(css: string): CustomCssProblem | null {
  if (css.length > 20_000) return "too_long";
  const checks: [RegExp, CustomCssProblem][] = [
    [/\\/, "backslash"],
    [/<\s*\/?/, "lt"],
    [/url\s*\(/i, "url"],
    [/@import|@namespace|@document/i, "import"],
    [/image-set\s*\(|cross-fade\s*\(|element\s*\(/i, "external_image"],
    [/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i, "expression"],
  ];
  for (const [re, why] of checks) if (re.test(css)) return why;
  return null;
}

/** Hoja de Google Fonts para una familia (pesos 400/600/700). */
export function googleFontCssUrl(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;600;700&display=swap`;
}
