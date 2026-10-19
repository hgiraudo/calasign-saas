# CalaSign en ChatGPT y en las APIs de OpenAI y Anthropic

Servidor MCP de CalaSign: **`{{BASE_URL}}/mcp`** (Streamable HTTP, sin sesión). Autenticación: OAuth 2.0
(authorization code + PKCE, descubrimiento por `/.well-known/oauth-protected-resource` y
`/.well-known/oauth-authorization-server`, registro dinámico en `{{BASE_URL}}/oauth/register`) o una API key de
CalaSign como `Authorization: Bearer cs_live_…`.

Herramientas: `list_envelopes`, `get_envelope`, `get_signing_status`, `list_templates`,
`create_envelope_from_template`, `create_envelope`, `send_envelope`, `remind_recipients`, `void_envelope`,
`download_signed_pdf`, `get_account`. Enviar y anular exigen `confirm: true`: el servidor devuelve primero un
resumen para que la persona lo apruebe.

> Verificado el 2026-10-18 contra la documentación pública. Lo marcado **(sin verificar)** puede cambiar.

## ChatGPT (interfaz)

ChatGPT acepta servidores MCP remotos como "apps"/"plugins" personalizados, con OAuth o sin autenticación (no
acepta una API key fija en un header).

1. Abrí **https://chatgpt.com/plugins** (en algunas versiones: *Settings → Apps & Connectors → Advanced settings →
   Developer mode* activado, y después *Create* en *Apps & Connectors*).
2. **+ → Add custom MCP server** (o *Create*).
3. Nombre: `CalaSign`. Descripción: `Firma electrónica: enviar documentos a firmar y seguir su estado`.
4. *Connection*: URL pública **`{{BASE_URL}}/mcp`**.
5. *Authentication*: **OAuth**. ChatGPT descubre el servidor de autorización y se registra solo (registro dinámico);
   no hace falta cargar client id ni secreto.
6. Aceptá el aviso de riesgo → **Create**. Revisá la lista de herramientas.
7. En un chat, elegí CalaSign (menú **+ → More / Developer mode**) y pedí, p. ej., "¿qué sobres tengo pendientes?".
   La primera vez se abre CalaSign para autorizar el acceso.

- Planes: modo desarrollador / apps personalizadas en Business, Enterprise y Edu; Plus y Pro según la región y el
  momento **(sin verificar: help.openai.com no se pudo consultar)**.
- Las URIs de redirección que usa ChatGPT son `https://chatgpt.com/connector_platform_oauth_redirect` y
  `https://chatgpt.com/connector/oauth/{callback_id}`; con registro dinámico las declara ChatGPT al registrarse.
- Las herramientas con `readOnlyHint` se ejecutan sin preguntar; `send_envelope` / `void_envelope` piden
  confirmación en ChatGPT y además exigen `confirm: true` del lado de CalaSign.

## API de OpenAI (Responses API, herramienta MCP remota)

```python
# pip install openai
import os
from openai import OpenAI

client = OpenAI()  # OPENAI_API_KEY
resp = client.responses.create(
    model=os.environ.get("OPENAI_MODEL", "gpt-5"),  # cualquier modelo con herramientas MCP (sin verificar el nombre vigente)
    tools=[{
        "type": "mcp",
        "server_label": "calasign",
        "server_description": "Firma electrónica CalaSign: sobres, firmantes y documentos firmados.",
        "server_url": "{{BASE_URL}}/mcp",
        "authorization": os.environ["CALASIGN_API_KEY"],  # API key o access token OAuth; OpenAI no la guarda
        # Solo lectura sin aprobación; enviar/anular quedan afuera de este ejemplo.
        "allowed_tools": ["list_envelopes", "get_envelope", "get_signing_status", "list_templates", "download_signed_pdf"],
        "require_approval": "never",
    }],
    input="¿Qué sobres tengo pendientes de firma? Respondé en español.",
)
print(resp.output_text)
```

Con curl:

```bash
curl https://api.openai.com/v1/responses -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' -d '{
  "model": "gpt-5",
  "tools": [{"type": "mcp", "server_label": "calasign", "server_url": "{{BASE_URL}}/mcp",
             "authorization": "'"$CALASIGN_API_KEY"'", "require_approval": "never",
             "allowed_tools": ["list_envelopes", "get_signing_status"]}],
  "input": "Listá mis últimos 5 sobres"
}'
```

- `authorization` es el campo documentado para el token (OpenAI arma `Authorization: Bearer …`). Versiones
  anteriores de la documentación usaban `headers: {"Authorization": "Bearer …"}` **(si tu SDK no acepta
  `authorization`, probá con `headers`)**.
- Si habilitás `send_envelope`, dejá `require_approval: "always"` para esa herramienta y mostrale a la persona el
  pedido de aprobación (`mcp_approval_request`) antes de responder con `mcp_approval_response`.

## API de Anthropic (Messages API, conector MCP)

```python
# pip install anthropic
import os
import anthropic

client = anthropic.Anthropic()  # ANTHROPIC_API_KEY
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=2000,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{
        "type": "url",
        "url": "{{BASE_URL}}/mcp",
        "name": "calasign",
        "authorization_token": os.environ["CALASIGN_API_KEY"],  # API key o access token OAuth
    }],
    tools=[{
        "type": "mcp_toolset",
        "mcp_server_name": "calasign",
        # Solo lectura: se desactivan las herramientas con efecto.
        "configs": {
            "send_envelope": {"enabled": False},
            "void_envelope": {"enabled": False},
            "remind_recipients": {"enabled": False},
        },
    }],
    messages=[{"role": "user", "content": "¿Quién falta firmar en mis sobres en curso?"}],
)
for block in response.content:
    if block.type == "text":
        print(block.text)
```

- Encabezado beta vigente: `anthropic-beta: mcp-client-2025-11-20` (el anterior, `mcp-client-2025-04-04`, sin
  `mcp_toolset`, está obsoleto). Existe `mcp-client-2026-09-15` para fijar la lista de herramientas.
- El conector usa Streamable HTTP o SSE (no stdio) y el servidor tiene que ser accesible desde internet.
- Para darle a Claude el contexto de uso de CalaSign, cargá la skill
  [`calasign-skill.zip`]({{BASE_URL}}/integrations/calasign-skill.zip) con la API de Skills, o pegá su `SKILL.md`
  en el `system`.
