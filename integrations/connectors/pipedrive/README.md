# CalaSign para Pipedrive

El conector de Pipedrive es **nativo** de CalaSign: la organización lo conecta con OAuth en **Ajustes → CRM y ERP**,
arma mapeos (Deal o Person → plantilla) y CalaSign devuelve al registro el estado del sobre (en un campo del Deal o de la
Person) y, al completarse, el **PDF firmado** (Files API) con una **nota** que lleva el SHA-256 y el link al sobre.

Esta carpeta suma la pieza del **Pipedrive Marketplace**: una acción de app (*App Extensions → Link action*)
«Enviar a firmar con CalaSign» en los Deals y las Persons.

| Archivo | Para qué |
|---|---|
| `send.html`, `send.js`, `send.css` | Página que abre la acción. Se publica en `{{BASE_URL}}/integrations/connectors/pipedrive/send.html`. |
| `app-extensions.json` | Los valores para cargar en el Developer Hub (callback, scopes, acciones). |

## Cómo funciona la acción

1. En un Deal (detalle o lista, con uno o varios seleccionados) o una Person, el usuario elige **Enviar a firmar con CalaSign**.
2. Pipedrive abre una pestaña en `send.html?resource=deal&selectedIds=42&companyId=…&userId=…&token=…`.
3. La página es del dominio de CalaSign y usa la **sesión del navegador** (si no hay sesión, pide iniciarla en otra
   pestaña y reintentar). No guarda API keys ni usa el JWT de Pipedrive.
4. Lista los mapeos activos de Pipedrive para ese tipo de registro de la conexión de **esa compañía**
   (`GET /v1/crm/mappings?provider=pipedrive&companyId=…`; alcanza con el permiso de crear sobres) y, con el que elija
   el usuario, llama a `POST /v1/crm/mappings/{id}/send` con `companyId` por cada registro (máximo 20 por vez). Muestra
   el resultado con un link a cada sobre. Sin `companyId` en la URL no ofrece mapeos (podrían ser de otra compañía), y
   si hay conexiones sin su compañía guardada avisa que hay que probarlas en CalaSign.

## Registrar la app (Pipedrive Developer Hub)

1. Entrá a <https://developers.pipedrive.com/> con una cuenta de desarrollador (sandbox) y creá una app **pública**.
2. **OAuth & access scopes**
   - Callback URL: `{{BASE_URL}}/v1/crm/oauth/pipedrive/callback`
   - Scopes: `base`, `deals:full` (leer el deal y sus participantes, escribir el campo de estado, archivos y notas del
     deal), `contacts:full` (personas: leer, escribir el estado, archivos y notas), `users:read`.
   - Copiá el **Client ID** y el **Client secret** a `PIPEDRIVE_CLIENT_ID` y `PIPEDRIVE_CLIENT_SECRET` del servidor.
3. **App extensions → Link actions**: una acción «Enviar a firmar con CalaSign» con URL
   `{{BASE_URL}}/integrations/connectors/pipedrive/send.html` en *Deal details*, *Deals list*, *Person details* y
   *Persons list*.
4. Instalala en la cuenta sandbox desde el Developer Hub y probala de punta a punta:
   - CalaSign → Ajustes → CRM y ERP → Pipedrive → **Conectar con OAuth**.
   - Crear en Pipedrive un campo personalizado del Deal «Estado CalaSign» (texto, o opción única con una opción por
     cada valor que escribe CalaSign: `sent`, `declined`, `voided`, `expired` y, para el completado, `completed` o el
     valor que se configure en el mapeo).
   - Crear un mapeo (Deal → plantilla; propiedad de estado «Estado CalaSign») y enviar desde un deal con la acción.

Si alguien instala la app desde el Marketplace, Pipedrive vuelve al callback **sin** `state` (la instalación no la
empezó CalaSign). Por seguridad ese código no se canjea: CalaSign lleva al usuario a Ajustes → CRM y ERP, donde conecta
con «Conectar con OAuth» (la app ya está aprobada, así que es un clic).

## Publicar en el Marketplace

En el Developer Hub, **Marketplace listing**: nombre, descripción corta y larga (es/en/pt), íconos (el de CalaSign),
capturas de la acción y de Ajustes → CRM y ERP, links a la guía (`{{BASE_URL}}/developers/guides/crm`), a la política de
privacidad y a soporte, y un video corto. Pipedrive revisa la app antes de listarla: pide una cuenta de prueba de
CalaSign con un mapeo listo y que la app use solo los scopes que necesita.
