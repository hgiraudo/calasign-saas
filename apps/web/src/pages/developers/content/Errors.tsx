import { useDocsText } from "../../../lib/i18n-docs";
import { BASE } from "../constants";
import { apiTabs } from "../samples";
import { Callout, Code, CodeTabs, DataTable, DocPage, H2, H3, Md } from "../ui";

const CODES: [string, string, string][] = [
  ["400", "validation_error", "err.c.validation"],
  ["400", "invalid_id", "err.c.invalidId"],
  ["400", "invalid_cursor · anchor_not_found · invalid_field · not_pdf · invalid_text · …", "err.c.bad"],
  ["400", "unknown_part · duplicate_part · invalid_json · too_many_documents · duplicate_document", "err.c.oneshot"],
  ["401", "unauthorized", "err.c.unauthorized"],
  ["402", "plan_limit", "err.c.plan"],
  ["403", "forbidden · insufficient_scope", "err.c.forbidden"],
  ["403", "two_factor_setup_required · ai_notice_required · bad_origin", "err.c.forbiddenOther"],
  ["404", "not_found", "err.c.notFound"],
  ["409", "not_draft · not_voidable · not_in_progress · conflict", "err.c.conflict"],
  ["409", "idempotency_mismatch · idempotency_in_progress", "err.c.idem"],
  ["409", "version_changed", "err.c.versionChanged"],
  ["409", "crm_account_unknown · company_mismatch", "err.c.crm"],
  ["410 · 409", "purged", "err.c.purged"],
  ["413", "file_too_large · payload_too_large", "err.c.tooLarge"],
  ["421", "wrong_cell", "err.c.wrongCell"],
  ["422", "roles_missing · rows_invalid · pdf_too_heavy", "err.c.unprocessable"],
  ["429", "rate_limited + retry-after", "err.c.rate"],
  ["429", "reminded_recently · reminder_daily_limit · form_rate_limited · ai_signer_limit · …", "err.c.rateBiz"],
  ["500", "internal_error", "err.c.internal"],
  ["502", "tsa_unavailable · ai_unavailable", "err.c.upstream"],
  ["503", "storage_unavailable · pdf_reader_busy · ai_rate_limited · ai_unavailable", "err.c.unavailable"],
  ["503", "byok_key_unavailable", "err.c.byok"],
  ["504", "ai_timeout", "err.c.aiTimeout"],
];

const LIMITS: [string, string][] = [
  ["*", "600 / min"],
  ["POST /mcp", "300 / min"],
  ["POST /oauth/token · /oauth/revoke · /oauth/introspect", "60 / min"],
  ["POST /oauth/register", "20 / h"],
  ["POST /v1/verify · POST /v1/validate", "20 / min"],
  ["POST /v1/certificates", "20 / min"],
  ["POST /v1/xml/sign", "120 / min"],
  ["/v1/signing/{token}/…", "120 / min"],
  ["POST /v1/auth/login · /v1/auth/signup", "10 / min"],
];

export function ErrorsPage() {
  const t = useDocsText();
  return (
    <DocPage title={t("err.title")} lead={t("err.lead")}>
      <H2 id="format">{t("err.format.h")}</H2>
      <Md text={t("err.format.p")} />
      <Code
        lang="json"
        title="400 Bad Request"
        code={`{
  "error": {
    "code": "validation_error",
    "message": "recipients.0.email: Invalid email",
    "details": [ { "path": "recipients.0.email", "message": "Invalid email" } ]
  }
}`}
      />
      <Code
        lang="json"
        title="402 Payment Required"
        code={`{
  "error": {
    "code": "plan_limit",
    "message": "Llegaste al límite de 50 sobres por mes del plan Starter",
    "details": { "plan": "starter", "limit": "envelopes_per_month", "used": 50, "max": 50,
                 "suggestedPlan": "business", "upgradeUrl": "/app/settings/billing" }
  }
}`}
      />
      <Md text={t("err.format.lang")} />

      <H2 id="codes">{t("err.codes.h")}</H2>
      <DataTable
        head={["HTTP", "code", t("err.col.meaning")]}
        rows={CODES.map(([s, c, k]) => [<strong key="s">{s}</strong>, <code key="c">{c}</code>, <Md key="m" text={t(k as never)} />])}
      />
      <Md text={t("err.codes.retry")} />

      <H2 id="idempotency">{t("err.idem.h")}</H2>
      <Md text={t("err.idem.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes",
          idempotencyKey: "pedido-1234",
          body: { subject: "Contrato de servicios", metadata: { externalId: "PED-1234" } },
        })}
      />
      <Md text={t("err.idem.rules")} />

      <H2 id="pagination">{t("err.page.h")}</H2>
      <Md text={t("err.page.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "GET",
          path: "/v1/envelopes",
          query: { status: "sent,finalizing", q: "contrato", limit: "50" },
        })}
      />
      <Code
        lang="json"
        title="200 OK"
        code={`{
  "items": [
    { "id": "0192f3a4-…", "subject": "Contrato de servicios", "status": "sent",
      "createdAt": "2026-10-18T14:30:00.000Z", "sentAt": "2026-10-18T14:31:02.000Z",
      "completedAt": null, "expiresAt": "2026-11-17T14:30:00.000Z",
      "recipients": [ { "name": "Ana Pérez", "status": "viewed", "role": "signer" } ] }
  ],
  "nextCursor": "MTc5MjMzNTQwMDAwMDAwMHwwMTkyZjNhNC0…"
}`}
      />
      <H3 id="iterate">{t("err.page.iter.h")}</H3>
      <CodeTabs
        tabs={[
          {
            id: "node",
            label: "Node.js",
            lang: "js",
            code: `let cursor;
do {
  const url = new URL("${BASE}/v1/envelopes");
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, { headers: { Authorization: \`Bearer \${process.env.CALASIGN_API_KEY}\` } });
  const page = await res.json();
  for (const e of page.items) console.log(e.id, e.status);
  cursor = page.nextCursor;
} while (cursor);`,
          },
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `import os, requests

headers = {"Authorization": f"Bearer {os.environ['CALASIGN_API_KEY']}"}
cursor = None
while True:
    params = {"limit": 100, **({"cursor": cursor} if cursor else {})}
    page = requests.get("${BASE}/v1/envelopes", params=params, headers=headers).json()
    for e in page["items"]:
        print(e["id"], e["status"])
    cursor = page["nextCursor"]
    if not cursor:
        break`,
          },
          { id: "sdk-python", label: "Python SDK", lang: "python", code: `for e in cs.envelopes.iterate(status="completed"):\n    print(e["id"])` },
          { id: "sdk-node", label: "Node SDK", lang: "ts", code: `for await (const e of cs.envelopes.iterate({ status: "completed" })) console.log(e.id);` },
        ]}
      />

      <H2 id="rate-limits">{t("err.rate.h")}</H2>
      <Md text={t("err.rate.p")} />
      <DataTable head={[t("err.col.route"), t("err.col.limit")]} rows={LIMITS.map(([r, l]) => [<code key="r">{r}</code>, l])} />
      <Callout kind="tip">{t("err.rate.tip")}</Callout>
    </DocPage>
  );
}
