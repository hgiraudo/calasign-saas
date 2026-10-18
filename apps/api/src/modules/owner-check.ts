// Quien configuró algo que crea sobres solo (formularios web, envíos masivos en curso) tiene que seguir pudiendo
// crearlos: miembro de la organización (o API key sin revocar), con envelopes:create y acceso a la plantilla.
import type { Db } from "../infra/db";
import { assertTemplateAccess, hasPerm, loadAccess } from "./access";
import type { AuthContext } from "./context";

/** Motivo con código estable (para traducirlo) y texto en español (para logs, evidencia y mensajes). */
export interface OwnerProblem {
  code: "not_member" | "missing_permission" | "template_access" | "key_revoked";
  message: string;
}

export async function ownerProblem(
  db: Db,
  owner: { tenantId: string; userId: string | null; apiKeyId: string | null },
  templateId: string | null,
): Promise<OwnerProblem | null> {
  if (!owner.userId && !owner.apiKeyId) return null; // configuraciones viejas sin dueño registrado: sin cambios
  if (owner.apiKeyId) {
    const k = await db.one<any>(`SELECT revoked_at FROM api_keys WHERE id = $1 AND tenant_id = $2`, [owner.apiKeyId, owner.tenantId]);
    if (!k || k.revoked_at) return { code: "key_revoked", message: "La API key que lo configuró fue revocada" };
  }
  const a = { tenantId: owner.tenantId, userId: owner.apiKeyId ? null : owner.userId, apiKeyId: owner.apiKeyId, actor: { type: "system", label: "dueño" } } as AuthContext;
  try {
    a.access = await loadAccess(db, a);
  } catch {
    return { code: "not_member", message: "Quien lo configuró ya no es miembro de la organización" };
  }
  if (!hasPerm(a, "envelopes:create")) return { code: "missing_permission", message: "Quien lo configuró ya no tiene permiso para crear sobres" };
  if (templateId) {
    try {
      await assertTemplateAccess(db, a, templateId, "view");
    } catch {
      return { code: "template_access", message: "Quien lo configuró ya no tiene acceso a la plantilla" };
    }
  }
  return null;
}

/** Igual que ownerProblem, pero solo el texto (null si el dueño sigue habilitado). */
export async function ownerCanStillCreate(
  db: Db,
  owner: { tenantId: string; userId: string | null; apiKeyId: string | null },
  templateId: string | null,
): Promise<string | null> {
  return (await ownerProblem(db, owner, templateId))?.message ?? null;
}
