// Estructura del portal: grupos de la barra lateral, páginas (ruta bajo /developers) y sus secciones (para la búsqueda).
import type { DocsKey } from "../../lib/i18n-docs";

export interface DocHeading {
  id: string;
  key: DocsKey;
}

export interface DocPageDef {
  /** Ruta relativa a /developers ("" = portada). */
  path: string;
  title: DocsKey;
  /** Título corto para la barra lateral (si difiere del de la página). */
  navTitle?: DocsKey;
  headings: DocHeading[];
  /** Palabras extra para la búsqueda (sin traducir: nombres propios, endpoints). */
  keywords?: string;
}

export interface NavGroup {
  title: DocsKey;
  pages: DocPageDef[];
}

const h = (id: string, key: DocsKey): DocHeading => ({ id, key });

export const NAV: NavGroup[] = [
  {
    title: "nav.start",
    pages: [
      {
        path: "",
        title: "intro.title",
        navTitle: "intro.nav",
        headings: [h("what-you-can-build", "intro.build.h"), h("base-url", "intro.base.h"), h("environments", "intro.env.h"), h("versioning", "intro.version.h"), h("next", "intro.next.h")],
        keywords: "dev.calasign.com sandbox buzón mailbox openapi",
      },
      {
        path: "quickstart",
        title: "qs.title",
        headings: [
          h("api-key", "qs.key.h"),
          h("create", "qs.create.h"),
          h("upload", "qs.upload.h"),
          h("recipients", "qs.recipients.h"),
          h("fields", "qs.fields.h"),
          h("send", "qs.send.h"),
          h("wait", "qs.wait.h"),
          h("download", "qs.download.h"),
          h("full-script", "qs.full.h"),
        ],
        keywords: "curl node python envelope sobre primer envío",
      },
      {
        path: "authentication",
        title: "auth.title",
        headings: [
          h("api-keys", "auth.keys.h"),
          h("oauth", "auth.oauth.h"),
          h("authorization-code", "auth.code.h"),
          h("client-credentials", "auth.cc.h"),
          h("refresh", "auth.refresh.h"),
          h("scopes", "auth.scopes.h"),
          h("dynamic-registration", "auth.dcr.h"),
          h("resource-indicators", "auth.resource.h"),
          h("discovery", "auth.discovery.h"),
        ],
        keywords: "oauth pkce token bearer cs_live cs_test csat_ refresh scope register rfc 7591 8707 9728 8414",
      },
      {
        path: "concepts",
        title: "concepts.title",
        headings: [
          h("lifecycle", "concepts.lifecycle.h"),
          h("recipients", "concepts.recipients.h"),
          h("routing", "concepts.routing.h"),
          h("documents", "concepts.documents.h"),
          h("fields", "concepts.fields.h"),
          h("templates", "concepts.templates.h"),
          h("evidence", "concepts.evidence.h"),
          h("pades", "concepts.pades.h"),
          h("verification", "concepts.verify.h"),
        ],
        keywords: "draft sent finalizing completed declined voided expired awaiting_certificates signer cc approver signature initials",
      },
    ],
  },
  {
    title: "nav.guides",
    pages: [
      { path: "guides/templates", title: "g.tpl.title", headings: [h("roles", "g.tpl.roles.h"), h("send", "g.tpl.send.h"), h("prefill", "g.tpl.prefill.h")], keywords: "from-template plantilla prefill" },
      { path: "guides/embedded-signing", title: "g.embed.title", headings: [h("origins", "g.embed.origins.h"), h("recipient", "g.embed.recipient.h"), h("url", "g.embed.url.h"), h("iframe", "g.embed.iframe.h"), h("events", "g.embed.events.h")], keywords: "iframe postMessage signing-url embedded frame-ancestors" },
      { path: "guides/anchors", title: "g.anchor.title", headings: [h("how", "g.anchor.how.h"), h("options", "g.anchor.options.h"), h("tips", "g.anchor.tips.h")], keywords: "anchor texto ancla" },
      { path: "guides/bulk-send", title: "g.bulk.title", headings: [h("csv", "g.bulk.csv.h"), h("json", "g.bulk.json.h"), h("track", "g.bulk.track.h")], keywords: "bulk csv masivo" },
      { path: "guides/web-forms", title: "g.forms.title", headings: [h("create", "g.forms.create.h"), h("share", "g.forms.share.h")], keywords: "web form formulario público" },
      { path: "guides/reminders", title: "g.rem.title", headings: [h("automatic", "g.rem.auto.h"), h("manual", "g.rem.manual.h"), h("expiration", "g.rem.exp.h"), h("corrections", "g.rem.corr.h")], keywords: "remind recordatorio vencimiento expiresAt corrections reassign delegate" },
      { path: "guides/certificate-signing", title: "g.cert.title", headings: [h("setup", "g.cert.setup.h"), h("flow", "g.cert.flow.h"), h("requirements", "g.cert.req.h")], keywords: "certificado token pkcs11 p12 icp-brasil firmador awaiting_certificates" },
      { path: "guides/identity", title: "g.idv.title", headings: [h("auth", "g.idv.auth.h"), h("kyc", "g.idv.kyc.h")], keywords: "otp kyc identidad selfie truora veriff" },
      { path: "guides/payments", title: "g.pay.title", headings: [h("configure", "g.pay.conf.h"), h("timing", "g.pay.timing.h")], keywords: "pago stripe mercadopago pix pse" },
      { path: "guides/crm", title: "g.crm.title", headings: [h("providers", "g.crm.providers.h"), h("mappings", "g.crm.mappings.h")], keywords: "hubspot salesforce siigo alegra" },
      {
        path: "guides/hr-contracts",
        title: "g.hrclm.title",
        headings: [h("providers", "g.hrclm.providers.h"), h("flows", "g.hrclm.flows.h"), h("webhook", "g.hrclm.webhook.h"), h("dms", "g.hrclm.dms.h")],
        keywords: "bamboohr hibob factorial ironclad juro sharepoint box drive onboarding legajo hris clm dms evidencia",
      },
      { path: "guides/custom-domain", title: "g.domain.title", headings: [h("dns", "g.domain.dns.h"), h("verify", "g.domain.verify.h")], keywords: "dominio propio cname txt white-label" },
      { path: "guides/branding", title: "g.brand.title", headings: [h("api", "g.brand.api.h")], keywords: "logo color marca branding" },
    ],
  },
  {
    title: "nav.platform",
    pages: [
      {
        path: "webhooks",
        title: "wh.title",
        headings: [
          h("setup", "wh.setup.h"),
          h("events", "wh.events.h"),
          h("payload", "wh.payload.h"),
          h("verify", "wh.verify.h"),
          h("retries", "wh.retries.h"),
          h("receiving", "wh.receive.h"),
          h("testing", "wh.test.h"),
        ],
        keywords: "hmac CalaSign-Signature envelope.completed recipient.signed retry",
      },
      {
        path: "errors",
        title: "err.title",
        headings: [h("format", "err.format.h"), h("codes", "err.codes.h"), h("idempotency", "err.idem.h"), h("pagination", "err.page.h"), h("rate-limits", "err.rate.h")],
        keywords: "error 400 401 402 403 404 409 429 Idempotency-Key cursor nextCursor retry-after",
      },
      { path: "sdks", title: "sdk.title", headings: [h("python", "sdk.py.h"), h("node", "sdk.node.h"), h("openapi", "sdk.openapi.h")], keywords: "sdk python node openapi-generator" },
    ],
  },
  {
    title: "nav.ai",
    pages: [
      { path: "ai", title: "ai.title", headings: [h("integrations", "ai.cards.h"), h("how", "ai.how.h")], keywords: "ia agentes mcp claude chatgpt gemini" },
      {
        path: "ai/mcp",
        title: "mcp.title",
        headings: [h("connect", "mcp.connect.h"), h("auth", "mcp.auth.h"), h("tools", "mcp.tools.h"), h("safety", "mcp.safety.h"), h("inspector", "mcp.inspector.h"), h("sdk", "mcp.sdk.h")],
        keywords: "mcp streamable http tools inspector",
      },
      {
        path: "ai/claude",
        title: "claude.title",
        headings: [h("connector", "claude.connector.h"), h("desktop", "claude.desktop.h"), h("code", "claude.code.h"), h("skill", "claude.skill.h"), h("api", "claude.api.h")],
        keywords: "claude anthropic mcpb skill plugin claude code connector",
      },
      { path: "ai/chatgpt", title: "gpt.title", headings: [h("connector", "gpt.connector.h"), h("api", "gpt.api.h")], keywords: "chatgpt openai responses developer mode apps" },
      { path: "ai/gemini", title: "gem.title", headings: [h("cli", "gem.cli.h"), h("extension", "gem.ext.h"), h("api", "gem.api.h")], keywords: "gemini google cli extension genai" },
      { path: "ai/office", title: "office.title", headings: [h("what", "office.what.h"), h("word", "office.word.h"), h("outlook", "office.outlook.h"), h("admin", "office.admin.h")], keywords: "word outlook office complemento add-in manifest" },
    ],
  },
];

/** Páginas en el orden de lectura (para "anterior / siguiente"), con la referencia de la API después de los SDKs. */
export const PAGE_ORDER: string[] = NAV.flatMap((g) => g.pages.map((p) => p.path));

export const ALL_PAGES: DocPageDef[] = NAV.flatMap((g) => g.pages);

export function pageByPath(path: string): DocPageDef | undefined {
  return ALL_PAGES.find((p) => p.path === path);
}
