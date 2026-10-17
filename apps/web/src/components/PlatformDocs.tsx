// Secciones de /developers sobre OAuth 2.0 y los SDKs.
import type { ReactNode } from "react";
import { OAUTH_SCOPES } from "@calasign/shared";
import { usePlatformText } from "../lib/i18n-platform";

const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.calasign.com";

const CC = `# Servidor a servidor: client credentials (token de 1 h)
curl -X POST ${origin}/oauth/token \\
  -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=client_credentials -d "scope=envelopes:read envelopes:write"

curl ${origin}/v1/envelopes -H "Authorization: Bearer $ACCESS_TOKEN"`;

const AUTH_CODE = `// En nombre de un usuario: authorization code + PKCE (S256, obligatorio)
import { createHash, randomBytes } from "node:crypto";
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

// 1. Redirigir al usuario a la pantalla de consentimiento
const url = new URL("${origin}/oauth/authorize");
url.search = new URLSearchParams({
  response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://app.tuempresa.com/oauth/callback",
  scope: "envelopes:read envelopes:write offline_access", state, code_challenge: challenge, code_challenge_method: "S256",
}).toString();

// 2. En el callback, canjear el código (con el verifier)
const res = await fetch("${origin}/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri, code_verifier: verifier,
                              client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
});
const { access_token, refresh_token } = await res.json();

// 3. Renovar: cada refresh devuelve un refresh_token NUEVO (el anterior deja de valer)
//    grant_type=refresh_token&refresh_token=...  ·  revocar: POST /oauth/revoke token=...`;

const SDK_NODE = `// npm i @calasign/sdk
import { CalaSign, constructWebhookEvent } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_KEY, baseUrl: "${origin}" });
// o: new CalaSign({ oauth: { clientId, clientSecret }, baseUrl: "${origin}" })

const { envelope } = await cs.envelopes.create({ subject: "Contrato" }); // idempotente ante reintentos
await cs.envelopes.uploadDocument(envelope.id, pdfBytes, "contrato.pdf");
for await (const e of cs.envelopes.iterate({ status: "completed" })) console.log(e.id);`;

const SDK_PY = `# pip install calasign
from calasign import CalaSign, construct_event

cs = CalaSign(os.environ["CALASIGN_KEY"], base_url="${origin}")
detail = cs.envelopes.create({"subject": "Contrato"})
for e in cs.envelopes.iterate(status="completed"):
    pdf = cs.envelopes.download_signed(e["id"])`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="stack" style={{ marginTop: 28 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="card pad" style={{ overflowX: "auto", fontSize: 13, lineHeight: 1.45, margin: 0 }}>
      <code>{children}</code>
    </pre>
  );
}

export function PlatformDocs() {
  const p = usePlatformText();
  return (
    <>
      <Section title={p("dev.oauth")}>
        <p>{p("dev.oauthText")}</p>
        <Code>{CC}</Code>
        <Code>{AUTH_CODE}</Code>
        <p className="small">
          <strong>{p("dev.scopes")}:</strong>{" "}
          {OAUTH_SCOPES.map((s) => (
            <span key={s} style={{ marginRight: 10, display: "inline-block" }}>
              <code>{s}</code> <span className="muted">{p(`scope.${s}`)}</span>
            </span>
          ))}
        </p>
      </Section>
      <Section title={p("dev.sdks")}>
        <p>{p("dev.sdksText")}</p>
        <Code>{SDK_NODE}</Code>
        <Code>{SDK_PY}</Code>
      </Section>
    </>
  );
}
