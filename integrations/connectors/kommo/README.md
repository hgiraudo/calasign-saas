# CalaSign para Kommo

El conector de Kommo (ex amoCRM) es **nativo** de CalaSign: la organización lo conecta con OAuth en **Ajustes → CRM y
ERP → Kommo**, arma mapeos (Lead → plantilla) y CalaSign devuelve al lead el estado del sobre (en un campo
personalizado) y, al completarse, el **PDF firmado** (Files API, vinculado al lead) con una **nota** que lleva el
SHA-256 y el link al sobre.

Esta carpeta suma la pieza del **Kommo Marketplace**: un widget con el botón **«Enviar a firmar con CalaSign»**.

| Archivo | Para qué |
|---|---|
| `calasign-kommo-widget.zip` | El widget para subir a la integración (manifest.json, script.js, i18n/, images/). |
| `send.html`, `send.js`, `send.css` | Página que abre el widget. Se publica en `{{BASE_URL}}/integrations/connectors/kommo/send.html`. |

## Cómo funciona el widget

1. En la **ficha de un lead** aparece el botón en el panel derecho; en la **lista de leads**, el widget aparece como
   acción sobre los seleccionados (máximo 20).
2. El botón abre una pestaña en `send.html?ids=42[,43…]`. La página es del dominio de CalaSign y usa la **sesión del
   navegador** (si no hay sesión, pide iniciarla y reintentar). No guarda API keys ni tokens en Kommo.
3. Lista los mapeos activos de Kommo (`GET /v1/crm/mappings?provider=kommo`) y, con el que elija el usuario, llama a
   `POST /v1/crm/mappings/{id}/send` por cada lead.

## Registrar la integración en Kommo

En Kommo, una **integración** es a la vez la app OAuth y el contenedor del widget.

1. En una cuenta de Kommo (de desarrollo o la del cliente para una integración privada): **Ajustes → Integraciones →
   Crear integración** (*Settings → Integrations → Create integration*). Para el Marketplace, desde la cuenta de
   **socio/desarrollador** de Kommo.
2. Datos:
   - **Redirect URL**: `{{BASE_URL}}/v1/crm/oauth/kommo/callback`
   - Permisos: **CRM** (leer leads y contactos, escribir el campo de estado y notas) y **Access to files** (subir el
     PDF y vincularlo al lead; sin este permiso el conector deja solo la nota con el link y el hash).
   - Nombre, descripción y logo (es/en/pt).
3. Guardar: Kommo muestra **ID de la integración** y **clave secreta** → variables `KOMMO_CLIENT_ID` y
   `KOMMO_CLIENT_SECRET` del servidor de CalaSign.
4. **Widget**: en la misma integración, subir `calasign-kommo-widget.zip` (pestaña *Widget* / *Upload archive*).
   Kommo valida el manifiesto y las imágenes: las de `images/` (logo_min, logo_small, logo_medium, logo, logo_main)
   salen de los íconos genéricos de CalaSign y **hay que reemplazarlas por los tamaños que pida Kommo** si el
   validador las rechaza.
5. Crear en Kommo el campo personalizado del lead para el estado (p. ej. «Estado CalaSign», de texto o de lista con
   las opciones que vaya a escribir el mapeo).

### Instalación desde Kommo

Si el usuario instala la integración desde Kommo (Marketplace o la lista de integraciones), Kommo llama al Redirect
URL con `code` y `referer` pero **sin `state`**: CalaSign no canjea ese código (ataría a una organización una cuenta
que nadie eligió desde CalaSign) y lleva al usuario a **Ajustes → CRM y ERP**, donde conecta con **Conectar con
OAuth**.

### Publicación en el Kommo Marketplace

1. Cuenta de socio (Kommo Partner / Technology Partner) y la integración pública con los textos en es/en/pt.
2. Revisión de Kommo: probar instalar, conectar desde CalaSign, enviar desde un lead y ver el estado, el PDF y la nota.
3. Política de privacidad: `{{BASE_URL}}/privacy`; soporte: `soporte@calasign.com`.
