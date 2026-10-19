# CalaSign para Zoho CRM

Botón **«Enviar a firmar con CalaSign»** en los Deals de Zoho CRM. Se apoya en el conector nativo de CalaSign
(Ajustes → **CRM y ERP** → Zoho CRM / Bigin), que es el que lee el Deal, arma el sobre y devuelve el estado y el PDF
firmado al registro. El botón solo le pide a CalaSign que envíe ese Deal:

```
[Deal] --botón--> función Deluge --POST /v1/crm/mappings/{id}/send { objectId: <Deal Id> }--> CalaSign
                                                                                                 │ lee el Deal (OAuth)
[Deal] <-- CalaSign_Status = sent / completed …, PDF firmado en Attachments, nota con el hash ───┘
```

## Contenido

| Archivo | Para qué |
|---|---|
| `deluge/enviar_a_firmar.deluge.txt` | Cuerpo de la función de tipo **Botón** (argumento `dealId`). Usa la conexión `calasign` y las variables `calasign_mapping_id` y `calasign_base_url`. |
| `README.md` | Esta guía. |

## Antes: el conector nativo en CalaSign

1. CalaSign → Ajustes → **CRM y ERP** → tarjeta **Zoho CRM / Bigin** → producto *Zoho CRM*, centro de datos de la
   cuenta (si no se sabe, `zoho.com`: Zoho redirige al que corresponda) → **Conectar con OAuth**.
2. En Zoho: Setup → Customization → Modules → **Deals** → campo nuevo **CalaSign Status** (línea de texto; nombre de API
   `CalaSign_Status`).
3. En CalaSign, **Mapeos → Nuevo**: conexión de Zoho, tipo `deal`, plantilla, destinatarios (*contacto* = el
   `Contact_Name` del Deal; *contacto con rol* = sus Contact Roles, p. ej. `Legal`; o campos del Deal), prellenado
   (campo ← `Amount`, `Deal_Name`, `Account_Name.name`…) y write-back en `CalaSign_Status`. Copiar el **id del mapeo**.

Con eso ya se puede enviar desde CalaSign con el id del Deal. El botón lo hace desde Zoho.

## Instalar el botón en una organización (≈ 10 minutos, sin Marketplace)

1. **API key**: CalaSign → Ajustes → API keys → nueva key con rol que pueda crear sobres.
2. **Conexión**: Zoho CRM → Setup → Developer Hub → **Connections** → *Create Connection* → *Custom Service*:
   - Service name `CalaSign`, Authentication type **API Key**.
   - Parámetro: nombre `Authorization`, ubicación **Header**, valor `Bearer <API key>`.
   - Connection link name: **`calasign`** (es el que usa la función).
3. **Variables**: Setup → Developer Hub → **Variables** → `calasign_mapping_id` (el id del mapeo) y, si CalaSign no es
   `{{BASE_URL}}` (dominio propio, otro entorno), `calasign_base_url`.
4. **Función y botón**: Setup → Customization → Modules → Deals → **Links and Buttons** → *New Button*:
   - Nombre «Enviar a firmar con CalaSign», ubicación *Detail page* (y, si se quiere, *List view* para un registro).
   - Acción **Writing Function** → pegar `deluge/enviar_a_firmar.deluge.txt`, argumento `dealId` = **Deals → Deal Id**.
   - *Save* → permisos por perfil (quién ve el botón).
5. Probar en un Deal: el mensaje trae el enlace al sobre; al firmarse, `CalaSign Status` pasa a `completed` (o el valor
   configurado) y el PDF aparece en **Attachments** con una nota.

**Bigin**: el mismo flujo con la conexión de producto *Bigin* en CalaSign, el campo en **Pipelines** y, en la función,
`zoho.bigin.getRecordById("Pipelines", …)` en lugar de `zoho.crm.getRecordById("Deals", …)`.

## Publicar en Zoho Marketplace (cuenta de CalaSign)

1. [Zoho Developer Console](https://sigma.zoho.com) → **Zoho CRM → Create Extension** (`CalaSign`, namespace p. ej.
   `calasign`).
2. En la extensión:
   - **Connectors / Connections**: servicio *CalaSign* con autenticación **API Key** (header `Authorization`, valor
     `Bearer {key}`); cada organización la completa al instalar. Link name `calasign` (en el código de la extensión
     puede quedar con el prefijo del namespace: ajustar `connection:` en la función).
   - **Custom field** `CalaSign Status` en Deals (sale con la extensión).
   - **Variables** `calasign_mapping_id` y `calasign_base_url` (en Deluge se leen con el prefijo, p. ej.
     `calasign__calasign_mapping_id`: ajustar los `getOrgVariable`). Mostrar ambas en la página de **Settings** de la
     extensión para que el administrador las complete después de instalar.
   - **Links and Buttons** → botón en Deals con la función de `deluge/enviar_a_firmar.deluge.txt`.
3. **Test your Extension** en la organización de prueba (sandbox de Developer Console) con un CalaSign de pruebas.
4. **Package → Publish**: ficha del Marketplace (descripción en es/en/pt, capturas del botón y del Deal con el PDF
   adjunto, URL de soporte, política de privacidad y términos), precio (gratis) y *Submit for review*. Zoho revisa la
   extensión (suele tardar algunos días hábiles) y la publica.

Notas:

- La extensión **no guarda datos**: la API key queda en la conexión de Zoho y los tokens de OAuth del conector nativo,
  cifrados en CalaSign.
- El conector nativo necesita `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` en el servidor de CalaSign (cliente
  *Server-based Application* en api-console.zoho.com con Multi-DC). Ver `docs/CRM.md`.
