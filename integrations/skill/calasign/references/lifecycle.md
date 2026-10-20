# Envelope lifecycle and statuses

```
draft ──send──► sent ──all signed──► finalizing ──sealed──► completed
                 │                        (PAdES seal + completion certificate)
                 ├──a signer declines──► declined
                 ├──void (sender)──────► voided
                 ├──expiresAt passes───► expired
                 └──certificate signing pending──► awaiting_certificates ──all signed──► finalizing ──► completed
```

| Envelope status | Meaning | What you can do |
|---|---|---|
| `draft` | Being prepared; nobody was notified | Edit, upload, set recipients/fields, delete, send |
| `sent` | In progress, waiting for signatures | Remind, void, correct (`POST /v1/envelopes/{id}/corrections`), embedded signing URL |
| `finalizing` | Everyone signed; the final PDF is being sealed (seconds) | Wait |
| `awaiting_certificates` | Waiting for signers who sign with their own digital certificate | Remind, void |
| `completed` | Done. Signed PDF available | Download `signed.pdf`, events |
| `declined` | A signer declined (reason in recipient `declineReason`) | Read reason; create a new envelope if needed |
| `voided` | Cancelled by the sender | — |
| `expired` | Not completed before `expiresAt` (default 30 days after creation) | Create a new envelope |

## Recipients

| Recipient status | Meaning |
|---|---|
| `created` | Not notified yet (draft, or waiting for an earlier routing step) |
| `sent` | Invitation delivered (e-mail/WhatsApp/Telegram) |
| `viewed` | Opened the document |
| `signed` | Signed (signers) / approved (approvers) |
| `completed` | Finished (CC copies receive the final document) |
| `declined` | Declined to sign |
| `delegated` / `reassigned` | Handed over to someone else (allowed if the envelope permits delegation; at most 20 per envelope → `409 too_many_replacements`) |

Roles: `signer` (must have ≥1 `signature` field), `approver` (approves without fields), `cc` (receives a copy).

## Routing order

`routingOrder` groups recipients into steps. Everyone in step 1 is notified at once (parallel); step 2 is
notified only when step 1 is finished; and so on. Example: two co-founders sign in parallel (1, 1), then
the lawyer (2), CC the accountant (3).

## Reminders & expiry

- Manual: `POST /v1/envelopes/{id}/remind` notifies pending recipients of the current step when `sent`; in
  `awaiting_certificates` it re-notifies the certificate signer whose turn it is. Other statuses → `409 not_in_progress`.
  At most once per 10 minutes per envelope; sooner → `429 reminded_recently`. There's also a daily cap per envelope
  (5 per 24 hours by default) → `429 reminder_daily_limit`. Neither has `Retry-After`: don't retry in a loop.
- Automatic: `reminderEveryDays` and `expiryWarningDays` on create/patch.
- `expiresAt`: ISO date-time; default 30 days.

## Evidence

Every action is appended to a hash-chained event log (`GET /v1/envelopes/{id}/events`). The final PDF is
sealed (PAdES B-T/B-LT/B-LTA) and carries a completion certificate. Anyone can verify a signed PDF at
`{{BASE_URL}}/verify`.
