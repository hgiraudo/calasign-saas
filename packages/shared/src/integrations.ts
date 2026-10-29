// Contrato de la API v1 — integraciones (Fase 3): webhooks, firma embebida, anclas de texto.
import { z } from "zod";
import { FIELD_TYPES } from "./api";
import { FieldConditions, FieldFormula } from "./scale-logic";

// ───────────────────────────── Webhooks ─────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
  "envelope.sent",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
  "recipient.viewed",
  "recipient.signed",
  "recipient.declined",
  "recipient.approved",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number] | "webhook.test";

export const CreateWebhookInput = z.object({
  url: z.string().trim().url().max(2000),
  description: z.string().trim().max(200).optional().nullable(),
  /** Vacío o ausente = todos los eventos. */
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).optional(),
  active: z.boolean().optional(),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = CreateWebhookInput.partial();
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  active: boolean;
  secretPrefix: string;
  /** Hasta cuándo se firma también con el secreto anterior (después de rotarlo). */
  previousSecretExpiresAt?: string | null;
  /**
   * Solo lectura, por qué está inactivo: `credential_revoked` (se revocó la credencial que lo creó) o `permission_lost`
   * (esa credencial ya no tiene webhooks:manage y envelopes:view_all): reactivarlo lo ata a la credencial actual;
   * `gone` (el receptor respondió 410); `failing` (demasiadas entregas fallidas seguidas o días fallando sin éxito);
   * `null` si está activo o se pausó a mano.
   */
  deactivatedReason?: "credential_revoked" | "permission_lost" | "gone" | "failing" | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookResponse {
  webhook: WebhookEndpoint;
  /** Secreto para verificar la firma HMAC. Se muestra una sola vez. */
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  envelopeId: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastResponse: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/** Cuerpo de cada entrega. Se firma con `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export interface WebhookEventPayload {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  tenantId: string;
  data: {
    envelope: {
      id: string;
      subject: string;
      status: string;
      metadata: Record<string, unknown>;
      sentAt: string | null;
      completedAt: string | null;
      signedSha256: string | null;
      recipients: { id: string; name: string; email: string | null; role: string; status: string; routingOrder: number }[];
    } | null;
    /** Destinatario que originó el evento (viewed/signed/declined). */
    recipientId?: string | null;
    reason?: string | null;
  };
}

// ───────────────────────────── Firma embebida ─────────────────────────────

/**
 * Sufijos públicos (y de hosting compartido) comunes: con un comodín sobre ellos (https://*.com.ar, https://*.github.io)
 * cualquiera que registre un dominio o un sitio debajo podía enmarcar la firma. Lista corta (no hay una lib de la PSL
 * instalada): los genéricos, los de segundo nivel de la región y los de hosting donde cualquiera crea un subdominio.
 */
export const COMMON_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // Segundo nivel por país (región y principales)
  "com.ar",
  "net.ar",
  "org.ar",
  "gob.ar",
  "gov.ar",
  "edu.ar",
  "int.ar",
  "mil.ar",
  "tur.ar",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  "art.br",
  "blog.br",
  "app.br",
  "dev.br",
  "eco.br",
  "ind.br",
  "inf.br",
  "tv.br",
  "com.mx",
  "org.mx",
  "gob.mx",
  "edu.mx",
  "net.mx",
  "com.uy",
  "org.uy",
  "edu.uy",
  "gub.uy",
  "net.uy",
  "com.py",
  "org.py",
  "edu.py",
  "gov.py",
  "net.py",
  "coop.py",
  "cl",
  "gob.cl",
  "co",
  "com.co",
  "org.co",
  "edu.co",
  "gov.co",
  "net.co",
  "com.pe",
  "org.pe",
  "gob.pe",
  "edu.pe",
  "net.pe",
  "nom.pe",
  "com.ec",
  "org.ec",
  "gob.ec",
  "edu.ec",
  "net.ec",
  "com.bo",
  "org.bo",
  "gob.bo",
  "com.ve",
  "org.ve",
  "gob.ve",
  "com.es",
  "org.es",
  "nom.es",
  "gob.es",
  "edu.es",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.tw",
  "com.hk",
  "com.sg",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "org.za",
  "com.tr",
  "com.pt",
  "com.pl",
  "co.il",
  "com.ru",
  // Hosting compartido: cualquiera crea un subdominio
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "blogspot.com",
  "glitch.me",
  "onrender.com",
  "fly.dev",
  "repl.co",
  "ngrok.io",
  "ngrok-free.app",
  "s3.amazonaws.com",
  "amazonaws.com",
  "wixsite.com",
  "myshopify.com",
]);

/** Comodín aceptable: al menos dos etiquetas después de "*." y que no sea un sufijo público común. */
export function wildcardOriginOk(origin: string): boolean {
  const m = /^https:\/\/\*\.([^:/]+)(?::\d+)?$/i.exec(origin.trim());
  if (!m) return true;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !l)) return false;
  return !COMMON_PUBLIC_SUFFIXES.has(host);
}

/** Orígenes https completos, sin ruta: https://app.cliente.com o https://*.cliente.com */
export const FrameAncestor = z
  .string()
  .trim()
  .max(300)
  .regex(/^(https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i, {
    message: "origen inválido (https://dominio[:puerto], sin ruta)",
  })
  .refine(wildcardOriginOk, { message: "comodín demasiado amplio: usá https://*.tudominio.com (no un sufijo público como *.com o *.com.ar)" });

export const EmbedSettingsInput = z.object({ frameAncestors: z.array(FrameAncestor).max(20) });
export type EmbedSettingsInput = z.infer<typeof EmbedSettingsInput>;

export interface EmbedSettings {
  frameAncestors: string[];
  /**
   * Solo en la respuesta del PATCH: comodines demasiado amplios que estaban guardados (de antes de la validación) y
   * volvieron en la lista; se descartaron en vez de rechazar el guardado.
   */
  discarded?: string[];
}

export const CreateSigningUrlInput = z.object({
  /** A dónde volver al terminar (https; http solo para localhost). Recibe ?event=signing_complete|declined. */
  returnUrl: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u), {
      message: "returnUrl debe ser https",
    })
    .optional()
    .nullable(),
  /** Subconjunto de los orígenes autorizados de la organización (por defecto, todos). */
  frameAncestors: z.array(FrameAncestor).max(20).optional(),
});
export type CreateSigningUrlInput = z.infer<typeof CreateSigningUrlInput>;

export interface SigningUrlResponse {
  /** URL de un solo uso para el iframe o la redirección. */
  url: string;
  expiresAt: string;
  /** true: el firmante tiene código OTP y la URL solo se abre en una pestaña o redirección (no dentro de un iframe). */
  tabOnly?: boolean;
}

/** GET /v1/signing/:token/embed — configuración de la ceremonia embebida para la página del firmante. */
export interface SigningEmbedInfo {
  embedded: boolean;
  returnUrl: string | null;
  /**
   * Orígenes que pueden enmarcar la página en la sesión embebida usada (los mismos del CSP frame-ancestors; vacío sin
   * sesión). La página los usa como destino de postMessage en vez de "*".
   */
  origins?: string[];
}

/** El origen coincide con uno de la lista (exacto o con comodín https://*.dominio). */
export function originAllowed(origin: string, list: readonly string[]): boolean {
  const o = origin.toLowerCase();
  return list.some((raw) => {
    const a = raw.toLowerCase();
    if (a === o) return true;
    const m = /^https:\/\/\*\.(.+)$/.exec(a);
    if (!m) return false;
    try {
      const u = new URL(o);
      const want = new URL(`https://${m[1]}`);
      return u.protocol === "https:" && u.port === want.port && u.hostname.endsWith(`.${want.hostname}`);
    } catch {
      return false;
    }
  });
}

/** Mensajes que la página del firmante envía a window.parent (postMessage) en modo embebido. */
export interface EmbedMessage {
  source: "calasign";
  /** "closed": el sobre terminó sin que este firmante firmara ni rechazara (anulado, vencido, rechazado por otro, completado). */
  type: "viewed" | "signing_complete" | "declined" | "error" | "closed";
  envelopeId: string | null;
  recipientId: string | null;
  /** Con "closed": estado del sobre. */
  status?: string;
}

// ───────────────────────────── Anclas de texto ─────────────────────────────

/**
 * Campo ubicado por un texto del PDF (p. ej. "\\firma1\\"). Se expande a un campo por cada aparición.
 * Offsets y tamaños en puntos PDF; offset relativo a la esquina superior izquierda del texto encontrado.
 */
export const AnchorFieldInput = z.object({
  id: z.string().uuid().optional(),
  /** Si se omite, se busca en todos los documentos del sobre. */
  documentId: z.string().uuid().optional(),
  recipientId: z.string().uuid(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  label: z.string().max(200).optional().nullable(),
  // Las mismas propiedades que un campo con coordenadas: sin declararlas acá, zod las descartaba en silencio
  // (un campo "solo lectura" con valor quedaba vacío y editable; un desplegable, sin opciones).
  value: z.string().max(2000).optional().nullable(),
  readOnly: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional().nullable(),
  min: z.number().finite().optional().nullable(),
  max: z.number().finite().optional().nullable(),
  conditions: FieldConditions.optional().nullable(),
  formula: FieldFormula.optional().nullable(),
  anchor: z.object({
    text: z.string().min(1).max(100),
    offsetX: z.number().min(-2000).max(2000).default(0),
    offsetY: z.number().min(-2000).max(2000).default(0),
    width: z.number().positive().max(2000),
    height: z.number().positive().max(2000),
    caseSensitive: z.boolean().default(true),
    /** Si es false (por defecto) y el texto no aparece, la petición falla. */
    ignoreIfNotPresent: z.boolean().default(false),
  }),
});
export type AnchorFieldInput = z.input<typeof AnchorFieldInput>;
