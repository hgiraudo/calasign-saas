# CalaSign para Make

App personalizada de Make (Custom Apps). Cada archivo del zip es el contenido de una pestaña del editor de apps de Make:

| Componente | Archivos | Pestañas |
|---|---|---|
| Base | `base.imljson`, `common.imljson` | Base, Common data (client_id/secret de la app OAuth de CalaSign) |
| Conexión API key | `connections/calasign-apikey/` | Communication, Parameters |
| Conexión OAuth 2.0 (PKCE S256) | `connections/calasign-oauth/` | Communication, Parameters, Default scope |
| Webhook (dedicado, attach/detach) | `webhooks/envelope-event/` | Communication, Parameters, Attach, Detach |
| Módulos | `modules/<id>/` | Communication (`api`), Static parameters, Mappable parameters (`expect`), Interface, Samples |
| RPC | `rpcs/listTemplates`, `rpcs/templateForm` | Communication, Parameters |
| Funciones IML | `functions/*.js` | Functions |

Módulos: **Watch Envelope Events** (instantáneo), **Send an Envelope from a Template** (los destinatarios por rol y los
campos prellenables salen de la plantilla por `rpc://templateForm`), **Send a Document for Signature** (crea, sube el
PDF, destinatarios, campos de firma y envía), **Get an Envelope**, **Download the Signed Document**, **Void an
Envelope**, **Search Envelopes**.

`calasign-make-app.json` tiene todo junto para revisarlo. `makecomapp.json` es el manifiesto para la extensión
**Make Apps Editor** de VS Code (desarrollo local): completar `origins` con la zona y el id de la app creada, poner la
API key de Make (scopes `sdk-apps:read`, `sdk-apps:write`) en `.secrets/apikey` y hacer *Deploy*.

## Pasos para publicar (cuenta de Make de CalaSign)

1. Make → **Custom apps → Create a new app** (`calasign`, color `#1F4E79`, ícono de 512×512).
2. Copiar cada archivo en su pestaña (o *Deploy* desde VS Code).
3. OAuth: crear en CalaSign (Ajustes → Apps OAuth) una app confidencial con redirect URI
   `https://www.make.com/oauth/cb/app` y scopes `envelopes:read envelopes:write templates:read webhooks:manage
   offline_access`; poner client_id y secret en *Common data*.
4. Probar cada módulo en un escenario y pedir la revisión de Make para publicarla ("Request review").
