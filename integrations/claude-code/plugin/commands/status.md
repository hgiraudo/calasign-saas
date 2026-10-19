---
description: Show the status of CalaSign envelopes (who signed, who is pending), or of one envelope
argument-hint: "[envelope id or search text]"
allowed-tools: Bash(curl:*), Bash(jq:*)
---

Report the status of CalaSign envelopes in the user's language, using the `calasign` skill.

Arguments: $ARGUMENTS

- If the argument is an envelope id (UUID): call `get_signing_status` (MCP) or `GET /v1/envelopes/{id}`
  plus `/events` (REST) and show: subject, status, who signed (with date), who is pending, who declined
  (with the reason), and whether the signed PDF is available.
- Otherwise: `list_envelopes` (MCP) or `GET /v1/envelopes?limit=10[&q=<text>]` (REST, with
  `Authorization: Bearer $CALASIGN_API_KEY`) and show a compact table: subject, status, pending signers,
  created date and the link `{{BASE_URL}}/app/envelopes/<id>`.
- This command is read-only: do not send, remind or void anything here. If the user then asks to remind
  or void, follow the skill's confirmation rules.
- If neither the MCP tools nor `CALASIGN_API_KEY` are available, explain how to connect (`/mcp` →
  `calasign` → authenticate, or export `CALASIGN_API_KEY`).
