// Guías por funcionalidad. Cada una es una página corta: qué es, los pedidos y los detalles que suelen fallar.
import { useDocsText } from "../../../lib/i18n-docs";
import { BASE } from "../constants";
import { apiTabs, sdkNode, sdkPy } from "../samples";
import { Callout, Code, CodeTabs, DataTable, DocPage, H2, Md, Step, Steps } from "../ui";

export function TemplatesGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.tpl.title")} lead={t("g.tpl.lead")}>
      <H2 id="roles">{t("g.tpl.roles.h")}</H2>
      <Md text={t("g.tpl.roles.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/templates/{templateId}/roles",
          body: {
            roles: [
              { name: "Cliente", role: "signer", routingOrder: 1 },
              { name: "Empresa", role: "signer", routingOrder: 2 },
            ],
          },
        })}
      />
      <Md text={t("g.tpl.roles.list")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/templates", query: { q: "contrato" }, extra: [sdkPy(`templates = cs.templates.list(q="contrato")`), sdkNode(`const templates = await cs.templates.list("contrato");`)] })} />

      <H2 id="send">{t("g.tpl.send.h")}</H2>
      <Md text={t("g.tpl.send.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/from-template",
          body: {
            templateId: "TEMPLATE_ID",
            subject: "Contrato de alquiler — Depto 4B",
            recipients: [
              { role: "Cliente", name: "Ana Pérez", email: "ana@example.com" },
              { role: "Empresa", name: "Bruno Costa", email: "bruno@inmobiliaria.com", phone: "+18095550123", channels: ["email", "whatsapp"] },
            ],
            prefill: { "Monto mensual": "1500", Inmueble: "Av. Winston Churchill 101, 4B" },
            metadata: { contractId: "ALQ-2026-0042" },
            send: true,
          },
          extra: [
            sdkPy(`detail = cs.envelopes.from_template({
    "templateId": template_id,
    "recipients": [{"role": "Cliente", "name": "Ana Pérez", "email": "ana@example.com"},
                   {"role": "Empresa", "name": "Bruno Costa", "email": "bruno@inmobiliaria.com"}],
    "prefill": {"Monto mensual": "1500"},
    "send": True,
})`),
            sdkNode(`const detail = await cs.envelopes.fromTemplate({
  templateId,
  recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" },
               { role: "Empresa", name: "Bruno Costa", email: "bruno@inmobiliaria.com" }],
  prefill: { "Monto mensual": "1500" },
  send: true,
});`),
          ],
        })}
      />
      <Callout kind="warn">{t("g.tpl.send.idem")}</Callout>

      <H2 id="prefill">{t("g.tpl.prefill.h")}</H2>
      <Md text={t("g.tpl.prefill.p")} />
    </DocPage>
  );
}

export function EmbeddedGuide() {
  const t = useDocsText();
  const frontend = `<iframe id="calasign" src="" title="CalaSign" style="width:100%;height:90vh;border:0"
        allow="camera; clipboard-write"></iframe>
<script>
  const frame = document.getElementById("calasign");
  frame.src = signingUrl;
  const calasignOrigin = new URL(signingUrl).origin;

  window.addEventListener("message", (e) => {
    if (e.origin !== calasignOrigin || e.data?.source !== "calasign") return;
    switch (e.data.type) {
      case "viewed":           onViewed(); break;
      case "signing_complete": onSigned(e.data.envelopeId); break;
      case "declined":         onDeclined(); break;
      case "closed":           onClosed(e.data.status); break;
      case "error":            requestNewUrl(); break;
    }
  });
</script>`;
  return (
    <DocPage title={t("g.embed.title")} lead={t("g.embed.lead")}>
      <Steps>
        <Step title={t("g.embed.s1")} />
        <Step title={t("g.embed.s2")} />
        <Step title={t("g.embed.s3")} />
        <Step title={t("g.embed.s4")} />
      </Steps>

      <H2 id="origins">{t("g.embed.origins.h")}</H2>
      <Md text={t("g.embed.origins.p")} />
      <CodeTabs tabs={apiTabs({ method: "PATCH", path: "/v1/settings/embed", body: { frameAncestors: ["https://app.tuempresa.com"] } })} />

      <H2 id="recipient">{t("g.embed.recipient.h")}</H2>
      <Md text={t("g.embed.recipient.p")} />
      <Code
        lang="json"
        code={`{ "recipients": [ { "id": "9b2d1c7e-4a8f-4e1b-9c3d-2f6a8b0c1d2e", "name": "Ana Pérez",
                      "email": "ana@example.com", "embedded": true } ] }`}
      />

      <H2 id="url">{t("g.embed.url.h")}</H2>
      <Md text={t("g.embed.url.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/recipients/{recipientId}/signing-url",
          body: { returnUrl: "https://app.tuempresa.com/firma-lista" },
          extra: [
            sdkPy(`r = cs.envelopes.signing_url(envelope_id, recipient_id, return_url="https://app.tuempresa.com/firma-lista")`),
            sdkNode(`const { url } = await cs.envelopes.signingUrl(envelopeId, recipientId, { returnUrl: "https://app.tuempresa.com/firma-lista" });`),
          ],
        })}
      />
      <Code lang="json" title="201 Created" code={`{ "url": "${BASE}/embed/Xk2…", "expiresAt": "2026-10-18T15:05:00.000Z" }`} />

      <H2 id="iframe">{t("g.embed.iframe.h")}</H2>
      <Md text={t("g.embed.iframe.p")} />
      <Code lang="xml" title="HTML" code={frontend} />

      <H2 id="events">{t("g.embed.events.h")}</H2>
      <DataTable
        head={["type", t("concepts.col.meaning")]}
        rows={[
          [<code key="1">viewed</code>, t("g.embed.ev.viewed")],
          [<code key="2">signing_complete</code>, t("g.embed.ev.complete")],
          [<code key="3">declined</code>, t("g.embed.ev.declined")],
          [<code key="4">closed</code>, t("g.embed.ev.closed")],
          [<code key="5">error</code>, t("g.embed.ev.error")],
        ]}
      />
      <Md text={t("g.embed.events.p")} />
      <Callout kind="warn">{t("g.embed.security")}</Callout>
    </DocPage>
  );
}

export function AnchorsGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.anchor.title")} lead={t("g.anchor.lead")}>
      <H2 id="how">{t("g.anchor.how.h")}</H2>
      <Md text={t("g.anchor.how.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/envelopes/{envelopeId}/fields",
          body: {
            fields: [
              { recipientId: "CLIENTE_ID", type: "signature", anchor: { text: "[[firma_cliente]]", offsetY: -40, width: 160, height: 40 } },
              { recipientId: "CLIENTE_ID", type: "date_signed", anchor: { text: "[[fecha_cliente]]", width: 90, height: 14, ignoreIfNotPresent: true } },
              { recipientId: "CLIENTE_ID", type: "dropdown", options: ["Mensual", "Anual"], anchor: { text: "[[plan]]", width: 120, height: 18 } },
            ],
          },
        })}
      />
      <H2 id="options">{t("g.anchor.options.h")}</H2>
      <DataTable
        head={[t("g.anchor.col.prop"), t("g.anchor.col.default"), t("concepts.col.meaning")]}
        rows={[
          [<code key="1">anchor.text</code>, "—", t("g.anchor.o.text")],
          [<code key="2">anchor.width / height</code>, "—", t("g.anchor.o.size")],
          [<code key="3">anchor.offsetX / offsetY</code>, "0", t("g.anchor.o.offset")],
          [<code key="4">anchor.caseSensitive</code>, "true", t("g.anchor.o.case")],
          [<code key="5">anchor.ignoreIfNotPresent</code>, "false", t("g.anchor.o.ignore")],
          [<code key="6">documentId</code>, t("g.anchor.o.alldocs"), t("g.anchor.o.doc")],
        ]}
      />
      <H2 id="tips">{t("g.anchor.tips.h")}</H2>
      <Md text={t("g.anchor.tips.p")} />
    </DocPage>
  );
}

export function BulkGuide() {
  const t = useDocsText();
  const csv = `Cliente.name,Cliente.email,Cliente.phone,Cliente.channels,field.Monto mensual,subject
Ana Pérez,ana@example.com,,email,1500,Contrato Ana Pérez
João Silva,joao@example.com.br,+5511999990000,email;whatsapp,2300,Contrato João Silva`;
  return (
    <DocPage title={t("g.bulk.title")} lead={t("g.bulk.lead")}>
      <H2 id="csv">{t("g.bulk.csv.h")}</H2>
      <Md text={t("g.bulk.csv.p")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/templates/{templateId}/bulk-csv", saveAs: "envio-masivo.csv" })} />
      <Code lang="text" title="envio-masivo.csv" code={csv} />
      <Md text={t("g.bulk.validate")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/bulk-sends",
          body: { templateId: "TEMPLATE_ID", name: "Renovaciones octubre", csv: "Cliente.name,Cliente.email,…\nAna Pérez,ana@example.com,…", skipInvalid: true },
        })}
      />
      <H2 id="json">{t("g.bulk.json.h")}</H2>
      <Md text={t("g.bulk.json.p")} />
      <Code
        lang="json"
        code={`{
  "templateId": "TEMPLATE_ID",
  "name": "Renovaciones octubre",
  "rows": [
    { "recipients": [ { "role": "Cliente", "name": "Ana Pérez", "email": "ana@example.com" } ],
      "prefill": { "Monto mensual": "1500" },
      "metadata": { "clienteId": "C-001" } },
    { "recipients": [ { "role": "Cliente", "name": "João Silva", "email": "joao@example.com.br" } ],
      "prefill": { "Monto mensual": "2300" },
      "metadata": { "clienteId": "C-002" } }
  ]
}`}
      />
      <H2 id="track">{t("g.bulk.track.h")}</H2>
      <Md text={t("g.bulk.track.p")} />
    </DocPage>
  );
}

export function WebFormsGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.forms.title")} lead={t("g.forms.lead")}>
      <H2 id="create">{t("g.forms.create.h")}</H2>
      <Md text={t("g.forms.create.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/web-forms",
          body: {
            templateId: "TEMPLATE_ID",
            name: "Alta de socios 2026",
            description: "Completá tus datos y firmá el reglamento.",
            signerRoleId: "ROLE_ID_SOCIO",
            fixedRecipients: [{ roleId: "ROLE_ID_CLUB", name: "Club Atlético", email: "secretaria@club.org" }],
            requireOtp: true,
            maxUses: 500,
          },
        })}
      />
      <H2 id="share">{t("g.forms.share.h")}</H2>
      <Md text={t("g.forms.share.p")} />
    </DocPage>
  );
}

export function RemindersGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.rem.title")} lead={t("g.rem.lead")}>
      <H2 id="automatic">{t("g.rem.auto.h")}</H2>
      <Md text={t("g.rem.auto.p")} />
      <Code
        lang="json"
        title="POST /v1/envelopes · PATCH /v1/envelopes/{id}"
        code={`{
  "subject": "Contrato de servicios",
  "expiresAt": "2026-12-31T23:59:59-03:00",
  "reminderEveryDays": 3,
  "expiryWarningDays": 2,
  "allowDelegation": true
}`}
      />
      <H2 id="manual">{t("g.rem.manual.h")}</H2>
      <Md text={t("g.rem.manual.p")} />
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/envelopes/{envelopeId}/remind", extra: [sdkPy(`cs.envelopes.remind(envelope_id)  # {"notified": 1}`)] })} />
      <H2 id="expiration">{t("g.rem.exp.h")}</H2>
      <Md text={t("g.rem.exp.p")} />
      <H2 id="corrections">{t("g.rem.corr.h")}</H2>
      <Md text={t("g.rem.corr.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/corrections",
          body: {
            reason: "El cliente pidió cambiar el correo",
            expiresAt: "2026-12-31T23:59:59-03:00",
            updateRecipients: [{ id: "RECIPIENT_ID", email: "ana.perez@nuevo-dominio.com" }],
          },
        })}
      />
      <Md text={t("g.rem.reassign")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/recipients/{recipientId}/reassign",
          body: { name: "Carla Gómez", email: "carla@cliente.com", reason: "Ana está de licencia" },
        })}
      />
    </DocPage>
  );
}

export function CertificateGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.cert.title")} lead={t("g.cert.lead")}>
      <H2 id="setup">{t("g.cert.setup.h")}</H2>
      <Md text={t("g.cert.setup.p")} />
      <Code
        lang="json"
        title="PUT /v1/envelopes/{id}/recipients"
        code={`{
  "recipients": [
    {
      "name": "João Silva",
      "email": "joao@example.com.br",
      "idDocumentType": "cpf",
      "idDocumentNumber": "123.456.789-09",
      "signatureType": "certificate",
      "certificateRequirements": {
        "matchIdDocument": true,
        "allowedIssuers": ["ICP-Brasil"],
        "requireQualified": false
      }
    }
  ]
}`}
      />
      <H2 id="flow">{t("g.cert.flow.h")}</H2>
      <Md text={t("g.cert.flow.p")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/envelopes/{envelopeId}/certificate-signatures" })} />
      <H2 id="requirements">{t("g.cert.req.h")}</H2>
      <Md text={t("g.cert.req.p")} />
    </DocPage>
  );
}

export function IdentityGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.idv.title")} lead={t("g.idv.lead")}>
      <H2 id="auth">{t("g.idv.auth.h")}</H2>
      <Md text={t("g.idv.auth.p")} />
      <Code
        lang="json"
        code={`{ "recipients": [ { "name": "Ana Pérez", "email": "ana@example.com", "phone": "+5491122334455",
                      "authMethod": "otp_whatsapp" } ] }`}
      />
      <H2 id="kyc">{t("g.idv.kyc.h")}</H2>
      <Md text={t("g.idv.kyc.p")} />
      <Code
        lang="json"
        code={`{ "recipients": [ { "name": "Ana Pérez", "email": "ana@example.com",
                      "idDocumentType": "cedula", "idDocumentNumber": "001-1234567-8",
                      "idVerification": { "provider": "truora", "level": "document_selfie" } } ] }`}
      />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/envelopes/{envelopeId}/recipients/{recipientId}/identity" })} />
    </DocPage>
  );
}

export function PaymentsGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.pay.title")} lead={t("g.pay.lead")}>
      <H2 id="configure">{t("g.pay.conf.h")}</H2>
      <Md text={t("g.pay.conf.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/envelopes/{envelopeId}/payment",
          body: { amount: 150.5, currency: "BRL", description: "Primera cuota", payerRecipientId: "RECIPIENT_ID", timing: "after_sign", provider: "mercadopago" },
        })}
      />
      <H2 id="timing">{t("g.pay.timing.h")}</H2>
      <Md text={t("g.pay.timing.p")} />
    </DocPage>
  );
}

export function CrmGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.crm.title")} lead={t("g.crm.lead")}>
      <H2 id="providers">{t("g.crm.providers.h")}</H2>
      <DataTable
        head={[t("g.crm.col.provider"), t("g.crm.col.does")]}
        rows={[
          [<strong key="h">HubSpot</strong>, t("g.crm.hubspot")],
          [<strong key="s">Salesforce</strong>, t("g.crm.salesforce")],
          [<strong key="z">Zoho CRM / Bigin</strong>, t("g.crm.zoho")],
          [<strong key="i">Siigo</strong>, t("g.crm.siigo")],
          [<strong key="a">Alegra</strong>, t("g.crm.alegra")],
          [<strong key="p">Pipedrive</strong>, t("g.crm.pipedrive")],
          [<strong key="r">RD Station CRM</strong>, t("g.crm.rdstation")],
          [<strong key="k">Kommo</strong>, t("g.crm.kommo")],
        ]}
      />
      <H2 id="mappings">{t("g.crm.mappings.h")}</H2>
      <Md text={t("g.crm.mappings.p")} />
      <H2 id="pipedrive">{t("g.crm.pipedrive.h")}</H2>
      <Md text={t("g.crm.pipedrive.p")} />
      <H2 id="rdstation">{t("g.crm.rdstation.h")}</H2>
      <Md text={t("g.crm.rdstation.p")} />
      <H2 id="kommo">{t("g.crm.kommo.h")}</H2>
      <Md text={t("g.crm.kommo.p")} />
    </DocPage>
  );
}

export function DomainGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.domain.title")} lead={t("g.domain.lead")}>
      <H2 id="dns">{t("g.domain.dns.h")}</H2>
      <CodeTabs tabs={apiTabs({ method: "PUT", path: "/v1/domains", body: { domain: "firmas.tuempresa.com" } })} />
      <Md text={t("g.domain.dns.p")} />
      <Code
        lang="text"
        title="DNS"
        code={`_calasign-challenge.firmas.tuempresa.com.  TXT    "calasign-verify=<txtValue>"
firmas.tuempresa.com.                      CNAME  ${new URL(BASE).host}.`}
      />
      <H2 id="verify">{t("g.domain.verify.h")}</H2>
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/domains/verify" })} />
      <Md text={t("g.domain.verify.p")} />
    </DocPage>
  );
}

export function BrandingGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.brand.title")} lead={t("g.brand.lead")}>
      <H2 id="api">{t("g.brand.api.h")}</H2>
      <CodeTabs tabs={apiTabs({ method: "PATCH", path: "/v1/settings/branding", body: { primaryColor: "#0d9488", emailFooter: "Inmobiliaria Caribe · Santo Domingo" } })} />
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/settings/branding/logo", multipart: { field: "file", file: "logo.png" } })} />
      <Md text={t("g.brand.api.p")} />
    </DocPage>
  );
}
