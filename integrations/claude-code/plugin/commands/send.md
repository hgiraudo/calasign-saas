---
description: Send a PDF from this project for e-signature with CalaSign (asks for signers, confirms before sending)
argument-hint: "[path/to/file.pdf] [signer names and e-mails]"
allowed-tools: Read, Glob, Grep, Bash(ls:*), Bash(file:*), Bash(pdftotext:*), Bash(curl:*), Bash(base64:*), Bash(uuidgen:*), Bash(jq:*)
---

Send a document for electronic signature with CalaSign. Use the `calasign` skill for the API details and
follow its safety rules strictly. Answer in the user's language (Spanish, Portuguese or English).

Arguments: $ARGUMENTS

1. **Find the PDF.** If a path was given, use it. Otherwise look for `*.pdf` in the project (skip
   `node_modules`, `dist`, `.git`) and ask which one if there are several. If the user points to a
   `.docx`/`.md`, say it must be exported to PDF first (do not convert it silently).
2. **Signers.** Take names and e-mails only from the arguments or from the user. Never invent or complete
   an e-mail address. Ask for whatever is missing: name, e-mail (or phone in E.164 for WhatsApp), signing
   order, optional message, language (`es`, `pt-BR`, `en`).
3. **Placement.** Check whether the PDF text contains anchors such as `[[firma]]`, `[[firma_1]]`,
   `[[firma_2]]` (for example `pdftotext file.pdf - | grep -o '\[\[[^]]*\]\]'` when available). If found,
   place one signature field per signer on its anchor; otherwise propose a signature block at the bottom
   of the last page (coordinates) and say so in the summary.
4. **Confirm.** Show a summary (file, subject, each signer `Name <email> — order N`, field placement) and
   ask for explicit approval. Do not send without a clear "yes".
5. **Create and send in ONE call** (atomic: if something fails, nothing is left behind).
   - If the CalaSign MCP tools are connected and `create_envelope` exists, call it with `send: true`: the
     first call returns a preview and a `confirmToken`; after the user's "yes", repeat the same call with that
     `confirmToken` (PDF as base64; for files over ~5 MB prefer the REST API).
   - Otherwise, if `CALASIGN_API_KEY` is set, use the skill's one-call REST request with `curl`: a single
     `POST /v1/envelopes` with `documents`, `recipients`, `fields`, `"send": true` and an `Idempotency-Key`
     (multipart with a `payload` part for large PDFs). Never print the key.
   - Otherwise, explain how to connect: run `/mcp`, select `calasign` and authenticate (OAuth), or export
     `CALASIGN_API_KEY` (created at {{BASE_URL}}/app/settings/api-keys).
6. Finish with the link `{{BASE_URL}}/app/envelopes/<id>`.
