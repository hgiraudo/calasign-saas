# Errors

Shape: `{"error": {"code": "<code>", "message": "<human text, usually Spanish>", "details": …}}`.
Validation errors (400 `validation_error`) list each problem in `details[] {path, message}`.
OAuth endpoints use the RFC 6749 shape `{"error": "...", "error_description": "..."}`.

| HTTP | code | Meaning → what to do |
|---|---|---|
| 400 | `validation_error` | Body doesn't match the schema → read `details`, fix the field |
| 400 | `invalid_field` | Field on a missing document/page, or recipient isn't a signer |
| 400 | `anchor_not_found` | Anchor text not in the PDF → check spelling/case, or `ignoreIfNotPresent` |
| 400 | `file_required`, `not_pdf`, `encrypted`, `empty`, `unreadable`, `too_many_pages` | Upload missing or PDF not usable (password-protected PDFs are rejected) → export a clean PDF |
| 400 | `invalid_id` | An id is not a UUID |
| 401 | `unauthorized` | Missing/invalid/expired key or token → check `CALASIGN_API_KEY`, refresh OAuth token |
| 402 | `plan_limit` / `payment_required` | Plan doesn't include this (API/MCP, monthly envelopes…) → upgrade in Settings → Plan |
| 403 | `forbidden` | User/key lacks the permission |
| 403 | `insufficient_scope` | OAuth token lacks the scope (e.g. `envelopes:write`) → re-authorize with it |
| 404 | `not_found` | Wrong id or belongs to another organization |
| 409 | `not_draft` | Editing/sending something that is not a draft |
| 409 | `not_in_progress` / `not_voidable` / `envelope_closed` | Action not valid in the current status |
| 409 | `idempotency_mismatch` | Same `Idempotency-Key` reused with a different body → use a new key |
| 409 | `idempotency_in_progress` | Same key still running → wait and retry |
| 409 | `conflict` | Concurrent change → re-read and retry |
| 413 | `file_too_large` | PDF over the size limit (25 MB by default) |
| 422 | `envelope_incomplete` | Can't send: `details.problems[]` (no document, no signer, signer without signature field, expiry in the past) |
| 422 | `pdf_too_heavy` | PDF too complex to search for anchors → use coordinates |
| 429 | — | Rate limited → wait (`Retry-After`) |
| 503 | `pdf_reader_busy` | Temporary → retry shortly |
| 5xx | `internal_error` | Retry with the same `Idempotency-Key` |

MCP tools return these as tool results with `isError: true` and text like
`Error 422 envelope_incomplete: …` — explain them to the user in plain language.
