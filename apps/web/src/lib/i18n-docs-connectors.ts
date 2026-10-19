// Textos del portal de desarrolladores para /developers/connectors (conectores low-code: Power Automate, Zapier, Make,
// n8n, Dynamics 365). Se suman a los diccionarios de i18n-docs*.ts; mismo marcado mínimo y variables ({{BASE}}).

export const connectorsDocsEs = {
  "nav.connectors": "Conectores",
  "conn.title": "Conectores low-code",
  "conn.nav": "Low-code y ERP",
  "conn.lead":
    "Integrá CalaSign con Power Automate, Logic Apps, Power Apps, Zapier, Make, n8n y Dynamics 365 sin escribir código: disparadores con cada evento del sobre, envío desde plantillas con campos dinámicos, envío de PDFs y descarga del documento firmado.",
  "conn.cards.h": "Conectores disponibles",
  "conn.card.pa.d": "Conector personalizado (OpenAPI 2.0) para Power Automate, Logic Apps, Power Apps y Copilot Studio.",
  "conn.card.zap.d": "App de Zapier con triggers instantáneos (REST hooks) y acciones para más de 8.000 apps.",
  "conn.card.make.d": "App personalizada de Make: webhook instantáneo, plantillas con formulario dinámico y envío de PDF.",
  "conn.card.n8n.d": "Paquete de nodos comunitarios: CalaSign y CalaSign Trigger (con verificación de firma HMAC).",
  "conn.card.d365.d": "Botón «Enviar a firmar» en oportunidades (u otra tabla), estado sincronizado y PDF firmado como nota.",
  "conn.card.a": "Instalar",
  "conn.common.h": "Antes de empezar",
  "conn.common.p":
    "Necesitás una **API key** (Ajustes → API keys; empieza con `cs_live_` o `cs_test_`) y, para los disparadores, un plan con webhooks. Todos los conectores usan los mismos eventos: `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`, `recipient.viewed`, `recipient.signed`, `recipient.declined` y `recipient.approved`. Cada suscripción es un webhook de tu organización (máximo 20) y se borra sola cuando apagás o borrás el flujo.\n\nPara enviar un PDF sin plantilla, los conectores ponen un campo de firma por firmante en la última página, o en los textos ancla `\\firma1\\`, `\\firma2\\`… si tu documento los tiene.",
  "conn.pa.h": "Power Automate, Logic Apps y Power Apps",
  "conn.pa.p":
    "1. Descargá el zip y descomprimilo.\n2. En [make.powerautomate.com](https://make.powerautomate.com) → **Datos → Conectores personalizados → Nuevo conector personalizado → Importar un archivo OpenAPI**, elegí `apiDefinition.swagger.json` y nombralo **CalaSign**. (En Logic Apps: *Conector personalizado de Logic Apps → Importar*.)\n3. En **Seguridad** dejá *Clave de API* (encabezado `Authorization`), guardá con **Crear conector** y subí `icon.png` en **General**.\n4. Creá la conexión pegando `Bearer cs_live_…` (con la palabra Bearer).\n5. Probá: un flujo con **When an envelope event occurs** (evento `envelope.completed`) + **Download the signed document** + *SharePoint → Crear archivo*.\n\nAcciones: enviar desde plantilla (el formulario muestra un destinatario por rol y los campos prellenables), estado, descargar el PDF firmado, listar sobres y plantillas, crear borrador + agregar PDF + destinatarios + campos + enviar, anular y recordar.",
  "conn.pa.cli": "Con la CLI de Power Platform",
  "conn.zap.h": "Zapier",
  "conn.zap.p":
    "Mientras la app no esté publicada en el directorio de Zapier, instalala como integración privada: descargá el proyecto, `npm install` y `zapier-platform push` con tu cuenta (o pedile a CalaSign una invitación a la versión beta). Después, en el Zap elegí **CalaSign**, conectá con tu API key y usá:\n\n- **Triggers:** Envelope Completed (trae el PDF firmado como archivo), Envelope Sent, Envelope Declined, Recipient Signed, New Envelope Event.\n- **Acciones:** Send Envelope From Template (campos por rol y prellenado de la plantilla elegida), Send Document for Signature (un PDF de otro paso y una lista de firmantes), Void Envelope, Remind Recipients.\n- **Búsqueda:** Find Envelope.",
  "conn.make.h": "Make",
  "conn.make.p":
    "El zip trae el contenido de cada pestaña del editor de apps de Make (Base, Connections, Webhooks, Modules, RPCs, Functions) y un `makecomapp.json` para la extensión **Make Apps Editor** de VS Code. En Make → **Custom apps → Create a new app**, copiá cada componente (o hacé *Deploy* desde VS Code) y usá la conexión **CalaSign (API key)**.\n\nMódulos: Watch Envelope Events (instantáneo), Send an Envelope from a Template, Send a Document for Signature, Get an Envelope, Download the Signed Document, Void an Envelope, Search Envelopes.",
  "conn.n8n.h": "n8n",
  "conn.n8n.p":
    "En n8n autoalojado, instalá el paquete en la carpeta de nodos y reiniciá n8n. Cuando esté publicado en npm también se instala desde **Settings → Community Nodes → Install** con el nombre `n8n-nodes-calasign`. Credenciales: **CalaSign API** (API key) o **CalaSign OAuth2 API** (código de autorización con PKCE: creá una app OAuth en CalaSign con la URL de redirección que muestra n8n).\n\nEl nodo **CalaSign Trigger** registra el webhook al activar el workflow, lo borra al desactivarlo y descarta los pedidos sin una firma `CalaSign-Signature` válida.",
  "conn.d365.h": "Dynamics 365",
  "conn.d365.p":
    "Funciona sobre el conector de Power Automate (instalalo primero) y sigue el modelo de DocuSign y Adobe Sign en Dynamics:\n\n1. `setup-dataverse.mjs` crea la solución **CalaSign**, las columnas `calasign_sendforsignature`, `calasign_status`, `calasign_envelopeid`, `calasign_templateid` y `calasign_completedon` en la tabla que elijas (por defecto oportunidad), y sube el web resource de los botones.\n2. En el diseñador de comandos agregá **Enviar a firmar** (`CalaSign.sendForSignature`) y **Ver en CalaSign** (`CalaSign.openEnvelope`), con el parámetro `PrimaryControl`.\n3. Creá los dos flujos de la carpeta `flows/`: uno envía la plantilla al contacto principal cuando se pulsa el botón; el otro actualiza el estado con cada evento y, al completarse, adjunta el PDF firmado como nota.\n\nPara Business Central y Finance & Operations se usa el mismo conector con sus disparadores de Power Automate; el README del zip explica cada caso.",
  "conn.d365.cmd": "Columnas y web resource",
  "conn.api.h": "Endpoints para armar conectores",
  "conn.api.p":
    "Si usás otra plataforma (Workato, Tray, Pipedream, Apps Script…), estos endpoints son los que usan los conectores:\n\n- `POST /v1/webhooks` con `{ url, events }`: suscripción; responde `201` con el header `Location`, y `DELETE` a esa URL la borra (REST hooks).\n- `GET /v1/webhooks/samples?event=envelope.completed`: eventos de ejemplo con la forma exacta de una entrega.\n- `GET /v1/templates/{id}/input-schema`: roles y campos prellenables de una plantilla, con JSON Schema para formularios dinámicos.\n- `POST /v1/envelopes/from-template/{templateId}` con `{ roles: { \"Cliente\": { name, email } }, prefill: { \"Monto\": \"1500\" } }`: crea y envía en un pedido.\n\nDetalle en la [referencia de la API](/developers/api).",
  "conn.crm.tip": "¿HubSpot, Salesforce, Siigo o Alegra? Tienen conector nativo, sin herramientas intermedias: ver la [guía de CRM y ERP](/developers/guides/crm).",
};

export type ConnectorsDocsKey = keyof typeof connectorsDocsEs;

export const connectorsDocsEn: Record<ConnectorsDocsKey, string> = {
  "nav.connectors": "Connectors",
  "conn.title": "Low-code connectors",
  "conn.nav": "Low-code and ERP",
  "conn.lead":
    "Connect CalaSign with Power Automate, Logic Apps, Power Apps, Zapier, Make, n8n and Dynamics 365 without code: triggers for every envelope event, sending from templates with dynamic fields, sending PDFs and downloading the signed document.",
  "conn.cards.h": "Available connectors",
  "conn.card.pa.d": "Custom connector (OpenAPI 2.0) for Power Automate, Logic Apps, Power Apps and Copilot Studio.",
  "conn.card.zap.d": "Zapier app with instant triggers (REST hooks) and actions for 8,000+ apps.",
  "conn.card.make.d": "Make custom app: instant webhook, templates with a dynamic form and PDF sending.",
  "conn.card.n8n.d": "Community node package: CalaSign and CalaSign Trigger (with HMAC signature verification).",
  "conn.card.d365.d": "“Send for signature” button on opportunities (or any table), synced status and the signed PDF as a note.",
  "conn.card.a": "Install",
  "conn.common.h": "Before you start",
  "conn.common.p":
    "You need an **API key** (Settings → API keys; starts with `cs_live_` or `cs_test_`) and, for triggers, a plan with webhooks. Every connector uses the same events: `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`, `recipient.viewed`, `recipient.signed`, `recipient.declined` and `recipient.approved`. Each subscription is a webhook of your organization (20 at most) and is removed automatically when you turn off or delete the flow.\n\nTo send a PDF without a template, the connectors place one signature field per signer on the last page, or on the anchor texts `\\firma1\\`, `\\firma2\\`… if your document has them.",
  "conn.pa.h": "Power Automate, Logic Apps and Power Apps",
  "conn.pa.p":
    "1. Download the zip and extract it.\n2. In [make.powerautomate.com](https://make.powerautomate.com) → **Data → Custom connectors → New custom connector → Import an OpenAPI file**, choose `apiDefinition.swagger.json` and name it **CalaSign**. (Logic Apps: *Logic Apps custom connector → Import*.)\n3. In **Security** keep *API key* (header `Authorization`), click **Create connector** and upload `icon.png` in **General**.\n4. Create the connection pasting `Bearer cs_live_…` (including the word Bearer).\n5. Try it: a flow with **When an envelope event occurs** (event `envelope.completed`) + **Download the signed document** + *SharePoint → Create file*.\n\nActions: send from a template (the form shows one recipient per role and the prefillable fields), status, download the signed PDF, list envelopes and templates, create a draft + add a PDF + recipients + fields + send, void and remind.",
  "conn.pa.cli": "With the Power Platform CLI",
  "conn.zap.h": "Zapier",
  "conn.zap.p":
    "Until the app is published in the Zapier directory, install it as a private integration: download the project, run `npm install` and `zapier-platform push` with your account (or ask CalaSign for an invite to the beta). Then pick **CalaSign** in your Zap, connect with your API key and use:\n\n- **Triggers:** Envelope Completed (includes the signed PDF as a file), Envelope Sent, Envelope Declined, Recipient Signed, New Envelope Event.\n- **Actions:** Send Envelope From Template (fields per role and prefill from the chosen template), Send Document for Signature (a PDF from another step and a list of signers), Void Envelope, Remind Recipients.\n- **Search:** Find Envelope.",
  "conn.make.h": "Make",
  "conn.make.p":
    "The zip has the content of every tab of the Make app editor (Base, Connections, Webhooks, Modules, RPCs, Functions) and a `makecomapp.json` for the **Make Apps Editor** VS Code extension. In Make → **Custom apps → Create a new app**, copy each component (or *Deploy* from VS Code) and use the **CalaSign (API key)** connection.\n\nModules: Watch Envelope Events (instant), Send an Envelope from a Template, Send a Document for Signature, Get an Envelope, Download the Signed Document, Void an Envelope, Search Envelopes.",
  "conn.n8n.h": "n8n",
  "conn.n8n.p":
    "On self-hosted n8n, install the package in the nodes folder and restart n8n. Once published on npm it can also be installed from **Settings → Community Nodes → Install** with the name `n8n-nodes-calasign`. Credentials: **CalaSign API** (API key) or **CalaSign OAuth2 API** (authorization code with PKCE: create an OAuth app in CalaSign with the redirect URL that n8n shows).\n\nThe **CalaSign Trigger** node registers the webhook when the workflow is activated, removes it when deactivated and drops requests without a valid `CalaSign-Signature`.",
  "conn.d365.h": "Dynamics 365",
  "conn.d365.p":
    "It runs on the Power Automate connector (install it first) and follows the DocuSign and Adobe Sign model for Dynamics:\n\n1. `setup-dataverse.mjs` creates the **CalaSign** solution, the columns `calasign_sendforsignature`, `calasign_status`, `calasign_envelopeid`, `calasign_templateid` and `calasign_completedon` on the table you choose (opportunity by default), and uploads the web resource for the buttons.\n2. In the command designer add **Send for signature** (`CalaSign.sendForSignature`) and **Open in CalaSign** (`CalaSign.openEnvelope`), with the `PrimaryControl` parameter.\n3. Create the two flows in the `flows/` folder: one sends the template to the primary contact when the button is pressed; the other updates the status on every event and, on completion, attaches the signed PDF as a note.\n\nBusiness Central and Finance & Operations use the same connector with their Power Automate triggers; the README in the zip covers each case.",
  "conn.d365.cmd": "Columns and web resource",
  "conn.api.h": "Endpoints for building connectors",
  "conn.api.p":
    "If you use another platform (Workato, Tray, Pipedream, Apps Script…), these are the endpoints the connectors use:\n\n- `POST /v1/webhooks` with `{ url, events }`: subscription; answers `201` with a `Location` header, and `DELETE` on that URL removes it (REST hooks).\n- `GET /v1/webhooks/samples?event=envelope.completed`: sample events with the exact shape of a delivery.\n- `GET /v1/templates/{id}/input-schema`: roles and prefillable fields of a template, with JSON Schema for dynamic forms.\n- `POST /v1/envelopes/from-template/{templateId}` with `{ roles: { \"Client\": { name, email } }, prefill: { \"Amount\": \"1500\" } }`: creates and sends in one request.\n\nDetails in the [API reference](/developers/api).",
  "conn.crm.tip": "HubSpot, Salesforce, Siigo or Alegra? They have a native connector, no middleware needed: see the [CRM and ERP guide](/developers/guides/crm).",
};

export const connectorsDocsPt: Record<ConnectorsDocsKey, string> = {
  "nav.connectors": "Conectores",
  "conn.title": "Conectores low-code",
  "conn.nav": "Low-code e ERP",
  "conn.lead":
    "Integre o CalaSign com Power Automate, Logic Apps, Power Apps, Zapier, Make, n8n e Dynamics 365 sem programar: gatilhos para cada evento do envelope, envio a partir de modelos com campos dinâmicos, envio de PDFs e download do documento assinado.",
  "conn.cards.h": "Conectores disponíveis",
  "conn.card.pa.d": "Conector personalizado (OpenAPI 2.0) para Power Automate, Logic Apps, Power Apps e Copilot Studio.",
  "conn.card.zap.d": "App do Zapier com gatilhos instantâneos (REST hooks) e ações para mais de 8.000 apps.",
  "conn.card.make.d": "App personalizado do Make: webhook instantâneo, modelos com formulário dinâmico e envio de PDF.",
  "conn.card.n8n.d": "Pacote de nós da comunidade: CalaSign e CalaSign Trigger (com verificação de assinatura HMAC).",
  "conn.card.d365.d": "Botão «Enviar para assinatura» em oportunidades (ou outra tabela), status sincronizado e o PDF assinado como anotação.",
  "conn.card.a": "Instalar",
  "conn.common.h": "Antes de começar",
  "conn.common.p":
    "Você precisa de uma **chave de API** (Configurações → Chaves de API; começa com `cs_live_` ou `cs_test_`) e, para os gatilhos, de um plano com webhooks. Todos os conectores usam os mesmos eventos: `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`, `recipient.viewed`, `recipient.signed`, `recipient.declined` e `recipient.approved`. Cada assinatura é um webhook da sua organização (no máximo 20) e é removida automaticamente quando você desliga ou exclui o fluxo.\n\nPara enviar um PDF sem modelo, os conectores colocam um campo de assinatura por signatário na última página, ou nos textos âncora `\\firma1\\`, `\\firma2\\`… se o documento os tiver.",
  "conn.pa.h": "Power Automate, Logic Apps e Power Apps",
  "conn.pa.p":
    "1. Baixe o zip e extraia.\n2. Em [make.powerautomate.com](https://make.powerautomate.com) → **Dados → Conectores personalizados → Novo conector personalizado → Importar um arquivo OpenAPI**, escolha `apiDefinition.swagger.json` e chame-o de **CalaSign**. (Logic Apps: *Conector personalizado de Aplicativos Lógicos → Importar*.)\n3. Em **Segurança** mantenha *Chave de API* (cabeçalho `Authorization`), clique em **Criar conector** e envie `icon.png` em **Geral**.\n4. Crie a conexão colando `Bearer cs_live_…` (com a palavra Bearer).\n5. Teste: um fluxo com **When an envelope event occurs** (evento `envelope.completed`) + **Download the signed document** + *SharePoint → Criar arquivo*.\n\nAções: enviar a partir de modelo (o formulário mostra um destinatário por papel e os campos pré-preenchíveis), status, baixar o PDF assinado, listar envelopes e modelos, criar rascunho + adicionar PDF + destinatários + campos + enviar, anular e lembrar.",
  "conn.pa.cli": "Com a CLI do Power Platform",
  "conn.zap.h": "Zapier",
  "conn.zap.p":
    "Enquanto o app não estiver publicado no diretório do Zapier, instale-o como integração privada: baixe o projeto, rode `npm install` e `zapier-platform push` com sua conta (ou peça à CalaSign um convite para a versão beta). Depois, no Zap escolha **CalaSign**, conecte com sua chave de API e use:\n\n- **Gatilhos:** Envelope Completed (traz o PDF assinado como arquivo), Envelope Sent, Envelope Declined, Recipient Signed, New Envelope Event.\n- **Ações:** Send Envelope From Template (campos por papel e pré-preenchimento do modelo escolhido), Send Document for Signature (um PDF de outra etapa e uma lista de signatários), Void Envelope, Remind Recipients.\n- **Busca:** Find Envelope.",
  "conn.make.h": "Make",
  "conn.make.p":
    "O zip traz o conteúdo de cada aba do editor de apps do Make (Base, Connections, Webhooks, Modules, RPCs, Functions) e um `makecomapp.json` para a extensão **Make Apps Editor** do VS Code. No Make → **Custom apps → Create a new app**, copie cada componente (ou faça *Deploy* pelo VS Code) e use a conexão **CalaSign (API key)**.\n\nMódulos: Watch Envelope Events (instantâneo), Send an Envelope from a Template, Send a Document for Signature, Get an Envelope, Download the Signed Document, Void an Envelope, Search Envelopes.",
  "conn.n8n.h": "n8n",
  "conn.n8n.p":
    "No n8n auto-hospedado, instale o pacote na pasta de nós e reinicie o n8n. Quando estiver publicado no npm, também pode ser instalado em **Settings → Community Nodes → Install** com o nome `n8n-nodes-calasign`. Credenciais: **CalaSign API** (chave de API) ou **CalaSign OAuth2 API** (código de autorização com PKCE: crie um app OAuth no CalaSign com a URL de redirecionamento que o n8n mostra).\n\nO nó **CalaSign Trigger** registra o webhook ao ativar o workflow, remove ao desativar e descarta requisições sem uma `CalaSign-Signature` válida.",
  "conn.d365.h": "Dynamics 365",
  "conn.d365.p":
    "Funciona sobre o conector do Power Automate (instale-o primeiro) e segue o modelo do DocuSign e do Adobe Sign no Dynamics:\n\n1. `setup-dataverse.mjs` cria a solução **CalaSign**, as colunas `calasign_sendforsignature`, `calasign_status`, `calasign_envelopeid`, `calasign_templateid` e `calasign_completedon` na tabela escolhida (oportunidade por padrão) e envia o web resource dos botões.\n2. No designer de comandos adicione **Enviar para assinatura** (`CalaSign.sendForSignature`) e **Ver no CalaSign** (`CalaSign.openEnvelope`), com o parâmetro `PrimaryControl`.\n3. Crie os dois fluxos da pasta `flows/`: um envia o modelo ao contato principal quando o botão é pressionado; o outro atualiza o status a cada evento e, ao concluir, anexa o PDF assinado como anotação.\n\nBusiness Central e Finance & Operations usam o mesmo conector com seus gatilhos do Power Automate; o README do zip explica cada caso.",
  "conn.d365.cmd": "Colunas e web resource",
  "conn.api.h": "Endpoints para criar conectores",
  "conn.api.p":
    "Se você usa outra plataforma (Workato, Tray, Pipedream, Apps Script…), estes são os endpoints que os conectores usam:\n\n- `POST /v1/webhooks` com `{ url, events }`: assinatura; responde `201` com o cabeçalho `Location`, e `DELETE` nessa URL a remove (REST hooks).\n- `GET /v1/webhooks/samples?event=envelope.completed`: eventos de exemplo com o formato exato de uma entrega.\n- `GET /v1/templates/{id}/input-schema`: papéis e campos pré-preenchíveis de um modelo, com JSON Schema para formulários dinâmicos.\n- `POST /v1/envelopes/from-template/{templateId}` com `{ roles: { \"Cliente\": { name, email } }, prefill: { \"Valor\": \"1500\" } }`: cria e envia em uma requisição.\n\nDetalhes na [referência da API](/developers/api).",
  "conn.crm.tip": "HubSpot, Salesforce, Siigo ou Alegra? Eles têm conector nativo, sem intermediários: veja o [guia de CRM e ERP](/developers/guides/crm).",
};
