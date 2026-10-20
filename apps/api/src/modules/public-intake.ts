// Defensas compartidas de los links públicos que crean trabajo a nombre de una organización (formularios web y
// workflows con inicio público): tope por organización (por hora y por día) contando los dos, con un lock por
// organización para que dos pedidos simultáneos no lo superen.
import { config } from "../config";
import type { Db } from "../infra/db";

/** Tiempo mínimo entre mostrar un formulario público y aceptarlo (un humano tarda más; un bot, menos). */
export const MIN_FILL_MS = 2500;

/**
 * Toma el lock de la organización (hasta el fin de la transacción) y dice si llegó a su tope de usos públicos: sobres
 * de formularios web + ejecuciones de workflows iniciadas por el link público que hicieron trabajo (completaron su
 * primer formulario o no tienen formulario: workflow_runs.public_collected_at), en la última hora y el último día. Los
 * inicios que nunca completan el formulario no gastan este cupo (tienen el suyo: publicStartsCapReached).
 * Debe correr dentro de una transacción y ser el último lock que se toma (orden: formulario/workflow → organización).
 */
export async function publicTenantCapReached(t: Db, tenantId: string): Promise<boolean> {
  await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`webform-tenant:${tenantId}`]);
  const r = await t.one<{ h: number; d: number }>(
    `SELECT COALESCE(SUM(h), 0)::int AS h, COALESCE(SUM(d), 0)::int AS d FROM (
       SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS h, count(*) AS d
         FROM envelopes WHERE tenant_id = $1 AND (metadata->>'webFormId') IS NOT NULL AND created_at > now() - interval '1 day'
       UNION ALL
       SELECT count(*) FILTER (WHERE public_collected_at > now() - interval '1 hour') AS h, count(*) AS d
         FROM workflow_runs WHERE tenant_id = $1 AND public_collected_at > now() - interval '1 day'
     ) x`,
    [tenantId],
  );
  const W = config.webForms;
  return (r?.h ?? 0) >= W.maxPerTenantHour || (r?.d ?? 0) >= W.maxPerTenantDay;
}

/**
 * Tope aparte (más alto) de inicios por el link público de workflows por organización y hora, completen o no el
 * formulario: un inicio crea un run (y su token) aunque no haga más nada. Mismo lock que publicTenantCapReached.
 */
export async function publicStartsCapReached(t: Db, tenantId: string): Promise<boolean> {
  await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`webform-tenant:${tenantId}`]);
  const r = await t.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM workflow_runs
      WHERE tenant_id = $1 AND started_by IS NULL AND started_by_api_key IS NULL AND created_at > now() - interval '1 hour'`,
    [tenantId],
  );
  return (r?.n ?? 0) >= config.webForms.maxPublicStartsPerTenantHour;
}
