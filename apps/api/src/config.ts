import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

const env = process.env;
const production = env.NODE_ENV === "production";

/**
 * Sufijos públicos de hostings conocidos (sección privada de la Public Suffix List): nunca van como Domain= de una cookie.
 * No hay una biblioteca de la PSL entre las dependencias: se cubre lo habitual (segundos niveles genéricos de los
 * ccTLD, como com.ar, co.uk, com.br o com.mx, con la regla de isPublicSuffix, y los hostings más comunes). Un caso no
 * cubierto se resuelve con SESSION_COOKIE_PARENT_DOMAINS.
 */
const PRIVATE_SUFFIXES = new Set([
  "vercel.app", "netlify.app", "herokuapp.com", "github.io", "pages.dev", "workers.dev", "onrender.com", "fly.dev",
  "amplifyapp.com", "azurewebsites.net", "cloudfront.net", "appspot.com", "web.app", "firebaseapp.com", "railway.app",
  "up.railway.app", "elasticbeanstalk.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
]);
const CC_SECOND_LEVELS = new Set(["com", "net", "org", "gov", "gob", "edu", "co", "ac", "mil", "ne", "or", "go", "nic", "ltd", "plc", "info", "biz", "int", "nom", "res", "tur"]);

/** Sufijo público: un solo nivel (com, ar), un segundo nivel genérico de un ccTLD (com.ar, co.uk) o un hosting conocido. */
function isPublicSuffix(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length < 2) return true;
  if (PRIVATE_SUFFIXES.has(domain)) return true;
  return labels.length === 2 && labels[1].length === 2 && CC_SECOND_LEVELS.has(labels[0]);
}

/**
 * El host de una URL y sus dominios padre (app.calasign.com → app.calasign.com, calasign.com), sin ningún sufijo
 * público (com, com.ar, co.uk, vercel.app…: ver isPublicSuffix). Vacío para localhost o una IP.
 */
export function hostAndParentDomains(url: string): string[] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return [];
  }
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".localhost")) return [];
  const labels = host.split(".");
  return labels.map((_, i) => labels.slice(i).join(".")).filter((d) => !isPublicSuffix(d));
}

/**
 * LEGACY_SESSION_COOKIE_READ_UNTIL: fecha ISO. Un valor ilegible daba NaN y `Date.now() >= NaN` es siempre false: la
 * cookie vieja se seguía leyendo para siempre. Se aborta el arranque.
 */
function legacyCookieReadUntil(v: string | undefined): number {
  const raw = v?.trim() || "2026-11-10T00:00:00Z";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`LEGACY_SESSION_COOKIE_READ_UNTIL inválido: "${v}" (se espera una fecha ISO, p. ej. 2026-11-10T00:00:00Z)`);
  return t;
}

// Entorno: solo local | dev | prod. Un valor mal escrito ("production", "staging") caía en las ramas "no prod" (mock de
// pagos, plan enterprise por defecto, claves cs_test) sin aviso; se aborta el arranque. Sin APP_ENV: prod con
// NODE_ENV=production, local si no (tests y e2e locales no la definen). "local" relaja controles (allowList del rate
// limit, /dev/mailbox sin sesión, hosts localhost): no se permite con NODE_ENV=production.
const APP_ENVS = ["local", "dev", "prod"] as const;
const appEnv = (env.APP_ENV?.trim() || (production ? "prod" : "local")) as (typeof APP_ENVS)[number];
if (!(APP_ENVS as readonly string[]).includes(appEnv)) {
  throw new Error(`APP_ENV inválido: "${env.APP_ENV}" (valores admitidos: ${APP_ENVS.join(", ")})`);
}
if (production && appEnv === "local") {
  throw new Error("APP_ENV=local no se admite con NODE_ENV=production (usar dev o prod)");
}
const dataDir = resolve(env.DATA_DIR ?? resolve(repoRoot, "var"));
mkdirSync(dataDir, { recursive: true });

export const config = {
  production,
  /** Nombre del entorno para mostrar y para logs: local, dev, prod. */
  environment: appEnv as string,
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? "0.0.0.0",
  /** Cantidad de proxies delante de la API cuyo X-Forwarded-For se cree (0 = ninguno). */
  trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 1),
  /** URL pública de la web (links de firma, correos). */
  appUrl: (env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  /**
   * Otros hosts de la plataforma donde existe la cuenta (además del de APP_URL), separados por coma: p. ej. el apex si
   * APP_URL es www, o el host que pone un proxy que reescribe Host. El resto solo sirve lo que ven los firmantes.
   */
  platformHosts: (env.PLATFORM_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, ""))
    .filter(Boolean),
  repoRoot,
  dataDir,
  /** Sin DATABASE_URL se usa PGlite (Postgres embebido) en var/pglite. */
  databaseUrl: env.DATABASE_URL || null,
  /** 32 bytes en base64. Cifra los tokens de firmante. Sin valor: se genera en var/secret.key (solo fuera de producción). */
  secretKey: env.SECRET_KEY || null,
  cookieSecure: bool(env.COOKIE_SECURE, production),
  /**
   * Dominios (Domain=) con los que el cierre de sesión borra además la cookie de nombre viejo (cs_session): una
   * cs_session plantada desde un subdominio con Domain= de un dominio padre no se borraba con el Set-Cookie sin Domain
   * y, mientras se lea la cookie vieja, volvía a abrir una sesión después del logout. Por defecto, el host de APP_URL y
   * sus dominios padre; SESSION_COOKIE_PARENT_DOMAINS (separados por coma) los reemplaza. Nunca un sufijo público.
   */
  legacySessionCookieDomains:
    env.SESSION_COOKIE_PARENT_DOMAINS !== undefined
      ? list(env.SESSION_COOKIE_PARENT_DOMAINS)
          .map((d) => d.toLowerCase().replace(/^\./, "").replace(/\.$/, ""))
          .filter((d) => d && !isPublicSuffix(d))
      : hostAndParentDomains(env.APP_URL ?? ""),
  /**
   * Hasta cuándo se sigue leyendo la cookie de sesión de nombre viejo (cs_session). __Host-cs_session llegó con el
   * deploy del 2026-10-20 y una sesión dura como máximo 14 días: pasada esta fecha ya no queda ninguna sesión válida con
   * el nombre viejo. TODO(2026-11-10): quitar LEGACY_SESSION_COOKIE y esta opción (context.ts).
   */
  legacySessionCookieReadUntil: legacyCookieReadUntil(env.LEGACY_SESSION_COOKIE_READ_UNTIL),
  storage: {
    driver: (env.STORAGE_DRIVER ?? (env.S3_BUCKET ? "s3" : "local")) as "local" | "s3",
    bucket: env.S3_BUCKET ?? "",
    prefix: env.S3_PREFIX ?? "",
    region: env.AWS_REGION ?? "us-east-1",
  },
  seal: {
    /** PEM de la clave del sello (desarrollo). En producción: KMS_KEY_ID. */
    keyPemFile: env.SEAL_KEY_FILE ?? null,
    chainPemFile: env.SEAL_CHAIN_FILE ?? null,
    kmsKeyId: env.KMS_KEY_ID ?? null,
    tsaUrl: env.TSA_URL ?? "https://freetsa.org/tsr",
    /** Si es false y la TSA falla, se sella igual en B-B y se deja constancia en la evidencia. */
    tsaRequired: bool(env.TSA_REQUIRED, production),
    /** Nivel PAdES por defecto del entorno: auto | B-B | B-T | B-LT | B-LTA (cada organización puede elegir otro). */
    level: env.SEAL_LEVEL ?? "auto",
  },
  evidence: {
    /** Clave KMS simétrica para envolver las claves de los certificados de las organizaciones. Sin valor: SECRET_KEY local. */
    custodyKmsKeyId: env.CUSTODY_KMS_KEY_ID ?? null,
    /** Directorio con raíces de confianza (PEM/DER) para validar firmas. Se suma la raíz del sello de plataforma. */
    trustStoreDir: env.TRUST_STORE_DIR ?? null,
    /** Consultar OCSP/CRL online al validar PDFs subidos (con protección SSRF). */
    validateOnlineRevocation: bool(env.VALIDATE_ONLINE_REVOCATION, false),
    /** Conectores CSC v2 en JSON: [{id, baseUrl, auth:{type,…}, credentialId?, pin?, level?}]. */
    cscConnectors: env.CSC_CONNECTORS ?? null,
  },
  mail: {
    smtpUrl: env.SMTP_URL ?? null,
    from: env.MAIL_FROM ?? "CalaSign <no-reply@calasign.com>",
    /**
     * Marca blanca: dirección neutra (sin la marca de la plataforma) para las organizaciones con "Powered by" oculto y
     * sin dominio de correo propio verificado. Sin configurar, se usa la de MAIL_FROM con el nombre de la marca.
     */
    whiteLabelFrom: env.MAIL_FROM_WHITE_LABEL ?? null,
    /** SPF que tienen que incluir los dominios de correo propios (p. ej. "amazonses.com"). */
    spfInclude: env.MAIL_SPF_INCLUDE ?? null,
    /**
     * Rebotes y quejas de SES: ARN de los temas SNS (separados por coma) cuyas notificaciones acepta
     * POST /v1/integrations/ses/sns. Sin ninguno, el endpoint rechaza todo. Ver docs/CORREO-REBOTES.md.
     */
    sesSnsTopicArns: list(env.SES_SNS_TOPIC_ARNS),
    /** Configuration set de SES que publica rebotes y quejas (encabezado X-SES-CONFIGURATION-SET). Opcional. */
    sesConfigurationSet: env.SES_CONFIGURATION_SET || null,
    /**
     * Días que una dirección con rebote permanente queda suprimida para toda la plataforma (60 por defecto). Las quejas
     * suprimen solo para la organización que envió y no vencen (se quitan desde Ajustes).
     */
    bounceSuppressionDays: Math.max(1, Number(env.EMAIL_BOUNCE_SUPPRESSION_DAYS ?? 60) || 60),
  },
  sms: {
    /**
     * Organizaciones (ids, separados por coma) autorizadas a usar un remitente alfanumérico propio en los SMS
     * (marca blanca, `sms.senderId`). El resto sale con el número por defecto (TWILIO_FROM): un remitente
     * alfanumérico sin verificar permite hacerse pasar por otra marca. Ver docs/MARCA-BLANCA.md.
     */
    alphanumericAllowedTenants: list(env.SMS_ALPHANUMERIC_ALLOWED_TENANTS),
  },
  jobs: {
    /**
     * Días que se guardan los jobs terminados (done/failed) antes de purgarlos. Los que todavía deduplican (clave atada
     * a un sobre que no terminó) se retienen igual: ver purgeFinishedJobs en infra/queue.ts.
     */
    retentionDays: Math.max(1, Number(env.JOBS_RETENTION_DAYS ?? 30) || 30),
  },
  webhooks: {
    /** Entregas fallidas definitivas seguidas (agotados los reintentos) que desactivan el endpoint (motivo "failing"). */
    maxConsecutiveFailures: Math.max(1, Number(env.WEBHOOK_MAX_CONSECUTIVE_FAILURES ?? 50) || 50),
    /** Días fallando sin ninguna entrega exitosa que también lo desactivan. */
    failingDays: Math.max(1, Number(env.WEBHOOK_FAILING_DAYS ?? 7) || 7),
    /**
     * Fallas definitivas seguidas mínimas para que los failingDays desactiven el endpoint (con tope en
     * maxConsecutiveFailures): si no, dos fallas separadas por una semana en una organización con pocos eventos bastaban.
     */
    failingDaysMinFailures: Math.max(1, Number(env.WEBHOOK_FAILING_DAYS_MIN_FAILURES ?? 5) || 5),
    /**
     * Horas mínimas fallando sin ningún éxito para que la racha (maxConsecutiveFailures) desactive el endpoint: si no,
     * una caída de 15 minutos del receptor durante un envío masivo de 50 sobres lo desactivaba.
     */
    failingMinHours: Math.max(0, Number.isFinite(Number(env.WEBHOOK_FAILING_MIN_HOURS ?? 72)) ? Number(env.WEBHOOK_FAILING_MIN_HOURS ?? 72) : 72),
    /** Días que se guardan las entregas (webhook_deliveries, con el payload del sobre) antes de purgarlas. */
    deliveryRetentionDays: Math.max(1, Number(env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? 90) || 90),
  },
  reminders: {
    /** Recordatorios manuales por sobre en 24 h (además de uno cada 10 minutos). */
    manualMaxPerDay: Number(env.REMINDERS_MANUAL_MAX_PER_DAY ?? 5),
    /** Recordatorios automáticos por destinatario cuando el sobre no tiene vencimiento. */
    automaticMaxWithoutExpiry: Number(env.REMINDERS_AUTO_MAX_WITHOUT_EXPIRY ?? 10),
  },
  whatsapp: {
    token: env.WHATSAPP_TOKEN ?? null,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? null,
    /** Nombre de la plantilla aprobada en Meta: recibe {{1}} remitente, {{2}} asunto, {{3}} link. */
    template: env.WHATSAPP_TEMPLATE ?? "calasign_signature_request",
    /** Plantilla aprobada para el código de verificación del firmante: recibe {{1}} el código. */
    otpTemplate: env.WHATSAPP_OTP_TEMPLATE ?? "calasign_verification_code",
    /**
     * Plantillas aprobadas para los otros avisos ({{1}} remitente, {{2}} asunto, {{3}} link o vacío). Sin ellas esos
     * avisos no salen por WhatsApp (van por los otros canales): con la de "te enviaron a firmar" un sobre anulado,
     * rechazado o completado llegaba como un pedido de firma.
     */
    completedTemplate: env.WHATSAPP_COMPLETED_TEMPLATE ?? null,
    voidedTemplate: env.WHATSAPP_VOIDED_TEMPLATE ?? null,
    declinedTemplate: env.WHATSAPP_DECLINED_TEMPLATE ?? null,
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN ?? null,
    /** Usuario del bot sin @ (para los links t.me/<bot>?start=…). */
    botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
    /** Secreto que Telegram manda en X-Telegram-Bot-Api-Secret-Token al webhook. */
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
    /** Vigencia (minutos) del token de un solo uso de los links t.me/<bot>?start=… */
    linkTtlMinutes: Number(env.TELEGRAM_LINK_TTL_MINUTES ?? 30),
  },
  /** Buzón de desarrollo: guarda todos los mensajes y los expone en /dev/mailbox. */
  devMailbox: bool(env.DEV_MAILBOX, !production),
  /** Corre el worker dentro del proceso de la API (desarrollo / entornos chicos). */
  workerInline: bool(env.WORKER_INLINE, !production),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  webDist: resolve(env.WEB_DIST ?? resolve(repoRoot, "apps/web/dist")),
  logLevel: env.LOG_LEVEL ?? "info",
  /**
   * Formularios web públicos: cada envío crea y envía un sobre que cuenta para la cuota del plan. Además del tope por
   * formulario, uno por organización (todos sus formularios juntos) y una ventana en la que el mismo correo no crea otro
   * sobre del mismo formulario.
   */
  webForms: {
    maxPerFormHour: Number(env.WEBFORM_MAX_PER_FORM_HOUR ?? 60),
    maxPerTenantHour: Number(env.WEBFORM_MAX_PER_TENANT_HOUR ?? 100),
    maxPerTenantDay: Number(env.WEBFORM_MAX_PER_TENANT_DAY ?? 500),
    /** Inicios por el link público de workflows por organización y hora, completen o no el formulario (más alto). */
    maxPublicStartsPerTenantHour: Number(env.WORKFLOW_PUBLIC_STARTS_PER_TENANT_HOUR ?? 1000),
    dedupeMinutes: Number(env.WEBFORM_DEDUPE_MINUTES ?? 10),
    /** Cloudflare Turnstile (opcional): con las dos claves, el envío exige el token del desafío. */
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY || null,
    turnstileVerifyUrl: env.TURNSTILE_VERIFY_URL ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  },
  /**
   * Códigos de verificación (solo los no verificados): topes por organización + destino (correo o teléfono, sin
   * importar el sobre), uno global por destino mucho más alto (anti-abuso entre organizaciones) y uno por organización.
   */
  otp: {
    maxPerDestinationHour: Number(env.OTP_MAX_PER_DESTINATION_HOUR ?? 10),
    maxPerDestinationDay: Number(env.OTP_MAX_PER_DESTINATION_DAY ?? 30),
    maxPerDestinationGlobalHour: Number(env.OTP_MAX_PER_DESTINATION_GLOBAL_HOUR ?? 100),
    maxPerTenantHour: Number(env.OTP_MAX_PER_TENANT_HOUR ?? 1000),
  },
  /** Planes, cobros y servidor MCP (Fase 6). */
  billing: {
    /** Plan de las organizaciones sin suscripción. En producción "free"; fuera de producción "enterprise" (pruebas sin límites). */
    defaultPlan: (env.BILLING_DEFAULT_PLAN ?? (appEnv === "prod" ? "free" : "enterprise")) as
      | "free"
      | "starter"
      | "business"
      | "enterprise",
    /**
     * Tope de tokens de IA por mes del plan Enterprise (los demás planes tienen el suyo fijo en PLANS). Vacío: el valor
     * de PLANS (50 M); "unlimited": sin tope del plan (rige solo el presupuesto de la organización).
     */
    enterpriseAiTokens: ((): number | null | undefined => {
      const v = env.BILLING_ENTERPRISE_AI_TOKENS?.trim();
      if (!v) return undefined;
      if (v === "unlimited") return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    })(),
    /** El proveedor de prueba ("mock") solo existe fuera de producción. */
    mockEnabled: appEnv !== "prod" || bool(env.PAYMENTS_MOCK_ENABLED, false),
    stripe: { secretKey: env.STRIPE_SECRET_KEY ?? null, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null, apiBase: env.STRIPE_API_BASE ?? "https://api.stripe.com" },
    mercadopago: {
      accessToken: env.MP_ACCESS_TOKEN ?? null,
      webhookSecret: env.MP_WEBHOOK_SECRET ?? null,
      apiBase: env.MP_API_BASE ?? "https://api.mercadopago.com",
      /**
       * Monedas en las que la cuenta de Mercado Pago puede cobrar suscripciones (MP_CURRENCIES, separadas por coma, p. ej.
       * "ARS"). Una cuenta cobra solo en la moneda de su país. Vacío: la de la cuenta (GET /users/me); si no se puede saber,
       * Mercado Pago no se ofrece para suscripciones. En dev y producción conviene definirla.
       */
      currencies: (env.MP_CURRENCIES ?? "")
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{3}$/.test(c)) as string[],
    },
  },
  mcp: {
    /** Vida de los links de descarga que devuelve el servidor MCP. */
    downloadLinkTtlSec: Number(env.MCP_DOWNLOAD_TTL_SEC ?? 900),
  },
};

export type Config = typeof config;
