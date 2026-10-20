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
| 400 | `invalid_role` | Web form: the role of whoever fills it in must be a signer role in the template's first routing step, with no fixed recipient |
| 400 | `invalid_form` | Web form: the template isn't complete with this configuration, or `embeddable` together with `requireOtp` (not allowed) |
| 400 | `invalid_brand` | `brandId` isn't a sub-brand of the organization (choosing a different sub-brand also needs the white-label plan → 402) |
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
| 409 | `version_changed` | Drafts and templates: you sent `X-Expected-Updated-At` (the `updatedAt` you read) and someone changed the draft/template meanwhile → `details.updatedAt` has the current value; re-read, review and repeat. Negotiations: there's a new version → review and repeat |
| 409 | `member_changed` | The member's role changed meanwhile → re-read and repeat |
| 409 | `not_embedded` | Signing URL requested for a non-embedded recipient that only authenticates with the emailed link → create it with `embedded: true` or require an OTP code |
| 409 | `otp_not_embeddable` | Signing URL requested with `frameAncestors` for a signer with an OTP code → open it in a tab/redirect (`tabOnly: true`) or remove the OTP |
| 409 | `template_has_forms` | Deleting a template with web forms that still accept submissions (active, not expired or used up); `details.names` lists them → deactivate or delete them first |
| 409 | `delivery_pending` | Webhook delivery retry while an attempt is running or a manual retry is already queued → wait |
| 410 | `purged` | The envelope's originals were deleted by the retention policy (counted from completion, void, decline or expiry): original download, template from envelope, AI. The signed PDF and evidence remain → no retry |
| 409 | `purged` | Cloning an envelope whose originals were purged by retention → can't clone it |
| 409 | `proposal_outdated` | The text changed since the proposal was made → reject it and ask for a new one |
| 409 | `too_many_replacements` | Envelope already had 20 delegations/reassignments → void and resend if needed |
| 413 | `file_too_large` | PDF over the size limit (25 MB by default) |
| 413 | `ai_input_too_large` | Document too long for the AI assistant → no retry |
| 422 | `envelope_incomplete` | Can't send: `details.problems[]` (no document, no signer, signer without signature field, expiry in the past) |
| 422 | `logic_order` | A field condition cites a field of someone who signs later (or at the same time) → reorder recipients/roles or cite a read-only field / an earlier signer's field; `details.problems[]` lists them. Problems the draft already had don't block other edits |
| 422 | `pdf_too_heavy` | PDF too complex to search for anchors → use coordinates |
| 429 | `rate_limited` (generic; older deployments sent `bad_request`) | Per-IP rate limit → wait for `Retry-After` (seconds) and retry |
| 429 | `reminded_recently`, `form_rate_limited`, `workflow_rate_limited`, `ai_signer_limit`, `ai_budget_exceeded`, `too_many_comments`, `too_many_proposals`, `archive_recently_renewed`, `too_many_attempts` | Business cap (specific code, **no** `Retry-After`) → don't retry in a loop; tell the user or try much later |
| 502 | `tsa_unavailable` | Timestamp authority failed → retry in a few minutes |
| 503 | `pdf_reader_busy` | Temporary → retry shortly |
| 503 | `byok_key_unavailable` | The organization's own encryption key (BYOK) is unavailable → an admin must restore access to the key; retry later |
| 5xx | `internal_error` | Retry with the same `Idempotency-Key` |

MCP tools return these as tool results with `isError: true` and text like
`Error 422 envelope_incomplete: …` — explain them to the user in plain language.
