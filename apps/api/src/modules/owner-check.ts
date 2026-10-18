// Quien configuró algo que crea sobres solo (formularios web, envíos masivos en curso) tiene que seguir pudiendo
// crearlos: miembro de la organización (o API key sin revocar), con envelopes:create y acceso a la plantilla.
import type { Db } from "../infra/db";
import { assertTemplateAccess, hasPerm, loadAccess } from "./access";
import type { AuthContext } from "./context";

export async function ownerCanStillCreate(
  db: Db,
  owner: { tenantId: string; userId: string | null; apiKeyId: string | null },
  templateId: string | null,
): Promise<string | null> {
  if (!owner.userId && !owner.apiKeyId) return null; // configuraciones viejas sin dueño registrado: sin cambios
  if (owner.apiKeyId) {
    const k = await db.one<any>(`SELECT revoked_at FROM api_keys WHERE id = $1 AND tenant_id = $2`, [owner.apiKeyId, owner.tenantId]);
    if (!k || k.revoked_at) return "La API key que lo configuró fue revocada";
  }
  const a = { tenantId: owner.tenantId, userId: owner.apiKeyId ? null : owner.userId, apiKeyId: owner.apiKeyId, actor: { type: "system", label: "dueño" } } as AuthContext;
  try {
    a.access = await loadAccess(db, a);
  } catch {
    return "Quien lo configuró ya no es miembro de la organización";
  }
  if (!hasPerm(a, "envelopes:create")) return "Quien lo configuró ya no tiene permiso para crear sobres";
  if (templateId) {
    try {
      await assertTemplateAccess(db, a, templateId, "view");
    } catch {
      return "Quien lo configuró ya no tiene acceso a la plantilla";
    }
  }
  return null;
}
