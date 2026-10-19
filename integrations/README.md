# Integraciones de CalaSign

Artefactos descargables para usar CalaSign desde asistentes de IA y desde Office. Las fuentes están acá; el build
(`integrations/build.mjs`) los genera en `apps/web/public/integrations/` (no se versiona), Vite los copia a
`apps/web/dist/integrations/` y la API los sirve en **`<base>/integrations/…`**.

| Artefacto | URL (dev) | Fuente |
|---|---|---|
| Skill de Claude (zip) | `https://dev.calasign.com/integrations/calasign-skill.zip` | `skill/calasign/` |
| Marketplace de Claude Code | `https://dev.calasign.com/integrations/claude-code/marketplace.json` (página: `/integrations/claude-code/`) | `claude-code/` + la skill |
| Plugin de Claude Code (zip) | `https://dev.calasign.com/integrations/claude-code/calasign-plugin-<versión>.zip` | idem |
| Extensión de Claude Desktop (MCPB) | `https://dev.calasign.com/integrations/calasign.mcpb` | `mcpb/` |
| Extensión de Gemini CLI | `https://dev.calasign.com/integrations/calasign-gemini-extension.zip` y carpeta `/integrations/gemini-cli/` | `gemini-cli/` + la skill (→ `GEMINI.md`) |
| Ejemplo API de Gemini | `https://dev.calasign.com/integrations/gemini-api/example.py` | `gemini-api/example.py` |
| Guía ChatGPT / OpenAI / Anthropic API | `https://dev.calasign.com/integrations/chatgpt/README.md` | `chatgpt/README.md` |
| Complemento de Word | `https://dev.calasign.com/integrations/office/manifest.xml` (página: `/integrations/office/`) | `office/` |
| Complemento de Outlook | `https://dev.calasign.com/integrations/office/manifest-outlook.xml` | `office/` |
| Índice | `https://dev.calasign.com/integrations/` y `/integrations/index.json` (tamaños y sha256) | `site/` |

## Build

```bash
corepack pnpm build:integrations                                   # https://dev.calasign.com
CALASIGN_BASE_URL=https://app.calasign.com corepack pnpm build:integrations   # otro entorno
node integrations/build.mjs --plugin-repo ../claude-plugins       # además, el repo git del marketplace
corepack pnpm --filter @calasign/integrations test                 # pruebas (sin red)
```

- **URL base**: `CALASIGN_BASE_URL` (default `https://dev.calasign.com`). Todas las fuentes usan `{{BASE_URL}}`; el
  build corta si queda un placeholder sin reemplazar. Otras variables: `CALASIGN_PRIVACY_URL` (default
  `<base>/privacy`, para el manifiesto MCPB), `CALASIGN_INTEGRATIONS_OUT`.
- **Versión**: la de `integrations/package.json` (plugin, MCPB, extensión de Gemini; Office usa `x.y.z.0`). Subila
  cuando cambie algo publicado: el zip del plugin lleva la versión en el nombre y su sha256 queda fijo en el
  marketplace.
- **Determinista**: zip propio (`lib/zip.mjs`, fecha fija, orden fijo) → mismo build, mismos bytes, mismo sha256.
- **Deploy**: `scripts/deploy-dev.sh` corre `build:integrations` con `https://$DOMAIN` antes de compilar la web, así
  que los binarios se generan en cada deploy y no se versionan. El servidor solo recibe `apps/web/dist`.
- **Servido por la API** (Caddy hace proxy de todo a la API): `apps/api/src/modules/integrations-static.ts`
  pone `cache-control: no-cache` en `/integrations/*`, `application/zip` al `.mcpb`, texto plano a `.md`/`.py`, y
  solo en `/integrations/office/*` cambia el CSP (frame-ancestors de Office, scripts de `appsforoffice.microsoft.com`),
  quita `X-Frame-Options` y usa `Cross-Origin-Opener-Policy: unsafe-none`. Un archivo inexistente bajo
  `/integrations/` da 404 (no cae en la SPA). El service worker (`apps/web/public/sw.js`) no intercepta `/integrations/`.

## Instalación por cliente

Servidor MCP: **`https://dev.calasign.com/mcp`** (Streamable HTTP; OAuth 2.0 con registro dinámico, o API key como
`Authorization: Bearer cs_live_…`).

### Claude (claude.ai / Claude Desktop) — conector remoto
1. Ajustes → **Conectores** → **Agregar conector personalizado**.
2. URL `https://dev.calasign.com/mcp` → Agregar → **Conectar** → login y consentimiento en CalaSign.
3. (Opcional) Skill: descargar `calasign-skill.zip` y subirla en **claude.ai/customize/skills** (requiere ejecución de
   código habilitada). Funciona igual en Claude Desktop. Por API: Skills API con el mismo zip.

### Claude Desktop — extensión MCPB
1. Descargar `calasign.mcpb` y abrirlo (doble clic) o Ajustes → **Extensiones** → Instalar extensión.
2. Pegar la **API key** (Ajustes → API keys en CalaSign). `CalaSign URL` solo se cambia para otro entorno.

Es un proxy stdio (Node, incluido en Claude Desktop) al servidor MCP remoto: herramientas, esquemas y anotaciones son
siempre las del servidor.

### Claude Code — plugin (sin repo git)
```bash
claude plugin marketplace add https://dev.calasign.com/integrations/claude-code/marketplace.json
claude plugin install calasign@calasign
# en Claude Code: /mcp → calasign → Authenticate
```
Trae el servidor MCP (`.mcp.json`, OAuth), la skill `calasign` y los comandos `/calasign:send` y `/calasign:status`.
El marketplace es un `marketplace.json` servido por HTTPS; como Claude Code solo descarga ese archivo, el plugin usa
la fuente **`archive`** (zip por HTTPS con `sha256`; Claude Code ≥ 2.1.224). Las rutas relativas no sirven en un
marketplace por URL.

**Alternativa con repo git** (p. ej. `github.com/calasign/claude-plugins`):
```bash
node integrations/build.mjs --plugin-repo ../claude-plugins   # .claude-plugin/marketplace.json + plugins/calasign/
# publicar ese directorio como repo; después:
claude plugin marketplace add calasign/claude-plugins
claude plugin install calasign@calasign
```

### Claude Code — solo el servidor MCP
```bash
claude mcp add --transport http calasign https://dev.calasign.com/mcp                     # OAuth (/mcp → Authenticate)
claude mcp add --transport http calasign https://dev.calasign.com/mcp --header "Authorization: Bearer $CALASIGN_API_KEY"
```

### ChatGPT
Ver [`chatgpt/README.md`](chatgpt/README.md): chatgpt.com/plugins (o Settings → Apps & Connectors → Developer mode) →
**Add custom MCP server** → URL `https://dev.calasign.com/mcp` → OAuth. Incluye los ejemplos de la Responses API
(herramienta `mcp`) y del conector MCP de la Messages API de Anthropic.

### Gemini CLI
```bash
# Solo el servidor (OAuth automático; o con -H "Authorization: Bearer …"):
gemini mcp add --transport http calasign https://dev.calasign.com/mcp
# Extensión (servidor + contexto GEMINI.md con la skill):
curl -LO https://dev.calasign.com/integrations/calasign-gemini-extension.zip
unzip calasign-gemini-extension.zip -d calasign && gemini extensions install ./calasign
# en Gemini CLI: /mcp auth calasign
```
`gemini extensions install` acepta una ruta local o un repo git (o un release de GitHub con el zip en la raíz), no una
URL https arbitraria a un zip: por eso hay que descomprimir primero.

### API de Gemini (Google AI Studio)
`gemini-api/example.py`: `google-genai` ≥ 2.31 + `mcp` ≥ 2.3; pasa una sesión MCP como herramienta
(`tools=[session]`, function calling automático), limitada a herramientas de solo lectura.

### Word y Outlook
Página con los pasos: `https://dev.calasign.com/integrations/office/`.
- **Word en la web**: Inicio → Complementos → Más configuraciones → **Cargar mi complemento** → `manifest.xml`.
- **Word en Windows**: catálogo de carpeta compartida (Archivo → Opciones → Centro de confianza → Catálogos de
  complementos de confianza) → Inicio → Complementos → Mis complementos → Carpeta compartida.
- **Word en Mac**: copiar `manifest.xml` a `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`.
- **Outlook (nuevo, clásico, web, Mac)**: **aka.ms/olksideload** → Mis complementos → Complementos personalizados →
  **Agregar desde archivo** → `manifest-outlook.xml`.
- **Toda la organización**: Centro de administración de Microsoft 365 → Configuración → Aplicaciones integradas →
  Cargar aplicaciones personalizadas.

Flujo de Word: sesión OAuth (diálogo de Office → `auth-start.html` → `/oauth/authorize` → `callback.html` →
`messageParent`; client_id por registro dinámico, guardado en localStorage; tokens con refresh) o API key como
alternativa → documento abierto como PDF (`getFileAsync(Pdf)`, en partes de 4 MB) o un PDF elegido → firmantes
(nombre, correo, orden) → mensaje → firmas por **texto ancla** (`[[firma_1]]`, con botón para insertarlo en el cursor)
o en una **página de firmas** agregada al final (pdf-lib) → resumen y confirmación → `POST /v1/envelopes`
(Idempotency-Key) → documento → destinatarios → campos → `send` → link a `/app/envelopes/<id>` y lista de envíos
recientes. Outlook (lectura): PDFs adjuntos (`getAttachmentContentAsync`, Mailbox 1.8) con el remitente precargado
como firmante. Textos en español, portugués o inglés según `Office.context.displayLanguage`.

**Manifiesto**: XML clásico, dos archivos. Un manifiesto XML no puede ser a la vez `TaskPaneApp` (Word) y `MailApp`
(Outlook). El manifiesto unificado JSON cubriría los dos en un paquete (GA para Word desde julio de 2026), pero se
instala como app de Teams/Microsoft 365 (zip), no corre en Outlook para Mac, Office perpetuo ni buzones locales, y la
carga por archivo es menos directa. Si se publica en AppSource más adelante, conviene sumar el unificado.

## Qué se verificó y cómo

| Qué | Cómo | Resultado |
|---|---|---|
| Build determinista | dos builds seguidos, `sha256sum -c` | iguales |
| Zips | `unzip -t` | sin errores |
| Skill | build: frontmatter (`name`, `description` ≤ 200, claves permitidas en claude.ai), links a `references/` | ok |
| Plugin y marketplace | `claude plugin validate --strict` (Claude Code 2.1.303) | ok |
| Marketplace por URL | `claude plugin marketplace add http://127.0.0.1…/marketplace.json` (config aislada) | se agrega |
| Plugin (repo git) | `--plugin-repo` → `marketplace add <dir>` → `install` → `plugin details` | instalado: skill + 2 comandos + MCP |
| MCPB | `mcpb validate` y `mcpb pack` (@anthropic-ai/mcpb 2.1.2) | ok |
| Proxy MCPB | `test/run.mjs` (servidor MCP simulado) y contra la API local real: initialize, tools/list con anotaciones, tools/call, confirmación, key inválida, sin key | ok |
| Manifiestos de Office | `office-addin-manifest validate` (servicio de Microsoft) | los dos válidos |
| Encabezados | `apps/api/test/integrations-static.test.ts` y `curl` contra la API local | ok |
| Flujo REST del panel | script con las mismas llamadas que `taskpane.js` (anclas y página de firmas), contra la API local | sobres enviados; reintento idempotente |
| OAuth del panel | cliente público con la redirect del complemento, consentimiento, canje PKCE, refresh, revoke, contra la API local | ok (sin registro dinámico: todavía no está) |
| Página de firmas | `test/run.mjs` (pdf-lib): páginas, campos dentro de la página, nombres no latinos | ok |
| Ejemplo de Gemini | sesión MCP real + conversión de herramientas de google-genai 2.31 (sin llamar a Gemini) | ok tras quitar `additionalProperties: false` |

## Pendiente / supuestos

- **Registro dinámico** (`POST /oauth/register`): lo agrega otra rama. Sin él no funcionan el plugin de Claude Code por
  OAuth (`claude mcp list`: "does not support dynamic client registration"), el conector de claude.ai, ChatGPT, Gemini
  CLI por OAuth ni el login del complemento de Office. El complemento manda solo `client_name`, `redirect_uris` y
  `token_endpoint_auth_method: "none"`, y pide los scopes `envelopes:read envelopes:write offline_access` en
  `/oauth/authorize`: el cliente registrado tiene que permitirlos.
- **Office en la web y COOP**: la pantalla de consentimiento (`/oauth/authorize`, la SPA) sale con
  `Cross-Origin-Opener-Policy: same-origin` (helmet). En Office en la web el diálogo es una ventana emergente y ese
  encabezado corta el vínculo con Office (error 12006): hay que servir esa ruta con `unsafe-none` (no se cambió acá
  porque es la pantalla de OAuth, de otra rama). En Word/Outlook de
  escritorio no afecta. Mientras tanto, el panel ofrece la API key.
- **Word en la web** no exporta a PDF desde un complemento (`getFileAsync(Pdf)` no soportado): el panel pide elegir el
  PDF del equipo.
- `frame-ancestors` de Office: Microsoft no publica una lista oficial; la usada combina los dominios de Office en la
  web, Outlook y Microsoft 365. Probarlo en Word/Outlook en la web después del deploy.
- **Privacidad**: el manifiesto MCPB apunta a `<base>/privacy`, que hoy no existe (`CALASIGN_PRIVACY_URL` para otra).
- No se probó en un cliente real: Claude Desktop instalando el `.mcpb`, Word/Outlook con el complemento, Gemini CLI
  (no está instalado), ChatGPT. La fuente `archive` del plugin solo se puede probar contra HTTPS público (rechaza
  loopback): probar `claude plugin install calasign@calasign` después del deploy.
- Nombres de modelos en los ejemplos (`gemini-3.8-flash`, `gpt-5`, `claude-opus-5-5`) y los pasos de la interfaz de
  ChatGPT cambian seguido: están parametrizados o marcados en las guías.
