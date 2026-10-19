# CalaSign para Dynamics 365

Integración low-code con Dynamics 365 Sales / Customer Service (y cualquier app model-driven de Dataverse), armada
con el **conector personalizado de CalaSign para Power Automate** — la misma arquitectura que usan DocuSign y Adobe
Acrobat Sign en Power Platform: botón en el registro → flujo → sobre; webhook → flujo → estado y PDF en el registro.

```
[Oportunidad] --botón "Enviar a firmar"--> calasign_sendforsignature = Sí
      │                                                │ (Dataverse: "cuando se modifica una fila")
      │                                   Flujo 1 "CalaSign: enviar a firmar"
      │                                     contacto principal → CalaSign "Send an envelope from a template"
      │                                     (metadata.recordId = id de la oportunidad) → guarda calasign_envelopeid
      ▼
[CalaSign] --webhook--> Flujo 2 "CalaSign: sincronizar estado"
                          calasign_status / calasign_completedon → nota con el PDF firmado
```

## Contenido

| Archivo | Para qué |
|---|---|
| `setup-dataverse.mjs` | Crea (idempotente) el publicador y la solución **CalaSign**, las columnas `calasign_sendforsignature`, `calasign_status`, `calasign_envelopeid`, `calasign_templateid`, `calasign_completedon` en la tabla elegida, sube el web resource y publica. |
| `webresources/calasign_commands.js` | Web resource `calasign_/commands.js`: botones **Enviar a firmar** (`CalaSign.sendForSignature`) y **Ver en CalaSign** (`CalaSign.openEnvelope`), con reglas de visibilidad `CalaSign.canSend` / `CalaSign.canOpen`. |
| `flows/calasign-send-on-request.json` | Definición del flujo 1 (Workflow Definition Language). |
| `flows/calasign-sync-status.json` | Definición del flujo 2. |
| `../power-automate/` | El conector personalizado (requisito). |

## Instalación (≈ 20 minutos, la hace un administrador del entorno)

1. **Conector**: make.powerautomate.com → *Datos → Conectores personalizados → Nuevo → Importar un archivo OpenAPI*
   con `apiDefinition.swagger.json` del zip de Power Automate (o `pac connector create`, ver su readme), dentro de la
   solución **CalaSign**. Crear la conexión con `Bearer <API key de CalaSign>`.
2. **Columnas y web resource**:
   ```bash
   DATAVERSE_URL=https://<org>.crm.dynamics.com \
   DATAVERSE_TOKEN=$(az account get-access-token --resource https://<org>.crm.dynamics.com --query accessToken -o tsv) \
   node setup-dataverse.mjs --table opportunity          # --table account, --table quote… · --dry-run para ver qué haría
   ```
   Agregar las columnas al formulario de la oportunidad (sección "Firma electrónica").
3. **Botones** (make.powerapps.com → la app → *Editar barra de comandos* → Formulario principal de Oportunidad):
   - *Enviar a firmar*: acción **Ejecutar JavaScript**, biblioteca `calasign_/commands.js`, función
     `CalaSign.sendForSignature`, parámetro `PrimaryControl`. Visibilidad (Power Fx):
     `IsBlank(Self.Selected.Item.'CalaSign envelope ID') || Self.Selected.Item.'CalaSign status' in ["declined","voided","expired","error"]`.
   - *Ver en CalaSign*: función `CalaSign.openEnvelope`, parámetro `PrimaryControl`, visible si hay `CalaSign envelope ID`.
4. **Flujos**: crear en la solución dos flujos automatizados siguiendo `flows/*.json` (cada acción tiene el nombre del
   paso del diseñador): disparador de Dataverse *Cuando se agrega, modifica o elimina una fila* (Modificado, tabla
   Oportunidades, ámbito Organización, columnas de filtro `calasign_sendforsignature`, fila de filtro
   `calasign_sendforsignature eq true`) y disparador de CalaSign *When an envelope event occurs*. En Logic Apps las
   definiciones se pegan en la vista de código (cambiando `shared_calasign` por el nombre de API del conector y
   configurando las conexiones).
5. Probar: abrir una oportunidad con contacto principal → **Enviar a firmar** → firmar el correo → la oportunidad
   muestra `completed` y una nota con el PDF firmado.

## Otras tablas y productos

- **Otra tabla** (cuenta, cotización, caso, contrato, entidad propia): `--table <nombre lógico>` y en los flujos cambiar
  `opportunity`/`opportunities`, el campo id y el lookup del contacto.
- **Business Central**: mismo patrón con el conector *Dynamics 365 Business Central* de Power Automate (disparador
  *When a record is changed (V3)* en la tabla de documentos de venta) y la acción de CalaSign; el PDF se adjunta con
  *Create an attachment*. Sin web resources: la acción se lanza desde el botón *Automate* del registro (flujo instantáneo).
- **Finance & Operations**: un *Business event* dispara el flujo y el PDF va a *Document management*.

## Notas

- La API key de CalaSign queda solo en la conexión del conector; el web resource no habla con CalaSign.
- `metadata.recordId` / `recordType` vuelven en cada evento: sirven para cualquier otra tabla.
- Un flujo por entorno; los webhooks de CalaSign son máximo 20 por organización.
