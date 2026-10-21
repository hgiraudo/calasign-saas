// Contrato del bloque "identidad" (Fase 5): verificación de identidad del firmante (KYC), SSO para
// remitentes (OIDC y SAML 2.0) y aprovisionamiento SCIM 2.0.
// No importa valores de api.ts (api.ts importa de acá): solo tipos.
import { z } from "zod";

// ───────────────────────────── Verificación de identidad (KYC) ─────────────────────────────

export const IDV_PROVIDERS = ["mock", "truora", "veriff"] as const;
export type IdvProvider = (typeof IDV_PROVIDERS)[number];

/** document: solo documento · document_selfie: + selfie con comparación facial · document_selfie_liveness: + prueba de vida. */
export const IDV_LEVELS = ["document", "document_selfie", "document_selfie_liveness"] as const;
export type IdvLevel = (typeof IDV_LEVELS)[number];

export const IDV_STATUSES = ["pending", "in_progress", "verified", "failed"] as const;
export type IdvStatus = (typeof IDV_STATUSES)[number];

/** Capturas del flujo integrado (proveedor "mock"). */
export const IDV_CAPTURE_KINDS = ["document_front", "document_back", "selfie", "selfie_liveness"] as const;
export type IdvCaptureKind = (typeof IDV_CAPTURE_KINDS)[number];

export const IdVerificationInput = z.object({
  provider: z.enum(IDV_PROVIDERS),
  level: z.enum(IDV_LEVELS).default("document_selfie"),
});
export type IdVerificationInput = z.input<typeof IdVerificationInput>;

/** Capturas requeridas por nivel (flujo integrado). */
export function requiredCaptures(level: IdvLevel): IdvCaptureKind[] {
  if (level === "document") return ["document_front", "document_back"];
  if (level === "document_selfie") return ["document_front", "document_back", "selfie"];
  return ["document_front", "document_back", "selfie", "selfie_liveness"];
}

/** Resultado normalizado de cualquier proveedor (nunca incluye imágenes). */
export interface IdvResult {
  status: "approved" | "declined" | "review" | "pending";
  document: {
    type: string | null;
    number: string | null;
    country: string | null;
    expiresOn: string | null;
  };
  person: {
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    birthDate: string | null;
  };
  /** 0..1, null si el nivel no incluye selfie. */
  faceMatchScore: number | null;
  /**
   * Decisión explícita del proveedor sobre la coincidencia selfie / documento (p. ej. la validación face-recognition de
   * Truora en "success"), cuando no da un puntaje. null/ausente = sin decisión explícita.
   */
  faceMatched?: boolean | null;
  /** null si el nivel no incluye prueba de vida. */
  liveness: boolean | null;
  riskFlags: string[];
  /** Id del proceso en el proveedor. */
  reference: string | null;
  declineReason: string | null;
  /**
   * Controles que la decisión no traía y se dieron por hechos porque la integración del proveedor los declara
   * (VERIFF_INTEGRATION_LEVEL, flujo de Truora por nivel). Lo agrega CalaSign al guardar el resultado.
   */
  inferredFromIntegration?: ("faceMatched" | "liveness")[];
}

export interface NameMatchResult {
  /** 0..1 */
  score: number;
  matched: boolean;
  threshold: number;
  /** null si el destinatario no declaró número de documento. */
  documentNumberMatched: boolean | null;
}

/** Lo que ve el firmante de su verificación. */
export interface SigningIdentity {
  required: boolean;
  provider: IdvProvider;
  level: IdvLevel;
  status: IdvStatus;
  /** "builtin": captura en CalaSign · "redirect": página del proveedor. */
  mode: "builtin" | "redirect";
  verificationId: string | null;
  redirectUrl: string | null;
  requiredCaptures: IdvCaptureKind[];
  capturedKinds: IdvCaptureKind[];
  attemptsLeft: number;
  failureReason: string | null;
}

export interface IdentityStartResponse {
  identity: SigningIdentity;
}

/** Estado de la verificación en el detalle del sobre (remitente). */
export interface RecipientIdentity {
  provider: IdvProvider;
  level: IdvLevel;
  status: IdvStatus;
  verifiedAt: string | null;
  failureReason: string | null;
}

export interface IdentityProviderInfo {
  id: IdvProvider;
  name: string;
  configured: boolean;
  /** "builtin" o "redirect". */
  mode: "builtin" | "redirect";
}

export const MOCK_DECISIONS = ["approve", "reject_document", "reject_face", "reject_liveness"] as const;

export const IdentitySettingsInput = z.object({
  defaultProvider: z.enum(IDV_PROVIDERS).optional(),
  defaultLevel: z.enum(IDV_LEVELS).optional(),
  /** 0.5..1 — similitud mínima entre el nombre declarado y el del documento. */
  nameMatchThreshold: z.number().min(0.5).max(1).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** Configuración del proveedor de prueba (solo para el proveedor "mock"). */
  mock: z
    .object({
      decision: z.enum(MOCK_DECISIONS).optional(),
      /** Nombre que "lee" el mock del documento. Vacío: usa el declarado por el remitente. */
      extractedName: z.string().trim().max(200).optional().nullable(),
      extractedDocumentNumber: z.string().trim().max(50).optional().nullable(),
    })
    .optional(),
});
export type IdentitySettingsInput = z.input<typeof IdentitySettingsInput>;

export interface IdentitySettings {
  defaultProvider: IdvProvider;
  defaultLevel: IdvLevel;
  nameMatchThreshold: number;
  maxAttempts: number;
  mock: { decision: (typeof MOCK_DECISIONS)[number]; extractedName: string | null; extractedDocumentNumber: string | null };
  providers: IdentityProviderInfo[];
}

// ───────────────────────────── SSO (remitentes) ─────────────────────────────

export const SSO_PROTOCOLS = ["oidc", "saml"] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

const domainRe = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const SsoSettingsInput = z
  .object({
    enabled: z.boolean(),
    protocol: z.enum(SSO_PROTOCOLS),
    /** Dominios de correo de la organización (descubrimiento por dominio). Únicos entre organizaciones. */
    domains: z.array(z.string().trim().toLowerCase().regex(domainRe, "dominio inválido")).max(20).default([]),
    /** Alta automática (JIT) de usuarios que entran por SSO y no son miembros. */
    jitEnabled: z.boolean().default(true),
    jitRole: z.enum(["admin", "member"]).default("member"),
    /** Bloquea el ingreso con contraseña (salvo propietarios, como acceso de emergencia). */
    enforce: z.boolean().default(false),
    /**
     * Duración absoluta (horas, 1 a 336) de las sesiones abiertas por SSO; omitir para conservar la actual (por defecto
     * 24). Bajarla acorta también las sesiones SSO ya abiertas.
     */
    sessionTtlHours: z.number().int().min(1).max(336).optional(),
    oidc: z
      .object({
        issuer: z.string().trim().url(),
        clientId: z.string().trim().min(1).max(500),
        /** Se guarda cifrado; omitir para conservar el actual. */
        clientSecret: z.string().min(1).max(2000).optional(),
        scopes: z.string().trim().max(500).default("openid email profile"),
        /**
         * Aceptar el correo del IdP aunque el id_token no traiga email_verified (por defecto no: se exige true). Para IdP
         * que no mandan ese claim, como Microsoft Entra ID en algunas configuraciones. Un false explícito se rechaza
         * siempre. Omitir para conservar el valor actual.
         */
        trustUnverifiedEmail: z.boolean().optional(),
      })
      .optional()
      .nullable(),
    saml: z
      .object({
        /** URL de inicio de sesión (HTTP-Redirect) del IdP. */
        entryPoint: z.string().trim().url(),
        /** EntityID del IdP (Issuer esperado en la respuesta). */
        idpIssuer: z.string().trim().min(1).max(1000),
        /** Certificado de firma del IdP en PEM o base64. Omitir para conservar el actual. */
        idpCert: z.string().trim().min(100).max(20000).optional(),
        /** Atributo con el correo; vacío: se usa el NameID. */
        emailAttribute: z.string().trim().max(500).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .refine((s) => !s.enabled || (s.protocol === "oidc" ? Boolean(s.oidc) : Boolean(s.saml)), {
    message: "falta la configuración del protocolo elegido",
  });
export type SsoSettingsInput = z.input<typeof SsoSettingsInput>;

export interface SsoSettings {
  enabled: boolean;
  protocol: SsoProtocol;
  domains: string[];
  jitEnabled: boolean;
  jitRole: "admin" | "member";
  enforce: boolean;
  /** Duración absoluta de las sesiones abiertas por SSO, en horas (por defecto 24). */
  sessionTtlHours: number;
  oidc: { issuer: string; clientId: string; scopes: string; hasClientSecret: boolean; trustUnverifiedEmail: boolean } | null;
  saml: { entryPoint: string; idpIssuer: string; idpCertFingerprint: string | null; emailAttribute: string | null } | null;
  /** Datos para configurar el IdP. */
  serviceProvider: {
    oidcRedirectUri: string;
    samlEntityId: string;
    samlAcsUrl: string;
    samlMetadataUrl: string;
    loginUrl: string;
  };
}

export const SsoDiscoverInput = z.object({ email: z.string().trim().toLowerCase().email() });
export type SsoDiscoverInput = z.infer<typeof SsoDiscoverInput>;

export interface SsoDiscoverResponse {
  sso: boolean;
  /** Ruta relativa que inicia el flujo (redirige al IdP). */
  startUrl: string | null;
  organizationName: string | null;
  /** true si la organización bloquea la contraseña. */
  enforced: boolean;
}

// ───────────────────────────── SCIM 2.0 ─────────────────────────────

export const CreateScimTokenInput = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateScimTokenInput = z.infer<typeof CreateScimTokenInput>;

export interface ScimToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ScimSettings {
  /** Base de los endpoints SCIM para configurar en el IdP. */
  baseUrl: string;
  tokens: ScimToken[];
  /** Rol con el que se dan de alta los usuarios aprovisionados. */
  defaultRole: "admin" | "member";
}
