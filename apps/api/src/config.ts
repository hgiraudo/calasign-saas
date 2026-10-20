import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

const env = process.env;
const production = env.NODE_ENV === "production";
const dataDir = resolve(env.DATA_DIR ?? resolve(repoRoot, "var"));
mkdirSync(dataDir, { recursive: true });

export const config = {
  production,
  /** Nombre del entorno para mostrar y para logs: local, dev, prod. */
  environment: env.APP_ENV ?? (production ? "prod" : "local"),
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
  },
  /** Buzón de desarrollo: guarda todos los mensajes y los expone en /dev/mailbox. */
  devMailbox: bool(env.DEV_MAILBOX, !production),
  /** Corre el worker dentro del proceso de la API (desarrollo / entornos chicos). */
  workerInline: bool(env.WORKER_INLINE, !production),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  webDist: resolve(env.WEB_DIST ?? resolve(repoRoot, "apps/web/dist")),
  logLevel: env.LOG_LEVEL ?? "info",
  /** Planes, cobros y servidor MCP (Fase 6). */
  billing: {
    /** Plan de las organizaciones sin suscripción. En producción "free"; fuera de producción "enterprise" (pruebas sin límites). */
    defaultPlan: (env.BILLING_DEFAULT_PLAN ?? ((env.APP_ENV ?? (production ? "prod" : "local")) === "prod" ? "free" : "enterprise")) as
      | "free"
      | "starter"
      | "business"
      | "enterprise",
    /** El proveedor de prueba ("mock") solo existe fuera de producción. */
    mockEnabled: (env.APP_ENV ?? (production ? "prod" : "local")) !== "prod" || bool(env.PAYMENTS_MOCK_ENABLED, false),
    stripe: { secretKey: env.STRIPE_SECRET_KEY ?? null, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null, apiBase: env.STRIPE_API_BASE ?? "https://api.stripe.com" },
    mercadopago: {
      accessToken: env.MP_ACCESS_TOKEN ?? null,
      webhookSecret: env.MP_WEBHOOK_SECRET ?? null,
      apiBase: env.MP_API_BASE ?? "https://api.mercadopago.com",
    },
  },
  mcp: {
    /** Vida de los links de descarga que devuelve el servidor MCP. */
    downloadLinkTtlSec: Number(env.MCP_DOWNLOAD_TTL_SEC ?? 900),
  },
};

export type Config = typeof config;
