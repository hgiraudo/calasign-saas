"""Gemini API (google-genai) + herramientas MCP de CalaSign.

El SDK de Gemini acepta una sesión MCP como herramienta (`tools=[session]`) y hace function calling automático:
el modelo ve las herramientas de CalaSign (list_envelopes, get_signing_status, …) y el SDK las ejecuta.

    pip install "google-genai>=2.31" "mcp>=2.3"
    export GEMINI_API_KEY=…            # Google AI Studio
    export CALASIGN_API_KEY=cs_live_…  # CalaSign → Ajustes → API keys
    python example.py "¿Qué sobres tengo pendientes de firma?"

Seguridad: send_envelope y void_envelope exigen confirm=true. Este ejemplo es de solo lectura por defecto
(ALLOWED_TOOLS); si habilitás el envío, pedile confirmación a la persona antes de que el modelo lo haga.
"""
import asyncio
import os
import sys

from google import genai
from google.genai import types
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client  # mismo helper que usa google-genai

CALASIGN_MCP_URL = os.environ.get("CALASIGN_BASE_URL", "{{BASE_URL}}").rstrip("/") + "/mcp"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")  # cualquier modelo Gemini con function calling
# Solo lectura: el modelo no puede enviar ni anular nada desde este ejemplo.
ALLOWED_TOOLS = {"list_envelopes", "get_envelope", "get_signing_status", "list_templates", "download_signed_pdf", "get_account"}

SYSTEM = (
    "Sos un asistente que usa CalaSign (firma electrónica). Respondé en el idioma de la persona. "
    "Nunca inventes correos. Para enviar o anular un sobre hace falta la aprobación explícita de la persona."
)


def gemini_safe_schema(schema):
    """Quita los subesquemas booleanos (`additionalProperties: false`, `items: true`).

    Los esquemas de las herramientas de CalaSign son JSON Schema estándar (generados con zod) y llevan
    `additionalProperties: false`; google-genai 2.31 falla al convertirlos ('bool' object has no attribute 'items').
    """
    if isinstance(schema, dict):
        return {k: gemini_safe_schema(v) for k, v in schema.items() if not (isinstance(v, bool) and k in ("additionalProperties", "items")) and k != "$schema"}
    if isinstance(schema, list):
        return [gemini_safe_schema(v) for v in schema]
    return schema


class ReadOnlySession(ClientSession):
    """Sesión MCP que solo expone las herramientas permitidas, con esquemas que Gemini acepta.

    Tiene que heredar de ClientSession: el SDK reconoce las sesiones MCP con isinstance (google-genai 2.x).
    """

    async def list_tools(self, *args, **kwargs):
        r = await super().list_tools(*args, **kwargs)
        r.tools = [
            t.model_copy(update={"input_schema": gemini_safe_schema(t.input_schema)})
            for t in r.tools
            if t.name in ALLOWED_TOOLS
        ]
        return r

    async def call_tool(self, name, arguments=None, *args, **kwargs):
        if name not in ALLOWED_TOOLS:
            raise PermissionError(f"Herramienta no habilitada en este ejemplo: {name}")
        return await super().call_tool(name, arguments, *args, **kwargs)


async def main(prompt: str) -> None:
    client = genai.Client()  # lee GEMINI_API_KEY
    headers = {"Authorization": f"Bearer {os.environ['CALASIGN_API_KEY']}"}
    # mcp 2.x: los headers van en el cliente HTTP (en 1.x era streamablehttp_client(url, headers=…)).
    async with create_mcp_http_client(headers=headers) as http:
        async with streamable_http_client(CALASIGN_MCP_URL, http_client=http) as (read, write):
            async with ReadOnlySession(read, write) as session:
                await session.initialize()
                response = await client.aio.models.generate_content(
                    model=MODEL,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=SYSTEM,
                        temperature=0,
                        tools=[session],  # sesión MCP → function calling automático
                    ),
                )
                print(response.text)


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "Listá mis últimos 5 sobres y decime cuáles faltan firmar."))
