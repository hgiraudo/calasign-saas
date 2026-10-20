// Fase 4 — Equipos: miembros, invitaciones, roles (RBAC), grupos, auditoría, retención y 2FA.
import { z } from "zod";
import type { PlanFeature } from "./billing";

// ───────────────────────────── Permisos ─────────────────────────────

export const PERMISSIONS = [
  "envelopes:create",
  "envelopes:view_all",
  "envelopes:manage_all",
  "templates:manage",
  "settings:manage",
  "members:manage",
  "api_keys:manage",
  "webhooks:manage",
  "audit:view",
  "billing:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const BUILTIN_ROLES = ["owner", "admin", "member"] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
/** Rol de una membresía: uno de los integrados o "custom" (con roleId). */
export type MemberRole = BuiltinRole | "custom";

export const BUILTIN_ROLE_PERMISSIONS: Record<BuiltinRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  member: ["envelopes:create"],
};

/** Rol a asignar: integrado, o custom con su id. */
export const RoleAssignment = z
  .object({
    role: z.enum(["owner", "admin", "member", "custom"]),
    roleId: z.string().uuid().optional().nullable(),
  })
  .refine((r) => (r.role === "custom") === Boolean(r.roleId), { message: "roleId es obligatorio solo con role=custom" });
export type RoleAssignment = z.infer<typeof RoleAssignment>;

export const CreateRoleInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});
export type CreateRoleInput = z.infer<typeof CreateRoleInput>;
export const UpdateRoleInput = CreateRoleInput.partial();
export type UpdateRoleInput = z.infer<typeof UpdateRoleInput>;

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  memberCount: number;
  createdAt: string;
}

// ───────────────────────────── Acceso de la sesión ─────────────────────────────

export interface TenantMembershipSummary {
  id: string;
  name: string;
  slug: string;
  role: MemberRole;
  roleName: string;
  current: boolean;
}

export interface AccessResponse {
  role: MemberRole;
  roleName: string;
  permissions: Permission[];
  groups: { id: string; name: string }[];
  tenants: TenantMembershipSummary[];
  twoFactor: { enabled: boolean; requiredByTenant: boolean; setupRequired: boolean };
  /** Funciones del plan actual de la organización (para que la consola no ofrezca lo que el plan no incluye). */
  planFeatures: PlanFeature[];
  planName: string;
}

export const SwitchTenantInput = z.object({ tenantId: z.string().uuid() });
export type SwitchTenantInput = z.infer<typeof SwitchTenantInput>;

// ───────────────────────────── Miembros e invitaciones ─────────────────────────────

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  roleId: string | null;
  roleName: string;
  groups: { id: string; name: string }[];
  twoFactorEnabled: boolean;
  joinedAt: string;
}

export const InviteMemberInput = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    role: z.enum(["owner", "admin", "member", "custom"]).default("member"),
    roleId: z.string().uuid().optional().nullable(),
    locale: z.enum(["es", "pt-BR", "en"]).optional(),
  })
  .refine((r) => (r.role === "custom") === Boolean(r.roleId), { message: "roleId es obligatorio solo con role=custom" });
export type InviteMemberInput = z.input<typeof InviteMemberInput>;

export interface Invitation {
  id: string;
  email: string;
  role: MemberRole;
  roleId: string | null;
  roleName: string;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
}

export interface CreateInvitationResponse {
  invitation: Invitation;
  /** Link de aceptación. Se devuelve solo al crearla (también se envía por correo). */
  acceptUrl: string;
}

/** Vista pública de una invitación (por su token). */
export interface InvitationPreview {
  organizationName: string;
  email: string;
  role: MemberRole;
  roleName: string;
  invitedByName: string | null;
  existingAccount: boolean;
  status: Invitation["status"];
}

export const AcceptInvitationInput = z.object({
  /** Cuenta nueva: nombre y contraseña. Cuenta existente: contraseña de esa cuenta (o sesión ya iniciada con ese correo). */
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(1).max(200).optional(),
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationInput>;

// ───────────────────────────── Grupos y visibilidad ─────────────────────────────

export const CreateGroupInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).optional().nullable(),
  memberIds: z.array(z.string().uuid()).max(1000).optional(),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;
export const UpdateGroupInput = CreateGroupInput.partial();
export type UpdateGroupInput = z.infer<typeof UpdateGroupInput>;

export interface Group {
  id: string;
  name: string;
  description: string | null;
  members: { userId: string; name: string; email: string }[];
  createdAt: string;
}

export const PutSharesInput = z.object({ groupIds: z.array(z.string().uuid()).max(100) });
export type PutSharesInput = z.infer<typeof PutSharesInput>;

export const PutTemplateSharesInput = PutSharesInput.extend({
  visibility: z.enum(["organization", "restricted"]).optional(),
});
export type PutTemplateSharesInput = z.infer<typeof PutTemplateSharesInput>;

export interface SharesResponse {
  groups: { id: string; name: string }[];
  /** Solo plantillas. */
  visibility?: "organization" | "restricted";
  /** Solo al guardar los de una plantilla: su updatedAt (el editor lo usa para su control de edición concurrente). */
  templateUpdatedAt?: string;
}

// ───────────────────────────── Auditoría de cuenta ─────────────────────────────

export interface AuditLogEntry {
  id: number;
  occurredAt: string;
  actorType: "user" | "api_key" | "system" | "anonymous";
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditLogResponse {
  items: AuditLogEntry[];
  nextCursor: string | null;
}

// ───────────────────────────── Seguridad y retención ─────────────────────────────

export interface SecuritySettings {
  /** Días después de completado un sobre en que se borran originales, imágenes de firma y adjuntos (null = nunca). */
  retentionDays: number | null;
  require2fa: boolean;
}

export const UpdateSecuritySettingsInput = z.object({
  retentionDays: z.number().int().min(1).max(36500).nullable().optional(),
  require2fa: z.boolean().optional(),
});
export type UpdateSecuritySettingsInput = z.infer<typeof UpdateSecuritySettingsInput>;

export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
  /** SVG del código QR (para mostrar inline). */
  qrSvg: string;
}

export const TotpCodeInput = z.object({ code: z.string().trim().min(6).max(20) });
export type TotpCodeInput = z.infer<typeof TotpCodeInput>;

export interface TotpEnableResponse {
  /** Códigos de recuperación de un solo uso. Se muestran una vez. */
  recoveryCodes: string[];
}

/** Respuesta de /v1/auth/login cuando la cuenta tiene 2FA: no crea sesión todavía. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}

export const TwoFactorLoginInput = z.object({
  challengeToken: z.string().min(20).max(200),
  /** Código TOTP de 6 dígitos o un código de recuperación. */
  code: z.string().trim().min(6).max(20),
});
export type TwoFactorLoginInput = z.infer<typeof TwoFactorLoginInput>;
