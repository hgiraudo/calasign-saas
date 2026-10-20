// Conectores low-code / iPaaS (Power Automate, Logic Apps, Zapier, Make, n8n, Dynamics 365): contratos de los endpoints
// pensados para herramientas que arman formularios a partir de metadatos (campos dinámicos) y que no saben armar
// arreglos de destinatarios por rol.
import { z } from "zod";
import { CHANNELS, LOCALES, UserMetadata } from "./api";

/** Destinatario de un rol de plantilla en el envío "por formulario" (las claves del objeto son el rol). */
export const LowcodeRoleRecipient = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/)
    .optional()
    .nullable(),
  locale: z.enum(LOCALES).optional().nullable(),
  channels: z.array(z.enum(CHANNELS)).min(1).optional(),
});
export type LowcodeRoleRecipient = z.input<typeof LowcodeRoleRecipient>;

/**
 * POST /v1/envelopes/from-template/{templateId}: como /v1/envelopes/from-template, pero con los destinatarios como
 * objeto `{ <id o nombre del rol>: { name, email, phone } }` y el prellenado como `{ <id o etiqueta del campo>: valor }`.
 * Es la forma que producen los campos dinámicos de Power Automate (x-ms-dynamic-schema), Zapier, Make y n8n.
 * Por defecto ENVÍA el sobre (send: true).
 */
export const LowcodeTemplateSendInput = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).optional().nullable(),
  locale: z.enum(LOCALES).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  metadata: UserMetadata.optional(),
  roles: z.record(z.string(), LowcodeRoleRecipient),
  /** Valores vacíos ("" o null) se ignoran: las herramientas low-code mandan todos los campos del formulario. */
  prefill: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  send: z.boolean().default(true),
});
export type LowcodeTemplateSendInput = z.input<typeof LowcodeTemplateSendInput>;

/** GET /v1/templates/{id}/input-schema: lo que hace falta para armar el formulario dinámico de una plantilla. */
export interface LowcodeTemplateInputSchema {
  templateId: string;
  name: string;
  roles: { id: string; name: string; role: string; routingOrder: number }[];
  /** Campos que el remitente puede prellenar (no de solo lectura). */
  fields: { id: string; label: string | null; type: string; required: boolean; options: string[] | null; roleId: string; roleName: string | null }[];
  /** JSON Schema (draft-04, el que entiende Power Automate) del objeto `roles` del envío. */
  rolesSchema: Record<string, unknown>;
  /** JSON Schema del objeto `prefill`. */
  prefillSchema: Record<string, unknown>;
}
