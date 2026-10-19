import { CHANNELS, ENVELOPE_STATUSES, FIELD_TYPES, RECIPIENT_ROLES, RECIPIENT_STATUSES } from "@calasign/shared";
import { useDocsText, type DocsKey } from "../../../lib/i18n-docs";
import { Callout, Code, DataTable, DocPage, H2, H3, Md } from "../ui";

/** Diagrama de estados del sobre (SVG accesible, colores del tema). */
function LifecycleDiagram() {
  const t = useDocsText();
  const node = (x: number, y: number, label: string, cls: string) => (
    <g key={label} className={`lc-node lc-${cls}`}>
      <rect x={x} y={y} width="150" height="40" rx="8" />
      <text x={x + 75} y={y + 25} textAnchor="middle">
        {label}
      </text>
    </g>
  );
  const arrow = (d: string, key: string) => <path key={key} d={d} className="lc-edge" markerEnd="url(#lc-arrow)" />;
  return (
    <figure className="docs-figure">
      <svg viewBox="0 0 760 300" role="img" aria-labelledby="lc-title lc-desc" className="lc-svg">
        <title id="lc-title">{t("concepts.lifecycle.alt.t")}</title>
        <desc id="lc-desc">{t("concepts.lifecycle.alt.d")}</desc>
        <defs>
          <marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="lc-head" />
          </marker>
        </defs>
        {arrow("M160,60 L205,60", "a1")}
        {arrow("M360,60 L405,60", "a2")}
        {arrow("M560,60 L605,60", "a3")}
        {arrow("M285,80 L285,140", "a4")}
        {arrow("M250,80 C200,170 120,180 95,240", "a5")}
        {arrow("M285,80 C285,180 260,200 255,240", "a6")}
        {arrow("M345,80 C440,130 460,190 440,240", "a7")}
        {arrow("M360,160 C420,160 470,120 470,82", "a8")}
        {arrow("M285,180 C300,215 330,230 400,252", "a9")}
        {node(10, 40, "draft", "draft")}
        {node(210, 40, "sent", "sent")}
        {node(410, 40, "finalizing", "finalizing")}
        {node(610, 40, "completed", "completed")}
        {node(210, 140, "awaiting_certificates", "awaiting")}
        {node(20, 240, "declined", "declined")}
        {node(180, 240, "expired", "expired")}
        {node(345, 240, "voided", "voided")}
      </svg>
      <figcaption>{t("concepts.lifecycle.caption")}</figcaption>
    </figure>
  );
}

export function ConceptsPage() {
  const t = useDocsText();
  const k = (s: string) => s as DocsKey;
  return (
    <DocPage title={t("concepts.title")} lead={t("concepts.lead")}>
      <H2 id="lifecycle">{t("concepts.lifecycle.h")}</H2>
      <Md text={t("concepts.lifecycle.p")} />
      <LifecycleDiagram />
      <DataTable
        head={["status", t("concepts.col.meaning")]}
        rows={ENVELOPE_STATUSES.map((s) => [<code key={s}>{s}</code>, <Md key="d" text={t(k(`concepts.status.${s}`))} />])}
      />

      <H2 id="recipients">{t("concepts.recipients.h")}</H2>
      <Md text={t("concepts.recipients.p")} />
      <DataTable
        head={["role", t("concepts.col.meaning")]}
        rows={RECIPIENT_ROLES.map((r) => [<code key={r}>{r}</code>, <Md key="d" text={t(k(`concepts.role.${r}`))} />])}
      />
      <H3 id="recipient-status">{t("concepts.rstatus.h")}</H3>
      <DataTable
        head={["status", t("concepts.col.meaning")]}
        rows={RECIPIENT_STATUSES.map((s) => [<code key={s}>{s}</code>, <Md key="d" text={t(k(`concepts.rstatus.${s}`))} />])}
      />
      <H3 id="channels">{t("concepts.channels.h")}</H3>
      <Md text={t("concepts.channels.p", { channels: CHANNELS.map((c) => `\`${c}\``).join(", ") })} />

      <H2 id="routing">{t("concepts.routing.h")}</H2>
      <Md text={t("concepts.routing.p")} />
      <Code
        lang="json"
        title={t("concepts.routing.example")}
        code={`{
  "recipients": [
    { "name": "Ana (área legal)", "email": "ana@empresa.com", "role": "approver", "routingOrder": 1 },
    { "name": "Bruno Costa",      "email": "bruno@cliente.com", "routingOrder": 2 },
    { "name": "Carla Gómez",      "email": "carla@cliente.com", "routingOrder": 2 },
    { "name": "Contabilidad",     "email": "conta@empresa.com", "role": "cc", "routingOrder": 3 }
  ]
}`}
      />

      <H2 id="documents">{t("concepts.documents.h")}</H2>
      <Md text={t("concepts.documents.p")} />

      <H2 id="fields">{t("concepts.fields.h")}</H2>
      <Md text={t("concepts.fields.p")} />
      <DataTable
        head={["type", t("concepts.col.meaning")]}
        rows={FIELD_TYPES.map((f) => [<code key={f}>{f}</code>, <Md key="d" text={t(k(`concepts.field.${f}`))} />])}
      />
      <H3 id="field-logic">{t("concepts.logic.h")}</H3>
      <Md text={t("concepts.logic.p")} />
      <Code
        lang="json"
        code={`{
  "fields": [
    { "id": "6f1c…", "documentId": "…", "recipientId": "…", "type": "checkbox", "label": "Acepta seguro",
      "page": 0, "x": 0.1, "y": 0.5, "width": 0.03, "height": 0.02, "required": false },
    { "documentId": "…", "recipientId": "…", "type": "text", "label": "Póliza",
      "page": 0, "x": 0.2, "y": 0.5, "width": 0.3, "height": 0.03,
      "conditions": [ { "fieldId": "6f1c…", "operator": "checked" } ] },
    { "documentId": "…", "recipientId": "…", "type": "number", "label": "Total",
      "page": 1, "x": 0.6, "y": 0.7, "width": 0.2, "height": 0.03, "formula": "{Precio} * {Cantidad}" }
  ]
}`}
      />

      <H2 id="templates">{t("concepts.templates.h")}</H2>
      <Md text={t("concepts.templates.p")} />

      <H2 id="evidence">{t("concepts.evidence.h")}</H2>
      <Md text={t("concepts.evidence.p")} />
      <Callout kind="info">{t("concepts.evidence.agent")}</Callout>

      <H2 id="pades">{t("concepts.pades.h")}</H2>
      <Md text={t("concepts.pades.p")} />
      <DataTable
        head={[t("concepts.pades.col.level"), t("concepts.pades.col.adds")]}
        rows={[
          ["PAdES B-B", t("concepts.pades.bb")],
          ["PAdES B-T", t("concepts.pades.bt")],
          ["PAdES B-LT", t("concepts.pades.blt")],
          ["PAdES B-LTA", t("concepts.pades.blta")],
        ]}
      />

      <H2 id="verification">{t("concepts.verify.h")}</H2>
      <Md text={t("concepts.verify.p")} />
    </DocPage>
  );
}
