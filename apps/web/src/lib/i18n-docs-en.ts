// English for the developer portal. See i18n-docs.ts.
import type { DocsKey } from "./i18n-docs";
import { connectorsDocsEn } from "./i18n-docs-connectors";
import { docsApiEn } from "./i18n-docs-api";

export const docsEn: Record<DocsKey, string> = {
  ...docsApiEn,
  // ───────── Interface ─────────
  "ui.docs": "Docs",
  "ui.searchPlaceholder": "Search the docs…",
  "ui.searchLabel": "Search",
  "ui.searchEmpty": "No results for “{q}”.",
  "ui.searchHint": "Pages, sections and endpoints",
  "ui.searchEndpoints": "Endpoints",
  "ui.searchPages": "Pages",
  "ui.menu": "Docs menu",
  "ui.closeMenu": "Close menu",
  "ui.onThisPage": "On this page",
  "ui.copy": "Copy",
  "ui.copied": "Copied",
  "ui.copyCode": "Copy code",
  "ui.linkTo": "Link to this section",
  "ui.prev": "Previous",
  "ui.next": "Next",
  "ui.openApp": "Go to the app",
  "ui.getKey": "Create API key",
  "ui.theme": "Theme",
  "ui.themeAuto": "Automatic",
  "ui.themeLight": "Light",
  "ui.themeDark": "Dark",
  "ui.skip": "Skip to content",
  "ui.notFound": "We couldn't find that docs page.",
  "ui.backHome": "Back to the docs home",
  "ui.new": "New",
  "ui.download": "Download",
  "ui.required": "required",
  "ui.optional": "optional",
  "ui.yes": "Yes",
  "ui.no": "No",
  // ───────── Navigation ─────────
  "nav.start": "Get started",
  "nav.guides": "Guides",
  "nav.platform": "Platform",
  "nav.reference": "API reference",
  "nav.ai": "AI and agents",
  // ───────── Introduction ─────────
  "intro.title": "Developer documentation",
  "intro.nav": "Introduction",
  "intro.lead":
    "The CalaSign REST API lets you send documents for signature, track every signature in real time and download the sealed PDF with its evidence, all from your own system. It's the same API the CalaSign web app uses: anything you can do in the app can be automated.",
  "intro.build.h": "What you can build",
  "intro.build.send.t": "Send for signature from your system",
  "intro.build.send.d": "Create an envelope with one or more PDFs, add signers by email, WhatsApp or Telegram, and send it with a couple of HTTP requests.",
  "intro.build.embed.t": "Signing inside your app",
  "intro.build.embed.d": "Show the signing ceremony in an iframe in your application, without the signer ever leaving your product.",
  "intro.build.webhooks.t": "React to every event",
  "intro.build.webhooks.d": "Receive an HMAC-signed POST when someone opens, signs or declines, and when the envelope is completed.",
  "intro.build.templates.t": "Templates, bulk send and web forms",
  "intro.build.templates.d": "Prepare the document once and reuse it: from the API, in bulk via CSV, or with a public link.",
  "intro.build.ai.t": "AI agents",
  "intro.build.ai.d": "Connect Claude, ChatGPT or Gemini to the CalaSign MCP server to query and send envelopes conversationally.",
  "intro.build.xml.t": "E-invoice signing",
  "intro.build.xml.d": "Sign XML with the DGII (e-CF), DIAN and SUNAT profiles using your organization's certificate.",
  "intro.base.h": "Base URL and format",
  "intro.base.p": "All requests go over HTTPS to the same origin as the web app. The API lives under `/v1`.",
  "intro.base.col.what": "What",
  "intro.base.col.url": "URL",
  "intro.base.api": "REST API v1",
  "intro.base.spec": "OpenAPI 3.1 specification",
  "intro.base.mcp": "MCP server (AI agents)",
  "intro.base.oauth": "OAuth 2.0",
  "intro.base.conventions":
    "- JSON bodies (UTF-8) with `Content-Type: application/json`; PDFs are uploaded as `multipart/form-data`.\n- UUID identifiers, ISO 8601 dates in UTC (`2026-03-01T14:30:00.000Z`).\n- Authentication with `Authorization: Bearer <API key or access token>` (see [Authentication](/developers/authentication)).\n- Errors always have the same shape: `{ \"error\": { \"code\", \"message\", \"details\" } }` (see [Errors](/developers/errors)).\n\nA first request to test your credential: it returns your organization.",
  "intro.env.h": "Environments and testing",
  "intro.env.p":
    "**{{BASE}}** is the development and test environment. Create a free account, generate an API key and test at no cost: new organizations in this environment have every feature enabled (API, webhooks, bulk send, simulated payments, simulated identity verification).\n\nAPI keys in this environment start with `cs_test_`; production keys start with `cs_live_`. Each environment has its own accounts, credentials and data: nothing is shared between them.",
  "intro.env.mailbox.t": "Dev mailbox",
  "intro.env.mailbox.p":
    "In the test environment, emails and WhatsApp or SMS messages never leave for the internet: they land in the app's **Dev mailbox** (top menu → *Dev mailbox*, path `/app/dev-mailbox`), with each recipient's signing link. That way you can open the link, sign as if you were the recipient and watch the webhooks arrive, all with made-up addresses.",
  "intro.version.h": "Versioning",
  "intro.version.p":
    "The version is part of the path (`/v1`). Within v1 we add endpoints, optional fields, enum values and event types without bumping the version, so your integration must **ignore fields it doesn't recognize** and not break on a new `status` or event type. A breaking change would ship under a new path version.\n\nThe [`/v1/openapi.json`](/v1/openapi.json) specification always reflects what's deployed: you can generate clients from it (see [SDKs](/developers/sdks)).",
  "intro.next.h": "Next steps",
  "intro.next.p":
    "1. Follow the [quickstart](/developers/quickstart) to send your first envelope in five minutes.\n2. Read the [concepts](/developers/concepts): envelope lifecycle, recipients, fields and evidence.\n3. Set up [webhooks](/developers/webhooks) to hear about every signature without polling the API.\n4. Explore the [full reference](/developers/api) or connect an [AI agent](/developers/ai).",
  // ───────── Quickstart ─────────
  "qs.title": "Quickstart",
  "qs.lead":
    "With **a single call** you create the envelope with the PDF, the signer and the signature field, and send it. Then you wait for the signature and download the signed document. You need `curl` (and `jq`), Node.js 18+ or Python 3.8+, and a test PDF containing the text `[[firma]]`.",
  "qs.key.h": "1. Get an API key",
  "qs.key.p":
    "Create an account at [{{BASE}}/signup]({{BASE}}/signup) (or sign in with yours), go to **Settings → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) and click **Create**. The secret is shown **only once**: store it in a secrets manager or an environment variable, never in your code or your frontend.",
  "qs.one.h": "2. Create and send the envelope in one call",
  "qs.one.p":
    "`POST /v1/envelopes` takes everything at once: the **documents** (`documents`: the PDF as `base64`, by public https `url` or as a `multipart/form-data` part), the **recipients** (`recipients`, same as `PUT /recipients`), the **fields** (`fields`, with anchor text or coordinates) and `send: true` to send it in the same request.\n\nIt is **atomic**: if anything fails (an invalid PDF, anchor text that isn't found, a signer without a signature field) you get the error and no half-built envelope is left behind. Send an `Idempotency-Key` (e.g. your order id) so a retry never creates or sends a second envelope. Without `send`, the envelope stays as a draft (`draft`) to review and send later with `POST /v1/envelopes/{id}/send`.",
  "qs.one.resp":
    "The response is the full envelope, with the `id` of the documents, recipients and fields (you'll see them in webhooks). In the test environment the invitation lands in the app's **Dev mailbox**: open it and sign it yourself. If you don't set `expiresAt`, the envelope expires after 30 days.",
  "qs.one.multipart.t": "Large PDFs: multipart instead of base64",
  "qs.one.multipart.p":
    "With `multipart/form-data` the JSON goes in the `payload` part and each PDF in its own part; the document references it with `file` (without `documents`, each file is a document, in order). This way the PDF doesn't grow 33% from base64. Up to 10 documents per call.",
  "qs.one.refs.t": "Several signers and documents",
  "qs.one.refs.p":
    "Since recipients and documents don't have an `id` yet, each field references them with `recipient` (its position in `recipients` starting at 0, its `ref` or its email) and `document` (its position in `documents` or its `ref`). With a single signer or a single document they can be omitted; a field with `anchor` and no `document` searches the text in every document.",
  "qs.fields.coords.t": "Your PDF has no anchor text?",
  "qs.fields.coords.p":
    "Use normalized coordinates: `page` starts at 0 and `x`, `y`, `width`, `height` go from 0 to 1 with the origin at the top left of the page. With several documents, set `document`.",
  "qs.one.embedded.t": "Embedded signing in your app",
  "qs.one.embedded.p":
    "If a recipient has `embedded: true` (signs inside your application, no invitation), the response of a send includes `signingUrls`: the single-use signing URL (5 minutes) of each embedded signer whose turn it is, with no extra call. `embeddedSigning` accepts `returnUrl` and `frameAncestors`. See the [embedded signing guide](/developers/guides/embedded-signing).",
  "qs.one.template.t": "From a template, also in one call",
  "qs.one.template.p":
    "If the document and fields already live in a [template](/developers/guides/templates), `POST /v1/envelopes/from-template` creates the envelope assigning a person to each role and, with `send: true`, sends it in the same request. It also accepts `Idempotency-Key`.",
  "qs.wait.h": "3. Wait for the signature",
  "qs.wait.p":
    "The recommended way is a [webhook](/developers/webhooks): register an https URL in **Settings → Integrations** and CalaSign notifies you with a signed POST on every event. When the last person signs, the envelope goes through `finalizing` (the PDF is assembled and sealed) and then `envelope.completed` arrives.\n\nIf you'd rather poll, call `GET /v1/envelopes/{id}` periodically (no more than once a minute per envelope) until `envelope.status` is `completed`, `declined`, `voided` or `expired`.",
  "qs.download.h": "4. Download the signed PDF",
  "qs.download.p":
    "Once the envelope is `completed`, `signed.pdf` returns the final PDF: the documents with the signatures stamped on them, the **completion certificate** at the end and the platform's PAdES seal. Before completion it returns 404. Also save `signedSha256` so you can verify it later.",
  "qs.full.h": "Full script",
  "qs.full.p":
    "Everything together, ready to copy: one call to create and send, the wait and the download. The `contrato.pdf` PDF must contain the text `[[firma]]`.",
  "qs.full.next":
    "What next? Use [templates](/developers/guides/templates) to avoid placing fields by hand, [embedded signing](/developers/guides/embedded-signing) to sign inside your app, or review the [concepts](/developers/concepts).",
  "qs.steps.h": "Step by step (several calls)",
  "qs.steps.p":
    "If you'd rather build the envelope gradually (for instance, so someone reviews it in the app before sending), the same data can be sent in separate calls: create the draft, upload each PDF, set the recipients, place the fields and send. Each step validates its own part and the envelope stays in `draft` until it's sent.",
  "qs.create.h": "a. Create the draft",
  "qs.create.p":
    "An **envelope** groups documents, recipients and fields. With just `subject` (and optionally `message`, `metadata`, `expiresAt`…) it starts as an empty draft (`draft`). Use `metadata` to store your own identifiers (they come back in every webhook; keys set by the system, such as `workflowRunId`, `webFormId`, `bulkSendId`, `crm` or `clonedFrom`, can't be set) and send an `Idempotency-Key` so a retry doesn't create a duplicate envelope.",
  "qs.create.resp": "Save `envelope.id`: you'll use it in the next steps.",
  "qs.upload.h": "b. Upload the PDF",
  "qs.upload.p":
    "Send the file as `multipart/form-data` in the `file` field. You can upload several PDFs to the same envelope: they're signed in the order you uploaded them. The response contains the document `id`, its page count and its SHA-256.",
  "qs.recipients.h": "c. Add the signer",
  "qs.recipients.p":
    "`PUT /recipients` replaces the whole list. By default each recipient is a `signer`, gets the invitation by `email` and has `routingOrder: 1`. With a `phone` in E.164 format you can also notify them via WhatsApp. You can send your own `id` (UUID) to reference the recipient from fields without reading the response; otherwise, take it from `recipients[].id`.",
  "qs.fields.h": "d. Place the fields",
  "qs.fields.p":
    "Every signer needs at least one field. The simplest way is an **anchor text**: write `[[firma]]` in the PDF (it can be white on white) and CalaSign places the field wherever it appears. `offsetX`, `offsetY`, `width` and `height` are in PDF points, relative to the top-left corner of the text. Replace `RECIPIENT_ID` with the signer's id.",
  "qs.send.h": "e. Send it",
  "qs.send.p":
    "Sending validates the documents, recipients and fields; the envelope moves to `sent` and the signers in the first routing step get their invitation. In the test environment the invitation lands in the app's **Dev mailbox**: open it and sign it yourself.",
  "qs.c.one": "Complete envelope in one call: PDF, signer, signature field on [[firma]] and send",
  "qs.c.multipart": "Same without base64: the JSON in the payload part and the PDF in its own part",
  "qs.c.noBase64": "the PDF goes without base64",
  "qs.c.wait": "Wait for the signature (better with a webhook)",
  "qs.c.download": "Download the signed PDF",
  "qs.c.sdkIdem": "the SDK adds the Idempotency-Key automatically",
  // ───────── Authentication ─────────
  "auth.title": "Authentication",
  "auth.lead":
    "Every API request carries `Authorization: Bearer <credential>`. The credential can be an API key for your organization or an OAuth 2.0 access token. API access (keys, OAuth and MCP) is included from the Starter plan up.",
  "auth.cmp.method": "Credential",
  "auth.cmp.when": "When to use it",
  "auth.cmp.format": "Format",
  "auth.cmp.key": "Your own backend integrated with your own organization. The simplest option.",
  "auth.cmp.cc": "Service-to-service with narrow scopes and tokens that expire after 1 hour.",
  "auth.cmp.code": "An app that acts on behalf of users in other organizations (marketplace, AI agents).",
  "auth.keys.h": "API keys",
  "auth.keys.p":
    "Create them in **Settings → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) or with `POST /v1/api-keys` from a session. The full secret is shown **only once**; after that you only see its prefix (the first 12 characters) and the last-used date.\n\n- Format: `cs_test_…` in the test environment and `cs_live_…` in production.\n- Each key belongs to the organization and has a **role** (`admin`, `member` or a custom role) that defines what it can do; nobody can create a key with more permissions than their own. To create webhooks or integrations (triggers, storage, CRM) the key also needs `envelopes:view_all`, like the `admin` role.\n- Envelopes created with a key are recorded as created via the API (`createdVia: \"api\"`) and the evidence names the key as the actor.",
  "auth.keys.rotate.h": "Rotation and revocation",
  "auth.keys.rotate.p":
    "Keys don't expire. To rotate one: create a new key, deploy it to your system, check in the list that the old one is no longer used (*last used*) and revoke it with **Revoke** or `DELETE /v1/api-keys/{id}`. Revocation is immediate: the next request with that key gets `401 unauthorized`.",
  "auth.keys.warn":
    "An API key grants access to the whole organization according to its role. Never put it in a mobile app, in browser JavaScript or in a repository. If a key leaks, revoke it right away.",
  "auth.oauth.h": "OAuth 2.0",
  "auth.oauth.p":
    "Register an application in **Settings → OAuth apps** ([`/app/settings/oauth-apps`](/app/settings/oauth-apps)) or with `POST /v1/oauth/apps`. You get a `client_id` (`csapp_…`) and, if the app is **confidential**, a `client_secret` (`cssec_…`, shown once; it can be rotated). A **public** app (desktop, mobile, SPA) has no secret and can only use authorization code with PKCE.\n\nTokens are opaque: the `csat_…` access token is valid for **1 hour**, the `csrt_…` refresh token for **30 days** and the authorization code for **10 minutes**. Errors from `/oauth/*` follow RFC 6749: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "auth.ep.endpoint": "Endpoint",
  "auth.ep.use": "Purpose",
  "auth.ep.authorize": "Consent screen in the browser (authorization code + PKCE).",
  "auth.ep.token": "Issue tokens: `authorization_code`, `client_credentials` and `refresh_token`. Body is `application/x-www-form-urlencoded` (JSON is also accepted).",
  "auth.ep.revoke": "Revoke a token (RFC 7009). Revoking a refresh token revokes the whole authorization. An unknown token or one from another app also returns 200.",
  "auth.ep.introspect": "Check whether a token is active (RFC 7662). Confidential clients only, and only tokens from the same app.",
  "auth.ep.register": "Dynamic client registration (RFC 7591), designed for AI agents and MCP clients.",
  "auth.code.h": "Authorization code + PKCE",
  "auth.code.p":
    "To act on behalf of a person: redirect them to the CalaSign consent screen, where they sign in if needed and approve the scopes, and they come back to your `redirect_uri` with `code` and `state`. **PKCE with S256 is required**, even for confidential clients. The `redirect_uri` must exactly match a registered one.\n\nThe client authenticates with HTTP Basic (`client_id:client_secret`) or with `client_id` and `client_secret` in the body. A public client sends only `client_id`.",
  "auth.code.c.pkce": "PKCE: random verifier and its S256 challenge",
  "auth.code.c.redirect": "Redirect the person to the consent screen",
  "auth.code.c.exchange": "In your callback: check state and exchange the code",
  "auth.code.c.callback": "received in the callback",
  "auth.code.c.public": "omit for a public client",
  "auth.code.after":
    "If the person declines, they come back with `error=access_denied`. If you requested `offline_access` you also get a `refresh_token`. A code can be exchanged only once: if it's reused, CalaSign revokes the tokens issued with it.",
  "auth.cc.h": "Client credentials",
  "auth.cc.p":
    "For server-to-server integrations with no person present. When you register the app with the `client_credentials` grant it's assigned a role (`member` by default) that works as a service identity. There's no refresh token: request a new token when the current one expires (`expires_in` = 3600). If you omit `scope` you get every scope enabled for the app (without `offline_access`).",
  "auth.refresh.h": "Token refresh and rotation",
  "auth.refresh.p":
    "Every use of a refresh token returns an access token **and a new refresh token**; the previous one stops working and the previous access token from the same authorization is revoked. Always store the latest refresh token you received. You can request fewer scopes than the original ones, never more.",
  "auth.refresh.warn":
    "If an already-exchanged refresh token shows up again, CalaSign treats it as stolen and revokes the **entire** authorization: the person has to approve the app again. Avoid refreshing in parallel from several processes with the same refresh token.",
  "auth.scopes.h": "Scopes",
  "auth.scopes.p":
    "Scopes limit what a token can do, on top of the user's or app's role: a token can never do more than the person who approved it. Request only the ones you need. An endpoint outside the token's scopes returns `403 insufficient_scope` with `details.requiredScope`.",
  "auth.scopes.col.desc": "Allows",
  "auth.dcr.h": "Dynamic client registration",
  "auth.dcr.p":
    "MCP clients (Claude, ChatGPT, Gemini CLI, the MCP Inspector) register themselves with `POST /oauth/register` (RFC 7591), without anyone having to create an app by hand. Registration requires no authentication and creates a client that can only use `authorization_code` + `refresh_token`.",
  "auth.dcr.req": "Request",
  "auth.dcr.resp": "Response",
  "auth.dcr.rules":
    "- `token_endpoint_auth_method`: `none` (public client, the norm for agents and desktop apps), `client_secret_post` or `client_secret_basic`. With the last two the response includes `client_secret`, shown only once.\n- `redirect_uris`: only `https://…` or loopback addresses (`http://127.0.0.1:<port>/…`, `http://localhost:<port>/…`).\n- PKCE with `S256` is required for every authorization.\n- The registered client has access to nothing until a person approves it on the consent screen.",
  "auth.resource.h": "Resource indicators (RFC 8707)",
  "auth.resource.p":
    "MCP clients send the `resource` parameter with the MCP server URL (`{{MCP_URL}}`) to `/oauth/authorize` and `/oauth/token`, to request a token meant for that resource. CalaSign accepts it in both steps; you don't need to send it if you call the REST API directly.",
  "auth.discovery.h": "Discovery",
  "auth.discovery.p":
    "Standard metadata lets a client configure OAuth from nothing but the MCP server URL. When a request to `/mcp` arrives without a credential, the `401` response carries `WWW-Authenticate: Bearer resource_metadata=\"…\"` pointing to these documents.",
  "auth.disc.prm": "Protected resource metadata (RFC 9728): resource, authorization server and scopes.",
  "auth.disc.as": "Authorization server metadata (RFC 8414): endpoints, grants, authentication methods and PKCE.",
  // ───────── Concepts ─────────
  "concepts.title": "Concepts",
  "concepts.lead": "The CalaSign model on one page: envelopes, recipients, documents, fields, templates and the evidence behind every signature.",
  "concepts.col.meaning": "Meaning",
  "concepts.lifecycle.h": "Envelope lifecycle",
  "concepts.lifecycle.p":
    "An **envelope** is the unit you send for signature: one or more PDFs, their recipients and each recipient's fields. While it's in `draft` everything can be changed; once sent it can only be [corrected](/developers/guides/reminders#corrections) within certain limits.",
  "concepts.lifecycle.alt.t": "Envelope statuses",
  "concepts.lifecycle.alt.d":
    "draft moves to sent when sent. From sent it can move to finalizing when everyone has signed, to awaiting_certificates if certificate signatures are pending, or end in declined, expired or voided. finalizing ends in completed. awaiting_certificates goes back to finalizing or can be voided.",
  "concepts.lifecycle.caption": "Final statuses: completed, declined, voided and expired.",
  "concepts.status.draft": "Draft. Documents, recipients, fields and options can be changed. It can be deleted.",
  "concepts.status.sent": "Sent and in progress: recipients in the current routing step have their invitation.",
  "concepts.status.finalizing":
    "Everyone has signed. CalaSign is assembling the final PDF, the completion certificate and the seal. It usually takes seconds; then it moves to `completed`. If an `after_sign` payment is pending, the envelope waits for the payment before this step.",
  "concepts.status.completed": "Done. The sealed PDF is available at `GET /v1/envelopes/{id}/signed.pdf` and `signedSha256` holds its hash.",
  "concepts.status.declined": "A signer or approver declined. The reason is in `recipients[].declineReason`.",
  "concepts.status.voided": "The sender voided it (`POST /v1/envelopes/{id}/void`) with a reason. Pending recipients are notified.",
  "concepts.status.expired": "`expiresAt` was reached before everyone signed. By default an envelope expires 30 days after it's created.",
  "concepts.status.awaiting_certificates":
    "Everyone has signed electronically and the [digital certificate signatures](/developers/guides/certificate-signing) are still pending. Can be voided.",
  "concepts.recipients.h": "Recipients and roles",
  "concepts.recipients.p":
    "A **recipient** is a person with a role. They don't need a CalaSign account: they get a personal link by email, WhatsApp or Telegram (or sign inside your app with [embedded signing](/developers/guides/embedded-signing)). An envelope can have up to 50 recipients.",
  "concepts.role.signer": "Signs and fills in their fields. This is the default role. It's the only role that can have fields.",
  "concepts.role.approver": "Reviews and approves (or declines) without fields on the document. Triggers the `recipient.approved` event.",
  "concepts.role.cc": "Gets a copy of the signed document when the envelope is completed. Doesn't sign or approve.",
  "concepts.rstatus.h": "Recipient status",
  "concepts.rstatus.created": "It's not their turn yet (waiting for their `routingOrder` step) or the envelope is a draft.",
  "concepts.rstatus.sent": "Received the invitation.",
  "concepts.rstatus.viewed": "Opened the link.",
  "concepts.rstatus.signed": "Signed (or approved, for an `approver`).",
  "concepts.rstatus.declined": "Declined; the envelope moves to `declined`.",
  "concepts.rstatus.completed": "Copy recipient (`cc`) who has already received the final document.",
  "concepts.rstatus.delegated": "Delegated signing to someone else (if the envelope allows it with `allowDelegation`). `replacedBy` points to the new recipient.",
  "concepts.rstatus.reassigned": "The sender replaced them with someone else. `replacedBy` points to the new recipient.",
  "concepts.channels.h": "Notification channels",
  "concepts.channels.p":
    "`channels` defines how the invitation is delivered: {channels}. `email` requires `email`; `whatsapp` requires `phone` in E.164 format (`+5491122334455`); `telegram` requires `telegramChatId` or, if you don't have it, another channel to send the linking link. With `embedded: true` or `inPerson` the recipient gets no invitations. `locale` (`es`, `pt-BR`, `en`) sets the language of the messages and the signing page.",
  "concepts.routing.h": "Signing order",
  "concepts.routing.p":
    "`routingOrder` (1 to 100) defines the routing steps. All recipients with the same number get the invitation at the same time (**parallel** signing); the next step only starts once the previous one is finished (**sequential** signing). Combine numbers to build mixed flows. Copy recipients (`cc`) get the document at the end, regardless of their number.",
  "concepts.routing.example": "Internal approval, then two signers in parallel and a copy",
  "concepts.documents.h": "Documents",
  "concepts.documents.p":
    "An envelope has one or more PDFs (`POST /v1/envelopes/{id}/documents`, multipart, `file` field). CalaSign normalizes each file on upload and stores two hashes in the evidence: the original file's and the normalized file's, which is the one displayed and signed. That way what the signer sees is exactly what they sign. The document details include `pageCount`, the size of each page (`pages[]`, in points) and `sha256`.",
  "concepts.fields.h": "Fields",
  "concepts.fields.p":
    "Fields are placed on the document with normalized coordinates — `page` from 0 and `x`, `y`, `width`, `height` between 0 and 1 with the origin at the top-left — or with an [anchor text](/developers/guides/anchors). `PUT /v1/envelopes/{id}/fields` replaces all fields (up to 500). Each field belongs to a signer (`recipientId`) and is required unless `required: false`. The sender can prefill it with `value` and lock it with `readOnly: true`.",
  "concepts.field.signature": "Signature (drawn or typed by the signer).",
  "concepts.field.initials": "Initials.",
  "concepts.field.date_signed": "Signing date. Filled in by CalaSign at signing.",
  "concepts.field.name": "Recipient's name. Filled in by CalaSign.",
  "concepts.field.email": "Recipient's email. Filled in by CalaSign.",
  "concepts.field.text": "Free text. Can be prefilled.",
  "concepts.field.checkbox": "Checkbox.",
  "concepts.field.number": "Number, with an optional range (`min`, `max`) or calculated with `formula`. Can be prefilled.",
  "concepts.field.dropdown": "Dropdown list: requires `options` (up to 50). Can be prefilled.",
  "concepts.field.company": "Company. Can be prefilled.",
  "concepts.field.title": "Job title. Can be prefilled.",
  "concepts.field.attachment": "The signer attaches a file (PDF, PNG or JPEG, up to 10 MB).",
  "concepts.logic.h": "Conditional and calculated fields",
  "concepts.logic.p":
    "`conditions` (up to 10, all must be met) shows a field — and requires it, if it's required — only based on another field's value: operators `equals`, `not_equals`, `checked`, `unchecked` and `filled`, referencing the other field's `id` (which is why sending your own ids is a good idea). The referenced field must be read-only, belong to the same recipient, or belong to someone who signs **earlier**: otherwise the condition would be decided with a value that doesn't exist yet and saving returns `422 logic_order`. `formula` calculates a `number` field from other number fields referenced by label: `{Precio} * {Cantidad} * 1.18`.",
  "concepts.templates.h": "Templates",
  "concepts.templates.p":
    "A **template** stores documents, fields and **roles** (for example “Customer” and “Company”) without specific people. When you use it with `POST /v1/envelopes/from-template` you assign a person to each role, can prefill fields by label and send in the same request. It's the foundation for [bulk send](/developers/guides/bulk-send), [web forms](/developers/guides/web-forms), CRM integrations and the `create_envelope_from_template` MCP tool. See the [templates guide](/developers/guides/templates).",
  "concepts.evidence.h": "Evidence and completion certificate",
  "concepts.evidence.p":
    "Every action on an envelope (creation, sending, opening, consent, signing, declining, voiding…) is recorded as an event with actor, IP, user agent and timestamp, **hash-chained** to the previous one: if anyone tampered with an event, the chain would no longer verify. Query it with `GET /v1/envelopes/{id}/events` (each event includes its `hash`).\n\nOn completion, the final PDF includes a **completion certificate**: participants, authentication method, IPs and times of each step, document hashes and the evidence chain summary.",
  "concepts.evidence.agent":
    "Actions taken by an AI agent through the [MCP server](/developers/ai/mcp) appear in the evidence with the actor “AI agent (<client name>)”, followed by the credential it used.",
  "concepts.pades.h": "PAdES seal",
  "concepts.pades.p":
    "The final PDF carries a digital signature from the platform in **PAdES** format (a CAdES signature embedded in the PDF), with the seal key in an HSM/KMS. Any PDF reader can check that the file hasn't changed since it was sealed. The level is chosen per organization (`PATCH /v1/settings/evidence`; `auto` by default) and an organization can add its own **company seal** with its certificate (`PUT /v1/envelopes/{id}/seal-options`). Later layers are added as incremental revisions, without touching what's already signed.",
  "concepts.pades.col.level": "Level",
  "concepts.pades.col.adds": "What it adds",
  "concepts.pades.bb": "Basic signature with the seal certificate.",
  "concepts.pades.bt": "RFC 3161 timestamp from a timestamping authority: proves when it was signed.",
  "concepts.pades.blt": "Embedded certificates, OCSP and CRLs: it can be validated even if the CA no longer responds.",
  "concepts.pades.blta": "Document timestamp protecting everything above; renewed before it expires for long-term archiving.",
  "concepts.verify.h": "Verification",
  "concepts.verify.p":
    "Anyone can check a document on the public [`/verify`](/verify) page, no account needed: CalaSign looks up the file's SHA-256 among the documents it sealed and shows the organization, the participants, the seal and the status of the evidence chain; it also validates every signature in the PDF (integrity, timestamp, certificate chain and revocation). Via the API: `POST /v1/verify` (hash lookup) and `POST /v1/validate` (signature validation), both public and taking `multipart` with a `file` field. If it couldn't be determined whether some certificate was revoked (no OCSP/CRL in the PDF and no online check, or only OCSP “unknown” responses), `POST /v1/validate` flags it with `revocationUnknown` (per signature, in `chain`, and in `summary`).",
  // ───────── Guide: templates ─────────
  "g.tpl.title": "Sending with templates",
  "g.tpl.lead":
    "If you always send the same document, set it up once as a template — in the app (**Templates**) or via the API — and then create each envelope with a single request, specifying only the people and the data that change.",
  "g.tpl.roles.h": "Templates and roles",
  "g.tpl.roles.p":
    "A template is built just like an envelope: `POST /v1/templates` (name, default subject and message), `POST /v1/templates/{id}/documents` for each PDF, `PUT /v1/templates/{id}/roles` and `PUT /v1/templates/{id}/fields` (fields use `roleId` instead of `recipientId`). You can also turn an existing envelope into a template with `POST /v1/templates/from-envelope/{envelopeId}`.\n\n**Roles** are the slots that real people fill later. They have a `name`, a `role` (`signer`, `approver` or `cc`) and a `routingOrder`.\n\nDeleting a template also deletes its web forms: if any of them still accepts submissions (active, not expired or used up), `DELETE /v1/templates/{id}` returns `409 template_has_forms` with their names in `details.names`.",
  "g.tpl.roles.list": "To use a template you need its `id` and the names of its roles: both come in the list.",
  "g.tpl.send.h": "Create an envelope from a template",
  "g.tpl.send.p":
    "`POST /v1/envelopes/from-template` copies documents, fields and roles, assigns each recipient to their role (by `role`, the name, case-insensitive, or by `roleId`) and returns the new envelope's details. Every role must have a person: if any is missing, the response is `422 roles_missing`. With `send: true` the envelope is sent in the same request; without it, it stays as a draft so you can review it or add a payment.",
  "g.tpl.send.idem":
    "This endpoint accepts `Idempotency-Key`: send a unique key per envelope and, if you retry after a timeout or a 5xx with the same key and the same body, you get the envelope already created instead of creating (and sending) another one.",
  "g.tpl.prefill.h": "Prefilling fields",
  "g.tpl.prefill.p":
    "`prefill` is an object `{ \"key\": \"value\" }` where the key is the `id` of a template field or its **label** (`label`, case-insensitive). If several fields share a label, they're all filled in. A key that doesn't match any field returns `400 unknown_prefill`. Fields marked `readOnly` in the template are locked for the signer.",
  // ───────── Guide: embedded signing ─────────
  "g.embed.title": "Embedded signing",
  "g.embed.lead":
    "Show the signing experience inside your application, in an iframe, for people already signed in to your product. The recipient gets no emails: your backend requests a single-use URL each time the person is about to sign.",
  "g.embed.s1": "Authorize the origins of your app that can display the iframe.",
  "g.embed.s2": "Mark the recipient with `embedded: true` and send the envelope.",
  "g.embed.s3": "When the person is about to sign, your backend requests a signing URL (expires in 5 minutes, single use).",
  "g.embed.s4": "Your frontend opens it in an iframe and listens for events via `postMessage`.",
  "g.embed.origins.h": "1. Authorize origins",
  "g.embed.origins.p":
    "The signing page can only be framed from origins your organization authorizes (applied as the CSP `frame-ancestors`). Add them in **Settings → Integrations → Embedded signing** or via the API: up to 20 `https://domain[:port]` origins without a path, with subdomain wildcards (`https://*.yourcompany.com`). In the local environment `http://localhost` is allowed.",
  "g.embed.recipient.h": "2. Embedded recipient",
  "g.embed.recipient.p":
    "With `embedded: true` the recipient gets no invitations or reminders and needs no `email` or `phone` (you can still send them so they appear in the evidence). Send the envelope as usual. An embedded recipient can't use an OTP code (an `otp_*` `authMethod` returns `400 validation_error`: your application authenticates them) or delegate signing.",
  "g.embed.url.h": "3. Request the signing URL",
  "g.embed.url.p":
    "Request it **right before** showing it: it expires after 5 minutes and is consumed when opened. The envelope must have been sent (otherwise `409 not_available`). If it isn't yet the recipient's turn according to `routingOrder`, they can open the document but can only sign when their turn comes. `returnUrl` (optional, https) is where the iframe is redirected when done, with `?event=signing_complete|declined&envelopeId=…`. `frameAncestors` (optional) restricts this session to a subset of the authorized origins. A non-embedded recipient only gets a URL if the page still asks them to authenticate (OTP code, in-person, or pending ID verification); if they only have the emailed link it returns `409 not_embedded`. For a non-embedded recipient with an OTP code, the URL comes back with `tabOnly: true`: it works in a tab or a redirect (it returns to `returnUrl` when done), not inside an iframe; requesting it with `frameAncestors` returns `409 otp_not_embeddable`.",
  "g.embed.iframe.h": "4. Show it in an iframe",
  "g.embed.iframe.p":
    "Always check the message origin. Use the origin of the URL you received: if your organization has a [custom domain](/developers/guides/custom-domain), the URL uses that domain.",
  "g.embed.events.h": "postMessage events",
  "g.embed.ev.viewed": "The person opened the document.",
  "g.embed.ev.complete": "They signed (or approved). You also get the `recipient.signed` webhook.",
  "g.embed.ev.declined": "They declined the document.",
  "g.embed.ev.error": "The link is invalid or has expired: request a new URL.",
  "g.embed.ev.closed":
    "The envelope ended without this person signing or declining: it was voided, expired, declined by another recipient, or was already completed. Includes `status` with the envelope status (`voided`, `expired`, `declined` or `completed`). It does not redirect to the `returnUrl`.",
  "g.embed.events.p":
    "Each message is `{ source: \"calasign\", type, envelopeId, recipientId }` (plus `status` on `closed`) and is sent only once per type. Treat browser events as a UI signal: the business confirmation is the [webhooks](/developers/webhooks), which are signed.",
  "g.embed.security":
    "With embedded signing, **your application** is what authenticates the person: the evidence records that the session was opened by your integration (“authenticated by the integrator”). Only request the URL for the signed-in person who corresponds to that recipient.",
  // ───────── Guide: anchors ─────────
  "g.anchor.title": "Fields by anchor text",
  "g.anchor.lead":
    "Instead of calculating coordinates, write markers in the document (for example `[[firma_cliente]]`) and let CalaSign place the fields. Ideal for PDFs generated by your system.",
  "g.anchor.how.h": "How it works",
  "g.anchor.how.p":
    "In `PUT /v1/envelopes/{id}/fields`, a field can carry `anchor` instead of `page`/`x`/`y`. CalaSign searches the documents for the text and creates **one field per occurrence**. You can mix anchor and coordinate fields in the same request. All the field's properties (`required`, `label`, `value`, `readOnly`, `options`, `min`, `max`, `conditions`, `formula`) are copied to each generated field.",
  "g.anchor.options.h": "Options",
  "g.anchor.col.prop": "Property",
  "g.anchor.col.default": "Default",
  "g.anchor.o.text": "Text to search for (1 to 100 characters).",
  "g.anchor.o.size": "Field size in PDF points (1 pt = 1/72 inch). Required.",
  "g.anchor.o.offset": "Offset in points from the top-left corner of the matched text. Negative = up or to the left.",
  "g.anchor.o.case": "Case-sensitive matching.",
  "g.anchor.o.ignore": "If `false` and the text isn't found, the request fails with `400 anchor_not_found`. With `true` the field simply isn't created.",
  "g.anchor.o.alldocs": "all",
  "g.anchor.o.doc": "Search only in that document.",
  "g.anchor.tips.h": "Tips",
  "g.anchor.tips.p":
    "- Use unique markers that are hard to confuse: `[[firma_1]]`, `\\s1\\`. Text that appears in the body of the contract would create extra fields.\n- You can write the marker white on a white background or in a very small font size: it's still text and is found all the same.\n- A scanned PDF (image only) has no text: there you need coordinates.\n- Generated fields come back in the response with their normalized coordinates: save them if you want to reuse them.\n- Very heavy PDFs can return `422 pdf_too_heavy`; if the reader is busy, `503 pdf_reader_busy` (retry).",
  // ───────── Guide: bulk send ─────────
  "g.bulk.title": "Bulk send",
  "g.bulk.lead":
    "Send the same template to hundreds of people — up to 5,000 rows per send — and CalaSign creates and sends one envelope per row in the background. Available from the Business plan up.",
  "g.bulk.csv.h": "With a CSV",
  "g.bulk.csv.p":
    "Download the template's sample CSV: it has one column per data point for each role (`Role.name`, `Role.email`, `Role.phone`, `Role.channels`) and one per prefillable field (`field.Label`), plus an optional per-row `subject`. In `channels`, separate multiple channels with `;`.",
  "g.bulk.validate":
    "Before sending you can validate without creating anything using `POST /v1/bulk-sends/validate` (same body): it returns `{ total, valid, invalid, errors: [{ row, errors }], columns }`. On creation, if there are invalid rows the response is `422 rows_invalid` with the same details, unless you send `skipInvalid: true`: then the valid rows are sent and the others are marked as failed. Validation also warns, without rejecting, about duplicate rows (`duplicates`: same recipients and prefill as an earlier one) and how many envelopes are left in this month's quota (`quotaRemaining`): if the valid rows don't fit in the quota, creating the send returns `402 plan_limit` without creating anything. Repeated columns or an unclosed quote return `422 invalid_csv`.",
  "g.bulk.json.h": "With JSON rows",
  "g.bulk.json.p": "Instead of `csv` you can send `rows` (one or the other). Each row accepts recipients by role, `prefill`, its own `subject` and `metadata`, which is stored on the envelope and comes back to you in webhooks.",
  "g.bulk.track.h": "Tracking",
  "g.bulk.track.p":
    "The response is the bulk send with its status (`queued`, `running`, `completed`, `cancelled`) and counters (`total`, `sent`, `failed`, `retryable`, `pending`). Query `GET /v1/bulk-sends/{id}`, get per-row details with `GET /v1/bulk-sends/{id}/items` (filterable by `status`) or download `results.csv`. `POST /v1/bulk-sends/{id}/cancel` stops the rows that haven't been processed yet. If the monthly quota runs out during the send, the remaining rows are marked as failed; `POST /v1/bulk-sends/{id}/retry-failed` requeues rows that failed because of the quota, the template or an internal error (rows with invalid data must be fixed in a new send). Each envelope created fires its own webhooks.",
  // ───────── Guide: web forms ─────────
  "g.forms.title": "Web forms",
  "g.forms.lead":
    "A public link (`/f/<slug>`) where anyone fills in their details and signs a document from a template: customer onboarding, consents, registrations. Each use creates an envelope. Available from the Business plan up.",
  "g.forms.create.h": "Create the form",
  "g.forms.create.p":
    "Choose the template and the **role taken by whoever fills in the form** (`signerRoleId`): it must be a signer role in the template's first routing step and have no fixed recipient (otherwise `400 invalid_role`). The other roles are covered with `fixedRecipients` (for example, your company's representative). Options: `prefill`, `lockPrefill` (prefilled values for whoever fills in the form become read-only; off by default), `maxUses`, `expiresAt`, `requireOtp` (asks for an email code before showing the document), `collectPhone` and `embeddable` (can be shown in an iframe from your authorized origins). An `embeddable` form can't use `requireOtp` (the verification isn't kept inside an iframe): `400 invalid_form`.",
  "g.forms.share.h": "Share and track it",
  "g.forms.share.p":
    "The response contains `url`, the public link to share. `GET /v1/web-forms/{id}/envelopes` lists the envelopes it generated and `uses` counts the uses. To pause it, `PATCH /v1/web-forms/{id}` with `active: false`. If its creator leaves the organization or loses access to the template, the form stops creating envelopes and `ownerInactiveReason` explains why. **Each public submission creates and sends an envelope that counts toward your plan's monthly quota.** Limits: 60 envelopes per hour per form and 100 per hour / 500 per day across all of the organization's forms (after that, `429 form_rate_limited`); the same email from the same IP on the same form within 10 minutes doesn't create another envelope, unless the previous one was voided or declined (`429 form_recent_submission`). With `lockPrefill: true`, what you prefill with `prefill` for the role of the person filling in the form is read-only (otherwise they're suggested values that person can correct). Without `requireOtp` the email isn't verified: that person gets no notifications nor the final copy by email, they download it from the signing page. Editing a form requires the plan; deactivating it (`active: false`) doesn't.",
  // ───────── Guide: reminders ─────────
  "g.rem.title": "Reminders, expiration and corrections",
  "g.rem.lead": "How to follow up with people who haven't signed, when an envelope expires and what can be changed after sending it.",
  "g.rem.auto.h": "Automatic reminders",
  "g.rem.auto.p":
    "When creating or editing the draft: `reminderEveryDays` (1 to 60) resends the invitation every N days to those whose turn is pending; `expiryWarningDays` sends a warning N days before expiration; `allowDelegation` lets the signer delegate to someone else. `null` disables each option.",
  "g.rem.manual.h": "Manual reminder",
  "g.rem.manual.p":
    "`POST /v1/envelopes/{id}/remind` immediately resends the invitation to pending recipients in the current routing step and returns how many were notified. At most one manual reminder every 10 minutes per envelope: sooner returns `429 reminded_recently`. If the envelope is in `awaiting_certificates`, it notifies the certificate signer whose turn it is. An envelope that isn't in progress returns `409 not_in_progress`.",
  "g.rem.exp.h": "Expiration",
  "g.rem.exp.p":
    "`expiresAt` (ISO 8601 with time zone) sets the signing deadline. If you don't set it, the envelope expires **30 days** after creation. On expiration it moves to `expired` and `envelope.expired` fires. To extend an envelope in progress, use a correction.",
  "g.rem.corr.h": "Corrections and reassignment",
  "g.rem.corr.p":
    "`POST /v1/envelopes/{id}/corrections` changes an in-progress envelope without voiding it: message, expiration, contact details (the previous link is revoked and a new one is sent), new recipients and fields for routing steps that haven't started, and removal of people who haven't opened the envelope yet. Anyone who has already signed can't be changed. `reason` is recorded in the evidence. The corrected envelope is still limited to 50 recipients and 500 fields (otherwise `422 envelope_incomplete`).",
  "g.rem.reassign":
    "To replace a pending recipient with someone else, use reassignment: the original is marked `reassigned` and the new one gets the invitation. An envelope allows at most 20 delegations or reassignments (after that, `409 too_many_replacements`).",
  // ───────── Guide: certificate ─────────
  "g.cert.title": "Digital certificate signing",
  "g.cert.lead":
    "A signer can additionally sign with **their own digital certificate** — USB token or smart card (PKCS#11), a certificate installed in Windows or a `.p12/.pfx` file — for cases that require the holder's digital signature: ICP-Brasil A1/A3, Peru's DNIe, certificates from entities accredited by ONAC (Colombia), INDOTEL (Dominican Republic) or the IP (Honduras).",
  "g.cert.setup.h": "Configure the signer",
  "g.cert.setup.p":
    "Add `signatureType: \"certificate\"` to the recipient (`signer` role only; it can also be set on a template's roles). A certificate signer doesn't need a signature field on the document.",
  "g.cert.flow.h": "How the envelope proceeds",
  "g.cert.flow.p":
    "1. Everyone signs electronically, as usual.\n2. CalaSign assembles the final PDF with the completion certificate and the envelope moves to `awaiting_certificates`. The first certificate signer gets the request.\n3. Each one signs in order with the **CalaSign Signer**, a desktop app downloaded from [`/firmador`](/firmador). The private key never leaves their device: CalaSign sends a hash and receives the signature (PAdES B-T, with a timestamp).\n4. With the last signature the envelope moves to `finalizing`, the platform seal is added and it becomes `completed`.\n\nThe progress of each certificate signature can be queried like this:",
  "g.cert.req.h": "Certificate requirements",
  "g.cert.req.p":
    "- `matchIdDocument`: the certificate must match the signer's `idDocumentNumber` (CPF, national ID, DNI…). It only applies if the recipient has a document number, and requires the chain to reach a trusted root.\n- `allowedIssuers`: accepted parts of the issuer name (for example `ICP-Brasil`, `RENIEC`). Empty = any.\n- `requireQualified`: require a CA from the platform's trust store.\n\nValidity period, key usage (`digitalSignature` or `nonRepudiation`) and not being a CA certificate are also checked. Rejected attempts are recorded in the evidence.",
  // ───────── Guide: identity ─────────
  "g.idv.title": "Authentication and identity verification",
  "g.idv.lead": "By default, having the personal link is enough to sign. You can require more: a one-time code or an identity verification with an ID document and a selfie.",
  "g.idv.auth.h": "One-time code",
  "g.idv.auth.p":
    "The recipient's `authMethod`: `link` (default), `otp_email` (requires `email`), `otp_sms` or `otp_whatsapp` (require `phone`) or `in_person` (signs on the device of a host from your organization, configured with `inPerson`). With OTP, the person must enter a 6-digit code before seeing the document, and the method is recorded in the completion certificate.",
  "g.idv.kyc.h": "Identity verification (KYC)",
  "g.idv.kyc.p":
    "`idVerification` requires identity verification before the documents can be viewed: `provider` (`truora`, `veriff` or `mock` for testing) and `level` (`document`, `document_selfie` or `document_selfie_liveness`). The name and number on the ID document are compared with what you declared (`idDocumentType`, `idDocumentNumber`). Defaults (provider, level, name-match threshold, attempts) are configured with `PATCH /v1/settings/identity`. The result — never the images — can be queried per recipient. Available from the Business plan up.",
  // ───────── Guide: payments ─────────
  "g.pay.title": "Collect payment at signing",
  "g.pay.lead":
    "An envelope can charge one of its signers within the same signing ceremony: deposits, first installments, fees. The payment receipt goes into the completion certificate. Available from the Business plan up.",
  "g.pay.conf.h": "Configure the payment",
  "g.pay.conf.p":
    "Drafts only. `amount` in units (up to 2 decimals), `currency` (`USD`, `BRL`, `COP`, `DOP`, `HNL`, `PEN`, `MXN`, `ARS`, `EUR`), `payerRecipientId` (a signer on the envelope) and `provider`: `stripe`, `mercadopago` or `mock` (testing only). `GET /v1/payments/providers` lists the configured providers. Mercado Pago offers Pix and boleto in Brazil and PSE in Colombia; Stripe charges cards (and Pix on Brazilian accounts).",
  "g.pay.timing.h": "Before or after signing",
  "g.pay.timing.p":
    "- `after_sign` (default): the person signs and then pays. The envelope **is only completed and sealed once the payment is confirmed**.\n- `before_sign`: they can't complete signing until they pay; meanwhile the signing attempt returns `402 payment_required`.\n\nConfirmation only arrives through the provider's verified webhook. If a payment arrives after the envelope is already closed, it's flagged for refund.",
  // ───────── Guide: CRM ─────────
  "g.hrclm.title": "HR, contracts and document management",
  "g.hrclm.providers.h": "Connectors",
  "g.hrclm.flows.h": "Flows and sending from a record",
  "g.hrclm.webhook.h": "Triggering from the source system",
  "g.hrclm.dms.h": "Archiving in document management systems",
  "g.crm.title": "CRM and ERP",
  "g.crm.lead":
    "Native connectors to send for signature from your CRM and write the result back, and to drop the signed PDF into your ERP. Configure them in **Settings → CRM and ERP** ([`/app/settings/crm`](/app/settings/crm)); the full configuration is also available in the API, in the [CRM and ERP](/developers/api/crm-y-erp) section.",
  "g.crm.providers.h": "Providers",
  "g.crm.col.provider": "Provider",
  "g.crm.col.does": "What it does",
  "g.crm.hubspot": "Send for signature from a Deal (associated contacts + properties → template), manually or via webhook when a property changes. On completion it updates a status property and attaches the PDF to the deal.",
  "g.crm.salesforce": "Send from an Opportunity (contact roles + fields). Updates a status field and publishes the PDF as a ContentVersion on the opportunity.",
  "g.crm.zoho":
    "OAuth in any Zoho data center (com, eu, in, com.au, jp, ca…). Send for signature from a **Deal** (primary contact and contact roles) or a **Contact**; in Bigin, from a Pipeline. Updates a status field (e.g. `CalaSign_Status`) and attaches the signed PDF to the record, with a note carrying the hash and the envelope link. A “Send for signature with CalaSign” button on Deals comes with the [Deluge function and extension guide](/integrations/connectors/zoho-crm/calasign-zoho-crm.zip).",
  "g.crm.siigo": "Colombia: finds the customer by a signer's ID number and adds the signed document reference to it.",
  "g.crm.alegra": "Finds the contact by ID number and attaches the PDF; an invoice can also be linked.",
  "g.crm.pipedrive": "OAuth with the company's API domain. Send from a Deal (primary person and participants + fields, including custom fields by key or name) or from a Person. Writes the status to a field of the record (text or single option) and, on completion, uploads the signed PDF to the deal or Person and adds a note with the SHA-256 and the link.",
  "g.crm.pipedrive.h": "Pipedrive",
  "g.crm.pipedrive.p":
    "1. **Settings → CRM and ERP → Pipedrive → Connect with OAuth**: authorize the Pipedrive company; CalaSign stores its API domain.\n2. In Pipedrive, create a custom deal field (or person field, for Person mappings) for the status (e.g. \"CalaSign status\", text or single option with the values you will write).\n3. Create a mapping: type `deal` (or `contact` for a Person), template, recipients (*primary contact* = the deal's person; *contact 1, 2…* = participants), prefill (`value`, `title`, `org_id.name`, or a custom field by its 40-character key or by name) and the status property.\n4. Send with `POST /v1/crm/mappings/{id}/send` (`objectId` = deal or Person id; `companyId` is optional: if you send it, it must be the connection's company, otherwise 409 `company_mismatch`) or from Pipedrive with the **Send for signature with CalaSign** action of the Marketplace app ([zip with the action and the guide](/integrations/connectors/pipedrive/calasign-pipedrive.zip)).",
  "g.crm.rdstation":
    "Brazil. OAuth through the RD Station App Store (CRM API v2). Send from a Deal (negociação: its contacts in order + fields, including custom fields by slug or name). Writes the status to a custom field (text or option) and, on completion, uploads the signed PDF to the deal's files with a note containing the hash and link.",
  "g.crm.rdstation.h": "RD Station CRM",
  "g.crm.rdstation.p":
    "1. **Settings → CRM and ERP → RD Station CRM → Connect with OAuth**: authorize the RD Station account.\n2. In RD Station CRM, create a custom deal field for the status (e.g. \"CalaSign status\", text or option with the values you will write).\n3. Create a mapping: type `deal`, template, recipients (*primary contact* = the deal's first contact; *contact 1, 2…* = the following ones), prefill (`name`, `one_time_price`, `recurrence_price`, or a custom field by slug or name) and the status field.\n4. Send with `POST /v1/crm/mappings/{id}/send` (`objectId` = the deal id, 24 characters).",
  "g.crm.kommo":
    "OAuth per account (Kommo subdomain). Send from a Lead (main contact and other contacts + fields, including custom fields by name, code or id). Writes the status to a lead field (text or list) and, on completion, attaches the signed PDF to the lead (Files API) with a note containing the hash and link.",
  "g.crm.kommo.h": "Kommo",
  "g.crm.kommo.p":
    "1. **Settings → CRM and ERP → Kommo → Connect with OAuth**: authorize the Kommo account; CalaSign stores its subdomain.\n2. In Kommo, create a custom lead field for the status (e.g. \"CalaSign status\", text or list with the options you will write).\n3. Create a mapping: type `deal` (= Lead), template, recipients (*primary contact* = the lead's main contact; *contact 1, 2…* = the others), prefill (`name`, `price`, or a custom field by name, code or id) and the status field.\n4. Send with `POST /v1/crm/mappings/{id}/send` (`objectId` = lead id; `companyId` is optional: if you send it, it must be the connection's account, otherwise 409 `company_mismatch`) or from Kommo with the widget's **Send for signature with CalaSign** button ([widget zip](/integrations/connectors/kommo/calasign-kommo-widget.zip)).",
  "g.crm.mappings.h": "Mappings and links",
  "g.crm.mappings.p":
    "A **mapping** connects a record type with a template: where each recipient comes from, which properties prefill which fields, what's written back at each status and when it triggers (`manual`, `webhook` or `on_completion`). Each envelope is **linked** to its record and every event (sent, completed, declined, voided, expired) is written back. Activity, with errors and retries, can be queried at `/v1/crm/runs`.",
  // ───────── Guide: custom domain ─────────
  "g.domain.title": "Custom domain",
  "g.domain.lead":
    "Sign from your own domain (`sign.yourcompany.com`): links in emails, WhatsApp and Telegram and embedded signing URLs use that domain, and the page shows your branding. Available on the Enterprise plan.",
  "g.domain.dns.h": "Register the domain and create the DNS records",
  "g.domain.dns.p":
    "The response contains `txtName`, `txtValue` and `cnameTarget`. In your DNS, create a **TXT** record to prove the domain is yours and a **CNAME** pointing to the platform. The CNAME can't go through a proxy (in Cloudflare, “DNS only”).",
  "g.domain.verify.h": "Verify",
  "g.domain.verify.p":
    "Once the TXT record has propagated, verify. The TLS certificate is issued automatically on first access. CalaSign rechecks the domain every 6 hours: if the TXT or CNAME disappears several times in a row, the domain goes back to `pending` and links switch to the platform domain.",
  // ───────── Guide: branding ─────────
  "g.brand.title": "Custom branding",
  "g.brand.lead": "Your logo, your color and your own footer in emails and on the signing page. Available from the Starter plan up.",
  "g.brand.api.h": "Via the API",
  "g.brand.api.p":
    "`primaryColor` uses the `#RRGGBB` format; `emailFooter`, up to 500 characters (`null` clears each value). The logo is uploaded as `multipart/form-data` in the `file` field: PNG, SVG or JPEG up to 200 KB. `DELETE /v1/settings/branding/logo` removes it. It can also be configured in **Settings → Branding**.",
  // ───────── Webhooks ─────────
  "wh.title": "Webhooks",
  "wh.lead":
    "CalaSign notifies you with a signed `POST` to your URL every time something happens on an envelope: someone opens it, signs, declines, or the envelope is completed. It's the recommended way to stay informed, rather than polling the API. Available from the Starter plan up.",
  "wh.setup.h": "Set up an endpoint",
  "wh.setup.p":
    "Register the URL in **Settings → Integrations** ([`/app/settings/integrations`](/app/settings/integrations)) or via the API. The URL must be `https`, public and without credentials; redirects aren't followed. Empty or missing `events` = all events. The response includes the `secret` (`whsec_…`) for verifying signatures: **it's shown only once**. You can have several endpoints, pause them (`active: false`) and change their events with `PATCH /v1/webhooks/{id}`. Since a webhook receives data from every envelope in the organization, creating or changing one, or retrying a delivery, requires `webhooks:manage` plus `envelopes:view_all` (e.g. the `admin` role). A webhook created with an API key or a user's OAuth token (Zapier, Make or Power Automate REST hooks) is tied to that credential: if the key or app is revoked, the user disconnects it or leaves the organization, the webhook is deactivated automatically (`active: false`, before any further delivery, recorded in the audit log). If you reactivate one that was deactivated for that reason, it moves to the credential of whoever reactivates it (from the console, it becomes an organization webhook); pausing and resuming a working one doesn't change its origin. Creating or activating a webhook, or changing its URL or events, requires webhooks in the plan (`402 plan_limit`); pausing it or changing only the description doesn't.",
  "wh.setup.once": "shown only once",
  "wh.events.h": "Events",
  "wh.events.p": "Subscribe only to the ones you use. New types may appear in the future: ignore the ones you don't recognize by responding `2xx`.",
  "wh.col.event": "Event",
  "wh.col.when": "When it's sent",
  "wh.ev.envelope.sent": "The envelope was sent (via the API, the web app, a bulk send, a web form or a CRM).",
  "wh.ev.envelope.completed": "Everyone signed and the sealed PDF is ready to download. `data.envelope.signedSha256` contains its hash.",
  "wh.ev.envelope.declined": "The envelope ended because someone declined. Arrives together with `recipient.declined`; `data.reason` contains the reason.",
  "wh.ev.envelope.voided": "The sender voided the envelope. `data.reason` contains the reason.",
  "wh.ev.envelope.expired": "`expiresAt` passed before everyone signed.",
  "wh.ev.recipient.viewed": "A recipient opened the document. `data.recipientId` says who.",
  "wh.ev.recipient.signed": "A signer signed. If routing steps remain, the next recipients get their invitation.",
  "wh.ev.recipient.declined": "A signer or approver declined. `data.reason` contains the reason.",
  "wh.ev.recipient.approved": "An approver (`role: approver`) approved.",
  "wh.ev.webhook.test": "Test event sent with **Send test** or `POST /v1/webhooks/{id}/test`. `data.envelope` is `null`.",
  "wh.payload.h": "Delivery format",
  "wh.payload.p":
    "Each delivery is a `POST` with a JSON body and these headers. The body contains a **snapshot of the envelope** at the time of the event, with your `metadata` and each recipient's status, so you often don't need to query the API.",
  "wh.payload.headers": "Headers",
  "wh.payload.body": "Body",
  "wh.col.field": "Field",
  "wh.f.id": "Unique event id. It's the same across all your endpoints and in retries: use it to avoid processing an event twice.",
  "wh.f.type": "Event type.",
  "wh.f.createdAt": "When the event was generated.",
  "wh.f.envelope": "Envelope state when the event was generated (`null` in `webhook.test`).",
  "wh.f.recipientId": "Recipient that triggered the event (`viewed`, `signed`, `approved`, `declined`), when applicable.",
  "wh.f.reason": "Reason for the decline or void, when applicable.",
  "wh.verify.h": "Verify the signature",
  "wh.verify.p":
    "The `CalaSign-Signature` header has the form `t=<unix>,v1=<hex>`, where `v1` is `HMAC-SHA256(secret, \"<t>.<body>\")` in hex. While you rotate the secret, the header carries one `v1` per active secret (`t=<unix>,v1=<new>,v1=<old>`). To verify:\n\n1. Split the header on commas and read `t` and every `v1`.\n2. Compute the HMAC with your secret over the text `t`, a dot and the **raw body**, byte for byte as it arrived (not re-serialized JSON).\n3. Compare it in constant time with each `v1`: accept the delivery if any of them matches.\n4. Reject deliveries whose `t` is more than 5 minutes old to prevent replays.",
  "wh.verify.warn":
    "The most common mistake is verifying the already-parsed body: any difference in whitespace or key order breaks the signature. Configure your framework to give you the raw body on this route (`express.raw`, `request.get_data()`, unparsed `request.body`).",
  "wh.c.raw": "RAW body, exactly as it arrived",
  "wh.c.async": "process outside the request",
  "wh.c.multi": "during a rotation several v1 values arrive: accept if any of them matches",
  "wh.retries.h": "Retries",
  "wh.retries.p":
    "A delivery counts as successful if your server responds **2xx within 10 seconds**. Any other status code, a redirect, a network error or a timeout is a failure and is retried with increasing backoff, up to **8 attempts** in total:",
  "wh.col.attempt": "Attempt",
  "wh.col.wait": "Wait since the previous one",
  "wh.retries.immediate": "immediate",
  "wh.retries.after":
    "After the last attempt the delivery is marked `failed`. You can see each delivery (response code, first characters of the response, error, next attempt) and retry it manually from **Settings → Integrations** or with `POST /v1/webhook-deliveries/{id}/retry` (requires webhooks in the plan; if an attempt is already in progress or a manual retry was already requested, `409 delivery_pending`). If you pause an endpoint, its pending deliveries are marked as failed.",
  "wh.receive.h": "Best practices for receiving",
  "wh.receive.p":
    "- **Respond quickly.** Verify the signature, store the event and respond `200`; process it later in a queue. If you take more than 10 seconds, CalaSign counts it as a failure and retries.\n- **Idempotency.** The same event can arrive more than once (retries, flaky networks). Store the `id` (also sent in `CalaSign-Event-Id`) and discard duplicates.\n- **No guaranteed order.** Events are delivered independently: `recipient.signed` can arrive after `envelope.completed`. Use `createdAt` and, when in doubt, fetch the current state with `GET /v1/envelopes/{id}`.\n- **Unknown events.** Respond `2xx` to types you don't handle.\n- **Secret rotation.** Use `POST /v1/webhooks/{id}/rotate-secret`: it returns the new secret and, for `graceHours` (24 by default), every delivery is signed with both, so you can switch the secret on your server without losing events.",
  "wh.test.h": "Testing",
  "wh.test.p":
    "Send a `webhook.test` event to an endpoint to check connectivity and signature verification. During development you can expose your local server with a tunnel (ngrok, Cloudflare Tunnel) or use a request inspection service. The test also requires webhooks in the plan (`402 plan_limit`).",
  "wh.test.deliveries.h": "Delivery history",
  "wh.test.deliveries.p": "Each endpoint's recent deliveries, with their status (`pending`, `succeeded`, `failed`), attempts, last HTTP status code and error.",
  // ───────── Errors, idempotency, pagination, limits ─────────
  "err.title": "Errors, idempotency and limits",
  "err.lead": "How the API responds when something goes wrong, how to retry without duplicating, how to page through long lists and how many requests you can make.",
  "err.format.h": "Error format",
  "err.format.p":
    "Every `/v1` error response has the same format: a stable English `code` for your code, a human-readable `message` and, sometimes, `details` with structured information. Code against `code` and the HTTP status, never against `message`.",
  "err.format.lang":
    "`message` values are in Spanish and their wording may change. OAuth endpoints (`/oauth/*`) use the RFC 6749 format instead: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "err.codes.h": "Common codes",
  "err.col.meaning": "What it means and what to do",
  "err.c.validation": "The body doesn't match the schema. `details[]` contains the `path` and `message` of each problem. Don't retry without fixing it.",
  "err.c.invalidId": "An id in the path isn't a valid UUID.",
  "err.c.bad": "Other request errors, with a specific `code` (invalid cursor, anchor text not found, field outside the page…).",
  "err.c.unauthorized": "The credential is missing, invalid, expired or revoked.",
  "err.c.plan":
    "The organization hit a plan limit or the feature isn't included. `details` contains `plan`, the limit or feature, `suggestedPlan` and `upgradeUrl`. Reads are never blocked by plan.",
  "err.c.forbidden": "The credential's role lacks the permission (`details.permission`) or the OAuth token is missing a scope (`details.requiredScope`).",
  "err.c.notFound": "The resource doesn't exist or belongs to another organization.",
  "err.c.conflict": "The resource's state doesn't allow the operation: for example, modifying an envelope that's no longer a draft or voiding a finished one.",
  "err.c.idem": "You reused an `Idempotency-Key` with a different body, or the original request is still being processed (retry in a few seconds).",
  "err.c.versionChanged":
    "Concurrent editing control: you sent `X-Expected-Updated-At` with the `updatedAt` you read when modifying a draft (`PATCH /v1/envelopes/{id}`, `PUT …/recipients`, `PUT …/fields`, `PUT …/seal-options`, `PATCH …/ai/settings`) or a template (`PATCH /v1/templates/{id}`, `PUT …/roles`, `PUT …/fields`, `PUT …/shares`), or when sending it (`POST …/send`), and someone changed it in the meantime. `details.updatedAt` has the current value: reload, review and retry. Without the header nothing is checked. In a negotiation it means there's a new version.",
  "err.c.purged":
    "The envelope's originals were deleted by the organization's retention policy (counted from when the envelope ended: completed, voided, declined or expired). `410` when downloading the original, creating a template from the envelope or using AI; `409` when cloning it. The signed PDF and the evidence are kept.",
  "err.c.tooLarge": "The file exceeds the maximum size.",
  "err.c.unprocessable": "The request is valid but can't be processed with that data (missing template roles, invalid rows, PDF too heavy to search for anchors).",
  "err.c.rate": "You exceeded the per-IP rate limit (code `rate_limited`; earlier API versions sent `bad_request`). Wait as long as the `retry-after` header says (in seconds) and retry.",
  "err.c.rateBiz":
    "Business cap with its own code (`reminded_recently`, `form_rate_limited`, `workflow_rate_limited`, `ai_signer_limit`, `ai_budget_exceeded`, `too_many_comments`, `too_many_proposals`, `archive_recently_renewed`, `too_many_attempts`). There's no `retry-after`: don't retry it in a loop; tell the user or try much later.",
  "err.c.internal": "Our error. It's safe to retry with increasing backoff; if you use `Idempotency-Key`, nothing gets duplicated.",
  "err.codes.retry":
    "**What to retry:** network errors, the per-IP rate-limit `429` (with `retry-after`) and `5xx`, with exponential backoff and some jitter. **What not to:** `429`s with their own code (business caps, no `retry-after`) and the rest of the `4xx` errors, which won't change if you repeat the same request.",
  "err.idem.h": "Idempotency",
  "err.idem.p":
    "If a create request is cut off (timeout, network), you don't know whether it went through. Send the `Idempotency-Key` header with a unique value per operation — for example, the request id in your system — and retry with the same value: CalaSign runs the operation only once and returns the stored response to retries, with the `idempotent-replay: true` header.",
  "err.idem.rules":
    "- Applies to `POST /v1/envelopes`, `POST /v1/envelopes/{id}/send`, `POST /v1/envelopes/from-template`, `POST /v1/envelopes/from-template/{templateId}`, `POST /v1/bulk-sends`, `POST /v1/crm/mappings/{id}/send`, `POST /v1/connectors/flows/{id}/send` and `POST /v1/document-templates/{id}/generate`. On all other endpoints the header is ignored.\n- The key is scoped per credential (API key, OAuth app or user) and is up to 200 characters.\n- Same key with a different body or path: `409 idempotency_mismatch`.\n- If the first request is still being processed: `409 idempotency_in_progress`; retry in a few seconds.\n- If the original request failed with an error, the key is released and you can retry.\n- The SDKs add a key automatically.",
  "err.page.h": "Pagination",
  "err.page.p":
    "`GET /v1/envelopes` paginates by **cursor**, from newest to oldest. `limit` goes from 1 to 100 (25 by default). If there are more results, the response contains `nextCursor`: pass it as `cursor` to request the next page; when it's `null`, you're done. The cursor is opaque: don't build or modify it. Filters: `status` (one or more, comma-separated) and `q` (searches the subject and the recipients' names or emails).",
  "err.page.iter.h": "Iterating over all pages",
  "err.rate.h": "Rate limits",
  "err.rate.p":
    "Limits are counted **per IP address** in one-minute windows. The general limit is 600 requests per minute across the whole API; some endpoints have their own limit, counted separately. Every response includes `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`; when you exceed it, the response is `429` with `retry-after`.",
  "err.col.route": "Path",
  "err.col.limit": "Limit per IP",
  "err.rate.tip":
    "To track the status of many envelopes, use [webhooks](/developers/webhooks) instead of polling in a loop. If you need higher limits, get in touch.",
  // ───────── SDKs ─────────
  "sdk.title": "SDKs",
  "sdk.lead":
    "Official SDKs for Python and Node.js, with no external dependencies. They handle the tedious parts: authentication (including OAuth token refresh), safe retries, pagination and webhook verification. For any other language, generate a client from the OpenAPI specification.",
  "sdk.notPublished":
    "The SDKs aren't published on PyPI or npm yet: install them from the CalaSign source code (the `sdks/python` and `packages/sdk-node` folders). The API is stable; once they're published only the install command changes.",
  "sdk.col.feature": "Feature",
  "sdk.f.deps": "Requirements",
  "sdk.f.py.deps": "Python ≥ 3.8, standard library only",
  "sdk.f.node.deps": "Node.js ≥ 18 (native fetch), with types",
  "sdk.f.auth": "Authentication",
  "sdk.f.retries": "Retries",
  "sdk.f.retries.v": "Network, 429 (honors Retry-After) and 5xx, exponential backoff, 3 by default",
  "sdk.f.idem": "Automatic Idempotency-Key",
  "sdk.f.errors": "Errors",
  "sdk.install": "Installation",
  "sdk.py.h": "Python",
  "sdk.node.h": "Node.js",
  "sdk.c.any": "any other endpoint, with the same authentication and retries",
  "sdk.methods.h": "Methods",
  "sdk.m.verify": "Verify a webhook",
  "sdk.openapi.h": "Any language with OpenAPI",
  "sdk.openapi.p":
    "The OpenAPI 3.1 specification at [`/v1/openapi.json`](/v1/openapi.json) describes every endpoint with its request and response schemas, parameters, errors and scopes. Use it with any client generator, to import the API into Postman or Insomnia, or to validate your requests in tests.",
  "sdk.openapi.import": "Import → Link / URL:",
  // ───────── AI and agents ─────────
  "ai.title": "AI and agents",
  "ai.lead":
    "Connect AI assistants to CalaSign to check the status of your envelopes, prepare sends from a template and download signed documents conversationally. Everything goes through the CalaSign **MCP server** (Model Context Protocol), with the same permissions, limits and evidence as the API.",
  "ai.cards.h": "Integrations",
  "ai.card.mcp.t": "MCP server",
  "ai.card.mcp.d": "One URL for any MCP client: automatic OAuth or API key.",
  "ai.card.mcp.a": "See tools",
  "ai.card.claude.d": "Custom connector in claude.ai and Claude Desktop, with OAuth sign-in.",
  "ai.card.claude.a": "Add connector",
  "ai.card.desktop.t": "Claude Desktop extension",
  "ai.card.desktop.d": "A `.mcpb` file: double-click, paste your API key and you're done.",
  "ai.card.code.d": "One command to add the server, or the plugin with the skill included.",
  "ai.card.code.a": "See commands",
  "ai.card.skill.t": "Agent Skill",
  "ai.card.skill.d": "Teaches Claude the CalaSign workflow: templates, confirmations and best practices.",
  "ai.card.gpt.d": "Custom MCP server in ChatGPT and the MCP tool in the Responses API.",
  "ai.card.gpt.a": "Connect ChatGPT",
  "ai.card.gem.d": "Gemini CLI (command or extension) and the Gemini API with an MCP session.",
  "ai.card.gem.a": ".zip extension",
  "ai.card.office.t": "Word and Outlook",
  "ai.card.office.d": "Add-in to send the document open in Word, or a PDF attached in Outlook, for signature.",
  "ai.how.h": "How it works",
  "ai.how.p":
    "The agent talks to `{{MCP_URL}}` and CalaSign runs each tool by calling its own API with **the agent's credential**. That means:\n\n- The agent can do exactly what its credential can: the API key's role or, with OAuth, the scopes the person approved and their own role.\n- The same plan limits and validations as the API apply.\n- Every action is recorded in the envelope's evidence with the actor “AI agent (<client>)”.\n- Sending and voiding take two steps: without a `confirmToken` the tool returns a preview with a token for the person to approve, and only acts with that token.",
  "ai.how.tip":
    "For testing, use the test environment: emails and WhatsApp messages the agent triggers land in the Dev mailbox without reaching anyone.",
  "ai.c.prompt": "Which of my envelopes are pending signature?",
  // ───────── MCP server ─────────
  "mcp.title": "MCP server",
  "mcp.lead":
    "Remote [Model Context Protocol](https://modelcontextprotocol.io) server so AI agents can work with CalaSign. Works with Claude, ChatGPT, Gemini, the MCP Inspector and any client that speaks Streamable HTTP.",
  "mcp.connect.h": "Connection",
  "mcp.col.prop": "Property",
  "mcp.col.value": "Value",
  "mcp.transport": "Transport",
  "mcp.transport.v": "Stateless Streamable HTTP: each `POST` is independent and the response is JSON. `GET` and `DELETE` return 405.",
  "mcp.auth.row": "Authentication",
  "mcp.auth.row.v": "OAuth 2.1 (discovery + dynamic registration) or `Authorization: Bearer <API key>`",
  "mcp.plan": "Plan",
  "mcp.plan.v": "Starter or higher (API access). Without it, `402 plan_limit`.",
  "mcp.connect.p": "Limit: 300 requests per minute per IP.",
  "mcp.auth.h": "Authentication",
  "mcp.auth.p":
    "**OAuth (recommended for people).** The client discovers everything on its own: the first request without a credential gets a `401` with the link to the metadata, the client registers via [dynamic registration](/developers/authentication#dynamic-registration), opens the CalaSign consent screen and the person chooses what to allow. Request `offline_access` so you don't have to sign in again every hour.\n\n**API key (scripts and environments without a browser).** Send `Authorization: Bearer cs_test_…`. The agent acts with that key's role: for an agent, prefer a key with the `member` role or a custom role, not `admin`.",
  "mcp.auth.401": "Response without a credential",
  "mcp.tools.h": "Tools",
  "mcp.tools.p": "All of them return condensed JSON designed for a model (ids, statuses, names) instead of the full API details.",
  "mcp.col.tool": "Tool",
  "mcp.col.does": "What it does",
  "mcp.col.confirm": "Confirmation",
  "mcp.tool.list_envelopes": "Lists envelopes, newest first. Filters: `status`, `query` (subject or recipient), `limit` (up to 50) and `cursor`.",
  "mcp.tool.get_envelope": "Envelope details: documents, recipients and their status.",
  "mcp.tool.get_signing_status": "Who signed, who's pending, who declined, and the latest evidence events.",
  "mcp.tool.list_templates": "Available templates with their roles (for creating envelopes from a template).",
  "mcp.tool.create_envelope_from_template": "Creates a **draft** envelope from a template, with one person per role and optional field values. With `send: true` it creates and sends it in a single call, in two steps: first it returns a preview with a `confirmToken` and, once the person approves, the call is repeated with that token. The same `requestId` (7 days) or, without one, a retry with the same arguments within ~10 minutes returns the envelope already created, with its current status and `replayed: true`. Accepts `locale`.",
  "mcp.tool.send_envelope": "Sends a draft: signers get their invitations.",
  "mcp.tool.void_envelope": "Voids an in-progress envelope with a reason; signers are notified.",
  "mcp.tool.download_signed_pdf": "Returns a temporary URL (15 minutes, up to 3 downloads and only while the agent's credential remains valid) to download the sealed PDF of a completed envelope, with its SHA-256.",
  "mcp.tool.create_envelope": "Creates a **draft** envelope from a PDF (base64 or an https URL), with its recipients. With `send: true` it creates and sends it in a single call, with the same preview and `confirmToken`. The same `requestId` (7 days) or, without one, a retry with the same arguments within ~10 minutes returns the envelope already created, with its current status and `replayed: true`. Accepts `locale`.",
  "mcp.tool.remind_recipients": "Resends the invitation to pending signers in the current routing step, in two steps: a preview with a `confirmToken` and, once the person approves, the same call with that token.",
  "mcp.tool.get_account": "Account details: organization, user or credential and plan; this month's usage only if the credential can see all envelopes or manage billing (otherwise `usage: null`).",
  "mcp.safety.h": "Security model",
  "mcp.safety.p":
    "- **Explicit two-step confirmation.** Without a `confirmToken`, tools with outward effects (send, void, remind) do nothing: they return a preview (subject, recipients) and a `confirmToken` signed by the server, valid for 5 minutes and bound to that action, that envelope, the version that was shown and the agent's credential. Only with that token do they act; if the envelope changed after the preview, it is rejected and a new one is needed. The server instructions ask the model to show the preview to the person and wait for approval.\n- **Drafts first.** Creating an envelope doesn't send it, except with `send: true`, which goes through the same preview and approval as sending. Retries with the same arguments don't create duplicate envelopes.\n- **Narrow permissions.** The agent can never do more than its credential. With OAuth, the person sees and approves the scopes; you can revoke access at any time from **Settings → OAuth apps** (connected apps).\n- **Evidence.** Every action is recorded as “AI agent (<client name>) — <credential>” in the envelope's evidence chain and in the completion certificate.\n- **Temporary downloads.** The signed PDF is delivered via a link that expires after 15 minutes (up to 3 downloads), not as content in the conversation; if you revoke the agent's credential, its links stop working.\n- **Untrusted content.** A subject line, a recipient's name or a decline reason may contain malicious instructions. The server returns that third-party text wrapped as `{\"untrusted\": …}` and tells the model it is data, never an instruction. Still, ask your agent not to take actions based on document content without confirming with the person.",
  "mcp.inspector.h": "Testing with MCP Inspector",
  "mcp.inspector.p":
    "The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the official tool for testing an MCP server: it lists the tools, runs them and shows the messages. It requires Node.js 22 or later. In the web UI choose the **Streamable HTTP** transport, paste the URL and add the `Authorization` header, or follow the OAuth flow. `--header` goes after the URL.",
  "mcp.inspector.c.ui": "Web UI (http://localhost:6274) with the connection preloaded",
  "mcp.inspector.c.cli": "Command-line mode: list tools",
  "mcp.sdk.h": "From your own agent",
  "mcp.sdk.p": "With the official MCP SDK for TypeScript (`@modelcontextprotocol/sdk`). There are equivalent SDKs for Python, Java, C#, Go and other languages.",
  "mcp.sdk.c.approve": "…show the summary to the person and, if they approve:",
  // ───────── Claude ─────────
  "claude.title": "Claude",
  "claude.lead":
    "Use CalaSign from claude.ai, Claude Desktop, Claude Code or your own app with the Claude API. Pick the option that fits where you work; they all use the same [MCP server](/developers/ai/mcp).",
  "claude.connector.h": "Connector in claude.ai and Claude Desktop",
  "claude.connector.p":
    "Custom connectors are available on all Claude plans (up to one on Free). You add one once and it's available on the web, in Claude Desktop and in the mobile app.",
  "claude.connector.s1": "In Claude, open **Customize → Connectors** and choose **Add custom connector**.",
  "claude.connector.s2": "Enter a name (CalaSign) and paste the server URL:",
  "claude.connector.s3":
    "For authentication, keep OAuth sign-in. If you're asked to choose the OAuth client, choose **Register automatically**. Click **Add** and then **Connect**.",
  "claude.connector.s4": "The CalaSign consent screen opens: sign in, review the permissions and approve. In each chat, enable the connector from the **+ → Connectors** button.",
  "claude.connector.team":
    "**Team and Enterprise:** first an organization owner adds it in **Organization settings → Connectors → Add → Custom**. Then each person finds it in **Customize → Connectors** with the *Custom* label, clicks **Connect** and signs in with their own CalaSign account.",
  "claude.connector.key":
    "Prefer an API key over OAuth? Some organizations see a *No sign-in* option with **Request headers** (beta): add `Authorization` with the value `Bearer cs_test_…` (including “Bearer ”). Authentication can't be changed later: to change it, remove the connector and add it again.",
  "claude.desktop.h": "Claude Desktop extension (.mcpb)",
  "claude.desktop.p":
    "If you work in Claude Desktop with an API key (for example, a service account), the `.mcpb` extension is the fastest option: it installs with a double-click and stores the key in the operating system's secure store.",
  "claude.desktop.s1": "Download `calasign.mcpb` and double-click it (or drag it into **Settings → Extensions** in Claude Desktop).",
  "claude.desktop.s2": "On the install screen, review the permissions and paste your CalaSign API key when asked.",
  "claude.desktop.s3": "Click **Install** and enable it. If your organization has disabled extensions, the section doesn't appear: use the connector.",
  "claude.code.h": "Claude Code",
  "claude.code.p":
    "Add the server with one command. With OAuth, the first time run `/mcp` inside Claude Code and follow the sign-in in the browser (or `claude mcp login calasign` from the terminal). `--scope user` makes it available in all your projects; `--scope project` saves it in `.mcp.json` to share with your team.",
  "claude.code.c.login": "inside Claude Code, to sign in:",
  "claude.plugin.h": "CalaSign plugin",
  "claude.plugin.p":
    "The plugin installs the MCP server and the CalaSign skill in one go. Type this inside Claude Code:",
  "claude.skill.h": "Agent Skill",
  "claude.skill.p":
    "The skill teaches Claude how to work with CalaSign: using templates, placing fields with anchors, asking for confirmation before sending, interpreting statuses and webhooks. Combine it with the connector or the MCP server.",
  "claude.skill.install":
    "**In claude.ai:** **Customize → Skills → Upload a skill**, choose the ZIP and enable it. Requires code execution to be enabled (**Settings → Capabilities**; on Enterprise an owner enables it).\n\n**In Claude Code:** unzip it into `~/.claude/skills/` (for you) or into your project's `.claude/skills/` (for your team). If you installed the plugin, you already have it.",
  "claude.api.h": "Claude API (MCP connector)",
  "claude.api.p":
    "With the Messages API, Claude connects directly to the MCP server without you implementing a client. You need the `mcp-client-2025-11-20` beta header, the server in `mcp_servers` and an `mcp_toolset` in `tools`. In `authorization_token` send a CalaSign OAuth access token or an API key. Your application is responsible for asking for confirmation before sending or voiding.",
  // ───────── ChatGPT ─────────
  "gpt.title": "ChatGPT",
  "gpt.lead": "Add CalaSign as a custom MCP server in ChatGPT, or use it from the OpenAI Responses API.",
  "gpt.connector.h": "Custom MCP server in ChatGPT",
  "gpt.connector.p":
    "Custom MCP servers are added from the ChatGPT web app. Depending on the plan, the workspace admin may need to enable or create them (on Business and Enterprise/Edu, for example). Menu names change often: if you can't find them, search for “MCP” in settings or in the OpenAI help center.",
  "gpt.connector.s1": "Open the ChatGPT **Plugins** section (*chatgpt.com/plugins*), click **+** and choose **Add custom MCP server**.",
  "gpt.connector.s2": "Name: CalaSign. Under **Connection**, paste the server URL:",
  "gpt.connector.s3": "Authentication: **OAuth**. ChatGPT registers itself with CalaSign; accept the warning and create it.",
  "gpt.connector.s4": "Install it, sign in to CalaSign when prompted and approve the permissions.",
  "gpt.connector.note":
    "ChatGPT asks for confirmation before using tools that modify data. On top of that, CalaSign requires the `confirmToken` from a preview to send or void, so nothing goes out without your approval.",
  "gpt.api.h": "OpenAI Responses API",
  "gpt.api.p":
    "The Responses API `mcp` tool connects the model to the CalaSign server. In `authorization` send a CalaSign OAuth access token or API key (it isn't stored: send it with every request).",
  // ───────── Gemini ─────────
  "gem.title": "Gemini",
  "gem.lead": "Use CalaSign from Gemini CLI — with a command or the extension — or from the Gemini API with an MCP session.",
  "gem.cli.h": "Gemini CLI",
  "gem.cli.p":
    "`gemini mcp add` saves the server in `settings.json` (`--scope user` for all your projects; by default, the current project). With OAuth, Gemini CLI detects that sign-in is needed, registers itself and opens the browser; you can also force it with `/mcp auth calasign`.",
  "gem.cli.c.login": "inside Gemini CLI, to sign in:",
  "gem.cli.note":
    "Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts. The steps on this page apply to Gemini CLI; in other tools, use the same URL with the HTTP transport.",
  "gem.ext.h": "Gemini CLI extension",
  "gem.ext.p":
    "The CalaSign extension adds the MCP server and a context file with instructions for working with envelopes and templates. Download it, unzip it and install it from the folder (Gemini CLI installs extensions from a git repository or a local folder, not from a ZIP).",
  "gem.api.h": "Gemini API (google-genai)",
  "gem.api.p":
    "The `google-genai` SDK for Python accepts an MCP session as a tool (experimental feature). This example uses the Streamable HTTP client from the `mcp` 2.x SDK; with `mcp` 1.x, the equivalent is `streamablehttp_client(url, headers={…})`.",
  // ───────── Office ─────────
  "office.title": "Word and Outlook add-in",
  "office.lead":
    "Send for signature without leaving Microsoft 365: the document you're writing in Word or a PDF you received by email in Outlook.",
  "office.what.h": "What it does",
  "office.what.p":
    "- **Word:** sends the document you have open for signature: you choose the recipients from the side panel and CalaSign creates and sends the envelope.\n- **Outlook:** while reading an email, you choose an attached PDF and send it for signature without downloading it.\n- In both cases you sign in with your CalaSign account, and everything stays in your organization like any other envelope.",
  "office.word.h": "Install in Word",
  "office.word.p":
    "Download `manifest.xml` and upload it as a custom add-in:\n\n- **Word on the web:** **Home → Add-ins → More Settings → Upload My Add-in**, choose the file and click **Upload**. It's stored in the browser: if you clear the site data, you'll need to upload it again.\n- **Word for Mac:** copy the manifest to `~/Library/Containers/com.microsoft.Word/Data/Documents/wef` (create the folder if it doesn't exist), restart Word and open it from **Home → Add-ins**.\n- **Word for Windows:** sideloading requires a shared folder configured as a trusted catalog (**File → Options → Trust Center → Trusted Add-in Catalogs**). For teams, centralized deployment (below) is simpler.",
  "office.outlook.h": "Install in Outlook",
  "office.outlook.p":
    "In Outlook on the web, the new Outlook for Windows, classic Outlook or Mac: open [aka.ms/olksideload](https://aka.ms/olksideload), go to **My add-ins**, and at the bottom, under **Custom add-ins**, choose **Add a custom add-in → Add from File** and pick `manifest-outlook.xml`. In classic Outlook it may take a while to appear.",
  "office.admin.h": "Centralized deployment (admins)",
  "office.admin.p":
    "A Microsoft 365 admin can deploy it for the whole organization or for groups: **Microsoft 365 admin center → Settings → Integrated apps** → upload a custom app with the manifest file or its URL, choose who it's assigned to and **Deploy**. It can take 24 to 72 hours to show up for everyone.",
  "office.admin.url": "Manifest URL",
  // ───────── Reference ─────────
  "ref.title": "API reference",
  "ref.lead":
    "Every v1 API endpoint, generated live from the OpenAPI specification served by the environment. Each operation shows its parameters, request body, responses and ready-to-copy examples.",
  "ref.overview": "Overview",
  "ref.spanishNote": "Reference descriptions come from the OpenAPI specification, which is written in Spanish.",
  "ref.loadError": "Couldn't load the specification. Try reloading the page or open /v1/openapi.json.",
  "ref.oneOf": "Values:",
  "ref.default": "Default:",
  "ref.chars": "characters",
  "ref.items": "items",
  "ref.anyOf": "Accepts one of these shapes:",
  "ref.option": "Option",
  "ref.freeObject": "Free-form object (any keys and values).",
  "ref.showChildren": "Show properties",
  "ref.public": "Public",
  "ref.sessionOnly": "Web session only",
  "ref.example": "Example",
  "ref.header": "Header",
  "ref.description": "Description",
  "ref.copyUrl": "Copy URL",
  "ref.params": "Parameters",
  "ref.name": "Name",
  "ref.in": "In",
  "ref.type": "Type",
  "ref.body": "Request body",
  "ref.responses": "Responses",
  "ref.examples": "Examples",
  ...connectorsDocsEn,
};
