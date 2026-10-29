import { OAUTH_SCOPES } from "@calasign/shared";
import { useDocsText } from "../../../lib/i18n-docs";
import { usePlatformText } from "../../../lib/i18n-platform";
import { BASE, MCP_URL } from "../constants";
import { apiTabs } from "../samples";
import { Badge, Callout, Code, CodeTabs, DataTable, DocPage, H2, H3, Md } from "../ui";

export function AuthPage() {
  const t = useDocsText();
  const p = usePlatformText();

  const pkceNode = `import { createHash, randomBytes } from "node:crypto";

// 1. ${t("auth.code.c.pkce")}
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");

// 2. ${t("auth.code.c.redirect")}
const url = new URL("${BASE}/oauth/authorize");
url.search = new URLSearchParams({
  response_type: "code",
  client_id: process.env.CALASIGN_CLIENT_ID,
  redirect_uri: "https://app.tuempresa.com/oauth/callback",
  scope: "envelopes:read envelopes:write offline_access",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();
// res.redirect(url)

// 3. ${t("auth.code.c.exchange")}
const res = await fetch("${BASE}/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,                       // ?code=… ${t("auth.code.c.callback")}
    redirect_uri: "https://app.tuempresa.com/oauth/callback",
    code_verifier: verifier,
    client_id: process.env.CALASIGN_CLIENT_ID,
    client_secret: process.env.CALASIGN_CLIENT_SECRET, // ${t("auth.code.c.public")}
  }),
});
const { access_token, refresh_token, expires_in, scope } = await res.json();`;

  const pkcePy = `import base64, hashlib, os, secrets
from urllib.parse import urlencode
import requests

verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)

authorize_url = "${BASE}/oauth/authorize?" + urlencode({
    "response_type": "code",
    "client_id": os.environ["CALASIGN_CLIENT_ID"],
    "redirect_uri": "https://app.tuempresa.com/oauth/callback",
    "scope": "envelopes:read envelopes:write offline_access",
    "state": state,
    "code_challenge": challenge,
    "code_challenge_method": "S256",
})

# ${t("auth.code.c.exchange")}
tokens = requests.post("${BASE}/oauth/token", data={
    "grant_type": "authorization_code",
    "code": code,
    "redirect_uri": "https://app.tuempresa.com/oauth/callback",
    "code_verifier": verifier,
}, auth=(os.environ["CALASIGN_CLIENT_ID"], os.environ["CALASIGN_CLIENT_SECRET"])).json()`;

  const tokenResponse = `{
  "access_token": "csat_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "csrt_…",
  "scope": "envelopes:read envelopes:write offline_access"
}`;

  const dcrRequest = `POST /oauth/register
Content-Type: application/json

{
  "client_name": "Mi agente",
  "redirect_uris": ["http://127.0.0.1:33418/callback"],
  "token_endpoint_auth_method": "none",
  "scope": "envelopes:read envelopes:write offline_access"
}`;

  const dcrResponse = `HTTP/1.1 201 Created

{
  "client_id": "csdyn_…",
  "client_id_issued_at": 1792335600,
  "client_secret_expires_at": 0,
  "client_name": "Mi agente",
  "redirect_uris": ["http://127.0.0.1:33418/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "envelopes:read envelopes:write offline_access"
}`;

  return (
    <DocPage title={t("auth.title")} lead={t("auth.lead")}>
      <DataTable
        head={[t("auth.cmp.method"), t("auth.cmp.when"), t("auth.cmp.format")]}
        rows={[
          [<strong key="k">API key</strong>, t("auth.cmp.key"), <code key="f">cs_test_… / cs_live_…</code>],
          [<strong key="c">OAuth · client credentials</strong>, t("auth.cmp.cc"), <code key="f">csat_…</code>],
          [<strong key="a">OAuth · authorization code + PKCE</strong>, t("auth.cmp.code"), <code key="f">csat_… + csrt_…</code>],
        ]}
      />

      <H2 id="api-keys">{t("auth.keys.h")}</H2>
      <Md text={t("auth.keys.p")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/envelopes", query: { limit: "5" } })} />
      <H3 id="rotation">{t("auth.keys.rotate.h")}</H3>
      <Md text={t("auth.keys.rotate.p")} />
      <Callout kind="warn">{t("auth.keys.warn")}</Callout>

      <H2 id="oauth">{t("auth.oauth.h")}</H2>
      <Md text={t("auth.oauth.p")} />
      <DataTable
        head={[t("auth.ep.endpoint"), t("auth.ep.use")]}
        rows={[
          [<code key="1">GET /oauth/authorize</code>, t("auth.ep.authorize")],
          [<code key="2">POST /oauth/token</code>, t("auth.ep.token")],
          [<code key="3">POST /oauth/revoke</code>, t("auth.ep.revoke")],
          [<code key="4">POST /oauth/introspect</code>, t("auth.ep.introspect")],
          [
            <span key="5">
              <code>POST /oauth/register</code> <Badge tone="new">{t("ui.new")}</Badge>
            </span>,
            t("auth.ep.register"),
          ],
        ]}
      />

      <H2 id="authorization-code">{t("auth.code.h")}</H2>
      <Md text={t("auth.code.p")} />
      <CodeTabs
        tabs={[
          { id: "node", label: "Node.js", lang: "js", code: pkceNode },
          { id: "python", label: "Python", lang: "python", code: pkcePy },
        ]}
      />
      <Code lang="json" code={tokenResponse} title="200 OK" />
      <Md text={t("auth.code.after")} />

      <H2 id="client-credentials">{t("auth.cc.h")}</H2>
      <Md text={t("auth.cc.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/oauth/token",
          auth: "basic",
          form: { grant_type: "client_credentials", scope: "envelopes:read envelopes:write" },
        })}
      />

      <H2 id="refresh">{t("auth.refresh.h")}</H2>
      <Md text={t("auth.refresh.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/oauth/token",
          auth: "basic",
          form: { grant_type: "refresh_token", refresh_token: "csrt_…" },
        })}
      />
      <Callout kind="warn">{t("auth.refresh.warn")}</Callout>

      <H2 id="scopes">{t("auth.scopes.h")}</H2>
      <Md text={t("auth.scopes.p")} />
      <DataTable head={["Scope", t("auth.scopes.col.desc")]} rows={OAUTH_SCOPES.map((s) => [<code key={s}>{s}</code>, p(`scope.${s}`)])} />

      <H2 id="dynamic-registration">
        {t("auth.dcr.h")} <Badge tone="new">{t("ui.new")}</Badge>
      </H2>
      <Md text={t("auth.dcr.p")} />
      <Code lang="http" code={dcrRequest} title={t("auth.dcr.req")} />
      <Code lang="http" code={dcrResponse} title={t("auth.dcr.resp")} />
      <Md text={t("auth.dcr.rules")} />

      <H2 id="resource-indicators">{t("auth.resource.h")}</H2>
      <Md text={t("auth.resource.p")} />
      <Code lang="text" code={`${BASE}/oauth/authorize?response_type=code&client_id=csapp_…&…&resource=${encodeURIComponent(MCP_URL)}`} />

      <H2 id="discovery">{t("auth.discovery.h")}</H2>
      <Md text={t("auth.discovery.p")} />
      <DataTable
        head={["URL", t("auth.ep.use")]}
        rows={[
          [<code key="1">/.well-known/oauth-protected-resource</code>, t("auth.disc.prm")],
          [<code key="2">/.well-known/oauth-authorization-server</code>, t("auth.disc.as")],
        ]}
      />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/.well-known/oauth-authorization-server", auth: false })} />
    </DocPage>
  );
}
