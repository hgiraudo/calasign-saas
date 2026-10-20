# CalaSign

CalaSign is an electronic signature service for Latin America (Dominican Republic, Honduras, Colombia and Brazil). With this connector you can send documents and templates for signature from Power Automate, Logic Apps, Power Apps and Copilot Studio, react to signature events and store the signed PDF anywhere.

## Publisher: CalaSign

## Prerequisites

- A CalaSign account with API access (plan Starter or higher for webhooks).
- An API key: in CalaSign go to **Settings → API keys → Create**.

## Supported operations

### Triggers

- **When an envelope event occurs**: starts the flow when an envelope is sent, completed, declined, voided or expires, or when a recipient views, signs, approves or declines. The subscription is created when the flow is saved and deleted when the flow is deleted.

### Actions

- **Send an envelope from a template**: pick a template; the form shows one recipient per template role and the prefillable fields (dynamic schema).
- **Get envelope status**.
- **Download the signed document**: PDF content, ready for SharePoint, OneDrive, Dataverse notes or email attachments.
- **List envelopes**, **List templates**.
- **Create a draft envelope**, **Add a PDF document to a draft**, **Set the recipients of a draft**, **Set the fields of a draft** (by anchor text such as `\firma1\` or by coordinates) and **Send a draft envelope**: to send any PDF without a template.
- **Void an envelope**, **Remind pending recipients**.

## Obtaining credentials

Create an API key in CalaSign and, when creating the connection, paste it with the `Bearer ` prefix: `Bearer cs_live_…`.

An OAuth 2.0 variant is provided in `apiProperties.oauth.json` (authorization code + refresh token, scopes `envelopes:read envelopes:write templates:read webhooks:manage offline_access`).

## Getting started

1. Trigger **When an envelope event occurs** with the event `envelope.completed`.
2. Action **Download the signed document** with the envelope ID from the trigger.
3. Action **SharePoint – Create file** with the file content.

## Known issues and limitations

- One subscription per flow; an organization can have up to 20 webhooks.
- The signed document is available only when the envelope status is `completed`.
- Revoking the API key (or OAuth authorization) that created the trigger subscription, or reconnecting the connection with another key, deactivates the subscription and the flow silently stops firing. Turn the flow off and on again (or re-save it) to subscribe again with the current connection.
- Idempotency keys are shared by every call made with the same connection and are tied to the request: use a different key for each action (for example `@{workflow().run.name}-create` and `@{workflow().run.name}-send`) and, inside an *Apply to each* loop, add the item index or ID. Reusing one key for two different calls returns `409 idempotency_mismatch`.

## Deployment instructions

```bash
paconn create --api-def apiDefinition.swagger.json --api-prop apiProperties.json --icon icon.png
# or, with the Power Platform CLI:
pac connector create --api-definition-file apiDefinition.swagger.json --api-properties-file apiProperties.json --icon-file icon.png
```
