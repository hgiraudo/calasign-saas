---
name: calasign
description: Send documents for e-signature and track them with CalaSign (MCP tools or REST API) - create envelopes, add signers, place fields by anchor text, send, remind, void, download signed PDFs.
license: Proprietary
metadata:
  version: "1.0.0"
  homepage: "{{BASE_URL}}/developers"
---

# CalaSign e-signature

CalaSign ({{BASE_URL}}) is a cloud e-signature service for Latin America (Dominican Republic, Honduras,
Colombia, Brazil, Peru). A document is sent inside an **envelope**: one or more PDFs, a list of
**recipients** (signers, approvers, CC) and **fields** (signature, date, name…) placed on the pages.

Use this skill whenever the user wants to: send a contract/PDF for signature, check who signed or who is
pending, remind signers, cancel (void) a request, download a signed PDF, use a CalaSign template, or
integrate CalaSign (REST API, webhooks, SDK) into code.

## Language

Most CalaSign users speak **Spanish** or **Brazilian Portuguese**. Always answer in the user's language.
When creating an envelope, set `locale` (`es`, `pt-BR` or `en`) to the language the signers should see
(default: the user's language). Write subjects and messages in that language too.

## Safety rules (mandatory)

1. **Never send or void without explicit approval.** Sending notifies real people by e-mail/WhatsApp;
   voiding cannot be undone. Before `send_envelope`/`void_envelope` with `confirm: true` (or `POST …/send`,
   `POST …/void`), show a summary — subject, documents, each recipient's name + e-mail/phone + role +
   order, field placement — and wait for a clear "yes" in the conversation. A previous approval does not
   cover a changed envelope.
2. **Never invent or guess contact data.** Use only names, e-mails and phone numbers the user gave you or
   that come from CalaSign/their files. If one is missing or looks wrong, ask. Phones must be E.164
   (`+5511999990000`).
3. Never print, log or commit API keys or tokens. Read them from the environment (`CALASIGN_API_KEY`).
4. Drafts are safe: creating a draft, uploading, setting recipients/fields never notifies anyone.
5. If a call fails with `plan_limit` (402) or `insufficient_scope` (403), explain it; don't retry blindly.

## Choose how to talk to CalaSign

1. **MCP tools available?** (names like `list_envelopes`, `send_envelope`, possibly prefixed, e.g.
   `calasign:list_envelopes` or `mcp__calasign__list_envelopes`) → use them. See
   [references/mcp-tools.md](references/mcp-tools.md).
2. **Otherwise, REST API** with `curl` or Python, authenticated with
   `Authorization: Bearer $CALASIGN_API_KEY` (API key from *Settings → API keys* in CalaSign, or an OAuth
   access token). See [references/rest-api.md](references/rest-api.md). If there is no key, tell the user
   how to get one ({{BASE_URL}}/app/settings/api-keys) instead of guessing.

The MCP server is `{{BASE_URL}}/mcp` (Streamable HTTP, OAuth 2.0 or API key as Bearer token).

## Workflow: send a PDF for signature

1. **Gather**: the PDF, the subject, each signer's name and e-mail (or phone), signing order (same number
   = in parallel, 1 then 2 = sequential), optional message, language, where each person signs.
2. **Placement**: prefer **anchor text** — if the PDF contains markers such as `[[firma]]`,
   `[[firma_1]]`, `\s1\`, put fields at those markers (see
   [references/fields-and-anchors.md](references/fields-and-anchors.md)). Otherwise use coordinates
   (normalized 0–1, top-left origin) — e.g. bottom of the last page. Every signer needs at least one
   `signature` field or sending fails with `envelope_incomplete`.
3. **Show the summary and ask for approval** (rule 1): subject, document(s), each recipient
   (name, e-mail/phone, role, order) and where each signs.
4. **Create and send in ONE call** (atomic: if anything is wrong — invalid PDF, missing anchor, a
   signer without a signature field — nothing is created):
   - MCP: `create_envelope` (PDF as base64 or https URL, recipients, anchor fields) or
     `create_envelope_from_template` (`list_templates` first to get role names), with
     `send: true, confirm: true` once the user approved. Without `send` they leave a **draft** (safe)
     that you can send later with `send_envelope`.
   - REST: a single `POST /v1/envelopes` with `documents`, `recipients`, `fields` and `"send": true`
     plus an `Idempotency-Key` header (see [references/rest-api.md](references/rest-api.md)); or
     `POST /v1/envelopes/from-template` with `"send": true`. Leave `send` out to create a draft only.
     The step-by-step endpoints (`…/documents`, `…/recipients`, `…/fields`, `…/send`) remain for
     editing an existing draft.
5. If you created a draft first, send it after approval: `send_envelope` with `confirm: true`, or
   `POST /v1/envelopes/{id}/send` with an `Idempotency-Key` header.
6. **Report**: envelope id, status, and the link `{{BASE_URL}}/app/envelopes/<id>`.

## Workflow: track, remind, void, download

- Status: `get_signing_status` / `GET /v1/envelopes/{id}` (+ `/events`). Statuses are explained in
  [references/lifecycle.md](references/lifecycle.md).
- List/search: `list_envelopes` (`status`, `query`) / `GET /v1/envelopes?status=sent&q=…`.
- Remind pending signers: `remind_recipients` / `POST /v1/envelopes/{id}/remind`.
- Void (with a reason, after approval): `void_envelope` / `POST /v1/envelopes/{id}/void`.
- Signed PDF (only when `completed`): `download_signed_pdf` (temporary URL) /
  `GET /v1/envelopes/{id}/signed.pdf`. It is PAdES-sealed and includes a completion certificate.

## Integrating CalaSign into code

- Full OpenAPI 3.1 spec: `{{BASE_URL}}/v1/openapi.json`. Portal: `{{BASE_URL}}/developers`.
- Python SDK (stdlib only) and Node SDK exist; REST works from any language.
- Webhooks are signed with HMAC-SHA256 — see [references/webhooks.md](references/webhooks.md).
- Errors are `{"error": {"code", "message", "details?"}}` — see [references/errors.md](references/errors.md).

## References

| File | When to read |
|---|---|
| [references/mcp-tools.md](references/mcp-tools.md) | Using the CalaSign MCP tools |
| [references/rest-api.md](references/rest-api.md) | curl/Python calls, auth, idempotency, pagination |
| [references/lifecycle.md](references/lifecycle.md) | Envelope and recipient statuses, routing order |
| [references/fields-and-anchors.md](references/fields-and-anchors.md) | Field types, coordinates, anchors |
| [references/webhooks.md](references/webhooks.md) | Events and signature verification |
| [references/errors.md](references/errors.md) | Error codes and how to fix them |
