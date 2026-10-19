// Guía: conectores de RR. HH. (BambooHR, HiBob, Factorial), contratos (Ironclad, Juro) y archivado en gestores
// documentales (SharePoint, Box, Drive, Dropbox, OneDrive, S3). Textos propios en tres idiomas (no usan DocsKey salvo
// título y encabezados, que la barra lateral y la búsqueda necesitan).
import { useI18n } from "../../../lib/i18n";
import { useDocsText } from "../../../lib/i18n-docs";
import { apiTabs } from "../samples";
import { CodeTabs, DataTable, DocPage, H2, Md } from "../ui";

const TXT = {
  es: {
    lead: "Conectores listos para usar, configurables desde Ajustes → RR. HH. y contratos sin escribir código: elegís un empleado o contrato, CalaSign arma el sobre con sus datos y, al completarse, devuelve el PDF sellado y el certificado de evidencia al sistema de origen.",
    colProvider: "Conector",
    colAuth: "Conexión",
    colDoes: "Qué hace",
    bamboohr: "Empleado (y su supervisor) → plantilla. Al completarse sube el PDF y la evidencia al legajo (categoría configurable) y escribe el estado en un campo.",
    hibob: "Empleado (y su reportsTo) → plantilla. Sube el firmado a los documentos confidenciales (o compartidos) del empleado.",
    factorial: "Empleado (y su manager) → plantilla. Sube el firmado a los documentos del empleado (carpeta opcional).",
    ironclad: "Workflow: el contrato en borrador + la hoja de firmas de la plantilla; firmantes desde los atributos (counterpartySigner…). Devuelve el firmado con upload-signed (completa el paso de firma). Registro: adjunto signedCopy y estado en una propiedad.",
    juro: "Contrato y firmantes desde Juro; sube la copia firmada como contrato.",
    flows:
      "Un **flujo** une una conexión con una plantilla: de dónde sale cada destinatario (persona del registro por orden, persona con un rol como `manager`, campos del registro o datos fijos), qué campos se prellenan, si el documento a firmar es el del sistema de origen (`documentSource: record`) y qué se devuelve al completarse (`uploadSigned`, `uploadEvidence`, `folder`, `statusProperty`). Cada evento del sobre (enviado, completado, rechazado, anulado, vencido) genera una devolución con reintentos; las credenciales revocadas no se reintentan solas (`409 connector_reauth_required`).",
    webhook:
      "Cada conexión tiene una **URL de webhook secreta** (`webhookUrl`). Pegala en el sistema de origen (webhooks de BambooHR, HiBob, Factorial, Ironclad o Juro, o una automatización de Power Automate/Zapier/Make/n8n con el cuerpo `{\"recordId\": \"…\", \"event\": \"…\"}`) y los flujos con `trigger: webhook` se disparan solos. Un registro con un sobre en curso no genera otro; las reentregas no duplican. `POST /v1/connectors/connections/{id}/rotate-webhook` la regenera.",
    dms:
      "El archivado automático (Ajustes → Almacenamiento, `/v1/storage`) deja cada documento firmado en Google Drive, Dropbox, OneDrive, **SharePoint** (sitio + biblioteca + carpeta) o **Box** (carpetas anidadas), o en un bucket S3. Con `includeEvidence: true` sube además el certificado de evidencia (JSON con la cadena de eventos y sus hashes).",
  },
  "pt-BR": {
    lead: "Conectores prontos para usar, configuráveis em Configurações → RH e contratos sem escrever código: você escolhe um colaborador ou contrato, o CalaSign monta o envelope com os dados e, ao concluir, devolve o PDF selado e o certificado de evidência ao sistema de origem.",
    colProvider: "Conector",
    colAuth: "Conexão",
    colDoes: "O que faz",
    bamboohr: "Colaborador (e o supervisor) → modelo. Ao concluir envia o PDF e a evidência ao prontuário (categoria configurável) e escreve o status num campo.",
    hibob: "Colaborador (e o reportsTo) → modelo. Envia o assinado aos documentos confidenciais (ou compartilhados) do colaborador.",
    factorial: "Colaborador (e o gestor) → modelo. Envia o assinado aos documentos do colaborador (pasta opcional).",
    ironclad: "Workflow: o contrato em rascunho + a folha de assinaturas do modelo; signatários a partir dos atributos (counterpartySigner…). Devolve o assinado com upload-signed (conclui a etapa de assinatura). Registro: anexo signedCopy e status numa propriedade.",
    juro: "Contrato e signatários a partir do Juro; envia a cópia assinada como contrato.",
    flows:
      "Um **fluxo** liga uma conexão a um modelo: de onde sai cada destinatário (pessoa do registro por ordem, pessoa com um papel como `manager`, campos do registro ou dados fixos), quais campos são preenchidos, se o documento é o do sistema de origem (`documentSource: record`) e o que é devolvido ao concluir (`uploadSigned`, `uploadEvidence`, `folder`, `statusProperty`). Cada evento do envelope gera uma devolução com novas tentativas; credenciais revogadas não são retentadas sozinhas (`409 connector_reauth_required`).",
    webhook:
      "Cada conexão tem uma **URL de webhook secreta** (`webhookUrl`). Cole no sistema de origem (webhooks do BambooHR, HiBob, Factorial, Ironclad ou Juro, ou uma automação do Power Automate/Zapier/Make/n8n com o corpo `{\"recordId\": \"…\", \"event\": \"…\"}`) e os fluxos com `trigger: webhook` disparam sozinhos. Um registro com envelope em andamento não gera outro; reentregas não duplicam.",
    dms:
      "O arquivamento automático (Configurações → Armazenamento, `/v1/storage`) deixa cada documento assinado no Google Drive, Dropbox, OneDrive, **SharePoint** (site + biblioteca + pasta) ou **Box** (pastas aninhadas), ou num bucket S3. Com `includeEvidence: true` envia também o certificado de evidência (JSON com a cadeia de eventos e seus hashes).",
  },
  en: {
    lead: "Ready-to-use connectors, configured from Settings → HR and contracts without code: pick an employee or contract, CalaSign builds the envelope from its data and, on completion, returns the sealed PDF and the evidence certificate to the source system.",
    colProvider: "Connector",
    colAuth: "Connection",
    colDoes: "What it does",
    bamboohr: "Employee (and supervisor) → template. On completion uploads the PDF and evidence to the employee file (configurable category) and writes the status to a field.",
    hibob: "Employee (and reportsTo) → template. Uploads the signed copy to the employee's confidential (or shared) documents.",
    factorial: "Employee (and manager) → template. Uploads the signed copy to the employee's documents (optional folder).",
    ironclad: "Workflow: the draft contract + the template's signature page; signers from the attributes (counterpartySigner…). Returns the signed copy via upload-signed (completes the signature step). Record: signedCopy attachment and status in a property.",
    juro: "Contract and signers from Juro; uploads the signed copy as a contract.",
    flows:
      "A **flow** links a connection to a template: where each recipient comes from (person on the record by order, person with a role such as `manager`, record fields or fixed data), which fields are prefilled, whether the document is the source system's (`documentSource: record`) and what is returned on completion (`uploadSigned`, `uploadEvidence`, `folder`, `statusProperty`). Each envelope event produces a return with retries; revoked credentials are not retried automatically (`409 connector_reauth_required`).",
    webhook:
      "Each connection has a **secret webhook URL** (`webhookUrl`). Paste it in the source system (BambooHR, HiBob, Factorial, Ironclad or Juro webhooks, or a Power Automate/Zapier/Make/n8n automation with the body `{\"recordId\": \"…\", \"event\": \"…\"}`) and flows with `trigger: webhook` fire on their own. A record with an envelope in progress doesn't get another one; redeliveries don't duplicate.",
    dms:
      "Automatic archiving (Settings → Storage, `/v1/storage`) drops every signed document in Google Drive, Dropbox, OneDrive, **SharePoint** (site + library + folder) or **Box** (nested folders), or an S3 bucket. With `includeEvidence: true` it also uploads the evidence certificate (JSON with the event chain and its hashes).",
  },
};

export function HrContractsGuide() {
  const t = useDocsText();
  const { locale } = useI18n();
  const x = TXT[locale as keyof typeof TXT] ?? TXT.es;
  return (
    <DocPage title={t("g.hrclm.title")} lead={x.lead}>
      <H2 id="providers">{t("g.hrclm.providers.h")}</H2>
      <DataTable
        head={[x.colProvider, x.colAuth, x.colDoes]}
        rows={[
          [<strong key="b">BambooHR</strong>, "API key", x.bamboohr],
          [<strong key="h">HiBob</strong>, "Service user", x.hibob],
          [<strong key="f">Factorial</strong>, "API key / OAuth", x.factorial],
          [<strong key="i">Ironclad</strong>, "OAuth (PKCE) / API token", x.ironclad],
          [<strong key="j">Juro</strong>, "API key", x.juro],
        ]}
      />
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/connectors/connections", body: { provider: "bamboohr", name: "BambooHR", credentials: { companyDomain: "acme", apiKey: "…" } } })} />

      <H2 id="flows">{t("g.hrclm.flows.h")}</H2>
      <Md text={x.flows} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/connectors/flows",
          body: {
            connectionId: "CONNECTION_ID",
            name: "Onboarding",
            objectType: "employee",
            templateId: "TEMPLATE_ID",
            roles: [
              { role: "Empleado", source: "contact", index: 0 },
              { role: "Jefe", source: "contact_role", contactRole: "manager" },
            ],
            prefill: [{ field: "Cargo", property: "jobTitle" }],
            writeBack: { uploadSigned: true, uploadEvidence: true, statusProperty: "customCalaSign" },
          },
        })}
      />
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/connectors/flows/{flowId}/send", body: { recordId: "101" } })} />

      <H2 id="webhook">{t("g.hrclm.webhook.h")}</H2>
      <Md text={x.webhook} />

      <H2 id="dms">{t("g.hrclm.dms.h")}</H2>
      <Md text={x.dms} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/storage/oauth/sharepoint/start",
          body: { name: "Legal", siteUrl: "https://empresa.sharepoint.com/sites/Legal", library: "Contratos", folder: "Firmados/2026", includeEvidence: true },
        })}
      />
    </DocPage>
  );
}
