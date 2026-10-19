# n8n-nodes-calasign

Community nodes for [CalaSign]({{BASE_URL}}) e-signature.

- **CalaSign**: send an envelope from a template (recipients per role and prefilled fields loaded from the template), send a PDF from a binary property to one or more signers (signatures on the last page or on the anchor texts `\firma1\`, `\firma2\`…), get / list envelopes, download the signed PDF, void, remind; list templates.
- **CalaSign Trigger**: starts a workflow on `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved`. It registers the webhook when the workflow is activated, removes it when deactivated, and verifies the `CalaSign-Signature` HMAC.

## Credentials

- **CalaSign API** (API key): CalaSign → Settings → API keys. Base URL `{{BASE_URL}}` (change it for a custom domain).
- **CalaSign OAuth2 API** (authorization code + PKCE): create an OAuth app in CalaSign (Settings → OAuth apps) with the redirect URL that n8n shows, grant types *authorization code*, scopes `envelopes:read envelopes:write templates:read webhooks:manage offline_access`.

## Install

Self-hosted n8n (from the package published by CalaSign):

```bash
cd ~/.n8n/nodes && npm install {{BASE_URL}}/integrations/connectors/n8n/n8n-nodes-calasign-{{VERSION}}.tgz
# restart n8n
```

Once published on npm: *Settings → Community Nodes → Install → `n8n-nodes-calasign`*.

## Compatibility

n8n 1.x and 2.x (`n8nNodesApiVersion` 1). No runtime dependencies.
