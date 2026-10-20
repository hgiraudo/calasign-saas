// Contrato documentado (GET /v1/openapi.json) contra la API real: rutas registradas, códigos de error y esquemas que
// los clientes (SDK, conectores, skill) leen del OpenAPI. Sin base: buildOpenApi() y un recorrido de las rutas del código.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/modules/openapi";
import { ERRORS } from "../src/modules/openapi-extra";
import { decodePdfBase64, PdfSourceError } from "../src/modules/pdf-source";

const doc = buildOpenApi() as any;
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Rutas que el OpenAPI deja afuera a propósito (no son para integradores). Cualquier otra ruta registrada tiene que
 * estar documentada.
 */
const EXCLUDED: [RegExp, string][] = [
  [/^\/v1\/auth\//, "sesión de la web: login con 2FA, contraseña, SSO, cambio de organización (signup y login sí se documentan)"],
  [/^\/v1\/me\/2fa\//, "verificación en dos pasos del usuario (solo sesión web)"],
  [/^\/v1\/billing(\/|$)/, "suscripción de la organización (consola web: cambiarla exige sesión de usuario, 403 billing_requires_user)"],
  [/^\/v1\/invite\//, "aceptar una invitación (link del correo)"],
  [/^\/v1\/integrations\//, "webhooks entrantes de proveedores (Stripe, Mercado Pago, SES, Telegram, KYC, SAML ACS); el de HubSpot sí se documenta"],
  [/^\/v1\/(crm|connectors|storage)\/oauth\/\{provider\}\/callback$/, "vuelta de OAuth de proveedores (navegador)"],
  [/^\/v1\/(payments|identity)\/return\//, "vuelta del checkout / de la verificación (navegador)"],
  [/^\/v1\/payments\/mock\//, "checkout simulado (solo fuera de producción)"],
  [/^\/v1\/oauth\/authorize\/info$/, "datos de la pantalla de consentimiento (web)"],
  [/^\/v1\/(downloads|firmador\/download)\//, "descargas con link firmado (MCP, Firmador)"],
  [/^\/v1\/branding\/logo\/|^\/v1\/public\/brand-assets\//, "imágenes de marca para correos y páginas"],
  [/^\/(mcp|\.well-known)(\/|$)/, "servidor MCP y metadatos OAuth (documentados en la guía MCP)"],
  [/^\/(dev|internal)\/|^\/healthz$|^\/embed\//, "desarrollo, salud y redirección del link embebido"],
];

function realRoutes(): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  const re = /\b\w+\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\(\s*["'`](\/[^"'`]*)["'`]/gs;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !name.includes("openapi")) {
        for (const m of readFileSync(p, "utf8").matchAll(re)) out.push({ method: m[1], path: m[2].replace(/:(\w+)/g, "{$1}"), file: p.slice(SRC.length + 1) });
      }
    }
  };
  walk(SRC);
  return out;
}

const shape = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
const examplesOf = (op: any, status: number) => Object.keys(op.responses[String(status)]?.content?.["application/json"]?.examples ?? {});
const resolve = (r: any) => (r?.$ref ? r.$ref.split("/").slice(1).reduce((o: any, k: string) => o?.[k], doc) : r);

describe("cobertura de rutas", () => {
  it("toda ruta registrada está en el OpenAPI o en la lista de exclusión", () => {
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries<any>(doc.paths)) for (const m of Object.keys(ops)) documented.add(`${m} ${shape(p)}`);
    const routes = realRoutes();
    expect(routes.length).toBeGreaterThan(300);
    const missing = routes.filter((r) => !documented.has(`${r.method} ${shape(r.path)}`) && !EXCLUDED.some(([re]) => re.test(r.path)));
    expect(missing.map((r) => `${r.method.toUpperCase()} ${r.path} (${r.file})`)).toEqual([]);
  });

  it("incluye las rutas que faltaban (edición, OAuth, SSO/SCIM, supresiones, firmante, formularios públicos)", () => {
    const want = [
      "patch /v1/agreement-fields/{id}",
      "patch /v1/negotiations/{id}",
      "patch /v1/negotiations/{id}/comments/{commentId}",
      "get /v1/public/negotiations/{token}/diff",
      "get /v1/public/negotiations/{token}/pdf",
      "get /v1/oauth/apps/{id}",
      "get /v1/oauth/connected-apps",
      "delete /v1/oauth/connected-apps/{clientId}",
      "get /v1/settings/sso",
      "put /v1/settings/sso",
      "get /v1/settings/scim",
      "patch /v1/settings/scim",
      "post /v1/settings/scim/tokens",
      "delete /v1/settings/scim/tokens/{id}",
      "get /v1/settings/email-suppressions",
      "delete /v1/settings/email-suppressions/{address}",
      "post /v1/signing/{token}/otp/send",
      "post /v1/signing/{token}/otp/verify",
      "get /v1/signing/{token}/documents/{documentId}/file",
      "post /v1/signing/{token}/fields/{fieldId}/attachment",
      "delete /v1/signing/{token}/fields/{fieldId}/attachment",
      "post /v1/signing/{token}/delegate",
      "get /v1/signing/{token}/identity",
      "post /v1/signing/{token}/identity/start",
      "post /v1/signing/{token}/identity/captures/{kind}",
      "post /v1/signing/{token}/identity/submit",
      "get /v1/signing/{token}/payment",
      "post /v1/signing/{token}/payment/checkout",
      "get /v1/signing/{token}/embed",
      "get /v1/public/forms/{slug}",
      "post /v1/public/forms/{slug}/submit",
    ];
    for (const k of want) {
      const [m, p] = k.split(" ");
      expect(doc.paths[p]?.[m], k).toBeTruthy();
    }
  });
});

describe("códigos de error", () => {
  it("POST /v1/envelopes documenta los errores del sobre en una llamada (not_pdf único, 413 file_too_large y payload_too_large)", () => {
    const op = doc.paths["/v1/envelopes"].post;
    expect(examplesOf(op, 400)).toEqual(
      expect.arrayContaining(["not_pdf", "unknown_part", "duplicate_part", "too_many_documents", "duplicate_document", "invalid_json", "payload_required", "too_many_fields"]),
    );
    expect(examplesOf(op, 413)).toEqual(expect.arrayContaining(["file_too_large", "payload_too_large"]));
    for (const c of ["unknown_part", "duplicate_part", "payload_too_large", "too_many_documents", "duplicate_document", "invalid_json", "file_too_large", "not_pdf"]) {
      expect(op.description).toContain(c);
    }
    expect(ERRORS).not.toHaveProperty("invalid_pdf");
    expect(JSON.stringify(doc)).not.toContain("documents_too_large");
  });

  it("un base64 que no es PDF es not_pdf, como la subida multipart", () => {
    let err: unknown;
    try {
      decodePdfBase64(Buffer.from("hola").toString("base64"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfSourceError);
    expect((err as PdfSourceError).code).toBe("not_pdf");
  });

  it("remind, void y send declaran X-Expected-Updated-At; remind documenta reminder_daily_limit", () => {
    for (const p of ["/v1/envelopes/{id}/void", "/v1/envelopes/{id}/remind", "/v1/envelopes/{id}/send"]) {
      const op = doc.paths[p].post;
      expect(JSON.stringify(op.parameters), p).toContain("ExpectedUpdatedAt");
      expect(examplesOf(op, 409), p).toContain("version_changed");
    }
    const remind = doc.paths["/v1/envelopes/{id}/remind"].post;
    expect(examplesOf(remind, 429)).toEqual(expect.arrayContaining(["reminded_recently", "reminder_daily_limit"]));
    expect(remind.description).toContain("reminder_daily_limit");
    expect(doc.paths["/v1/envelopes/batch"].post.description).toContain("reminder_daily_limit");
  });

  it("421 wrong_cell, 403 bad_origin y 400 invalid_text globales en components.responses", () => {
    const wrong = doc.components.responses.WrongCell;
    expect(wrong.headers.Location).toBeTruthy();
    const ex = resolve(wrong.content["application/json"].examples.wrong_cell).value.error;
    expect(ex.code).toBe("wrong_cell");
    expect(Object.keys(ex.details).sort()).toEqual(["baseUrl", "cell"]);
    expect(resolve(doc.components.responses.BadOrigin.content["application/json"].examples.bad_origin).value.error.code).toBe("bad_origin");
    expect(resolve(doc.components.responses.InvalidText.content["application/json"].examples.invalid_text).value.error.code).toBe("invalid_text");
    expect(doc.info.description).toContain("wrong_cell");
  });

  it("los 403 de las rutas autenticadas incluyen two_factor_setup_required (salvo /v1/me)", () => {
    const forbidden = doc.components.responses.Forbidden.content["application/json"].examples;
    expect(Object.keys(forbidden)).toContain("two_factor_setup_required");
    expect(doc.paths["/v1/envelopes"].post.responses["403"].$ref).toBe("#/components/responses/Forbidden");
    expect(JSON.stringify(doc.paths["/v1/me"].get.responses["403"])).not.toContain("two_factor_setup_required");
  });

  it("los 5xx están en el catálogo con su status y dicen si se reintentan", () => {
    const want: Record<string, [number, string]> = {
      tsa_unavailable: [502, "tsa_unavailable"],
      storage_unavailable: [503, "storage_unavailable"],
      byok_key_unavailable: [503, "byok_key_unavailable"],
      pdf_reader_busy: [503, "pdf_reader_busy"],
      ai_unavailable: [503, "ai_unavailable"],
      ai_unavailable_upstream: [502, "ai_unavailable"],
      ai_rate_limited: [503, "ai_rate_limited"],
      ai_timeout: [504, "ai_timeout"],
    };
    for (const [k, [status, code]] of Object.entries(want)) {
      expect(ERRORS[k]?.status, k).toBe(status);
      expect(ERRORS[k]?.code, k).toBe(code);
    }
    for (const k of ["storage_unavailable", "pdf_reader_busy", "ai_rate_limited"]) expect(ERRORS[k].summary).toMatch(/^.*Reintentable/);
    expect(ERRORS.byok_key_unavailable.summary).toMatch(/NO reintentar/);
    expect(examplesOf(doc.paths["/v1/envelopes/{id}/ai/review"].post, 503)).toEqual(expect.arrayContaining(["ai_unavailable", "ai_rate_limited"]));
    expect(examplesOf(doc.paths["/v1/envelopes/{id}/ai/review"].post, 504)).toEqual(["ai_timeout"]);
  });

  it("ai_notice_required es 403 en todos lados", () => {
    expect(ERRORS.ai_notice_required.status).toBe(403);
    const patch = doc.paths["/v1/settings/ai"].patch;
    expect(examplesOf(patch, 403)).toContain("ai_notice_required");
    expect(patch.description).toContain("403 ai_notice_required");
    expect(JSON.stringify(doc)).not.toContain("422 ai_notice_required");
  });

  it("documenta en el catálogo y en sus rutas los códigos que faltaban", () => {
    const cases: [string, string, number, string][] = [
      ["/v1/signing/{token}/delegate", "post", 409, "same_person"],
      ["/v1/signing/{token}/delegate", "post", 410, "envelope_closed"],
      ["/v1/envelopes/{id}/fields", "put", 400, "too_many_fields"],
      ["/v1/validate", "post", 400, "unreadable_pdf"],
      ["/v1/validate", "post", 400, "not_pdf"],
      ["/v1/certificates/{id}", "delete", 409, "certificate_in_use"],
      ["/v1/xml/sign", "post", 400, "xml_sign_failed"],
      ["/v1/public/forms/{slug}/submit", "post", 410, "form_inactive"],
      ["/v1/public/forms/{slug}/submit", "post", 410, "form_unavailable"],
      ["/v1/public/forms/{slug}/submit", "post", 409, "form_misconfigured"],
      ["/v1/public/forms/{slug}/submit", "post", 400, "phone_required"],
      ["/v1/webhooks/samples", "get", 400, "invalid_event"],
      ["/v1/oauth/authorize/decision", "post", 400, "invalid_target"],
      ["/v1/oauth/apps/{id}/rotate-secret", "post", 400, "public_client"],
      ["/v1/crm/mappings/{id}/send", "post", 409, "crm_account_unknown"],
      ["/v1/crm/mappings/{id}/send", "post", 409, "company_mismatch"],
      ["/v1/agreements/{id}/file", "get", 410, "purged"],
    ];
    for (const [p, m, status, code] of cases) expect(examplesOf(doc.paths[p][m], status), `${m} ${p} ${status}`).toContain(code);
    expect(JSON.stringify(doc)).not.toContain("file_purged");
  });
});

describe("esquemas de respuesta", () => {
  const schema = (name: string) => doc.components.schemas[name];

  it("GET /v1/crm/mappings: descripción, provider/companyId y CrmMappingList con connectionsWithoutAccount", () => {
    const op = doc.paths["/v1/crm/mappings"].get;
    expect(op.description).toContain("connectionsWithoutAccount");
    expect(op.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(["connectionId", "provider", "companyId"]));
    expect(op.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/CrmMappingList");
    expect(schema("CrmMappingList").properties.connectionsWithoutAccount).toBeTruthy();
  });

  it("BYOK (notice), IA (planTokenCap/effectiveTokenBudget), workflow-runs (redacted) y captchaSiteKey", () => {
    for (const m of ["put", "delete"]) {
      expect(doc.paths["/v1/settings/byok"][m].responses["200"].content["application/json"].schema.properties.notice, m).toBeTruthy();
    }
    expect(schema("AiSettings").properties).toHaveProperty("planTokenCap");
    expect(schema("AiSettings").properties).toHaveProperty("effectiveTokenBudget");
    expect(schema("WorkflowRun").properties).toHaveProperty("redacted");
    expect(doc.paths["/v1/public/forms/{slug}"].get.responses["200"].content["application/json"].schema.properties).toHaveProperty("captchaSiteKey");
    expect(doc.paths["/v1/public/workflows/{slug}"].get.responses["200"].content["application/json"].schema.properties).toHaveProperty("captchaSiteKey");
  });

  it("la descripción general documenta la convención de nombres de la query", () => {
    expect(doc.info.description).toMatch(/camelCase/);
    expect(doc.info.description).toMatch(/snake_case/);
  });
});
