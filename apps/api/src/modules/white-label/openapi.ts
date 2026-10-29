// Operaciones de marca blanca para el OpenAPI (y de ahí los SDKs).
import { z } from "zod";
import {
  BRAND_ASSET_KINDS,
  BRAND_MESSAGE_EVENTS,
  BrandConfigInput,
  BrandPreviewInput,
  CreateBrandInput,
  SetDomainInput,
  UpdateBrandInput,
} from "@calasign/shared";
import type { Op } from "../openapi-extra";
import { named } from "../openapi-schemas";

const iso = z.string().datetime().nullable();
const color = z.string().nullable();

const PublicBrandThemeSchema = named(
  "PublicBrandTheme",
  z.object({
    brandId: z.string().describe('"default" (marca de la organización) o id de la sub-marca'),
    name: z.string(),
    productName: z.string().nullable(),
    whiteLabel: z.boolean().describe('Sin "Powered by" ni menciones a la plataforma'),
    theme: z.object({
      primaryColor: color,
      secondaryColor: color,
      backgroundColor: color,
      textColor: color,
      buttonColor: color,
      buttonTextColor: color,
      headerTextColor: color,
      borderRadius: z.number().nullable(),
      fontFamily: z.string().nullable(),
      fontSource: z.enum(["system", "google", "upload"]).nullable(),
    }),
    css: z.string().describe("Variables del tema + CSS propio saneado"),
    links: z.object({
      websiteUrl: z.string().nullable(),
      supportUrl: z.string().nullable(),
      privacyUrl: z.string().nullable(),
      termsUrl: z.string().nullable(),
    }),
    logoUrl: z.string().nullable(),
    logoDarkUrl: z.string().nullable(),
    faviconUrl: z.string().nullable(),
    fontUrl: z.string().nullable(),
    fontCssUrl: z.string().nullable(),
    texts: z.record(z.string(), z.record(z.string(), z.string())),
  }),
);

const BrandDomainSchema = named(
  "BrandDomain",
  z.object({
    domain: z.string(),
    status: z.enum(["pending", "verified"]),
    txtName: z.string(),
    txtValue: z.string(),
    cnameTarget: z.string(),
    verifiedAt: iso,
    lastCheckedAt: iso,
    lastError: z.string().nullable(),
  }),
);

const BrandSchema = named(
  "Brand",
  z.object({
    id: z.string().describe('"default" o uuid de la sub-marca'),
    name: z.string(),
    slug: z.string(),
    isDefault: z.boolean(),
    config: BrandConfigInput,
    assets: z.object({
      logoUrl: z.string().nullable(),
      logoDarkUrl: z.string().nullable(),
      faviconUrl: z.string().nullable(),
      fontUrl: z.string().nullable(),
    }),
    emailSender: z.object({ from: z.string(), replyTo: z.string().nullable(), customDomain: z.boolean(), warning: z.string().nullable() }),
    domain: BrandDomainSchema.nullable(),
    baseUrl: z.string(),
    effective: PublicBrandThemeSchema,
    updatedAt: iso,
  }),
);

const EmailDomainSchema = named(
  "EmailDomain",
  z.object({
    domain: z.string(),
    status: z.enum(["pending", "verified"]),
    records: z.array(
      z.object({
        purpose: z.enum(["ownership", "dkim", "spf", "dmarc"]),
        type: z.literal("TXT"),
        name: z.string(),
        value: z.string(),
        ok: z.boolean().nullable(),
        required: z.boolean(),
      }),
    ),
    verifiedAt: iso,
    lastCheckedAt: iso,
    lastError: z.string().nullable().describe("Último error de la verificación por DNS"),
    sesIdentityError: z
      .string()
      .nullable()
      .describe("Amazon SES rechazó el dominio como remitente (identidad sin verificar): los correos salen desde la plataforma"),
    sesIdentityErrorAt: iso,
  }),
);

const PreviewSchema = named(
  "BrandPreview",
  z.object({
    subject: z.string().optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    from: z.string().optional(),
    theme: PublicBrandThemeSchema.optional(),
  }),
);

const ID = "`id`: `default` (marca de la organización) o el uuid de una sub-marca.";
const T = "Marca";
const WL = ["plan_limit_white_label"];

export const WHITE_LABEL_OPS: Op[] = [
  {
    method: "get",
    path: "/v1/settings/brands",
    operationId: "listBrands",
    tag: T,
    summary: "Marcas (la de la organización y sus sub-marcas)",
    description: "Marca blanca completa: tema, textos por idioma, plantillas de correo, remitente, dominios. Ver docs/MARCA-BLANCA.md.",
    response: z.object({ items: z.array(BrandSchema) }),
  },
  {
    method: "post",
    path: "/v1/settings/brands",
    operationId: "createBrand",
    tag: T,
    summary: "Crear una sub-marca (cliente de una organización revendedora)",
    body: CreateBrandInput,
    response: BrandSchema,
    status: 201,
    errors: WL,
  },
  { method: "get", path: "/v1/settings/brands/{id}", operationId: "getBrand", tag: T, summary: "Marca", description: ID, response: BrandSchema },
  {
    method: "put",
    path: "/v1/settings/brands/{id}",
    operationId: "updateBrand",
    tag: T,
    summary: "Reemplazar la configuración de una marca",
    description: `${ID} La configuración se reemplaza entera (hacé GET, modificá y PUT). Una sub-marca hereda de la marca de la organización lo que no define. Plantillas: eventos ${BRAND_MESSAGE_EVENTS.join(", ")}; variables {{recipientName}}, {{senderName}}, {{organizationName}}, {{subject}}, {{message}}, {{link}}, {{reason}}, {{declinedBy}}, {{productName}}, {{supportUrl}}, {{code}}.`,
    body: UpdateBrandInput,
    response: BrandSchema,
    errors: ["plan_limit_branding", ...WL],
  },
  {
    method: "delete",
    path: "/v1/settings/brands/{id}",
    operationId: "deleteBrand",
    tag: T,
    summary: "Borrar una sub-marca (sus sobres pasan a la marca de la organización)",
    response: "none",
    status: 204,
  },
  {
    method: "post",
    path: "/v1/settings/brands/{id}/preview",
    operationId: "previewBrand",
    tag: T,
    summary: "Vista previa de un correo o del tema",
    description: `${ID} \`config\` (opcional): configuración sin guardar. kind=email devuelve asunto, HTML, texto y remitente; kind=theme, el tema público.`,
    body: BrandPreviewInput,
    response: PreviewSchema,
  },
  {
    method: "post",
    path: "/v1/settings/brands/{id}/assets/{kind}",
    operationId: "uploadBrandAsset",
    tag: T,
    summary: "Subir logo, logo oscuro, favicon o fuente",
    description: `kind: ${BRAND_ASSET_KINDS.join(", ")}. Logo/logoDark: PNG, JPG o SVG (200 KB). Favicon: PNG, SVG o ICO (100 KB). Fuente: WOFF2, WOFF, TTF u OTF (600 KB).`,
    multipart: true,
    fileDescription: "Imagen o fuente",
    response: BrandSchema,
    errors: ["plan_limit_branding", ...WL],
  },
  {
    method: "delete",
    path: "/v1/settings/brands/{id}/assets/{kind}",
    operationId: "deleteBrandAsset",
    tag: T,
    summary: "Quitar un archivo de la marca",
    response: BrandSchema,
  },
  {
    method: "put",
    path: "/v1/settings/brands/{id}/domain",
    operationId: "setBrandDomain",
    tag: T,
    summary: "Dominio web propio de una sub-marca",
    description: "Publicá el TXT indicado y un CNAME al host de la plataforma, y verificá. La marca de la organización usa /v1/domains.",
    body: SetDomainInput,
    response: z.object({ domain: BrandDomainSchema }),
    errors: WL,
  },
  {
    method: "post",
    path: "/v1/settings/brands/{id}/domain/verify",
    operationId: "verifyBrandDomain",
    tag: T,
    summary: "Verificar el dominio de la sub-marca",
    description: "Verificar (o re-verificar) exige la marca blanca en el plan (402); quitarlo no.",
    response: z.object({ domain: BrandDomainSchema }),
    errors: WL,
  },
  {
    method: "delete",
    path: "/v1/settings/brands/{id}/domain",
    operationId: "deleteBrandDomain",
    tag: T,
    summary: "Quitar el dominio de la sub-marca",
    response: "none",
    status: 204,
  },
  {
    method: "get",
    path: "/v1/settings/email-domains",
    operationId: "listEmailDomains",
    tag: T,
    summary: "Dominios de correo (remitente propio)",
    response: z.object({ items: z.array(EmailDomainSchema) }),
  },
  {
    method: "post",
    path: "/v1/settings/email-domains",
    operationId: "addEmailDomain",
    tag: T,
    summary: "Agregar un dominio de correo",
    description: "Devuelve los registros DNS: TXT de propiedad y clave DKIM (obligatorios), SPF y DMARC (recomendados).",
    body: SetDomainInput,
    response: EmailDomainSchema,
    status: 201,
    errors: WL,
  },
  {
    method: "post",
    path: "/v1/settings/email-domains/{domain}/verify",
    operationId: "verifyEmailDomain",
    tag: T,
    summary: "Verificar un dominio de correo",
    description: "Verificar (o re-verificar) exige la marca blanca en el plan (402); quitarlo no.",
    response: EmailDomainSchema,
    errors: WL,
  },
  {
    method: "delete",
    path: "/v1/settings/email-domains/{domain}",
    operationId: "deleteEmailDomain",
    tag: T,
    summary: "Quitar un dominio de correo",
    response: "none",
    status: 204,
  },
  {
    method: "get",
    path: "/v1/public/brand-theme",
    operationId: "getPublicBrandTheme",
    tag: T,
    summary: "Tema público de una marca (por ?b= o por el dominio)",
    auth: "none",
    query: [{ name: "b", description: "id de sub-marca o slug de la organización" }],
    response: PublicBrandThemeSchema,
  },
];
