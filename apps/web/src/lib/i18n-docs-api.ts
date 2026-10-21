// Textos de la guía "Sincronización y operaciones avanzadas" del portal de desarrolladores (/developers/guides/sync):
// búsqueda avanzada, API de eventos (polling y SSE), datos de formulario, clonado, lote y rotación del secreto de
// webhooks. Archivo aparte para no tocar los diccionarios grandes: se mezclan en i18n-docs*.ts con un spread.

export const docsApiEs = {
  "g.sync.title": "Sincronización y operaciones avanzadas",
  "g.sync.nav": "Sincronización y lote",
  "g.sync.lead":
    "Mantené tu sistema al día con CalaSign aunque se pierda un webhook: búsqueda por fechas y metadata, una API de eventos con cursor (y en vivo por SSE), los datos que completaron los firmantes, clonado de sobres, operaciones en lote y rotación del secreto de los webhooks sin cortar entregas.",
  "g.sync.search.h": "Búsqueda avanzada de sobres",
  "g.sync.search.p":
    "`GET /v1/envelopes` acepta, además de `status` y `q`:\n\n- `created_from` / `created_to`, `sent_from` / `sent_to`, `completed_from` / `completed_to` (ISO 8601; *_from inclusive, *_to exclusivo).\n- `updated_from` (alias `updated_since`) y `updated_to`: cambia con cada cambio de estado del sobre. Para sincronizar, guardá la hora del pedido anterior y pedí los cambios desde ahí.\n- `metadata=clave:valor` o `metadata[clave]=valor` (repetible, hasta 10; tienen que coincidir todos). Compara contra valores string, que es como conviene guardar tus ids.\n- `recipient` (correo, sin distinguir mayúsculas, o teléfono E.164), `template_id` y `created_via` (`api` o `web`).\n\nCada resumen trae `updatedAt` y `metadata`.",
  "g.sync.events.h": "API de eventos (polling con cursor)",
  "g.sync.events.p":
    "`GET /v1/events` devuelve la actividad de la organización del evento más viejo al más nuevo, con los mismos tipos que los webhooks (`envelope.sent`, `recipient.signed`, `envelope.completed`…). Es la red de seguridad de los webhooks: si tu receptor estuvo caído, recorré los eventos desde el último cursor que procesaste.\n\n1. La primera vez, sin `after` (trae las últimas 24 h, o desde `since`).\n2. Procesá `items` y guardá `nextCursor`.\n3. Pedí `?after=<nextCursor>`; con `hasMore: true`, enseguida; si no, en unos segundos.\n\nFiltros: `types` (separados por coma), `envelope_id`, `scope=all` (todos los registros de evidencia: `document.added`, `envelope.reminded`, …) y `limit` (hasta 500). Cada evento trae el sobre con su estado **actual** y su `metadata`. Una API key sin `envelopes:view_all` ve solo los eventos de sus sobres.",
  "g.sync.events.ids":
    "**Cambio (20/10/2026):** el `id` de cada evento pasó de `evt_…` a un UUID, el mismo que el `id` del webhook de ese evento: deduplicá por `id` entre los dos canales. Si guardaste ids viejos, cada evento trae además `legacyId` con el valor anterior (`evt_…`). `legacyId` está **obsoleto** y se va a quitar; usalo solo para migrar lo que ya tenías guardado. Para seguir leyendo, usá siempre `cursor` / `nextCursor`, no el `id`.",
  "g.sync.events.note":
    "Cada evento recibe su lugar en el cursor recién cuando quedó confirmado: así ningún evento queda detrás del cursor, aunque una operación tarde. El cursor es opaco: guardalo tal cual. Puede haber repetidos entre webhooks y eventos: el `id` de un evento es el mismo en los dos canales (y en los reintentos del webhook), así que descartalos por `id`. El `id` no sirve como cursor: para seguir, usá `cursor` o `nextCursor`.",
  "g.sync.stream.h": "Eventos en vivo (SSE)",
  "g.sync.stream.p":
    "`GET /v1/events/stream` mantiene la conexión abierta y manda cada evento como Server-Sent Event: `id:` (el cursor), `event:` (el tipo) y `data:` (el evento en JSON). Retoma desde `after` o el header `Last-Event-ID` (EventSource lo manda solo al reconectar); sin ninguno empieza desde `since` (fecha ISO 8601), o ahora si no lo indicás. La conexión se cierra a los `max_seconds` (entre 60 y 3600; 300 por defecto) con `event: end`. Máximo 5 streams abiertos por organización. Cada minuto se revisa la credencial: si se revoca, la persona deja la organización, cambian sus permisos o el plan ya no incluye la API, el stream termina con `event: end` y `reason: \"unauthorized\"` (al reconectar rige el acceso nuevo). Ideal para tableros y herramientas internas; para integraciones de servidor, preferí webhooks + polling.",
  "g.sync.form.h": "Datos de formulario y adjuntos",
  "g.sync.form.p":
    "`GET /v1/envelopes/{id}/form-data` devuelve lo que completó cada destinatario (texto, número, desplegable, casillas, fecha de firma…) y una vista plana `values` de etiqueta → valor, lista para tu base de datos o tu CRM. Las firmas e iniciales solo informan `filled` (no la imagen); los campos ocultos por la lógica condicional vienen con `hidden: true` y no entran en `values`. Los adjuntos traen tipo, tamaño, hash y `downloadPath`: `GET /v1/envelopes/{id}/attachments/{fieldId}` devuelve el archivo original que subió el firmante.",
  "g.sync.clone.h": "Clonar un sobre",
  "g.sync.clone.p":
    "`POST /v1/envelopes/{id}/clone` crea un borrador nuevo a partir de cualquier sobre (también uno completado, anulado o vencido): mismos documentos, destinatarios (su configuración, no su estado) y campos con su lógica. No copia lo que escribieron los firmantes (salvo `includeValues: true`, que copia los de los tipos que el remitente puede prellenar: texto, número, lista, empresa y cargo), adjuntos, firmas ni el cobro. Opciones: `subject`, `message`, `metadata` (por defecto la del original más `clonedFrom`), `expiresAt`, `includeRecipients` e `includeFields`. Si los originales del sobre ya se borraron por la política de retención (que también se aplica a los sobres anulados, rechazados y vencidos), responde `409 purged`.",
  "g.sync.batch.h": "Operaciones en lote",
  "g.sync.batch.p":
    "`POST /v1/envelopes/batch` aplica `get`, `void` (con `reason`), `remind` o `delete` (solo borradores) a hasta 100 sobres. Cada id corre como su pedido individual —mismos permisos, validaciones y auditoría— y la respuesta trae un resultado por id, en el mismo orden, con `ok`, `status` y `data` o `error`. Un error en uno no corta el resto, así que la respuesta es 200 aunque fallen elementos. Cada elemento cuenta para el límite de pedidos.",
  "g.sync.rotate.h": "Rotar el secreto de un webhook",
  "g.sync.rotate.p":
    "`POST /v1/webhooks/{id}/rotate-secret` devuelve un secreto nuevo (una sola vez). Durante `graceHours` (24 por defecto, máximo 168) cada entrega lleva dos firmas: `CalaSign-Signature: t=…,v1=<nuevo>,v1=<anterior>`. El receptor acepta si alguna coincide, así podés desplegar el secreto nuevo sin perder eventos. `graceHours: 0` invalida el anterior de inmediato (p. ej. si se filtró). Los SDK aceptan cualquier `v1` que coincida desde esta versión; si verificás a mano, recorré todos los `v1` del header.",
};

type DocsApiKey = keyof typeof docsApiEs;

export const docsApiPt: Record<DocsApiKey, string> = {
  "g.sync.title": "Sincronização e operações avançadas",
  "g.sync.nav": "Sincronização e lote",
  "g.sync.lead":
    "Mantenha seu sistema em dia com a CalaSign mesmo que um webhook se perca: busca por datas e metadata, uma API de eventos com cursor (e ao vivo por SSE), os dados preenchidos pelos signatários, clonagem de envelopes, operações em lote e rotação do segredo dos webhooks sem interromper entregas.",
  "g.sync.search.h": "Busca avançada de envelopes",
  "g.sync.search.p":
    "`GET /v1/envelopes` aceita, além de `status` e `q`:\n\n- `created_from` / `created_to`, `sent_from` / `sent_to`, `completed_from` / `completed_to` (ISO 8601; *_from inclusivo, *_to exclusivo).\n- `updated_from` (alias `updated_since`) e `updated_to`: muda a cada mudança de status do envelope. Para sincronizar, guarde a hora da requisição anterior e peça as mudanças a partir dela.\n- `metadata=chave:valor` ou `metadata[chave]=valor` (repetível, até 10; todos precisam coincidir). Compara com valores string, que é como convém guardar seus ids.\n- `recipient` (e-mail, sem diferenciar maiúsculas, ou telefone E.164), `template_id` e `created_via` (`api` ou `web`).\n\nCada resumo traz `updatedAt` e `metadata`.",
  "g.sync.events.h": "API de eventos (polling com cursor)",
  "g.sync.events.p":
    "`GET /v1/events` devolve a atividade da organização do evento mais antigo ao mais novo, com os mesmos tipos dos webhooks (`envelope.sent`, `recipient.signed`, `envelope.completed`…). É a rede de segurança dos webhooks: se o seu receptor ficou fora do ar, percorra os eventos a partir do último cursor processado.\n\n1. Na primeira vez, sem `after` (traz as últimas 24 h, ou a partir de `since`).\n2. Processe `items` e guarde `nextCursor`.\n3. Peça `?after=<nextCursor>`; com `hasMore: true`, em seguida; se não, em alguns segundos.\n\nFiltros: `types` (separados por vírgula), `envelope_id`, `scope=all` (todos os registros de evidência: `document.added`, `envelope.reminded`, …) e `limit` (até 500). Cada evento traz o envelope com seu status **atual** e sua `metadata`. Uma API key sem `envelopes:view_all` vê apenas os eventos dos seus envelopes.",
  "g.sync.events.ids":
    "**Mudança (20/10/2026):** o `id` de cada evento passou de `evt_…` para um UUID, o mesmo `id` do webhook desse evento: deduplique por `id` entre os dois canais. Se você guardou ids antigos, cada evento traz também `legacyId` com o valor anterior (`evt_…`). `legacyId` está **obsoleto** e será removido; use-o só para migrar o que já tinha guardado. Para continuar lendo, use sempre `cursor` / `nextCursor`, não o `id`.",
  "g.sync.events.note":
    "Cada evento recebe seu lugar no cursor só depois de confirmado: assim nenhum evento fica atrás do cursor, mesmo que uma operação demore. O cursor é opaco: guarde-o como está. Pode haver repetidos entre webhooks e eventos: o `id` de um evento é o mesmo nos dois canais (e nas novas tentativas do webhook), então descarte-os pelo `id`. O `id` não serve como cursor: para continuar, use `cursor` ou `nextCursor`.",
  "g.sync.stream.h": "Eventos ao vivo (SSE)",
  "g.sync.stream.p":
    "`GET /v1/events/stream` mantém a conexão aberta e envia cada evento como Server-Sent Event: `id:` (o cursor), `event:` (o tipo) e `data:` (o evento em JSON). Retoma a partir de `after` ou do header `Last-Event-ID` (o EventSource o envia sozinho ao reconectar); sem nenhum, começa a partir de `since` (data ISO 8601), ou agora se você não o indicar. A conexão é fechada após `max_seconds` (entre 60 e 3600; 300 por padrão) com `event: end`. Máximo de 5 streams abertos por organização. A cada minuto a credencial é revisada: se for revogada, a pessoa sair da organização, suas permissões mudarem ou o plano deixar de incluir a API, o stream termina com `event: end` e `reason: \"unauthorized\"` (ao reconectar vale o novo acesso). Ideal para painéis e ferramentas internas; para integrações de servidor, prefira webhooks + polling.",
  "g.sync.form.h": "Dados de formulário e anexos",
  "g.sync.form.p":
    "`GET /v1/envelopes/{id}/form-data` devolve o que cada destinatário preencheu (texto, número, lista, caixas, data da assinatura…) e uma visão plana `values` de rótulo → valor, pronta para o seu banco de dados ou CRM. Assinaturas e rubricas informam apenas `filled` (não a imagem); campos ocultos pela lógica condicional vêm com `hidden: true` e não entram em `values`. Os anexos trazem tipo, tamanho, hash e `downloadPath`: `GET /v1/envelopes/{id}/attachments/{fieldId}` devolve o arquivo original enviado pelo signatário.",
  "g.sync.clone.h": "Clonar um envelope",
  "g.sync.clone.p":
    "`POST /v1/envelopes/{id}/clone` cria um rascunho novo a partir de qualquer envelope (inclusive concluído, anulado ou vencido): mesmos documentos, destinatários (sua configuração, não seu status) e campos com sua lógica. Não copia o que os signatários escreveram (salvo `includeValues: true`, que copia os dos tipos que o remetente pode preencher: texto, número, lista, empresa e cargo), anexos, assinaturas nem a cobrança. Opções: `subject`, `message`, `metadata` (por padrão a do original mais `clonedFrom`), `expiresAt`, `includeRecipients` e `includeFields`. Se os originais do envelope já foram apagados pela política de retenção (que também se aplica a envelopes anulados, recusados e vencidos), retorna `409 purged`.",
  "g.sync.batch.h": "Operações em lote",
  "g.sync.batch.p":
    "`POST /v1/envelopes/batch` aplica `get`, `void` (com `reason`), `remind` ou `delete` (só rascunhos) a até 100 envelopes. Cada id roda como sua requisição individual —mesmas permissões, validações e auditoria— e a resposta traz um resultado por id, na mesma ordem, com `ok`, `status` e `data` ou `error`. Um erro em um não interrompe o resto, então a resposta é 200 mesmo que alguns elementos falhem. Cada elemento conta para o limite de requisições.",
  "g.sync.rotate.h": "Rotacionar o segredo de um webhook",
  "g.sync.rotate.p":
    "`POST /v1/webhooks/{id}/rotate-secret` devolve um segredo novo (uma única vez). Durante `graceHours` (24 por padrão, máximo 168) cada entrega leva duas assinaturas: `CalaSign-Signature: t=…,v1=<novo>,v1=<anterior>`. O receptor aceita se alguma coincidir, assim você implanta o segredo novo sem perder eventos. `graceHours: 0` invalida o anterior imediatamente (p. ex. se vazou). Os SDKs aceitam qualquer `v1` que coincida a partir desta versão; se você verifica manualmente, percorra todos os `v1` do header.",
};

export const docsApiEn: Record<DocsApiKey, string> = {
  "g.sync.title": "Sync and advanced operations",
  "g.sync.nav": "Sync and batch",
  "g.sync.lead":
    "Keep your system in sync with CalaSign even if a webhook gets lost: search by dates and metadata, a cursor-based events API (and live over SSE), the data signers filled in, envelope cloning, batch operations and webhook secret rotation without dropping deliveries.",
  "g.sync.search.h": "Advanced envelope search",
  "g.sync.search.p":
    "Besides `status` and `q`, `GET /v1/envelopes` accepts:\n\n- `created_from` / `created_to`, `sent_from` / `sent_to`, `completed_from` / `completed_to` (ISO 8601; *_from inclusive, *_to exclusive).\n- `updated_from` (alias `updated_since`) and `updated_to`: changes on every envelope status change. To sync, store the time of your previous request and ask for changes since then.\n- `metadata=key:value` or `metadata[key]=value` (repeatable, up to 10; all must match). Compared against string values, which is how you should store your ids.\n- `recipient` (email, case-insensitive, or E.164 phone), `template_id` and `created_via` (`api` or `web`).\n\nEach summary includes `updatedAt` and `metadata`.",
  "g.sync.events.h": "Events API (cursor polling)",
  "g.sync.events.p":
    "`GET /v1/events` returns the organization's activity from oldest to newest, with the same types as webhooks (`envelope.sent`, `recipient.signed`, `envelope.completed`…). It is the safety net for webhooks: if your receiver was down, walk the events from the last cursor you processed.\n\n1. The first time, without `after` (returns the last 24 h, or since `since`).\n2. Process `items` and store `nextCursor`.\n3. Request `?after=<nextCursor>`; with `hasMore: true`, right away; otherwise, in a few seconds.\n\nFilters: `types` (comma-separated), `envelope_id`, `scope=all` (every evidence record: `document.added`, `envelope.reminded`, …) and `limit` (up to 500). Each event carries the envelope with its **current** status and `metadata`. An API key without `envelopes:view_all` only sees events for its own envelopes.",
  "g.sync.events.ids":
    "**Change (2026-10-20):** each event's `id` changed from `evt_…` to a UUID, the same as the `id` of that event's webhook: deduplicate by `id` across both channels. If you stored old ids, each event also carries `legacyId` with the previous value (`evt_…`). `legacyId` is **deprecated** and will be removed; use it only to migrate what you already stored. To keep reading, always use `cursor` / `nextCursor`, not the `id`.",
  "g.sync.events.note":
    "Each event gets its place in the cursor only once it has committed, so no event ever ends up behind the cursor, even if an operation is slow. The cursor is opaque: store it as is. Webhooks and events may overlap: an event has the same `id` on both channels (and across webhook retries), so dedupe by `id`. The `id` is not a cursor: to continue, use `cursor` or `nextCursor`.",
  "g.sync.stream.h": "Live events (SSE)",
  "g.sync.stream.p":
    "`GET /v1/events/stream` keeps the connection open and sends each event as a Server-Sent Event: `id:` (the cursor), `event:` (the type) and `data:` (the event as JSON). It resumes from `after` or the `Last-Event-ID` header (EventSource sends it automatically on reconnect); with neither, it starts from `since` (ISO 8601 date), or now if you omit it. The connection closes after `max_seconds` (between 60 and 3600; 300 by default) with `event: end`. Up to 5 open streams per organization. The credential is rechecked every minute: if it is revoked, the person leaves the organization, their permissions change or the plan no longer includes the API, the stream ends with `event: end` and `reason: \"unauthorized\"` (reconnecting applies the new access). Great for dashboards and internal tools; for server integrations prefer webhooks + polling.",
  "g.sync.form.h": "Form data and attachments",
  "g.sync.form.p":
    "`GET /v1/envelopes/{id}/form-data` returns what each recipient filled in (text, number, dropdown, checkboxes, signing date…) plus a flat `values` map of label → value, ready for your database or CRM. Signatures and initials only report `filled` (not the image); fields hidden by conditional logic come with `hidden: true` and are left out of `values`. Attachments include type, size, hash and `downloadPath`: `GET /v1/envelopes/{id}/attachments/{fieldId}` returns the original file the signer uploaded.",
  "g.sync.clone.h": "Clone an envelope",
  "g.sync.clone.p":
    "`POST /v1/envelopes/{id}/clone` creates a new draft from any envelope (including completed, voided or expired ones): same documents, recipients (their settings, not their status) and fields with their logic. It does not copy what signers typed (unless `includeValues: true`, which copies the values of the types a sender can prefill: text, number, dropdown, company and title), attachments, signatures or the payment. Options: `subject`, `message`, `metadata` (by default the original's plus `clonedFrom`), `expiresAt`, `includeRecipients` and `includeFields`. If the envelope's originals were already deleted by the retention policy (which also applies to voided, declined and expired envelopes), it returns `409 purged`.",
  "g.sync.batch.h": "Batch operations",
  "g.sync.batch.p":
    "`POST /v1/envelopes/batch` applies `get`, `void` (with `reason`), `remind` or `delete` (drafts only) to up to 100 envelopes. Each id runs as its own request —same permissions, validations and audit log— and the response has one result per id, in the same order, with `ok`, `status` and `data` or `error`. One failure doesn't stop the rest, so the response is 200 even if some items fail. Each item counts towards the rate limit.",
  "g.sync.rotate.h": "Rotate a webhook secret",
  "g.sync.rotate.p":
    "`POST /v1/webhooks/{id}/rotate-secret` returns a new secret (only once). For `graceHours` (24 by default, 168 max) every delivery carries two signatures: `CalaSign-Signature: t=…,v1=<new>,v1=<previous>`. Receivers accept if any matches, so you can roll out the new secret without losing events. `graceHours: 0` revokes the previous one immediately (e.g. if it leaked). The SDKs accept any matching `v1` as of this version; if you verify by hand, check every `v1` in the header.",
};
