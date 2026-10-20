// Português (Brasil) do portal de desenvolvedores. Ver i18n-docs.ts.
import type { DocsKey } from "./i18n-docs";
import { connectorsDocsPt } from "./i18n-docs-connectors";
import { docsApiPt } from "./i18n-docs-api";

export const docsPt: Record<DocsKey, string> = {
  ...docsApiPt,
  // ───────── Interface ─────────
  "ui.docs": "Docs",
  "ui.searchPlaceholder": "Pesquisar na documentação…",
  "ui.searchLabel": "Pesquisar",
  "ui.searchEmpty": "Nenhum resultado para «{q}».",
  "ui.searchHint": "Páginas, seções e endpoints",
  "ui.searchEndpoints": "Endpoints",
  "ui.searchPages": "Páginas",
  "ui.menu": "Menu da documentação",
  "ui.closeMenu": "Fechar menu",
  "ui.onThisPage": "Nesta página",
  "ui.copy": "Copiar",
  "ui.copied": "Copiado",
  "ui.copyCode": "Copiar código",
  "ui.linkTo": "Link para esta seção",
  "ui.prev": "Anterior",
  "ui.next": "Próximo",
  "ui.openApp": "Ir para o app",
  "ui.getKey": "Criar API key",
  "ui.theme": "Tema",
  "ui.themeAuto": "Automático",
  "ui.themeLight": "Claro",
  "ui.themeDark": "Escuro",
  "ui.skip": "Pular para o conteúdo",
  "ui.notFound": "Não encontramos essa página da documentação.",
  "ui.backHome": "Voltar ao início da documentação",
  "ui.new": "Novo",
  "ui.download": "Baixar",
  "ui.required": "obrigatório",
  "ui.optional": "opcional",
  "ui.yes": "Sim",
  "ui.no": "Não",
  // ───────── Navegação ─────────
  "nav.start": "Começar",
  "nav.guides": "Guias",
  "nav.platform": "Plataforma",
  "nav.reference": "Referência da API",
  "nav.ai": "IA e agentes",
  // ───────── Introdução ─────────
  "intro.title": "Documentação para desenvolvedores",
  "intro.nav": "Introdução",
  "intro.lead":
    "A API REST da CalaSign permite enviar documentos para assinatura, acompanhar cada assinatura em tempo real e baixar o PDF selado com sua evidência, a partir do seu próprio sistema. É a mesma API usada pela web da CalaSign: tudo o que dá para fazer no app pode ser automatizado.",
  "intro.build.h": "O que você pode construir",
  "intro.build.send.t": "Enviar para assinatura a partir do seu sistema",
  "intro.build.send.d": "Crie um envelope com um ou mais PDFs, adicione signatários por e-mail, WhatsApp ou Telegram e envie com poucas requisições HTTP.",
  "intro.build.embed.t": "Assinatura dentro do seu app",
  "intro.build.embed.d": "Mostre a cerimônia de assinatura em um iframe da sua aplicação, sem que o signatário saia do seu produto.",
  "intro.build.webhooks.t": "Reagir a cada evento",
  "intro.build.webhooks.d": "Receba um POST assinado com HMAC quando alguém abre, assina ou recusa, e quando o envelope é concluído.",
  "intro.build.templates.t": "Modelos, envios em massa e formulários",
  "intro.build.templates.d": "Prepare o documento uma vez e reutilize: pela API, em lote via CSV ou com um link público.",
  "intro.build.ai.t": "Agentes de IA",
  "intro.build.ai.d": "Conecte Claude, ChatGPT ou Gemini ao servidor MCP da CalaSign para consultar e enviar envelopes conversando.",
  "intro.build.xml.t": "Assinatura de notas fiscais eletrônicas",
  "intro.build.xml.d": "Assine XML com os perfis da DGII (e-CF), da DIAN e da SUNAT usando o certificado da sua organização.",
  "intro.base.h": "URL base e formato",
  "intro.base.p": "Todas as requisições vão por HTTPS para a mesma origem da web. A API fica sob `/v1`.",
  "intro.base.col.what": "O quê",
  "intro.base.col.url": "URL",
  "intro.base.api": "API REST v1",
  "intro.base.spec": "Especificação OpenAPI 3.1",
  "intro.base.mcp": "Servidor MCP (agentes de IA)",
  "intro.base.oauth": "OAuth 2.0",
  "intro.base.conventions":
    "- Corpos em JSON (UTF-8) com `Content-Type: application/json`; os PDFs são enviados como `multipart/form-data`.\n- Identificadores UUID, datas ISO 8601 em UTC (`2026-03-01T14:30:00.000Z`).\n- Autenticação com `Authorization: Bearer <API key ou access token>` (veja [Autenticação](/developers/authentication)).\n- Erros sempre com o mesmo formato: `{ \"error\": { \"code\", \"message\", \"details\" } }` (veja [Erros](/developers/errors)).\n\nUma primeira requisição para testar sua credencial: retorna a sua organização.",
  "intro.env.h": "Ambientes e testes",
  "intro.env.p":
    "**{{BASE}}** é o ambiente de desenvolvimento e testes. Crie uma conta grátis, gere uma API key e teste sem custo: as organizações novas deste ambiente têm todas as funções habilitadas (API, webhooks, envios em massa, pagamentos simulados, verificação de identidade simulada).\n\nAs API keys deste ambiente começam com `cs_test_`; as de produção, com `cs_live_`. Cada ambiente tem suas próprias contas, credenciais e dados: nada é compartilhado entre eles.",
  "intro.env.mailbox.t": "Caixa de desenvolvimento",
  "intro.env.mailbox.p":
    "No ambiente de testes os e-mails e mensagens de WhatsApp ou SMS não saem para a internet: ficam na **Caixa dev** do app (menu superior → *Caixa dev*, rota `/app/dev-mailbox`), com o link de assinatura de cada destinatário. Assim você pode abrir o link, assinar como se fosse o destinatário e ver os webhooks chegarem, usando endereços inventados.",
  "intro.version.h": "Versões",
  "intro.version.p":
    "A versão vai na rota (`/v1`). Dentro da v1 adicionamos endpoints, campos opcionais, valores de enumerações e tipos de evento sem mudar de versão, então a sua integração precisa **ignorar os campos que não conhece** e não falhar diante de um `status` ou de um tipo de evento novo. Uma mudança incompatível iria para uma nova versão da rota.\n\nA especificação [`/v1/openapi.json`](/v1/openapi.json) sempre reflete o que está implantado: você pode gerar clientes a partir dela (veja [SDKs](/developers/sdks)).",
  "intro.next.h": "Próximos passos",
  "intro.next.p":
    "1. Siga o [início rápido](/developers/quickstart) para enviar seu primeiro envelope em cinco minutos.\n2. Leia os [conceitos](/developers/concepts): ciclo de vida do envelope, destinatários, campos e evidência.\n3. Configure [webhooks](/developers/webhooks) para saber de cada assinatura sem consultar a API.\n4. Explore a [referência completa](/developers/api) ou conecte um [agente de IA](/developers/ai).",
  // ───────── Início rápido ─────────
  "qs.title": "Início rápido",
  "qs.lead":
    "Com **uma única chamada** você cria o envelope com o PDF, a signatária e o campo de assinatura, e o envia. Depois espera a assinatura e baixa o documento assinado. Você precisa de `curl` (e `jq`), Node.js 18+ ou Python 3.8+ e um PDF de teste que contenha o texto `[[firma]]`.",
  "qs.key.h": "1. Obtenha uma API key",
  "qs.key.p":
    "Crie uma conta em [{{BASE}}/signup]({{BASE}}/signup) (ou entre com a sua), vá em **Configurações → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) e clique em **Criar**. O segredo é exibido **uma única vez**: guarde-o em um gerenciador de segredos ou em uma variável de ambiente, nunca no código nem no frontend.",
  "qs.one.h": "2. Crie e envie o envelope em uma única chamada",
  "qs.one.p":
    "`POST /v1/envelopes` recebe tudo junto: os **documentos** (`documents`: o PDF em `base64`, por `url` https pública ou como parte de um `multipart/form-data`), os **destinatários** (`recipients`, igual a `PUT /recipients`), os **campos** (`fields`, com texto âncora ou coordenadas) e `send: true` para enviá-lo na mesma requisição.\n\nÉ **atômico**: se algo falhar (um PDF inválido, um texto âncora que não aparece, um signatário sem campo de assinatura) a resposta é o erro e não fica nenhum envelope pela metade. Envie uma `Idempotency-Key` (p. ex. o id do seu pedido) para que uma nova tentativa não crie nem envie um segundo envelope. Sem `send`, o envelope fica como rascunho (`draft`) para revisar e enviar depois com `POST /v1/envelopes/{id}/send`.",
  "qs.one.resp":
    "A resposta é o envelope completo, com os `id` dos documentos, destinatários e campos (você vai vê-los nos webhooks). No ambiente de testes o convite fica na **Caixa dev** do app: abra-o e assine você mesmo. Se você não indicar `expiresAt`, o envelope vence em 30 dias.",
  "qs.one.multipart.t": "PDFs grandes: multipart em vez de base64",
  "qs.one.multipart.p":
    "Em `multipart/form-data` o JSON vai na parte `payload` e cada PDF em sua própria parte; o documento a referencia com `file` (sem `documents`, cada arquivo é um documento, em ordem). Assim o PDF não cresce 33% pelo base64. Até 10 documentos por chamada.",
  "qs.one.refs.t": "Vários signatários e documentos",
  "qs.one.refs.p":
    "Como os destinatários e documentos ainda não têm `id`, cada campo os referencia com `recipient` (a posição em `recipients` começando em 0, seu `ref` ou seu e-mail) e `document` (a posição em `documents` ou seu `ref`). Com um único signatário ou um único documento podem ser omitidos; um campo com `anchor` e sem `document` procura o texto em todos os documentos.",
  "qs.fields.coords.t": "Seu PDF não tem texto âncora?",
  "qs.fields.coords.p":
    "Use coordenadas normalizadas: `page` começa em 0 e `x`, `y`, `width`, `height` vão de 0 a 1 com origem no canto superior esquerdo da página. Com vários documentos, indique `document`.",
  "qs.one.embedded.t": "Assinatura incorporada no seu app",
  "qs.one.embedded.p":
    "Se um destinatário vai com `embedded: true` (assina dentro da sua aplicação, sem convite), a resposta de um envio traz `signingUrls`: a URL de assinatura de uso único (5 minutos) de cada signatário incorporado cuja vez já chegou, sem outra chamada. `embeddedSigning` aceita `returnUrl` e `frameAncestors`. Veja o [guia de assinatura incorporada](/developers/guides/embedded-signing).",
  "qs.one.template.t": "A partir de um modelo, também em uma chamada",
  "qs.one.template.p":
    "Se o documento e os campos já estão em um [modelo](/developers/guides/templates), `POST /v1/envelopes/from-template` cria o envelope atribuindo uma pessoa a cada papel e, com `send: true`, o envia na mesma requisição. Também aceita `Idempotency-Key`.",
  "qs.wait.h": "3. Aguarde a assinatura",
  "qs.wait.p":
    "A forma recomendada é um [webhook](/developers/webhooks): registre uma URL https em **Configurações → Integrações** e a CalaSign avisa você com um POST assinado a cada evento. Quando a última pessoa assina, o envelope passa por `finalizing` (o PDF é montado e selado) e depois chega `envelope.completed`.\n\nSe preferir consultar, chame `GET /v1/envelopes/{id}` de tempos em tempos (no máximo uma vez por minuto por envelope) até que `envelope.status` seja `completed`, `declined`, `voided` ou `expired`.",
  "qs.download.h": "4. Baixe o PDF assinado",
  "qs.download.p":
    "Com o envelope em `completed`, `signed.pdf` retorna o PDF final: os documentos com as assinaturas aplicadas, o **certificado de conclusão** no final e o selo PAdES da plataforma. Antes da conclusão, responde 404. Guarde também `signedSha256` para verificá-lo no futuro.",
  "qs.full.h": "Script completo",
  "qs.full.p":
    "Tudo junto, pronto para copiar: uma chamada para criar e enviar, a espera e o download. O PDF `contrato.pdf` precisa conter o texto `[[firma]]`.",
  "qs.full.next":
    "E agora? Use [modelos](/developers/guides/templates) para não posicionar campos manualmente, [assinatura incorporada](/developers/guides/embedded-signing) para assinar dentro do seu app, ou revise os [conceitos](/developers/concepts).",
  "qs.steps.h": "Passo a passo (várias chamadas)",
  "qs.steps.p":
    "Se você prefere montar o envelope aos poucos (por exemplo, para que alguém o revise no app antes de enviar), os mesmos dados podem ser enviados em chamadas separadas: criar o rascunho, enviar cada PDF, definir os destinatários, posicionar os campos e enviar. Cada passo valida a sua parte e o envelope fica em `draft` até o envio.",
  "qs.create.h": "a. Crie o rascunho",
  "qs.create.p":
    "Um **envelope** agrupa documentos, destinatários e campos. Só com `subject` (e opcionalmente `message`, `metadata`, `expiresAt`…) ele nasce como rascunho (`draft`) vazio. Use `metadata` para guardar seus próprios identificadores (eles voltam em cada webhook; as chaves definidas pelo sistema, como `workflowRunId`, `webFormId`, `bulkSendId`, `crm` ou `clonedFrom`, não podem ser fixadas) e envie uma `Idempotency-Key` para que uma nova tentativa não crie um envelope duplicado.",
  "qs.create.resp": "Guarde `envelope.id`: você vai usá-lo nos passos seguintes.",
  "qs.upload.h": "b. Envie o PDF",
  "qs.upload.p":
    "Envie o arquivo como `multipart/form-data` no campo `file`. Você pode enviar vários PDFs para o mesmo envelope: eles são assinados na ordem em que foram enviados. A resposta traz o `id` do documento, seu número de páginas e seu SHA-256.",
  "qs.recipients.h": "c. Adicione a signatária",
  "qs.recipients.p":
    "`PUT /recipients` substitui a lista completa. Por padrão cada destinatário é `signer`, recebe o convite por `email` e tem `routingOrder: 1`. Com `phone` no formato E.164 você também pode avisá-lo pelo WhatsApp. Você pode enviar seu próprio `id` (UUID) para referenciá-lo nos campos sem ler a resposta; caso contrário, pegue-o de `recipients[].id`.",
  "qs.fields.h": "d. Posicione os campos",
  "qs.fields.p":
    "Cada signatário precisa de pelo menos um campo. A forma mais simples é um **texto âncora**: escreva `[[firma]]` no PDF (pode ser branco sobre branco) e a CalaSign coloca o campo onde ele aparecer. `offsetX`, `offsetY`, `width` e `height` são em pontos PDF, relativos ao canto superior esquerdo do texto. Substitua `RECIPIENT_ID` pelo id da signatária.",
  "qs.send.h": "e. Envie",
  "qs.send.p":
    "Ao enviar, os documentos, os destinatários e os campos são validados; o envelope passa para `sent` e os signatários do primeiro turno recebem o convite. No ambiente de testes o convite fica na **Caixa dev** do app: abra-o e assine você mesmo.",
  "qs.c.one": "Envelope completo em uma chamada: PDF, signatária, campo de assinatura sobre [[firma]] e envio",
  "qs.c.multipart": "O mesmo sem base64: o JSON na parte payload e o PDF em sua própria parte",
  "qs.c.noBase64": "o PDF vai sem base64",
  "qs.c.wait": "Aguardar a assinatura (melhor com um webhook)",
  "qs.c.download": "Baixar o PDF assinado",
  "qs.c.sdkIdem": "o SDK adiciona a Idempotency-Key sozinho",
  // ───────── Autenticação ─────────
  "auth.title": "Autenticação",
  "auth.lead":
    "Todas as requisições à API levam `Authorization: Bearer <credencial>`. A credencial pode ser uma API key da sua organização ou um access token OAuth 2.0. O acesso via API (keys, OAuth e MCP) está incluído a partir do plano Starter.",
  "auth.cmp.method": "Credencial",
  "auth.cmp.when": "Quando usar",
  "auth.cmp.format": "Formato",
  "auth.cmp.key": "Seu próprio backend integrado com a sua própria organização. O mais simples.",
  "auth.cmp.cc": "Serviço a serviço com scopes restritos e tokens que expiram em 1 hora.",
  "auth.cmp.code": "Um app que age em nome de usuários de outras organizações (marketplace, agentes de IA).",
  "auth.keys.h": "API keys",
  "auth.keys.p":
    "São criadas em **Configurações → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) ou com `POST /v1/api-keys` a partir de uma sessão. O segredo completo é exibido **uma única vez**; depois só aparecem o prefixo (os primeiros 12 caracteres) e a data do último uso.\n\n- Formato: `cs_test_…` no ambiente de testes e `cs_live_…` em produção.\n- Cada key pertence à organização e tem um **papel** (`admin`, `member` ou um papel personalizado) que define o que ela pode fazer; ninguém pode criar uma key com mais permissões do que as próprias. Para criar webhooks ou integrações (gatilhos, armazenamento, CRM) a key também precisa de `envelopes:view_all`, como o papel `admin`.\n- Os envelopes criados com uma key ficam registrados como criados pela API (`createdVia: \"api\"`) e a evidência nomeia a key como ator.",
  "auth.keys.rotate.h": "Rotação e revogação",
  "auth.keys.rotate.p":
    "As keys não expiram. Para rotacionar uma: crie uma nova, implante-a no seu sistema, confira na lista que a antiga deixou de ser usada (*último uso*) e revogue-a com **Revogar** ou `DELETE /v1/api-keys/{id}`. A revogação é imediata: a próxima requisição com essa key recebe `401 unauthorized`.",
  "auth.keys.warn":
    "Uma API key dá acesso a toda a organização conforme o seu papel. Nunca a coloque em um app móvel, em JavaScript do navegador nem em um repositório. Se uma key vazar, revogue-a imediatamente.",
  "auth.oauth.h": "OAuth 2.0",
  "auth.oauth.p":
    "Registre uma aplicação em **Configurações → Apps OAuth** ([`/app/settings/oauth-apps`](/app/settings/oauth-apps)) ou com `POST /v1/oauth/apps`. Você recebe um `client_id` (`csapp_…`) e, se o app for **confidencial**, um `client_secret` (`cssec_…`, exibido uma vez; pode ser rotacionado). Um app **público** (desktop, móvel, SPA) não tem segredo e só pode usar authorization code com PKCE.\n\nOs tokens são opacos: access token `csat_…` válido por **1 hora**, refresh token `csrt_…` válido por **30 dias** e código de autorização válido por **10 minutos**. Os erros de `/oauth/*` seguem a RFC 6749: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "auth.ep.endpoint": "Endpoint",
  "auth.ep.use": "Para quê",
  "auth.ep.authorize": "Tela de consentimento no navegador (authorization code + PKCE).",
  "auth.ep.token": "Emitir tokens: `authorization_code`, `client_credentials` e `refresh_token`. Corpo `application/x-www-form-urlencoded` (também aceita JSON).",
  "auth.ep.revoke": "Revogar um token (RFC 7009). Revogar um refresh token revoga toda a autorização. Um token desconhecido ou de outro app também responde 200.",
  "auth.ep.introspect": "Consultar se um token está válido (RFC 7662). Somente clientes confidenciais e tokens do mesmo app.",
  "auth.ep.register": "Registro dinâmico de clientes (RFC 7591), pensado para agentes de IA e clientes MCP.",
  "auth.code.h": "Authorization code + PKCE",
  "auth.code.p":
    "Para agir em nome de uma pessoa: você a redireciona para a tela de consentimento da CalaSign, ela faz login se necessário e aprova os scopes, e volta para a sua `redirect_uri` com `code` e `state`. **PKCE com S256 é obrigatório**, inclusive para clientes confidenciais. A `redirect_uri` precisa coincidir exatamente com uma registrada.\n\nO cliente se autentica com HTTP Basic (`client_id:client_secret`) ou com `client_id` e `client_secret` no corpo. Um cliente público envia apenas `client_id`.",
  "auth.code.c.pkce": "PKCE: verifier aleatorio e seu challenge S256",
  "auth.code.c.redirect": "Redirecionar a pessoa para a tela de consentimento",
  "auth.code.c.exchange": "No seu callback: verificar o state e trocar o codigo",
  "auth.code.c.callback": "recebido no callback",
  "auth.code.c.public": "omitir em um cliente publico",
  "auth.code.after":
    "Se a pessoa recusar, ela volta com `error=access_denied`. Se você pediu `offline_access`, recebe também um `refresh_token`. Um código só pode ser trocado uma vez: se for reutilizado, a CalaSign revoga os tokens emitidos com ele.",
  "auth.cc.h": "Client credentials",
  "auth.cc.p":
    "Para integrações servidor a servidor sem uma pessoa presente. Ao registrar o app com o grant `client_credentials`, ele recebe um papel (por padrão `member`) que funciona como uma identidade de serviço. Não há refresh token: peça um novo quando o atual expirar (`expires_in` = 3600). Se você omitir `scope`, recebe todos os scopes habilitados para o app (sem `offline_access`).",
  "auth.refresh.h": "Renovação e rotação de tokens",
  "auth.refresh.p":
    "Cada uso de um refresh token retorna um access token **e um refresh token novos**; o anterior deixa de valer e o access token anterior da mesma autorização é revogado. Guarde sempre o último refresh token recebido. Você pode pedir menos scopes que os originais, nunca mais.",
  "auth.refresh.warn":
    "Se um refresh token já trocado aparecer de novo, a CalaSign o trata como roubado e revoga **toda** a autorização: a pessoa precisa aprovar o app novamente. Evite renovar em paralelo a partir de vários processos com o mesmo refresh token.",
  "auth.scopes.h": "Scopes",
  "auth.scopes.p":
    "Os scopes limitam o que um token pode fazer, além do papel do usuário ou do app: um token nunca pode mais do que a pessoa que o aprovou. Peça apenas os que você precisa. Um endpoint fora dos scopes do token responde `403 insufficient_scope` com `details.requiredScope`.",
  "auth.scopes.col.desc": "Permite",
  "auth.dcr.h": "Registro dinâmico de clientes",
  "auth.dcr.p":
    "Os clientes MCP (Claude, ChatGPT, Gemini CLI, o MCP Inspector) se registram sozinhos com `POST /oauth/register` (RFC 7591), sem que ninguém precise criar um app manualmente. O registro não exige autenticação e cria um cliente que só pode usar `authorization_code` + `refresh_token`.",
  "auth.dcr.req": "Requisição",
  "auth.dcr.resp": "Resposta",
  "auth.dcr.rules":
    "- `token_endpoint_auth_method`: `none` (cliente público, o normal em agentes e apps desktop), `client_secret_post` ou `client_secret_basic`. Com os dois últimos a resposta inclui `client_secret`, exibido uma única vez.\n- `redirect_uris`: apenas `https://…` ou endereços de loopback (`http://127.0.0.1:<porta>/…`, `http://localhost:<porta>/…`).\n- PKCE com `S256` é obrigatório em todas as autorizações.\n- O cliente registrado não tem acesso a nada até que uma pessoa o aprove na tela de consentimento.",
  "auth.resource.h": "Indicadores de recurso (RFC 8707)",
  "auth.resource.p":
    "Os clientes MCP enviam o parâmetro `resource` com a URL do servidor MCP (`{{MCP_URL}}`) em `/oauth/authorize` e em `/oauth/token`, para pedir um token destinado a esse recurso. A CalaSign o aceita nas duas etapas; você não precisa enviá-lo se chamar a API REST diretamente.",
  "auth.discovery.h": "Descoberta",
  "auth.discovery.p":
    "Os metadados padrão permitem que um cliente configure o OAuth apenas a partir da URL do servidor MCP. Quando uma requisição a `/mcp` chega sem credencial, a resposta `401` traz `WWW-Authenticate: Bearer resource_metadata=\"…\"` apontando para estes documentos.",
  "auth.disc.prm": "Metadados do recurso protegido (RFC 9728): recurso, servidor de autorização e scopes.",
  "auth.disc.as": "Metadados do servidor de autorização (RFC 8414): endpoints, grants, métodos de autenticação e PKCE.",
  // ───────── Conceitos ─────────
  "concepts.title": "Conceitos",
  "concepts.lead": "O modelo da CalaSign em uma página: envelopes, destinatários, documentos, campos, modelos e a evidência que respalda cada assinatura.",
  "concepts.col.meaning": "Significado",
  "concepts.lifecycle.h": "Ciclo de vida do envelope",
  "concepts.lifecycle.p":
    "Um **envelope** (*envelope*) é a unidade enviada para assinatura: um ou mais PDFs, seus destinatários e os campos de cada um. Enquanto está em `draft`, tudo pode ser modificado; depois de enviado, só pode ser [corrigido](/developers/guides/reminders#corrections) dentro de certos limites.",
  "concepts.lifecycle.alt.t": "Estados do envelope",
  "concepts.lifecycle.alt.d":
    "draft passa para sent ao enviar. A partir de sent pode passar para finalizing quando todos assinam, para awaiting_certificates se houver assinaturas com certificado pendentes, ou terminar em declined, expired ou voided. finalizing termina em completed. awaiting_certificates volta para finalizing ou pode ser anulado.",
  "concepts.lifecycle.caption": "Estados finais: completed, declined, voided e expired.",
  "concepts.status.draft": "Rascunho. É possível alterar documentos, destinatários, campos e opções. Pode ser excluído.",
  "concepts.status.sent": "Enviado e em andamento: os destinatários do turno atual receberam o convite.",
  "concepts.status.finalizing":
    "Todos assinaram. A CalaSign está montando o PDF final, o certificado de conclusão e o selo. Costuma levar segundos; depois passa para `completed`. Se uma cobrança com `after_sign` estiver pendente, o envelope aguarda o pagamento antes desta etapa.",
  "concepts.status.completed": "Concluído. O PDF selado está disponível em `GET /v1/envelopes/{id}/signed.pdf` e `signedSha256` contém o seu hash.",
  "concepts.status.declined": "Um signatário ou aprovador recusou. O motivo fica em `recipients[].declineReason`.",
  "concepts.status.voided": "O remetente o anulou (`POST /v1/envelopes/{id}/void`) com um motivo. Os pendentes recebem um aviso.",
  "concepts.status.expired": "Chegou `expiresAt` sem que todos tivessem assinado. Por padrão, um envelope expira 30 dias após a criação.",
  "concepts.status.awaiting_certificates":
    "Todos assinaram eletronicamente e faltam as [assinaturas com certificado digital](/developers/guides/certificate-signing). Pode ser anulado.",
  "concepts.recipients.h": "Destinatários e papéis",
  "concepts.recipients.p":
    "Um destinatário (*recipient*) é uma pessoa com um papel. Ele não precisa de conta na CalaSign: recebe um link pessoal por e-mail, WhatsApp ou Telegram (ou assina dentro do seu app com [assinatura incorporada](/developers/guides/embedded-signing)). Um envelope aceita até 50 destinatários.",
  "concepts.role.signer": "Assina e preenche seus campos. É o papel padrão. É o único papel que pode ter campos.",
  "concepts.role.approver": "Revisa e aprova (ou recusa) sem campos no documento. Gera o evento `recipient.approved`.",
  "concepts.role.cc": "Recebe uma cópia do documento assinado quando o envelope é concluído. Não assina nem aprova.",
  "concepts.rstatus.h": "Estado de cada destinatário",
  "concepts.rstatus.created": "Ainda não é a vez dele (aguarda seu turno de `routingOrder`) ou o envelope está em rascunho.",
  "concepts.rstatus.sent": "Recebeu o convite.",
  "concepts.rstatus.viewed": "Abriu o link.",
  "concepts.rstatus.signed": "Assinou (ou aprovou, se for `approver`).",
  "concepts.rstatus.declined": "Recusou; o envelope passa para `declined`.",
  "concepts.rstatus.completed": "Cópia (`cc`) que já recebeu o documento final.",
  "concepts.rstatus.delegated": "Delegou a assinatura a outra pessoa (se o envelope permitir com `allowDelegation`). `replacedBy` aponta para o novo destinatário.",
  "concepts.rstatus.reassigned": "O remetente o substituiu por outra pessoa. `replacedBy` aponta para o novo destinatário.",
  "concepts.channels.h": "Canais de notificação",
  "concepts.channels.p":
    "`channels` define por onde chega o convite: {channels}. `email` precisa de `email`; `whatsapp` precisa de `phone` no formato E.164 (`+5491122334455`); `telegram` precisa de `telegramChatId` ou, se você não o tiver, de outro canal para enviar o link de vinculação. Com `embedded: true` ou `inPerson` o destinatário não recebe convites. `locale` (`es`, `pt-BR`, `en`) define o idioma das mensagens e da página de assinatura.",
  "concepts.routing.h": "Ordem de assinatura",
  "concepts.routing.p":
    "`routingOrder` (1 a 100) define os turnos. Todos os destinatários com o mesmo número recebem o convite ao mesmo tempo (assinatura em **paralelo**); o turno seguinte só é ativado quando o anterior termina (assinatura em **sequência**). Combinando números, você monta fluxos mistos. As cópias (`cc`) recebem o documento no final, independentemente do número.",
  "concepts.routing.example": "Aprovação interna, depois dois signatários em paralelo e uma cópia",
  "concepts.documents.h": "Documentos",
  "concepts.documents.p":
    "Um envelope tem um ou mais PDFs (`POST /v1/envelopes/{id}/documents`, multipart, campo `file`). A CalaSign normaliza cada arquivo no envio e guarda dois hashes na evidência: o do arquivo original e o do normalizado, que é o exibido e assinado. Assim, o que o signatário vê é exatamente o que ele assina. O detalhe do documento traz `pageCount`, o tamanho de cada página (`pages[]`, em pontos) e `sha256`.",
  "concepts.fields.h": "Campos",
  "concepts.fields.p":
    "Os campos são posicionados no documento com coordenadas normalizadas — `page` a partir de 0 e `x`, `y`, `width`, `height` entre 0 e 1 com origem no canto superior esquerdo — ou com um [texto âncora](/developers/guides/anchors). `PUT /v1/envelopes/{id}/fields` substitui todos os campos (até 500). Cada campo pertence a um signatário (`recipientId`) e é obrigatório, salvo `required: false`. O remetente pode preenchê-lo previamente com `value` e bloqueá-lo com `readOnly: true`.",
  "concepts.field.signature": "Assinatura (desenhada ou digitada pelo signatário).",
  "concepts.field.initials": "Rubrica.",
  "concepts.field.date_signed": "Data da assinatura. Preenchida pela CalaSign ao assinar.",
  "concepts.field.name": "Nome do destinatário. Preenchido pela CalaSign.",
  "concepts.field.email": "E-mail do destinatário. Preenchido pela CalaSign.",
  "concepts.field.text": "Texto livre. Pode ser pré-preenchido.",
  "concepts.field.checkbox": "Caixa de seleção.",
  "concepts.field.number": "Número, com intervalo opcional (`min`, `max`) ou calculado com `formula`. Pode ser pré-preenchido.",
  "concepts.field.dropdown": "Lista suspensa: exige `options` (até 50). Pode ser pré-preenchido.",
  "concepts.field.company": "Empresa. Pode ser pré-preenchido.",
  "concepts.field.title": "Cargo. Pode ser pré-preenchido.",
  "concepts.field.attachment": "O signatário anexa um arquivo (PDF, PNG ou JPEG, até 10 MB).",
  "concepts.logic.h": "Campos condicionais e calculados",
  "concepts.logic.p":
    "`conditions` (até 10, todas precisam ser atendidas) mostra um campo —e o exige, se for obrigatório— apenas conforme o valor de outro: operadores `equals`, `not_equals`, `checked`, `unchecked` e `filled`, referenciando o `id` do outro campo (por isso convém enviar ids próprios). O campo citado precisa ser somente leitura, do mesmo destinatário ou de alguém que assina **antes**: caso contrário, a condição seria decidida com um valor que ainda não existe e o salvamento responde `422 logic_order`. `formula` calcula um campo `number` a partir de outros campos numéricos citados pelo rótulo: `{Precio} * {Cantidad} * 1.18`.",
  "concepts.templates.h": "Modelos",
  "concepts.templates.p":
    "Um **modelo** guarda documentos, campos e **papéis** (por exemplo «Cliente» e «Empresa») sem pessoas específicas. Ao usá-lo com `POST /v1/envelopes/from-template`, você atribui uma pessoa a cada papel, pode pré-preencher campos pelo rótulo e enviar na mesma requisição. É a base do [envio em massa](/developers/guides/bulk-send), dos [formulários web](/developers/guides/web-forms), das integrações com CRM e da ferramenta MCP `create_envelope_from_template`. Veja o [guia de modelos](/developers/guides/templates).",
  "concepts.evidence.h": "Evidência e certificado de conclusão",
  "concepts.evidence.p":
    "Cada ação sobre um envelope (criação, envio, abertura, consentimento, assinatura, recusa, anulação…) é registrada como um evento com ator, IP, user agent e data, **encadeado por hash** com o anterior: se alguém alterasse um evento, a cadeia deixaria de ser verificável. Consulte com `GET /v1/envelopes/{id}/events` (cada evento traz o seu `hash`).\n\nAo ser concluído, o PDF final inclui um **certificado de conclusão**: participantes, método de autenticação, IPs e horários de cada etapa, hashes dos documentos e o resumo da cadeia de evidência.",
  "concepts.evidence.agent":
    "As ações feitas por um agente de IA através do [servidor MCP](/developers/ai/mcp) ficam na evidência com o ator «agente IA (<nome do cliente>)», seguido da credencial utilizada.",
  "concepts.pades.h": "Selo PAdES",
  "concepts.pades.p":
    "O PDF final leva uma assinatura digital da plataforma no formato **PAdES** (assinatura CAdES dentro do PDF), com a chave do selo em um HSM/KMS. Qualquer leitor de PDF pode comprovar que o arquivo não mudou desde que foi selado. O nível é escolhido por organização (`PATCH /v1/settings/evidence`; por padrão `auto`) e uma organização pode acrescentar seu próprio **selo de empresa** com o seu certificado (`PUT /v1/envelopes/{id}/seal-options`). As camadas posteriores são adicionadas como revisões incrementais, sem tocar no que já foi assinado.",
  "concepts.pades.col.level": "Nível",
  "concepts.pades.col.adds": "O que acrescenta",
  "concepts.pades.bb": "Assinatura básica com o certificado do selo.",
  "concepts.pades.bt": "Carimbo do tempo RFC 3161 de uma autoridade de carimbo do tempo: prova quando foi assinado.",
  "concepts.pades.blt": "Certificados, OCSP e CRL incorporados: pode ser validado mesmo que a CA não responda mais.",
  "concepts.pades.blta": "Carimbo do tempo de documento que protege tudo o que veio antes; é renovado antes de expirar, para arquivamento de longo prazo.",
  "concepts.verify.h": "Verificação",
  "concepts.verify.p":
    "Qualquer pessoa pode verificar um documento na página pública [`/verify`](/verify), sem conta: a CalaSign busca o SHA-256 do arquivo entre os documentos que selou e mostra a organização, os participantes, o selo e o estado da cadeia de evidência; além disso, valida cada assinatura do PDF (integridade, carimbo do tempo, cadeia de certificados e revogação). Via API: `POST /v1/verify` (busca por hash) e `POST /v1/validate` (validação de assinaturas), ambos públicos e com `multipart` campo `file`.",
  // ───────── Guia: modelos ─────────
  "g.tpl.title": "Enviar com modelos",
  "g.tpl.lead":
    "Se você sempre envia o mesmo documento, monte-o uma vez como modelo —no app (**Modelos**) ou via API— e depois crie cada envelope com uma única requisição, informando só as pessoas e os dados que mudam.",
  "g.tpl.roles.h": "Modelos e papéis",
  "g.tpl.roles.p":
    "Um modelo é montado igual a um envelope: `POST /v1/templates` (nome, assunto e mensagem padrão), `POST /v1/templates/{id}/documents` para cada PDF, `PUT /v1/templates/{id}/roles` e `PUT /v1/templates/{id}/fields` (os campos usam `roleId` em vez de `recipientId`). Você também pode converter um envelope existente em modelo com `POST /v1/templates/from-envelope/{envelopeId}`.\n\nOs **papéis** são os lugares que depois serão ocupados por pessoas reais. Eles têm `name`, `role` (`signer`, `approver` ou `cc`) e `routingOrder`.",
  "g.tpl.roles.list": "Para usar um modelo você precisa do seu `id` e do nome dos seus papéis: os dois vêm na listagem.",
  "g.tpl.send.h": "Criar um envelope a partir de um modelo",
  "g.tpl.send.p":
    "`POST /v1/envelopes/from-template` copia documentos, campos e papéis, atribui cada destinatário ao seu papel (por `role`, o nome, sem diferenciar maiúsculas, ou por `roleId`) e retorna o detalhe do novo envelope. Todos os papéis precisam ter uma pessoa: se faltar algum, a resposta é `422 roles_missing`. Com `send: true` o envelope é enviado na mesma requisição; sem ele, fica em rascunho para você revisar ou adicionar uma cobrança.",
  "g.tpl.send.idem":
    "Este endpoint aceita `Idempotency-Key`: envie uma chave única por envelope e, se tentar de novo após um timeout ou um 5xx com a mesma chave e o mesmo corpo, você recebe o envelope já criado em vez de criar (e enviar) outro.",
  "g.tpl.prefill.h": "Pré-preencher campos",
  "g.tpl.prefill.p":
    "`prefill` é um objeto `{ \"clave\": \"valor\" }` em que a chave é o `id` de um campo do modelo ou o seu **rótulo** (`label`, sem diferenciar maiúsculas). Se vários campos compartilham o rótulo, todos são preenchidos. Uma chave que não corresponde a nenhum campo retorna `400 unknown_prefill`. Os campos com `readOnly` no modelo ficam bloqueados para o signatário.",
  // ───────── Guia: assinatura incorporada ─────────
  "g.embed.title": "Assinatura incorporada",
  "g.embed.lead":
    "Mostre a assinatura dentro da sua aplicação, em um iframe, para pessoas que já fizeram login no seu produto. O destinatário não recebe e-mails: o seu backend pede uma URL de uso único cada vez que a pessoa vai assinar.",
  "g.embed.s1": "Autorize as origens do seu app que podem exibir o iframe.",
  "g.embed.s2": "Marque o destinatário com `embedded: true` e envie o envelope.",
  "g.embed.s3": "Quando a pessoa for assinar, o seu backend pede uma URL de assinatura (expira em 5 minutos, vale uma vez).",
  "g.embed.s4": "O seu frontend a abre em um iframe e escuta os eventos via `postMessage`.",
  "g.embed.origins.h": "1. Autorizar origens",
  "g.embed.origins.p":
    "A página de assinatura só pode ser enquadrada a partir das origens autorizadas pela sua organização (aplicadas como `frame-ancestors` do CSP). Cadastre-as em **Configurações → Integrações → Assinatura incorporada** ou via API: até 20 origens `https://dominio[:porta]` sem caminho, com curinga de subdomínio (`https://*.tuempresa.com`). No ambiente local, `http://localhost` é aceito.",
  "g.embed.recipient.h": "2. Destinatário incorporado",
  "g.embed.recipient.p":
    "Com `embedded: true` o destinatário não recebe convites nem lembretes e não precisa de `email` nem de `phone` (você pode enviá-los mesmo assim para que constem na evidência). Envie o envelope como sempre.",
  "g.embed.url.h": "3. Pedir a URL de assinatura",
  "g.embed.url.p":
    "Peça-a **logo antes** de exibi-la: ela expira em 5 minutos e é consumida ao ser aberta. O envelope precisa estar enviado (caso contrário, `409 not_available`). Se ainda não for a vez do destinatário segundo `routingOrder`, ele pode abrir o documento, mas só assina quando chegar o seu turno. `returnUrl` (opcional, https) é para onde o iframe é redirecionado ao terminar, com `?event=signing_complete|declined&envelopeId=…`. `frameAncestors` (opcional) restringe esta sessão a um subconjunto das origens autorizadas.",
  "g.embed.iframe.h": "4. Exibi-la em um iframe",
  "g.embed.iframe.p":
    "Sempre verifique a origem da mensagem. Use a origem da URL recebida: se a sua organização tiver [domínio próprio](/developers/guides/custom-domain), a URL usa esse domínio.",
  "g.embed.events.h": "Eventos postMessage",
  "g.embed.ev.viewed": "A pessoa abriu o documento.",
  "g.embed.ev.complete": "Assinou (ou aprovou). Você também recebe o webhook `recipient.signed`.",
  "g.embed.ev.declined": "Recusou o documento.",
  "g.embed.ev.error": "O link não é válido ou já expirou: peça uma URL nova.",
  "g.embed.events.p":
    "Cada mensagem é `{ source: \"calasign\", type, envelopeId, recipientId }` e é enviada uma única vez por tipo. Trate os eventos do navegador como um sinal para a interface: a confirmação de negócio são os [webhooks](/developers/webhooks), que são assinados.",
  "g.embed.security":
    "Com assinatura incorporada, **a sua aplicação** é quem autentica a pessoa: a evidência registra que a sessão foi aberta pela sua integração («autenticada pelo integrador»). Peça a URL apenas para a pessoa que fez login e que corresponde a esse destinatário.",
  // ───────── Guia: âncoras ─────────
  "g.anchor.title": "Campos por texto âncora",
  "g.anchor.lead":
    "Em vez de calcular coordenadas, escreva marcadores no documento (por exemplo `[[firma_cliente]]`) e deixe a CalaSign posicionar os campos. Ideal para PDFs gerados pelo seu sistema.",
  "g.anchor.how.h": "Como funciona",
  "g.anchor.how.p":
    "Em `PUT /v1/envelopes/{id}/fields`, um campo pode levar `anchor` em vez de `page`/`x`/`y`. A CalaSign busca o texto nos documentos e cria **um campo para cada ocorrência**. Você pode misturar campos por âncora e por coordenadas na mesma requisição. Todas as propriedades do campo (`required`, `label`, `value`, `readOnly`, `options`, `min`, `max`, `conditions`, `formula`) são copiadas para cada campo gerado.",
  "g.anchor.options.h": "Opções",
  "g.anchor.col.prop": "Propriedade",
  "g.anchor.col.default": "Padrão",
  "g.anchor.o.text": "Texto a buscar (1 a 100 caracteres).",
  "g.anchor.o.size": "Tamanho do campo em pontos PDF (1 pt = 1/72 de polegada). Obrigatórios.",
  "g.anchor.o.offset": "Deslocamento em pontos a partir do canto superior esquerdo do texto encontrado. Negativo = para cima ou para a esquerda.",
  "g.anchor.o.case": "Diferenciar maiúsculas e minúsculas.",
  "g.anchor.o.ignore": "Se for `false` e o texto não aparecer, a requisição falha com `400 anchor_not_found`. Com `true` o campo simplesmente não é criado.",
  "g.anchor.o.alldocs": "todos",
  "g.anchor.o.doc": "Buscar apenas nesse documento.",
  "g.anchor.tips.h": "Dicas",
  "g.anchor.tips.p":
    "- Use marcadores únicos e difíceis de confundir: `[[firma_1]]`, `\\s1\\`. Um texto que aparece no corpo do contrato criaria campos a mais.\n- Você pode escrever o marcador em branco sobre fundo branco ou em um tamanho de fonte muito pequeno: continua sendo texto e é encontrado do mesmo jeito.\n- Um PDF digitalizado (só imagem) não tem texto: nesse caso é preciso usar coordenadas.\n- Os campos gerados voltam na resposta com suas coordenadas normalizadas: guarde-as se quiser reutilizá-las.\n- PDFs muito pesados podem responder `422 pdf_too_heavy`; se o leitor estiver ocupado, `503 pdf_reader_busy` (tente novamente).",
  // ───────── Guia: envio em massa ─────────
  "g.bulk.title": "Envio em massa",
  "g.bulk.lead":
    "Envie o mesmo modelo para centenas de pessoas —até 5.000 linhas por envio— e a CalaSign cria e envia um envelope por linha em segundo plano. Disponível a partir do plano Business.",
  "g.bulk.csv.h": "Com um CSV",
  "g.bulk.csv.p":
    "Baixe o CSV de exemplo do modelo: ele traz uma coluna para cada dado de cada papel (`Rol.name`, `Rol.email`, `Rol.phone`, `Rol.channels`) e uma para cada campo pré-preenchível (`field.Etiqueta`), além de `subject` opcional por linha. Em `channels`, separe vários canais com `;`.",
  "g.bulk.validate":
    "Antes de enviar, você pode validar sem criar nada com `POST /v1/bulk-sends/validate` (mesmo corpo): responde `{ total, valid, invalid, errors: [{ row, errors }], columns }`. Ao criar, se houver linhas inválidas a resposta é `422 rows_invalid` com esse mesmo detalhe, a menos que você envie `skipInvalid: true`: nesse caso as válidas são enviadas e as outras ficam como falhas.",
  "g.bulk.json.h": "Com linhas JSON",
  "g.bulk.json.p": "Em vez de `csv` você pode enviar `rows` (um dos dois). Cada linha aceita destinatários por papel, `prefill`, um `subject` próprio e `metadata`, que é salvo no envelope e volta para você nos webhooks.",
  "g.bulk.track.h": "Acompanhamento",
  "g.bulk.track.p":
    "A resposta é o envio em massa com seu estado (`queued`, `running`, `completed`, `cancelled`) e contadores (`total`, `sent`, `failed`, `pending`). Consulte `GET /v1/bulk-sends/{id}`, o detalhe por linha com `GET /v1/bulk-sends/{id}/items` (filtrável por `status`) ou baixe `results.csv`. `POST /v1/bulk-sends/{id}/cancel` interrompe as linhas que ainda não foram processadas. Cada envelope criado dispara seus próprios webhooks.",
  // ───────── Guia: formulários web ─────────
  "g.forms.title": "Formulários web",
  "g.forms.lead":
    "Um link público (`/f/<slug>`) onde qualquer pessoa preenche seus dados e assina um documento de um modelo: cadastros de clientes, consentimentos, inscrições. Cada uso cria um envelope. Disponível a partir do plano Business.",
  "g.forms.create.h": "Criar o formulário",
  "g.forms.create.p":
    "Escolha o modelo e o **papel assumido por quem preenche o formulário** (`signerRoleId`, precisa ser signatário). Os demais papéis são cobertos com `fixedRecipients` (por exemplo, o representante da sua empresa). Opções: `prefill`, `maxUses`, `expiresAt`, `requireOtp` (pede um código por e-mail antes de mostrar o documento), `collectPhone` e `embeddable` (pode ser exibido em um iframe a partir das suas origens autorizadas).",
  "g.forms.share.h": "Compartilhar e acompanhar",
  "g.forms.share.p":
    "A resposta traz `url`, o link público para compartilhar. `GET /v1/web-forms/{id}/envelopes` lista os envelopes gerados e `uses` conta os usos. Para pausá-lo, `PATCH /v1/web-forms/{id}` com `active: false`. Se quem o criou sair da organização ou perder acesso ao modelo, o formulário deixa de criar envelopes e `ownerInactiveReason` explica o motivo. Cada formulário cria no máximo 60 envelopes por hora; depois responde `429 form_rate_limited`.",
  // ───────── Guia: lembretes ─────────
  "g.rem.title": "Lembretes, expiração e correções",
  "g.rem.lead": "Como insistir com quem não assinou, quando um envelope expira e o que pode ser alterado depois de enviá-lo.",
  "g.rem.auto.h": "Lembretes automáticos",
  "g.rem.auto.p":
    "Ao criar ou editar o rascunho: `reminderEveryDays` (1 a 60) reenvia o convite a cada N dias para quem está com o turno pendente; `expiryWarningDays` avisa N dias antes da expiração; `allowDelegation` permite que o signatário delegue a outra pessoa. `null` desativa cada opção.",
  "g.rem.manual.h": "Lembrete manual",
  "g.rem.manual.p":
    "`POST /v1/envelopes/{id}/remind` reenvia imediatamente o convite aos pendentes do turno atual e retorna quantos foram notificados. No máximo um lembrete manual a cada 10 minutos por envelope: antes disso responde `429 reminded_recently`. Se o envelope estiver em `awaiting_certificates`, avisa o signatário com certificado da vez. Um envelope que não está em andamento responde `409 not_in_progress`.",
  "g.rem.exp.h": "Expiração",
  "g.rem.exp.p":
    "`expiresAt` (ISO 8601 com fuso horário) define até quando é possível assinar. Se você não informar, o envelope expira **30 dias** após a criação. Ao expirar, passa para `expired` e dispara `envelope.expired`. Para estender o prazo de um envelope em andamento, use uma correção.",
  "g.rem.corr.h": "Correções e reatribuição",
  "g.rem.corr.p":
    "`POST /v1/envelopes/{id}/corrections` altera um envelope em andamento sem anulá-lo: mensagem, expiração, dados de contato (o link anterior é revogado e um novo é enviado), destinatários e campos novos para turnos que não começaram, e remoção de quem ainda não abriu o envelope. Quem já assinou não pode ser alterado. `reason` fica na evidência. O envelope corrigido continua limitado a 50 destinatários e 500 campos (senão, `422 envelope_incomplete`).",
  "g.rem.reassign":
    "Para substituir um destinatário pendente por outra pessoa, use a reatribuição: o original fica como `reassigned` e o novo recebe o convite. Um envelope admite no máximo 20 delegações ou reatribuições (depois, `409 too_many_replacements`).",
  // ───────── Guia: certificado ─────────
  "g.cert.title": "Assinatura com certificado digital",
  "g.cert.lead":
    "Um signatário pode assinar também com **o seu próprio certificado digital** —token USB ou cartão (PKCS#11), certificado instalado no Windows ou arquivo `.p12/.pfx`— nos casos que exigem assinatura digital do titular: ICP-Brasil A1/A3, DNIe do Peru, certificados de entidades credenciadas pela ONAC (Colômbia), INDOTEL (República Dominicana) ou o IP (Honduras).",
  "g.cert.setup.h": "Configurar o signatário",
  "g.cert.setup.p":
    "Adicione `signatureType: \"certificate\"` ao destinatário (somente papel `signer`; também pode ser definido nos papéis de um modelo). Um signatário com certificado não precisa de campo de assinatura no documento.",
  "g.cert.flow.h": "Como o envelope segue",
  "g.cert.flow.p":
    "1. Todos assinam eletronicamente, como sempre.\n2. A CalaSign monta o PDF final com o certificado de conclusão e o envelope passa para `awaiting_certificates`. O primeiro signatário com certificado recebe a solicitação.\n3. Cada um assina em ordem com o **Firmador CalaSign**, um app desktop que pode ser baixado em [`/firmador`](/firmador). A chave privada nunca sai do dispositivo: a CalaSign envia um hash e recebe a assinatura (PAdES B-T, com carimbo do tempo).\n4. Com a última assinatura o envelope passa para `finalizing`, o selo da plataforma é adicionado e ele fica `completed`.\n\nO progresso de cada assinatura com certificado é consultado assim:",
  "g.cert.req.h": "Requisitos do certificado",
  "g.cert.req.p":
    "- `matchIdDocument`: o certificado precisa corresponder ao `idDocumentNumber` do signatário (CPF, cédula, DNI…). Aplica-se apenas se o destinatário tiver documento e exige que a cadeia chegue a uma raiz confiável.\n- `allowedIssuers`: partes do nome do emissor aceitas (por exemplo `ICP-Brasil`, `RENIEC`). Vazio = qualquer um.\n- `requireQualified`: exigir uma CA do repositório confiável da plataforma.\n\nAlém disso, são verificados a validade, o uso da chave (`digitalSignature` ou `nonRepudiation`) e que não seja um certificado de CA. As tentativas recusadas ficam na evidência.",
  // ───────── Guia: identidade ─────────
  "g.idv.title": "Autenticação e verificação de identidade",
  "g.idv.lead": "Por padrão, ter o link pessoal basta para assinar. Você pode exigir mais: um código de uso único ou uma verificação de identidade com documento e selfie.",
  "g.idv.auth.h": "Código de uso único",
  "g.idv.auth.p":
    "`authMethod` do destinatário: `link` (padrão), `otp_email` (exige `email`), `otp_sms` ou `otp_whatsapp` (exigem `phone`) ou `in_person` (assinatura no dispositivo de um anfitrião da sua organização, configurada com `inPerson`). Com OTP, a pessoa precisa digitar um código de 6 dígitos antes de ver o documento, e o método fica registrado no certificado de conclusão.",
  "g.idv.kyc.h": "Verificação de identidade (KYC)",
  "g.idv.kyc.p":
    "`idVerification` exige verificar a identidade antes de ver os documentos: `provider` (`truora`, `veriff` ou `mock` para testes) e `level` (`document`, `document_selfie` ou `document_selfie_liveness`). O nome e o número do documento são comparados com o que você declarou (`idDocumentType`, `idDocumentNumber`). Os valores padrão (provedor, nível, limite de correspondência do nome, tentativas) são configurados em `PATCH /v1/settings/identity`. O resultado —nunca as imagens— é consultado por destinatário. Disponível a partir do plano Business.",
  // ───────── Guia: cobranças ─────────
  "g.pay.title": "Cobrar ao assinar",
  "g.pay.lead":
    "Um envelope pode cobrar de um dos seus signatários dentro da mesma cerimônia: sinais, primeiras parcelas, honorários. O comprovante do pagamento vai no certificado de conclusão. Disponível a partir do plano Business.",
  "g.pay.conf.h": "Configurar a cobrança",
  "g.pay.conf.p":
    "Somente em rascunho. `amount` em unidades (com até 2 casas decimais), `currency` (`USD`, `BRL`, `COP`, `DOP`, `HNL`, `PEN`, `MXN`, `ARS`, `EUR`), `payerRecipientId` (um signatário do envelope) e `provider`: `stripe`, `mercadopago` ou `mock` (só em testes). `GET /v1/payments/providers` lista os provedores configurados. O Mercado Pago oferece Pix e boleto no Brasil e PSE na Colômbia; a Stripe cobra com cartão (e Pix em contas do Brasil).",
  "g.pay.timing.h": "Antes ou depois de assinar",
  "g.pay.timing.p":
    "- `after_sign` (padrão): a pessoa assina e depois paga. O envelope **só é concluído e selado quando o pagamento é confirmado**.\n- `before_sign`: não é possível concluir a assinatura antes de pagar; enquanto isso, a tentativa de assinatura responde `402 payment_required`.\n\nA confirmação chega apenas pelo webhook verificado do provedor. Se um pagamento chegar com o envelope já encerrado, ele é marcado para reembolso.",
  // ───────── Guia: CRM ─────────
  "g.hrclm.title": "RH, contratos e gestão documental",
  "g.hrclm.providers.h": "Conectores",
  "g.hrclm.flows.h": "Fluxos e envio a partir de um registro",
  "g.hrclm.webhook.h": "Disparar a partir do sistema de origem",
  "g.hrclm.dms.h": "Arquivamento em gestores documentais",
  "g.crm.title": "CRM e ERP",
  "g.crm.lead":
    "Conectores nativos para enviar para assinatura a partir do CRM e devolver o resultado, e para deixar o PDF assinado no ERP. São configurados em **Configurações → CRM e ERP** ([`/app/settings/crm`](/app/settings/crm)); toda a configuração também está na API, seção [CRM e ERP](/developers/api/crm-y-erp).",
  "g.crm.providers.h": "Provedores",
  "g.crm.col.provider": "Provedor",
  "g.crm.col.does": "O que faz",
  "g.crm.hubspot": "Enviar para assinatura a partir de um Deal (contatos associados + propriedades → modelo), manualmente ou por webhook ao mudar uma propriedade. Ao concluir, atualiza uma propriedade de estado e anexa o PDF ao deal.",
  "g.crm.salesforce": "Enviar a partir de uma Opportunity (papéis de contato + campos). Atualiza um campo de estado e publica o PDF como ContentVersion na oportunidade.",
  "g.crm.zoho":
    "OAuth em qualquer data center do Zoho (com, eu, in, com.au, jp, ca…). Enviar para assinatura a partir de um **Deal** (contato principal e papéis de contato) ou de um **Contact**; no Bigin, de um Pipeline. Atualiza um campo de status (ex. `CalaSign_Status`) e anexa o PDF assinado ao registro, com uma nota que traz o hash e o link do envelope. O botão «Enviar para assinatura com CalaSign» nos Deals vem com a [função Deluge e o guia da extensão](/integrations/connectors/zoho-crm/calasign-zoho-crm.zip).",
  "g.crm.siigo": "Colômbia: busca o cliente pela identificação de um signatário e adiciona a referência do documento assinado.",
  "g.crm.alegra": "Busca o contato pela identificação e anexa o PDF; também é possível vincular uma fatura.",
  "g.crm.pipedrive": "OAuth com o domínio da empresa. Enviar a partir de um Deal (pessoa principal e participantes + campos, inclusive personalizados pela key ou pelo nome) ou de uma Person. Grava o estado em um campo do registro (texto ou opção única) e, ao concluir, envia o PDF assinado ao deal ou à Person e cria uma nota com o SHA-256 e o link.",
  "g.crm.pipedrive.h": "Pipedrive",
  "g.crm.pipedrive.p":
    "1. **Configurações → CRM e ERP → Pipedrive → Conectar com OAuth**: autorize a empresa do Pipedrive; o CalaSign guarda o domínio da API.\n2. No Pipedrive, crie um campo personalizado do deal (ou da pessoa, para mapeamentos de Person) para o estado (ex. «Estado CalaSign», de texto ou de opção única com as opções que serão gravadas).\n3. Crie um mapeamento: tipo `deal` (ou `contact` para uma Person), modelo, destinatários (*contato principal* = a pessoa do deal; *contato 1, 2…* = os participantes), preenchimento (`value`, `title`, `org_id.name`, ou um campo personalizado pela key de 40 caracteres ou pelo nome) e a propriedade de estado.\n4. Envie com `POST /v1/crm/mappings/{id}/send` (`objectId` = id do deal ou da Person) ou a partir do Pipedrive com a ação **Enviar para assinatura com CalaSign** do app do Marketplace ([zip com a ação e o guia](/integrations/connectors/pipedrive/calasign-pipedrive.zip)).",
  "g.crm.rdstation":
    "Brasil. OAuth da RD Station App Store (API v2 do CRM). Enviar a partir de uma Negociação (os contatos na ordem + campos, inclusive personalizados pelo slug ou nome). Grava o estado em um campo personalizado (texto ou opção) e, ao concluir, envia o PDF assinado para os Anexos com uma anotação com o hash e o link.",
  "g.crm.rdstation.h": "RD Station CRM",
  "g.crm.rdstation.p":
    "1. **Configurações → CRM e ERP → RD Station CRM → Conectar com OAuth**: autorize a conta do RD Station.\n2. No RD Station CRM, crie um campo personalizado de negociações para o estado (ex. «Estado CalaSign», de texto ou de opção com os valores que serão gravados).\n3. Crie um mapeamento: tipo `deal`, modelo, destinatários (*contato principal* = o primeiro contato da negociação; *contato 1, 2…* = os seguintes), preenchimento (`name`, `one_time_price`, `recurrence_price`, ou um campo personalizado pelo slug ou nome) e o campo de estado.\n4. Envie com `POST /v1/crm/mappings/{id}/send` (`objectId` = id da negociação, 24 caracteres).",
  "g.crm.kommo":
    "OAuth por conta (subdomínio do Kommo). Enviar a partir de um Lead (contato principal e demais contatos + campos, inclusive personalizados pelo nome, código ou id). Grava o estado em um campo do lead (texto ou lista) e, ao concluir, anexa o PDF assinado ao lead (Files API) com uma nota com o hash e o link.",
  "g.crm.kommo.h": "Kommo",
  "g.crm.kommo.p":
    "1. **Configurações → CRM e ERP → Kommo → Conectar com OAuth**: autorize a conta do Kommo; o CalaSign guarda o subdomínio.\n2. No Kommo, crie um campo personalizado do lead para o estado (ex. «Estado CalaSign», de texto ou de lista com as opções que serão gravadas).\n3. Crie um mapeamento: tipo `deal` (= Lead), modelo, destinatários (*contato principal* = o contato principal do lead; *contato 1, 2…* = os demais), preenchimento (`name`, `price`, ou um campo personalizado pelo nome, código ou id) e o campo de estado.\n4. Envie com `POST /v1/crm/mappings/{id}/send` (`objectId` = id do lead) ou a partir do Kommo com o botão **Enviar para assinatura com CalaSign** do widget ([zip do widget](/integrations/connectors/kommo/calasign-kommo-widget.zip)).",
  "g.crm.mappings.h": "Mapeamentos e vínculos",
  "g.crm.mappings.p":
    "Um **mapeamento** une um tipo de registro a um modelo: de onde sai cada destinatário, quais propriedades pré-preenchem quais campos, o que é escrito de volta em cada estado e quando é disparado (`manual`, `webhook` ou `on_completion`). Cada envelope fica **vinculado** ao seu registro e cada evento (enviado, concluído, recusado, anulado, expirado) é escrito de volta. A atividade, com erros e novas tentativas, é consultada em `/v1/crm/runs`.",
  // ───────── Guia: domínio próprio ─────────
  "g.domain.title": "Domínio próprio",
  "g.domain.lead":
    "Assine a partir do seu próprio domínio (`firmas.tuempresa.com`): os links dos e-mails, do WhatsApp e do Telegram e as URLs de assinatura incorporada usam esse domínio, e a página mostra a sua marca. Disponível no plano Enterprise.",
  "g.domain.dns.h": "Registrar o domínio e criar os registros DNS",
  "g.domain.dns.p":
    "A resposta traz `txtName`, `txtValue` e `cnameTarget`. Crie no seu DNS um registro **TXT** para provar que o domínio é seu e um **CNAME** apontando para a plataforma. O CNAME não pode passar por um proxy (no Cloudflare, «somente DNS»).",
  "g.domain.verify.h": "Verificar",
  "g.domain.verify.p":
    "Quando o TXT tiver se propagado, faça a verificação. O certificado TLS é emitido automaticamente no primeiro acesso. A CalaSign verifica o domínio novamente a cada 6 horas: se o TXT ou o CNAME sumirem várias vezes seguidas, o domínio volta para `pending` e os links passam para o domínio da plataforma.",
  // ───────── Guia: marca ─────────
  "g.brand.title": "Marca própria",
  "g.brand.lead": "Seu logo, sua cor e um rodapé próprio nos e-mails e na página de assinatura. Disponível a partir do plano Starter.",
  "g.brand.api.h": "Via API",
  "g.brand.api.p":
    "`primaryColor` vai no formato `#RRGGBB`; `emailFooter`, até 500 caracteres (`null` remove cada valor). O logo é enviado como `multipart/form-data` no campo `file`: PNG, SVG ou JPEG de até 200 KB. `DELETE /v1/settings/branding/logo` o remove. Também é configurado em **Configurações → Marca**.",
  // ───────── Webhooks ─────────
  "wh.title": "Webhooks",
  "wh.lead":
    "A CalaSign avisa você com um `POST` assinado para a sua URL sempre que algo acontece em um envelope: alguém o abre, assina, recusa, ou o envelope é concluído. É a forma recomendada de ficar sabendo, em vez de consultar a API. Disponível a partir do plano Starter.",
  "wh.setup.h": "Configurar um endpoint",
  "wh.setup.p":
    "Registre a URL em **Configurações → Integrações** ([`/app/settings/integrations`](/app/settings/integrations)) ou via API. A URL precisa ser `https`, pública e sem credenciais; redirecionamentos não são seguidos. `events` vazio ou ausente = todos os eventos. A resposta inclui o `secret` (`whsec_…`) para verificar as assinaturas: **é exibido uma única vez**. Você pode ter vários endpoints, pausá-los (`active: false`) e alterar seus eventos com `PATCH /v1/webhooks/{id}`. Como um webhook recebe os dados de todos os envelopes da organização, criá-lo, alterá-lo ou reenviar uma entrega exige `webhooks:manage` e também `envelopes:view_all` (p. ex. o papel `admin`). Um webhook criado com uma API key ou com o token OAuth de um usuário (os REST hooks do Zapier, Make ou Power Automate) fica vinculado a essa credencial: se a key ou o app for revogado, o usuário desconectá-lo ou sair da organização, o webhook é desativado automaticamente (`active: false`, com registro na auditoria). Reativá-lo o vincula à credencial de quem o reativa.",
  "wh.setup.once": "é exibido uma única vez",
  "wh.events.h": "Eventos",
  "wh.events.p": "Assine apenas os que você usa. Tipos novos podem surgir no futuro: ignore os que você não conhece respondendo `2xx`.",
  "wh.col.event": "Evento",
  "wh.col.when": "Quando é enviado",
  "wh.ev.envelope.sent": "O envelope foi enviado (via API, pela web, por um envio em massa, um formulário ou um CRM).",
  "wh.ev.envelope.completed": "Todos assinaram e o PDF selado está pronto para download. `data.envelope.signedSha256` traz o seu hash.",
  "wh.ev.envelope.declined": "O envelope terminou porque alguém recusou. Chega junto com `recipient.declined`; `data.reason` traz o motivo.",
  "wh.ev.envelope.voided": "O remetente anulou o envelope. `data.reason` traz o motivo.",
  "wh.ev.envelope.expired": "`expiresAt` venceu sem que todos tivessem assinado.",
  "wh.ev.recipient.viewed": "Um destinatário abriu o documento. `data.recipientId` indica quem.",
  "wh.ev.recipient.signed": "Um signatário assinou. Se restarem turnos, os seguintes recebem o convite.",
  "wh.ev.recipient.declined": "Um signatário ou aprovador recusou. `data.reason` traz o motivo.",
  "wh.ev.recipient.approved": "Um aprovador (`role: approver`) aprovou.",
  "wh.ev.webhook.test": "Evento de teste enviado com **Enviar teste** ou `POST /v1/webhooks/{id}/test`. `data.envelope` é `null`.",
  "wh.payload.h": "Formato da entrega",
  "wh.payload.p":
    "Cada entrega é um `POST` com corpo JSON e estes cabeçalhos. O corpo traz um **retrato do envelope** no momento do evento, com a sua `metadata` e o estado de cada destinatário, então muitas vezes não é preciso consultar a API.",
  "wh.payload.headers": "Cabeçalhos",
  "wh.payload.body": "Corpo",
  "wh.col.field": "Campo",
  "wh.f.id": "Id único do evento. É o mesmo em todos os seus endpoints e nas novas tentativas: use-o para não processar duas vezes.",
  "wh.f.type": "Tipo de evento.",
  "wh.f.createdAt": "Quando o evento foi gerado.",
  "wh.f.envelope": "Estado do envelope quando o evento foi gerado (`null` em `webhook.test`).",
  "wh.f.recipientId": "Destinatário que originou o evento (`viewed`, `signed`, `approved`, `declined`), quando aplicável.",
  "wh.f.reason": "Motivo da recusa ou da anulação, quando aplicável.",
  "wh.verify.h": "Verificar a assinatura",
  "wh.verify.p":
    "O cabeçalho `CalaSign-Signature` tem a forma `t=<unix>,v1=<hex>`, em que `v1` é `HMAC-SHA256(secret, \"<t>.<corpo>\")` em hexadecimal. Enquanto você rotaciona o segredo, o cabeçalho traz um `v1` por segredo vigente (`t=<unix>,v1=<novo>,v1=<anterior>`). Para verificar:\n\n1. Separe o cabeçalho por vírgulas e leia `t` e todos os `v1`.\n2. Calcule o HMAC com o seu segredo sobre o texto `t`, um ponto e o **corpo bruto**, byte a byte como chegou (não o JSON serializado de novo).\n3. Compare-o em tempo constante com cada `v1`: aceite a entrega se algum coincidir.\n4. Rejeite entregas com `t` de mais de 5 minutos para evitar repetições.",
  "wh.verify.warn":
    "O erro mais comum é verificar o corpo já interpretado: qualquer diferença de espaços ou de ordem das chaves quebra a assinatura. Configure o seu framework para entregar o corpo bruto nesta rota (`express.raw`, `request.get_data()`, `request.body` sem parsear).",
  "wh.c.raw": "corpo BRUTO, exatamente como chegou",
  "wh.c.async": "processar fora da requisicao",
  "wh.c.multi": "durante uma rotação chegam vários v1: aceite se algum coincidir",
  "wh.retries.h": "Novas tentativas",
  "wh.retries.p":
    "Uma entrega conta como bem-sucedida se o seu servidor responder **2xx em menos de 10 segundos**. Qualquer outro código, um redirecionamento, um erro de rede ou um timeout é uma falha e é tentado novamente com espera crescente, até **8 tentativas** no total:",
  "wh.col.attempt": "Tentativa",
  "wh.col.wait": "Espera desde a anterior",
  "wh.retries.immediate": "imediata",
  "wh.retries.after":
    "Após a última tentativa a entrega fica `failed`. Você pode ver cada entrega (código de resposta, primeiros caracteres da resposta, erro, próxima tentativa) e reenviá-la manualmente em **Configurações → Integrações** ou com `POST /v1/webhook-deliveries/{id}/retry`. Se você pausar um endpoint, as entregas pendentes são marcadas como falhas.",
  "wh.receive.h": "Boas práticas ao receber",
  "wh.receive.p":
    "- **Responda rápido.** Verifique a assinatura, salve o evento e responda `200`; processe depois em uma fila. Se você demorar mais de 10 segundos, a CalaSign conta como falha e tenta novamente.\n- **Idempotência.** Um mesmo evento pode chegar mais de uma vez (novas tentativas, redes instáveis). Guarde `id` (também vem em `CalaSign-Event-Id`) e descarte os repetidos.\n- **Sem ordem garantida.** Os eventos são entregues de forma independente: `recipient.signed` pode chegar depois de `envelope.completed`. Use `createdAt` e, na dúvida, consulte o estado atual com `GET /v1/envelopes/{id}`.\n- **Eventos desconhecidos.** Responda `2xx` aos tipos que você não trata.\n- **Rotação do segredo.** Use `POST /v1/webhooks/{id}/rotate-secret`: ele retorna o segredo novo e, durante `graceHours` (24 por padrão), cada entrega vai assinada com os dois, assim você troca o segredo no seu servidor sem perder eventos.",
  "wh.test.h": "Testar",
  "wh.test.p":
    "Envie um evento `webhook.test` para um endpoint para testar a conectividade e a verificação da assinatura. Em desenvolvimento, você pode expor seu servidor local com um túnel (ngrok, Cloudflare Tunnel) ou usar um serviço de inspeção de requisições.",
  "wh.test.deliveries.h": "Histórico de entregas",
  "wh.test.deliveries.p": "As entregas recentes de cada endpoint, com seu estado (`pending`, `succeeded`, `failed`), tentativas, último código HTTP e erro.",
  // ───────── Erros, idempotência, paginação, limites ─────────
  "err.title": "Erros, idempotência e limites",
  "err.lead": "Como a API responde quando algo dá errado, como tentar novamente sem duplicar, como percorrer listas longas e quantas requisições você pode fazer.",
  "err.format.h": "Formato dos erros",
  "err.format.p":
    "Todas as respostas de erro de `/v1` têm o mesmo formato: um `code` estável em inglês para o seu código, uma `message` legível e, às vezes, `details` com informações estruturadas. Programe com base em `code` e no status HTTP, nunca em `message`.",
  "err.format.lang":
    "As `message` estão em espanhol e podem mudar de redação. Os endpoints OAuth (`/oauth/*`) usam o formato da RFC 6749 no lugar: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "err.codes.h": "Códigos frequentes",
  "err.col.meaning": "O que significa e o que fazer",
  "err.c.validation": "O corpo não respeita o esquema. `details[]` traz `path` e `message` de cada problema. Não tente novamente sem corrigir.",
  "err.c.invalidId": "Um id da rota não é um UUID válido.",
  "err.c.bad": "Outros erros da requisição, com um `code` específico (cursor inválido, texto âncora não encontrado, campo fora da página…).",
  "err.c.unauthorized": "A credencial está ausente, é inválida, expirou ou foi revogada.",
  "err.c.plan":
    "A organização atingiu um limite do seu plano ou a funcionalidade não está incluída. `details` traz `plan`, o limite ou a funcionalidade, `suggestedPlan` e `upgradeUrl`. As leituras nunca são bloqueadas por plano.",
  "err.c.forbidden": "O papel da credencial não tem a permissão (`details.permission`) ou falta um scope ao token OAuth (`details.requiredScope`).",
  "err.c.notFound": "O recurso não existe ou pertence a outra organização.",
  "err.c.conflict": "O estado do recurso não permite a operação: por exemplo, modificar um envelope que não é mais rascunho ou anular um já encerrado.",
  "err.c.idem": "Você reutilizou uma `Idempotency-Key` com outro corpo, ou a requisição original ainda está sendo processada (tente novamente em alguns segundos).",
  "err.c.tooLarge": "O arquivo excede o tamanho máximo.",
  "err.c.unprocessable": "A requisição é válida, mas não pode ser processada com esses dados (faltam papéis do modelo, linhas inválidas, PDF pesado demais para buscar âncoras).",
  "err.c.rate": "Você excedeu o limite de requisições por IP (sem código próprio). Aguarde o tempo indicado no cabeçalho `retry-after` (segundos) e tente novamente.",
  "err.c.rateBiz":
    "Limite de negócio com código próprio (`reminded_recently`, `form_rate_limited`, `workflow_rate_limited`, `ai_signer_limit`, `ai_budget_exceeded`, `too_many_comments`, `too_many_proposals`, `archive_recently_renewed`, `too_many_attempts`). Não traz `retry-after`: não tente novamente em loop; avise o usuário ou tente bem mais tarde.",
  "err.c.internal": "Erro nosso. É seguro tentar novamente com espera crescente; se você usa `Idempotency-Key`, nada é duplicado.",
  "err.codes.retry":
    "**O que tentar novamente:** erros de rede, o `429` do limite por IP (com `retry-after`) e `5xx`, com espera exponencial e um pouco de aleatoriedade. **O que não:** os `429` com código próprio (limites de negócio, sem `retry-after`) e os demais `4xx`, que não vão mudar se você repetir a mesma requisição.",
  "err.idem.h": "Idempotência",
  "err.idem.p":
    "Se uma requisição de criação é interrompida (timeout, rede), você não sabe se ela chegou. Envie o cabeçalho `Idempotency-Key` com um valor único por operação —por exemplo, o id do pedido no seu sistema— e tente novamente com o mesmo valor: a CalaSign executa a operação uma única vez e devolve às novas tentativas a resposta guardada, com o cabeçalho `idempotent-replay: true`.",
  "err.idem.rules":
    "- Aplica-se em `POST /v1/envelopes`, `POST /v1/envelopes/{id}/send`, `POST /v1/envelopes/from-template`, `POST /v1/envelopes/from-template/{templateId}`, `POST /v1/bulk-sends` e `POST /v1/crm/mappings/{id}/send`. Nos demais endpoints o cabeçalho é ignorado.\n- A chave vale por credencial (API key, app OAuth ou usuário) e tem até 200 caracteres.\n- Mesma chave com outro corpo ou outra rota: `409 idempotency_mismatch`.\n- Se a primeira requisição ainda estiver sendo processada: `409 idempotency_in_progress`; tente novamente em alguns segundos.\n- Se a requisição original falhou com erro, a chave é liberada e você pode tentar de novo.\n- Os SDKs adicionam uma chave automaticamente.",
  "err.page.h": "Paginação",
  "err.page.p":
    "`GET /v1/envelopes` pagina por **cursor**, do mais recente ao mais antigo. `limit` vai de 1 a 100 (padrão 25). Se houver mais resultados, a resposta traz `nextCursor`: passe-o como `cursor` para pedir a página seguinte; quando for `null`, você terminou. O cursor é opaco: não o construa nem o modifique. Filtros: `status` (um ou vários separados por vírgula) e `q` (busca no assunto e no nome ou e-mail dos destinatários).",
  "err.page.iter.h": "Percorrer todas as páginas",
  "err.rate.h": "Limites de requisições",
  "err.rate.p":
    "Os limites são contados **por endereço IP** em janelas de um minuto. O limite geral é de 600 requisições por minuto para o conjunto da API; alguns endpoints têm um limite próprio, contado à parte. Cada resposta traz `x-ratelimit-limit`, `x-ratelimit-remaining` e `x-ratelimit-reset`; ao excedê-lo, a resposta é `429` com `retry-after`.",
  "err.col.route": "Rota",
  "err.col.limit": "Limite por IP",
  "err.rate.tip":
    "Para acompanhar o estado de muitos envelopes, use [webhooks](/developers/webhooks) em vez de consultar em loop. Se você precisa de limites maiores, fale com a gente.",
  // ───────── SDKs ─────────
  "sdk.title": "SDKs",
  "sdk.lead":
    "SDKs oficiais para Python e Node.js, sem dependências externas. Eles resolvem a parte tediosa: autenticação (incluindo a renovação de tokens OAuth), novas tentativas seguras, paginação e verificação de webhooks. Para qualquer outra linguagem, gere um cliente a partir da especificação OpenAPI.",
  "sdk.notPublished":
    "Os SDKs ainda não estão publicados no PyPI nem no npm: são instalados a partir do código-fonte da CalaSign (pastas `sdks/python` e `packages/sdk-node`). A API é estável; quando forem publicados, só muda o comando de instalação.",
  "sdk.col.feature": "Característica",
  "sdk.f.deps": "Requisitos",
  "sdk.f.py.deps": "Python ≥ 3.8, apenas a biblioteca padrão",
  "sdk.f.node.deps": "Node.js ≥ 18 (fetch nativo), com tipos",
  "sdk.f.auth": "Autenticação",
  "sdk.f.retries": "Novas tentativas",
  "sdk.f.retries.v": "Rede, 429 (respeita Retry-After) e 5xx, backoff exponencial, 3 por padrão",
  "sdk.f.idem": "Idempotency-Key automática",
  "sdk.f.errors": "Erros",
  "sdk.install": "Instalação",
  "sdk.py.h": "Python",
  "sdk.node.h": "Node.js",
  "sdk.c.any": "qualquer outro endpoint, com a mesma autenticacao e novas tentativas",
  "sdk.methods.h": "Métodos",
  "sdk.m.verify": "Verificar um webhook",
  "sdk.openapi.h": "Qualquer linguagem com OpenAPI",
  "sdk.openapi.p":
    "A especificação OpenAPI 3.1 em [`/v1/openapi.json`](/v1/openapi.json) descreve todos os endpoints com seus esquemas de requisição e resposta, parâmetros, erros e scopes. Use-a com qualquer gerador de clientes, para importar a API no Postman ou no Insomnia, ou para validar suas requisições nos testes.",
  "sdk.openapi.import": "Importar → Link / URL:",
  // ───────── IA e agentes ─────────
  "ai.title": "IA e agentes",
  "ai.lead":
    "Conecte assistentes de IA à CalaSign para consultar o estado dos seus envelopes, preparar envios a partir de um modelo e baixar documentos assinados conversando. Tudo passa pelo **servidor MCP** da CalaSign (Model Context Protocol), com as mesmas permissões, limites e evidência da API.",
  "ai.cards.h": "Integrações",
  "ai.card.mcp.t": "Servidor MCP",
  "ai.card.mcp.d": "Uma URL para qualquer cliente MCP: OAuth automático ou API key.",
  "ai.card.mcp.a": "Ver ferramentas",
  "ai.card.claude.d": "Conector personalizado no claude.ai e no Claude Desktop, com login OAuth.",
  "ai.card.claude.a": "Adicionar conector",
  "ai.card.desktop.t": "Extensão do Claude Desktop",
  "ai.card.desktop.d": "Arquivo `.mcpb`: clique duas vezes, cole sua API key e pronto.",
  "ai.card.code.d": "Um comando para adicionar o servidor, ou o plugin com a skill incluída.",
  "ai.card.code.a": "Ver comandos",
  "ai.card.skill.t": "Agent Skill",
  "ai.card.skill.d": "Ensina ao Claude o fluxo da CalaSign: modelos, confirmações e boas práticas.",
  "ai.card.gpt.d": "Servidor MCP personalizado no ChatGPT e ferramenta MCP na API de Responses.",
  "ai.card.gpt.a": "Conectar o ChatGPT",
  "ai.card.gem.d": "Gemini CLI (comando ou extensão) e a API do Gemini com uma sessão MCP.",
  "ai.card.gem.a": "Extensão .zip",
  "ai.card.office.t": "Word e Outlook",
  "ai.card.office.d": "Suplemento para enviar para assinatura o documento aberto no Word ou um PDF anexado no Outlook.",
  "ai.how.h": "Como funciona",
  "ai.how.p":
    "O agente conversa com `{{MCP_URL}}` e a CalaSign executa cada ferramenta chamando a sua própria API com **a credencial do agente**. Por isso:\n\n- O agente pode exatamente o que a sua credencial pode: o papel da API key ou, com OAuth, os scopes que a pessoa aprovou e o próprio papel dela.\n- Valem os mesmos limites do plano e as mesmas validações da API.\n- Cada ação fica na evidência do envelope com o ator «agente IA (<cliente>)».\n- Enviar e anular exigem `confirm: true`: sem isso a ferramenta retorna um resumo para que a pessoa aprove.",
  "ai.how.tip":
    "Para testar, use o ambiente de testes: os e-mails e mensagens de WhatsApp disparados pelo agente ficam na Caixa dev, sem chegar a ninguém.",
  "ai.c.prompt": "Quais envelopes tenho pendentes de assinatura?",
  // ───────── Servidor MCP ─────────
  "mcp.title": "Servidor MCP",
  "mcp.lead":
    "Servidor remoto de [Model Context Protocol](https://modelcontextprotocol.io) para que agentes de IA trabalhem com a CalaSign. Funciona com Claude, ChatGPT, Gemini, o MCP Inspector e qualquer cliente que fale Streamable HTTP.",
  "mcp.connect.h": "Conexão",
  "mcp.col.prop": "Propriedade",
  "mcp.col.value": "Valor",
  "mcp.transport": "Transporte",
  "mcp.transport.v": "Streamable HTTP, sem sessão: cada `POST` é independente e a resposta é JSON. `GET` e `DELETE` respondem 405.",
  "mcp.auth.row": "Autenticação",
  "mcp.auth.row.v": "OAuth 2.1 (descoberta + registro dinâmico) ou `Authorization: Bearer <API key>`",
  "mcp.plan": "Plano",
  "mcp.plan.v": "Starter ou superior (acesso via API). Sem ele, `402 plan_limit`.",
  "mcp.connect.p": "Limite: 300 requisições por minuto por IP.",
  "mcp.auth.h": "Autenticação",
  "mcp.auth.p":
    "**OAuth (recomendado para pessoas).** O cliente descobre tudo sozinho: a primeira requisição sem credencial recebe `401` com o link para os metadados, o cliente se registra com [registro dinâmico](/developers/authentication#dynamic-registration), abre a tela de consentimento da CalaSign e a pessoa escolhe o que permitir. Peça `offline_access` para não precisar fazer login de novo a cada hora.\n\n**API key (scripts e ambientes sem navegador).** Envie `Authorization: Bearer cs_test_…`. O agente age com o papel dessa key: para um agente, convém uma key com papel `member` ou um papel personalizado, não `admin`.",
  "mcp.auth.401": "Resposta sem credencial",
  "mcp.tools.h": "Ferramentas",
  "mcp.tools.p": "Todas retornam JSON resumido pensado para um modelo (ids, estados, nomes) em vez do detalhe completo da API.",
  "mcp.col.tool": "Ferramenta",
  "mcp.col.does": "O que faz",
  "mcp.col.confirm": "Confirmação",
  "mcp.tool.list_envelopes": "Lista os envelopes, do mais recente ao mais antigo. Filtros: `status`, `query` (assunto ou destinatário), `limit` (até 50) e `cursor`.",
  "mcp.tool.get_envelope": "Detalhe de um envelope: documentos, destinatários e seu estado.",
  "mcp.tool.get_signing_status": "Quem assinou, quem falta, quem recusou e os últimos eventos da evidência.",
  "mcp.tool.list_templates": "Modelos disponíveis com seus papéis (para criar envelopes a partir de modelo).",
  "mcp.tool.create_envelope_from_template": "Cria um envelope em **rascunho** a partir de um modelo, com uma pessoa por papel e valores de campos opcionais. Não envia nada.",
  "mcp.tool.send_envelope": "Envia um rascunho: os signatários recebem os convites.",
  "mcp.tool.void_envelope": "Anula um envelope em andamento com um motivo; os signatários recebem o aviso.",
  "mcp.tool.download_signed_pdf": "Retorna uma URL temporária (15 minutos) para baixar o PDF selado de um envelope concluído, com o seu SHA-256.",
  "mcp.tool.create_envelope": "Cria um envelope em **rascunho** a partir de um PDF (em base64 ou de uma URL https), com seus destinatários. Não envia nada.",
  "mcp.tool.remind_recipients": "Reenvia o convite aos signatários pendentes do turno atual.",
  "mcp.tool.get_account": "Dados da conta: organização, usuário ou credencial, plano e uso do mês.",
  "mcp.safety.h": "Modelo de segurança",
  "mcp.safety.p":
    "- **Confirmação explícita.** As ferramentas com efeito para fora (enviar, anular, lembrar) exigem `confirm: true`. Sem esse parâmetro não fazem nada e retornam um resumo (assunto, destinatários) com a instrução de mostrá-lo à pessoa e pedir a aprovação dela. As instruções do servidor pedem o mesmo ao modelo.\n- **Rascunhos primeiro.** Criar um envelope nunca o envia: a pessoa revisa antes.\n- **Permissões restritas.** O agente nunca pode mais do que a sua credencial. Com OAuth, a pessoa vê e aprova os scopes; você pode revogar o acesso a qualquer momento em **Configurações → Apps OAuth** (apps conectados).\n- **Evidência.** Cada ação fica registrada como «agente IA (<nome do cliente>) — <credencial>» na cadeia de evidência do envelope e no certificado de conclusão.\n- **Downloads temporários.** O PDF assinado é entregue com um link que expira em 15 minutos, não como conteúdo na conversa.\n- **Conteúdo não confiável.** O texto de um documento ou de um assunto pode conter instruções maliciosas. Peça ao seu agente que não execute ações a partir do conteúdo dos documentos sem confirmar com a pessoa.",
  "mcp.inspector.h": "Testar com o MCP Inspector",
  "mcp.inspector.p":
    "O [MCP Inspector](https://github.com/modelcontextprotocol/inspector) é a ferramenta oficial para testar um servidor MCP: lista as ferramentas, executa-as e mostra as mensagens. Requer Node.js 22 ou superior. Na interface web, escolha o transporte **Streamable HTTP**, cole a URL e adicione o cabeçalho `Authorization`, ou siga o fluxo OAuth. `--header` vai depois da URL.",
  "mcp.inspector.c.ui": "Interface web (http://localhost:6274) com a conexao pre-carregada",
  "mcp.inspector.c.cli": "Modo linha de comando: listar ferramentas",
  "mcp.sdk.h": "A partir do seu próprio agente",
  "mcp.sdk.p": "Com o SDK oficial de MCP para TypeScript (`@modelcontextprotocol/sdk`). Há SDKs equivalentes para Python, Java, C#, Go e outras linguagens.",
  "mcp.sdk.c.approve": "…mostrar o resumo para a pessoa e, se ela aprovar:",
  // ───────── Claude ─────────
  "claude.title": "Claude",
  "claude.lead":
    "Use a CalaSign no claude.ai, no Claude Desktop, no Claude Code ou no seu próprio app com a API do Claude. Escolha a opção conforme onde você trabalha; todas usam o mesmo [servidor MCP](/developers/ai/mcp).",
  "claude.connector.h": "Conector no claude.ai e no Claude Desktop",
  "claude.connector.p":
    "Os conectores personalizados estão disponíveis em todos os planos do Claude (no Free, até um). Eles são adicionados uma vez e ficam disponíveis na web, no Claude Desktop e no app móvel.",
  "claude.connector.s1": "No Claude, abra **Personalizar → Conectores** (*Customize → Connectors*) e escolha **Adicionar conector personalizado** (*Add custom connector*).",
  "claude.connector.s2": "Digite um nome (CalaSign) e cole a URL do servidor:",
  "claude.connector.s3":
    "Na autenticação, mantenha o login com OAuth. Se for pedido para escolher o cliente OAuth, escolha **Registrar automaticamente** (*Register automatically*). Clique em **Adicionar** e depois em **Conectar**.",
  "claude.connector.s4": "A tela de consentimento da CalaSign é aberta: faça login, revise as permissões e aprove. Em cada chat, ative o conector pelo botão **+ → Conectores**.",
  "claude.connector.team":
    "**Team e Enterprise:** primeiro um proprietário da organização o adiciona em **Configurações da organização → Conectores → Adicionar → Personalizado** (*Organization settings → Connectors → Add → Custom*). Depois, cada pessoa o encontra em **Personalizar → Conectores** com o rótulo *Custom*, clica em **Conectar** e faz login com a sua própria conta da CalaSign.",
  "claude.connector.key":
    "Prefere uma API key em vez de OAuth? Algumas organizações veem a opção *Sem login* com **Cabeçalhos da requisição** (*Request headers*, beta): adicione `Authorization` com o valor `Bearer cs_test_…` (incluindo «Bearer »). A autenticação não pode ser alterada depois: para mudá-la, remova o conector e adicione-o novamente.",
  "claude.desktop.h": "Extensão do Claude Desktop (.mcpb)",
  "claude.desktop.p":
    "Se você trabalha no Claude Desktop com uma API key (por exemplo, uma conta de serviço), a extensão `.mcpb` é o mais rápido: é instalada com um clique duplo e guarda a key no armazenamento seguro do sistema operacional.",
  "claude.desktop.s1": "Baixe `calasign.mcpb` e abra-o com um clique duplo (ou arraste-o para **Configurações → Extensões** no Claude Desktop).",
  "claude.desktop.s2": "Na tela de instalação, revise as permissões e cole a sua API key da CalaSign quando for solicitada.",
  "claude.desktop.s3": "Clique em **Instalar** e ative-a. Se a sua organização desativou as extensões, a seção não aparece: use o conector.",
  "claude.code.h": "Claude Code",
  "claude.code.p":
    "Adicione o servidor com um comando. Com OAuth, na primeira vez execute `/mcp` dentro do Claude Code e siga o login no navegador (ou `claude mcp login calasign` pelo terminal). `--scope user` o deixa disponível em todos os seus projetos; `--scope project` o salva em `.mcp.json` para compartilhá-lo com a sua equipe.",
  "claude.code.c.login": "dentro do Claude Code, para fazer login:",
  "claude.plugin.h": "Plugin da CalaSign",
  "claude.plugin.p":
    "O plugin instala de uma vez o servidor MCP e a skill da CalaSign. Digite isto dentro do Claude Code:",
  "claude.skill.h": "Agent Skill",
  "claude.skill.p":
    "A skill ensina ao Claude como trabalhar com a CalaSign: usar modelos, posicionar campos com âncoras, pedir confirmação antes de enviar, interpretar estados e webhooks. Combine-a com o conector ou com o servidor MCP.",
  "claude.skill.install":
    "**No claude.ai:** **Personalizar → Skills → + → Criar skill → Fazer upload de uma skill** (*Customize → Skills → Upload a skill*), escolha o ZIP e ative-a. Requer a execução de código habilitada (**Configurações → Capacidades**; no Enterprise, quem habilita é um proprietário).\n\n**No Claude Code:** descompacte-a em `~/.claude/skills/` (para você) ou em `.claude/skills/` do seu projeto (para a sua equipe). Se você instalou o plugin, já a tem.",
  "claude.api.h": "API do Claude (conector MCP)",
  "claude.api.p":
    "Com a API de Mensagens, o Claude se conecta diretamente ao servidor MCP sem que você implemente um cliente. É preciso o cabeçalho beta `mcp-client-2025-11-20`, o servidor em `mcp_servers` e um `mcp_toolset` em `tools`. Em `authorization_token`, envie um access token OAuth da CalaSign ou uma API key. A sua aplicação é responsável por pedir confirmação antes de enviar ou anular.",
  // ───────── ChatGPT ─────────
  "gpt.title": "ChatGPT",
  "gpt.lead": "Adicione a CalaSign como servidor MCP personalizado no ChatGPT, ou use-a pela API de Responses da OpenAI.",
  "gpt.connector.h": "Servidor MCP personalizado no ChatGPT",
  "gpt.connector.p":
    "Os servidores MCP personalizados são adicionados pela web do ChatGPT. Dependendo do plano, o administrador do espaço de trabalho pode precisar habilitá-los ou criá-los (no Business e no Enterprise/Edu, por exemplo). Os nomes dos menus mudam com frequência: se não os encontrar, procure «MCP» nas configurações ou na central de ajuda da OpenAI.",
  "gpt.connector.s1": "Abra a seção de **Plugins** do ChatGPT (*chatgpt.com/plugins*), clique em **+** e escolha **Adicionar servidor MCP personalizado** (*Add custom MCP server*).",
  "gpt.connector.s2": "Nome: CalaSign. Em **Conexão**, cole a URL do servidor:",
  "gpt.connector.s3": "Autenticação: **OAuth**. O ChatGPT se registra sozinho na CalaSign; aceite o aviso e crie-o.",
  "gpt.connector.s4": "Instale-o, faça login na CalaSign quando for solicitado e aprove as permissões.",
  "gpt.connector.note":
    "O ChatGPT pede confirmação antes de usar ferramentas que modificam dados. Além disso, a CalaSign exige `confirm: true` para enviar ou anular, então nada sai sem a sua aprovação.",
  "gpt.api.h": "API de Responses da OpenAI",
  "gpt.api.p":
    "A ferramenta `mcp` da API de Responses conecta o modelo ao servidor da CalaSign. Em `authorization`, envie um access token OAuth ou uma API key da CalaSign (não é armazenado: envie-o em cada requisição).",
  // ───────── Gemini ─────────
  "gem.title": "Gemini",
  "gem.lead": "Use a CalaSign no Gemini CLI —com um comando ou com a extensão— ou pela API do Gemini com uma sessão MCP.",
  "gem.cli.h": "Gemini CLI",
  "gem.cli.p":
    "`gemini mcp add` salva o servidor em `settings.json` (`--scope user` para todos os seus projetos; por padrão, o projeto atual). Com OAuth, o Gemini CLI detecta que é preciso fazer login, registra-se sozinho e abre o navegador; você também pode forçar isso com `/mcp auth calasign`.",
  "gem.cli.c.login": "dentro do Gemini CLI, para fazer login:",
  "gem.cli.note":
    "O Google substituiu o Gemini CLI pelo Antigravity CLI para contas gratuitas e do Google One. Os passos desta página se aplicam ao Gemini CLI; em outras ferramentas, use a mesma URL com transporte HTTP.",
  "gem.ext.h": "Extensão do Gemini CLI",
  "gem.ext.p":
    "A extensão da CalaSign acrescenta o servidor MCP e um arquivo de contexto com instruções para trabalhar com envelopes e modelos. Baixe-a, descompacte-a e instale-a a partir da pasta (o Gemini CLI instala extensões a partir de um repositório git ou de uma pasta local, não de um ZIP).",
  "gem.api.h": "API do Gemini (google-genai)",
  "gem.api.p":
    "O SDK `google-genai` para Python aceita uma sessão MCP como ferramenta (função experimental). Este exemplo usa o cliente Streamable HTTP do SDK `mcp` 2.x; com `mcp` 1.x, o equivalente é `streamablehttp_client(url, headers={…})`.",
  // ───────── Office ─────────
  "office.title": "Suplemento do Word e do Outlook",
  "office.lead":
    "Envie para assinatura sem sair do Microsoft 365: o documento que você está escrevendo no Word ou um PDF que chegou por e-mail no Outlook.",
  "office.what.h": "O que faz",
  "office.what.p":
    "- **Word:** envia para assinatura o documento que você tem aberto: você escolhe os destinatários no painel lateral e a CalaSign cria e envia o envelope.\n- **Outlook:** ao ler um e-mail, você escolhe um PDF anexado e o envia para assinatura sem baixá-lo.\n- Nos dois casos você faz login com a sua conta da CalaSign, e tudo fica na sua organização como qualquer outro envelope.",
  "office.word.h": "Instalar no Word",
  "office.word.p":
    "Baixe `manifest.xml` e carregue-o como suplemento próprio:\n\n- **Word na web:** **Página Inicial → Suplementos → Mais Configurações → Carregar Meu Suplemento** (*Home → Add-ins → More Settings → Upload My Add-in*), escolha o arquivo e clique em **Carregar**. Ele fica salvo no navegador: se você apagar os dados do site, será preciso carregá-lo de novo.\n- **Word para Mac:** copie o manifesto para `~/Library/Containers/com.microsoft.Word/Data/Documents/wef` (crie a pasta se não existir), reinicie o Word e abra-o em **Página Inicial → Suplementos**.\n- **Word para Windows:** o carregamento individual requer uma pasta compartilhada configurada como catálogo confiável (**Arquivo → Opções → Central de Confiabilidade → Catálogos de Suplementos Confiáveis**). Para equipes, a instalação centralizada (abaixo) é mais simples.",
  "office.outlook.h": "Instalar no Outlook",
  "office.outlook.p":
    "No Outlook na web, no novo Outlook para Windows, no Outlook clássico ou no Mac: abra [aka.ms/olksideload](https://aka.ms/olksideload), vá em **Meus suplementos** (*My add-ins*) e, no final, em **Suplementos personalizados**, escolha **Adicionar um suplemento personalizado → Adicionar do arquivo** (*Add a custom add-in → Add from File*) e selecione `manifest-outlook.xml`. No Outlook clássico, pode demorar para aparecer.",
  "office.admin.h": "Instalação centralizada (administradores)",
  "office.admin.p":
    "Um administrador do Microsoft 365 pode instalá-lo para toda a organização ou para grupos: **Centro de administração do Microsoft 365 → Configurações → Aplicativos integrados** (*Settings → Integrated apps*) → carregar um aplicativo personalizado com o arquivo do manifesto ou com a sua URL, escolher a quem ele é atribuído e **Implantar**. Pode levar de 24 a 72 horas para aparecer para todos.",
  "office.admin.url": "URL do manifesto",
  // ───────── Referência ─────────
  "ref.title": "Referência da API",
  "ref.lead":
    "Todos os endpoints da API v1, gerados ao vivo a partir da especificação OpenAPI servida pelo ambiente. Cada operação mostra seus parâmetros, o corpo da requisição, as respostas e exemplos prontos para copiar.",
  "ref.overview": "Visão geral",
  "ref.spanishNote": "As descrições da referência vêm da especificação OpenAPI, que está em espanhol.",
  "ref.loadError": "Não foi possível carregar a especificação. Tente recarregar a página ou abra /v1/openapi.json.",
  "ref.oneOf": "Valores:",
  "ref.default": "Padrão:",
  "ref.chars": "caracteres",
  "ref.items": "elementos",
  "ref.anyOf": "Aceita uma destas formas:",
  "ref.option": "Opção",
  "ref.freeObject": "Objeto livre (chaves e valores à escolha).",
  "ref.showChildren": "Ver propriedades",
  "ref.public": "Público",
  "ref.sessionOnly": "Somente sessão web",
  "ref.example": "Exemplo",
  "ref.header": "Cabeçalho",
  "ref.description": "Descrição",
  "ref.copyUrl": "Copiar URL",
  "ref.params": "Parâmetros",
  "ref.name": "Nome",
  "ref.in": "Em",
  "ref.type": "Tipo",
  "ref.body": "Corpo da requisição",
  "ref.responses": "Respostas",
  "ref.examples": "Exemplos",
  ...connectorsDocsPt,
};
