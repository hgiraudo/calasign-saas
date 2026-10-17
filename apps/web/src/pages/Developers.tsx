// /developers — documentación para integradores (pública). Endpoints leídos de /v1/openapi.json.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { WEBHOOK_EVENT_TYPES } from "@calasign/shared";
import { useIntText } from "../lib/integrations-i18n";
import { LocaleSwitcher, Logo, Spinner } from "../components/ui";

interface Spec {
  info: { title: string; version: string };
  paths: Record<string, Record<string, { tags?: string[]; summary?: string; description?: string; security?: unknown[] }>>;
}

const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.calasign.com";

const QUICKSTART = `# 1. Crear el sobre
curl -X POST ${origin}/v1/envelopes \\
  -H "Authorization: Bearer $CALASIGN_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pedido-1234" \\
  -d '{"subject":"Contrato de servicios","metadata":{"externalId":"PED-1234"}}'

# 2. Subir el PDF
curl -X POST ${origin}/v1/envelopes/$ENVELOPE_ID/documents \\
  -H "Authorization: Bearer $CALASIGN_KEY" -F file=@contrato.pdf

# 3. Destinatarios (ids generados por vos para referenciarlos desde los campos)
curl -X PUT ${origin}/v1/envelopes/$ENVELOPE_ID/recipients \\
  -H "Authorization: Bearer $CALASIGN_KEY" -H "Content-Type: application/json" \\
  -d '{"recipients":[{"id":"'$SIGNER_ID'","name":"Ana Pérez","email":"ana@cliente.com",
       "phone":"+5511999990000","channels":["email","whatsapp"],"routingOrder":1}]}'

# 4. Campos (por texto ancla o por coordenadas) y envío
curl -X PUT ${origin}/v1/envelopes/$ENVELOPE_ID/fields \\
  -H "Authorization: Bearer $CALASIGN_KEY" -H "Content-Type: application/json" \\
  -d '{"fields":[{"recipientId":"'$SIGNER_ID'","type":"signature",
       "anchor":{"text":"[[firma]]","offsetY":-40,"width":150,"height":40}}]}'
curl -X POST ${origin}/v1/envelopes/$ENVELOPE_ID/send -H "Authorization: Bearer $CALASIGN_KEY"

# 5. Al completarse (webhook envelope.completed), descargar el PDF sellado
curl -o firmado.pdf ${origin}/v1/envelopes/$ENVELOPE_ID/signed.pdf -H "Authorization: Bearer $CALASIGN_KEY"`;

const EMBED = `// Backend: destinatario con "embedded": true, sobre enviado. Pedir la URL (vence en 5 min, un solo uso):
const r = await fetch(\`${origin}/v1/envelopes/\${envelopeId}/recipients/\${recipientId}/signing-url\`, {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.CALASIGN_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ returnUrl: "https://app.tuempresa.com/firma-lista" }),
});
const { url } = await r.json();

// Frontend: el origen tiene que estar autorizado en Integraciones → Firma embebida.
// <iframe src={url} style="width:100%;height:90vh;border:0" allow="clipboard-write"></iframe>
window.addEventListener("message", (e) => {
  if (e.origin !== "${origin}" || e.data?.source !== "calasign") return;
  // e.data.type: "viewed" | "signing_complete" | "declined" | "error"
  if (e.data.type === "signing_complete") mostrarConfirmacion(e.data.envelopeId);
});`;

const VERIFY_NODE = `import { createHmac, timingSafeEqual } from "node:crypto";

// Usar el cuerpo CRUDO (sin parsear) del POST.
export function verifyCalaSign(rawBody, header, secret, toleranceSec = 300) {
  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(\`\${m[1]}.\${rawBody}\`).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], "hex"));
}`;

const VERIFY_PY = `import hmac, hashlib, re, time

def verify_calasign(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    m = re.fullmatch(r"t=(\\d+),v1=([0-9a-f]{64})", header or "")
    if not m or abs(time.time() - int(m.group(1))) > tolerance:
        return False
    expected = hmac.new(secret.encode(), m.group(1).encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m.group(2))`;

const ANCHOR = `{
  "fields": [
    { "recipientId": "…", "type": "signature",
      "anchor": { "text": "[[firma_cliente]]", "offsetX": 0, "offsetY": -40, "width": 160, "height": 40 } },
    { "recipientId": "…", "type": "date_signed",
      "anchor": { "text": "[[fecha]]", "width": 90, "height": 14, "ignoreIfNotPresent": true } }
  ]
}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="card pad" style={{ overflowX: "auto", fontSize: 13, lineHeight: 1.45, margin: 0 }}>
      <code>{children}</code>
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="stack" style={{ marginTop: 28 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const METHOD_COLOR: Record<string, string> = { get: "#0f7c7c", post: "#1d4ed8", put: "#7c3aed", patch: "#b45309", delete: "#b91c1c" };

export function DevelopersPage() {
  const tt = useIntText();
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/v1/openapi.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setSpec)
      .catch(() => setError(true));
  }, []);

  const groups = useMemo(() => {
    const g = new Map<string, { method: string; path: string; summary: string; description?: string }[]>();
    for (const [path, ops] of Object.entries(spec?.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        const tag = op.tags?.[0] ?? "API";
        if (!g.has(tag)) g.set(tag, []);
        g.get(tag)!.push({ method, path, summary: op.summary ?? "", description: op.description });
      }
    }
    return [...g.entries()];
  }, [spec]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/app" className="brand">
          <Logo light />
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
          <a href="/v1/openapi.json" target="_blank" rel="noopener" style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>
            openapi.json
          </a>
          <LocaleSwitcher compact />
        </div>
      </header>
      <main className="content">
        <div className="page narrow">
          <div className="page-head">
            <h1>{tt("dev.title")}</h1>
          </div>
          <p className="muted">{tt("dev.intro")}</p>

          <Section title={tt("dev.auth")}>
            <p>{tt("dev.authText")}</p>
          </Section>

          <Section title={tt("dev.quickstart")}>
            <Code>{QUICKSTART}</Code>
          </Section>

          <Section title={tt("dev.embedded")}>
            <p>{tt("dev.embeddedText")}</p>
            <Code>{EMBED}</Code>
          </Section>

          <Section title={tt("dev.anchors")}>
            <p>{tt("dev.anchorsText")}</p>
            <Code>{ANCHOR}</Code>
          </Section>

          <Section title={tt("dev.webhooks")}>
            <p>{tt("dev.webhooksText")}</p>
            <p className="small">
              {tt("dev.events")}:{" "}
              {WEBHOOK_EVENT_TYPES.map((e) => (
                <code key={e} style={{ marginRight: 8 }}>
                  {e}
                </code>
              ))}
            </p>
            <Code>{VERIFY_NODE}</Code>
            <Code>{VERIFY_PY}</Code>
          </Section>

          <Section title={tt("dev.endpoints")}>
            {error ? (
              <p className="muted">—</p>
            ) : !spec ? (
              <Spinner />
            ) : (
              groups.map(([tag, ops]) => (
                <div key={tag} className="card pad stack" style={{ gap: 8 }}>
                  <h3 style={{ margin: 0 }}>{tag}</h3>
                  {ops.map((op) => (
                    <div key={op.method + op.path} className="stack" style={{ gap: 2 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 12,
                            color: "#fff",
                            background: METHOD_COLOR[op.method] ?? "#334155",
                            borderRadius: 4,
                            padding: "1px 6px",
                            minWidth: 52,
                            textAlign: "center",
                          }}
                        >
                          {op.method.toUpperCase()}
                        </span>
                        <code className="break">{op.path}</code>
                        <span className="muted small">{op.summary}</span>
                      </div>
                      {op.description && <p className="muted small" style={{ margin: "0 0 0 60px" }}>{op.description}</p>}
                    </div>
                  ))}
                </div>
              ))
            )}
          </Section>
        </div>
      </main>
    </div>
  );
}
