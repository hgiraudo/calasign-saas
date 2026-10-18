// Operaciones del bloque Datos para /v1/openapi.json.
import { SetByokInput } from "@calasign/shared";

const TAG = "Datos";

export const DATA_OPS = [
  { method: "get", path: "/v1/public/cells", tag: TAG, summary: "Regiones (celdas) donde se pueden guardar los datos", auth: "none" },
  { method: "get", path: "/v1/settings/byok", tag: TAG, summary: "Estado de BYOK y política sugerida para la clave KMS del cliente" },
  {
    method: "put",
    path: "/v1/settings/byok",
    tag: TAG,
    summary: "Probar y activar (o cambiar) la clave KMS del cliente",
    body: SetByokInput,
    description: "422 byok_key_test_failed si la clave no pasa la prueba.",
  },
  { method: "post", path: "/v1/settings/byok/test", tag: TAG, summary: "Probar la clave KMS configurada" },
  { method: "delete", path: "/v1/settings/byok", tag: TAG, summary: "Dejar de usar la clave del cliente para lo nuevo", response: "none", status: 204 },
  { method: "get", path: "/v1/settings/sso/domains", tag: TAG, summary: "Dominios SSO y su verificación por DNS" },
  { method: "post", path: "/v1/settings/sso/domains/{domain}/verify", tag: TAG, summary: "Verificar un dominio SSO (TXT _calasign-sso.<dominio>)" },
  { method: "get", path: "/v1/envelopes/{id}/archive", tag: TAG, summary: "Vigencia del sello de archivo y versiones del PDF firmado" },
  { method: "post", path: "/v1/envelopes/{id}/archive/renew", tag: TAG, summary: "Renovar ahora el sello de archivo (DSS + sello de documento)" },
] as const;
