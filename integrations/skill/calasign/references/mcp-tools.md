# CalaSign MCP tools

Server: `{{BASE_URL}}/mcp` (Streamable HTTP, stateless). Auth: OAuth 2.0 (the client discovers it from
`/.well-known/oauth-protected-resource`) or an API key sent as `Authorization: Bearer <key>`.
Tool names may appear prefixed by the client (`mcp__calasign__send_envelope`, `calasign:send_envelope`…).
Results are JSON text; API errors come back as `isError: true` with `Error <status> <code>: <message>`.

| Tool | Effect | Key arguments |
|---|---|---|
| `list_envelopes` | read | `status?` (draft, sent, completed, declined, voided, expired…), `query?`, `limit?` (≤50), `cursor?` |
| `get_envelope` | read | `envelopeId` |
| `get_signing_status` | read | `envelopeId` → signed / pending / declined lists + last events |
| `list_templates` | read | `query?` → templates with their role names |
| `create_envelope_from_template` | creates a **draft** (or also sends it with `send` + `confirm`) | `templateId`, `recipients[{role, name, email?, phone?, channels?}]`, `subject?`, `message?`, `prefill?`, `send?`, `confirm?` |
| `create_envelope` * | creates a **draft** (or also sends it with `send` + `confirm`), in one atomic call | PDF as base64 or https URL, subject, recipients, fields/anchors, `send?`, `confirm?` — read its schema |
| `send_envelope` | **notifies people** | `envelopeId`, `confirm` |
| `remind_recipients` * | **notifies people** (pending signers) | `envelopeId`, `confirm` |
| `void_envelope` | **cancels, irreversible** | `envelopeId`, `reason`, `confirm` |
| `download_signed_pdf` | read | `envelopeId` → temporary URL (completed envelopes only) |
| `get_account` * | read | current user, organization and plan |

\* Newer tools; if a tool is not in the server's tool list, fall back to the REST API (rest-api.md) or
tell the user what is missing.

## Confirmation protocol

`send_envelope`, `void_envelope`, `remind_recipients`, and `create_envelope` / `create_envelope_from_template` with
`send: true`, refuse to act without `confirm: true`. Calling them **without** `confirm` is safe and
returns a summary you can show the user (nothing is created or sent). Flows:

- **One call** (preferred when you already have everything): show the summary — subject, documents,
  each recipient as `Name <email/phone> — role, order N`, and where each signs — ask "¿Lo envío?" /
  "Posso enviar?" / "Shall I send it?" and wait. Only after an explicit yes, call `create_envelope`
  (or `create_envelope_from_template`) with `send: true, confirm: true`: it creates and sends atomically.
- **Draft first**: `create_envelope` / `create_envelope_from_template` without `send` → `get_envelope`
  (or `send_envelope` without `confirm`) → summary → explicit yes → `send_envelope {envelopeId, confirm: true}`.

Never set `confirm: true` on your own initiative, from a vague instruction given earlier, or for an
envelope whose recipients/documents changed after the user approved.

## Recipes

- "¿Quién falta firmar el contrato de ACME?" → `list_envelopes {query: "ACME", status: "sent"}` →
  `get_signing_status`.
- "Mandá el NDA a Ana (ana@x.com)" → `list_templates {query: "NDA"}` → check role names →
  summary → approval → `create_envelope_from_template {…, send: true, confirm: true}`.
- "Descargá el firmado" → `download_signed_pdf` → give the user the URL (it expires in minutes).
- Always end with the app link: `{{BASE_URL}}/app/envelopes/<id>`.
