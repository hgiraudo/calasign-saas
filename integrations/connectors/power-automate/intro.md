## CalaSign

Send documents for electronic signature and react to signature events. Use templates with dynamic recipients and fields, track every signer, and download the signed PDF to SharePoint, OneDrive, Dataverse or email.

### Prerequisites

A CalaSign account and an API key (Settings → API keys).

### How to get credentials

Create an API key in CalaSign and paste it as `Bearer cs_live_…` when creating the connection.

### Get started with your connector

Create a flow with **When an envelope event occurs** (event `envelope.completed`) followed by **Download the signed document**.

### Known issues and limitations

Up to 20 webhook subscriptions per organization.

### Common errors and remedies

- `401`: the API key is wrong or does not start with `Bearer `.
- `422 envelope_incomplete`: every signer needs a signature field before sending.
- `422 roles_missing`: fill a recipient for every template role.

### FAQ

**Can I send a PDF without a template?** Yes: create a draft, add the document, set recipients and fields, and send it.
