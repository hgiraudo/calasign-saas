// Operaciones del bloque Datos para /v1/openapi.json.
import { z } from "zod";
import { BYOK_STATUSES, SetByokInput } from "@calasign/shared";
import { named } from "../openapi-schemas";

const TAG = "Datos";

/** Espejo de ByokSettings (packages/shared/src/data.ts). */
const ByokSettingsSchema = named(
  "ByokSettings",
  z.object({
    status: z.enum(BYOK_STATUSES),
    keyArn: z.string().nullable(),
    checkedAt: z.string().datetime().nullable(),
    enabledAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
    platformPrincipal: z.string().describe("Rol de la plataforma que la clave tiene que autorizar."),
    keyPolicy: z.record(z.string(), z.unknown()).describe("Política (statements) a agregar en la clave del cliente."),
    region: z.string().describe("Celda (región) de los datos: la clave tiene que estar en esa región."),
  }),
);
const ByokChangeSchema = ByokSettingsSchema.extend({
  notice: z
    .string()
    .nullable()
    .describe("Si había una clave activa: aviso de que lo guardado antes del cambio sigue cifrado con ella (no se re-cifra; no deshabilitarla mientras haga falta leerlo). null si no había."),
});

export const DATA_OPS = [
  { method: "get", path: "/v1/public/cells", tag: TAG, summary: "Regiones (celdas) donde se pueden guardar los datos", auth: "none" },
  { method: "get", path: "/v1/settings/byok", tag: TAG, summary: "Estado de BYOK y política sugerida para la clave KMS del cliente", response: ByokSettingsSchema },
  {
    method: "put",
    path: "/v1/settings/byok",
    tag: TAG,
    summary: "Probar y activar (o cambiar) la clave KMS del cliente",
    body: SetByokInput,
    description: "422 byok_key_test_failed si la clave no pasa la prueba. Responde el estado de BYOK con `notice` si reemplaza a otra clave activa.",
    response: ByokChangeSchema,
  },
  { method: "post", path: "/v1/settings/byok/test", tag: TAG, summary: "Probar la clave KMS configurada" },
  {
    method: "delete",
    path: "/v1/settings/byok",
    tag: TAG,
    summary: "Dejar de usar la clave del cliente para lo nuevo",
    responseDescription:
      "200 con el estado de BYOK (ByokSettings, como GET) y `notice`: si había una clave activa, aviso de que lo ya guardado sigue cifrado con ella (no se re-cifra). Antes respondía 204 sin cuerpo.",
    response: ByokChangeSchema,
  },
  { method: "get", path: "/v1/settings/sso/domains", tag: TAG, summary: "Dominios SSO y su verificación por DNS" },
  { method: "post", path: "/v1/settings/sso/domains/{domain}/verify", tag: TAG, summary: "Verificar un dominio SSO (TXT _calasign-sso.<dominio>)", description: "Exige SSO en el plan (402).", errors: ["plan_limit_sso"] },
  { method: "get", path: "/v1/envelopes/{id}/archive", tag: TAG, summary: "Vigencia del sello de archivo y versiones del PDF firmado" },
  {
    method: "post",
    path: "/v1/envelopes/{id}/archive/renew",
    tag: TAG,
    summary: "Renovar ahora el sello de archivo (DSS + sello de documento)",
    description:
      "Una renovación a la vez por sobre (409 archive_renewal_in_progress), hasta 3 por día (429 archive_recently_renewed, sin Retry-After) y 50 en total (409 archive_renewal_limit). Si la autoridad de sellado de tiempo falla, 502 tsa_unavailable: reintentar más tarde. 409 archive_not_due si falta para el vencimiento o si un sello nuevo no extendería la validez (el último ya es del certificado vigente de la TSA); 409 archive_not_applicable si el PDF no es de archivo (o no se puede analizar). Si falla el almacenamiento, 503 storage_unavailable o byok_key_unavailable.",
    errors: ["archive_renewal_in_progress", "archive_recently_renewed", "archive_renewal_limit", "archive_not_due", "archive_not_applicable", "tsa_unavailable"],
  },
] as const;
