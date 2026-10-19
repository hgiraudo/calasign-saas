// Pipedrive con un fetch falso (sin red): OAuth (Basic + api_domain), lectura de Deal/Person con campos
// personalizados, write-back en un campo de opción única, Files API + nota y prueba de conexión.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateCrmMappingInput } from "@calasign/shared";
import { encrypt } from "../src/lib/util";
import { MappingError, mapPrefill, mapRecipients } from "../src/modules/crm/mapping";
import { validatePipedriveDomain } from "../src/modules/crm/pipedrive";
import { CrmConn, attachSigned, fetchRecord, oauthConfigured, testConnection, tokenSupported, writeStatus } from "../src/modules/crm/providers";

const STATUS_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // campo personalizado "Estado CalaSign" (opción única)
const PLAN_KEY = "ffffeeeeddddccccbbbbaaaa9999888877776666"; // campo personalizado "Plan" (opción única)
const NIT_KEY = "0123456789abcdef0123456789abcdef01234567"; // campo personalizado "NIT" (texto)

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

let calls: Call[] = [];
let token = "pd-at-1";
const real = globalThis.fetch;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deal = {
  id: 42,
  title: "Licencia anual ACME",
  value: 1500,
  currency: "COP",
  person_id: { name: "Ana Pérez", email: [{ label: "work", value: "ana@acme.test", primary: true }], phone: [{ value: "+57 300 111 2233", primary: true }], value: 7 },
  org_id: { name: "ACME S.A.S.", value: 3 },
  [PLAN_KEY]: "37",
  [NIT_KEY]: "900123456",
};
const dealFields = [
  { key: "title", name: "Title", field_type: "varchar" },
  { key: STATUS_KEY, name: "Estado CalaSign", field_type: "enum", options: [{ id: 11, label: "Enviado" }, { id: 12, label: "Firmado" }] },
  { key: PLAN_KEY, name: "Plan", field_type: "enum", options: [{ id: 37, label: "Plan Pro" }] },
  { key: NIT_KEY, name: "NIT", field_type: "varchar" },
  { key: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", name: "Nota libre", field_type: "text" },
];

function fakePipedrive(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init?.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === "string") body = JSON.parse(body);
    calls.push({ method, url, headers, body });
    const u = new URL(url);
    if (u.host === "oauth.pipedrive.com" && u.pathname === "/oauth/token") {
      if (headers.authorization !== `Basic ${Buffer.from("pd-client:pd-secret").toString("base64")}`) return json(401, { error: "invalid_client" });
      if (body.grant_type === "refresh_token" && body.refresh_token === "pd-rt") {
        token = "pd-at-2";
        return json(200, { access_token: token, refresh_token: "pd-rt-2", expires_in: 3599, api_domain: "https://acme.pipedrive.com", token_type: "Bearer" });
      }
      return json(400, { error: "invalid_grant" });
    }
    if (u.origin !== "https://acme.pipedrive.com") return json(404, { success: false, error: `host ${u.host}` });
    if (headers.authorization !== `Bearer ${token}`) return json(401, { success: false, error: "unauthorized access" });
    const p = u.pathname;
    if (p === "/api/v1/users/me") return json(200, { success: true, data: { id: 1, email: "admin@acme.test", company_id: 9988, company_name: "ACME", company_domain: "acme" } });
    if (p === "/api/v1/deals/42" && method === "GET") return json(200, { success: true, data: deal });
    if (p === "/api/v1/deals/42" && method === "PUT") return json(200, { success: true, data: { id: 42, ...body } });
    if (p === "/api/v1/deals/404") return json(404, { success: false, error: "Deal not found" });
    if (p === "/api/v1/deals/42/participants")
      return json(200, {
        success: true,
        data: [
          { id: 1, person_id: { name: "Ana Pérez", email: [{ value: "ana@acme.test", primary: true }], value: 7 } },
          { id: 2, person_id: { name: "Luis Gómez", email: [{ value: "luis@acme.test", primary: true }], phone: [], value: 8 } },
          { id: 3, person_id: 9 },
        ],
        related_objects: { person: { "9": { id: 9, name: "Carla Ruiz", email: [{ value: "carla@acme.test", primary: true }], phone: [] } } },
      });
    if (p === "/api/v1/dealFields") return json(200, { success: true, data: dealFields });
    if (p === "/api/v1/personFields") return json(200, { success: true, data: [{ key: "name", name: "Name", field_type: "varchar" }] });
    if (p === "/api/v1/persons/7") return json(200, { success: true, data: { id: 7, name: "Ana Pérez", email: [{ value: "ana@acme.test", primary: true }], phone: [] } });
    if (p === "/api/v1/files" && method === "POST") return json(201, { success: true, data: { id: 501 } });
    if (p === "/api/v1/notes" && method === "POST") return json(201, { success: true, data: { id: 601 } });
    return json(404, { success: false, error: `mock: ${method} ${p}` });
  }) as typeof fetch;
}

const conn = (creds: Record<string, unknown> = { access_token: "pd-at-1", refresh_token: "pd-rt", expires_at: Date.now() + 3_600_000 }) =>
  new CrmConn({ id: "c1", provider: "pipedrive", auth_type: "oauth", credentials_enc: encrypt(JSON.stringify(creds)), config: { apiDomain: "https://acme.pipedrive.com" } }, null);

beforeEach(() => {
  calls = [];
  token = "pd-at-1";
  process.env.PIPEDRIVE_CLIENT_ID = "pd-client";
  process.env.PIPEDRIVE_CLIENT_SECRET = "pd-secret";
  globalThis.fetch = fakePipedrive();
});
afterEach(() => {
  globalThis.fetch = real;
  delete process.env.PIPEDRIVE_CLIENT_ID;
  delete process.env.PIPEDRIVE_CLIENT_SECRET;
});

describe("Pipedrive", () => {
  it("valida el api_domain de la compañía", () => {
    expect(validatePipedriveDomain("https://acme.pipedrive.com/")).toBe("https://acme.pipedrive.com");
    for (const bad of ["https://evil.test", "http://acme.pipedrive.com", "https://acme.pipedrive.com.evil.test", "https://a.b.pipedrive.com", "no es url"]) {
      expect(() => validatePipedriveDomain(bad), bad).toThrow(/api_domain/);
    }
  });

  it("solo OAuth: configurado con las variables, sin token pegado", () => {
    expect(oauthConfigured("pipedrive")).toBe(true);
    expect(tokenSupported("pipedrive")).toBe(false);
    delete process.env.PIPEDRIVE_CLIENT_SECRET;
    expect(oauthConfigured("pipedrive")).toBe(false);
  });

  it("prueba de conexión: etiqueta con el dominio de la compañía", async () => {
    const t = await testConnection(conn());
    expect(t).toEqual({ label: "acme.pipedrive.com", config: { companyId: "9988", companyDomain: "acme" } });
  });

  it("lee el deal: persona principal primero, participantes sin repetir, campos personalizados por key y por nombre", async () => {
    const r = await fetchRecord(conn(), "deal", "42", ["title", PLAN_KEY, "NIT", "org_id"]);
    expect(r.title).toBe("Licencia anual ACME");
    expect(r.contacts.map((c) => [c.id, c.name, c.email, c.primary])).toEqual([
      ["7", "Ana Pérez", "ana@acme.test", true],
      ["8", "Luis Gómez", "luis@acme.test", false],
      ["9", "Carla Ruiz", "carla@acme.test", false],
    ]);
    // Opción única: el id 37 se muestra como su etiqueta; un campo pedido por su nombre visible se resuelve a su key.
    expect(r.properties[PLAN_KEY]).toBe("Plan Pro");
    expect(r.properties.NIT).toBe("900123456");
    const roles = CreateCrmMappingInput.parse({
      connectionId: "0192f0e0-0000-7000-8000-000000000001",
      name: "x",
      objectType: "deal",
      roles: [
        { role: "Cliente", source: "contact_role", primary: true, channels: ["email", "whatsapp"] },
        { role: "Garante", source: "contact", index: 2 },
      ],
    }).roles;
    const rec = mapRecipients(r, roles);
    expect(rec[0]).toMatchObject({ name: "Ana Pérez", email: "ana@acme.test", phone: "+573001112233", channels: ["email", "whatsapp"] });
    expect(rec[1]).toMatchObject({ name: "Carla Ruiz", email: "carla@acme.test" });
    expect(
      mapPrefill(r, [
        { field: "Monto", property: "value" },
        { field: "Empresa", property: "org_id.name" },
        { field: "Plan", property: PLAN_KEY },
        { field: "NIT", property: "NIT" },
      ]),
    ).toEqual({ Monto: "1500", Empresa: "ACME S.A.S.", Plan: "Plan Pro", NIT: "900123456" });
  });

  it("sin campos personalizados pedidos no lee la definición de campos", async () => {
    await fetchRecord(conn(), "deal", "42", ["title", "value"]);
    expect(calls.some((c) => c.url.includes("/dealFields"))).toBe(false);
  });

  it("lee una Person (objectType contact): ella misma es el contacto principal", async () => {
    const r = await fetchRecord(conn(), "contact", "7", []);
    expect(r.title).toBe("Ana Pérez");
    expect(r.contacts).toEqual([{ id: "7", name: "Ana Pérez", email: "ana@acme.test", phone: null, role: null, primary: true }]);
    await expect(fetchRecord(conn(), "invoice", "7", [])).rejects.toThrow(/no admite/);
  });

  it("deal inexistente → 404", async () => {
    await expect(fetchRecord(conn(), "deal", "404", [])).rejects.toMatchObject({ status: 404 });
  });

  it("token vencido: refresca con Basic (sin secreto en el cuerpo) y reintenta", async () => {
    const c = conn({ access_token: "viejo", refresh_token: "pd-rt", expires_at: Date.now() - 1000 });
    await fetchRecord(c, "deal", "42", []);
    const tok = calls.find((x) => x.url === "https://oauth.pipedrive.com/oauth/token")!;
    expect(tok.body).toEqual({ grant_type: "refresh_token", refresh_token: "pd-rt" });
    expect(tok.headers.authorization).toMatch(/^Basic /);
    expect(c.creds).toMatchObject({ access_token: "pd-at-2", refresh_token: "pd-rt-2" });
  });

  it("un 401 sin vencimiento conocido también refresca una vez", async () => {
    const c = conn({ access_token: "revocado", refresh_token: "pd-rt", expires_at: null });
    const r = await fetchRecord(c, "contact", "7", []);
    expect(r.id).toBe("7");
    expect(calls.filter((x) => x.url.includes("/oauth/token"))).toHaveLength(1);
  });

  it("write-back: campo de opción única por nombre → id de la opción; opción inexistente → error de mapeo", async () => {
    await writeStatus(conn(), "deal", "42", "Estado CalaSign", "firmado");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://acme.pipedrive.com/api/v1/deals/42");
    expect(put.body).toEqual({ [STATUS_KEY]: 12 });
    await writeStatus(conn(), "deal", "42", "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", "completed");
    expect(calls.filter((c) => c.method === "PUT")[1].body).toEqual({ c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0: "completed" });
    await expect(writeStatus(conn(), "deal", "42", STATUS_KEY, "anulado")).rejects.toBeInstanceOf(MappingError);
    await expect(writeStatus(conn(), "deal", "42", "no_existe", "sent")).rejects.toBeInstanceOf(MappingError);
  });

  it("adjunta el PDF al deal (Files API) y deja una nota con el hash y el link", async () => {
    const ref = await attachSigned(conn(), "deal", "42", {
      fileName: "Contrato - 0192.pdf",
      pdf: new TextEncoder().encode("%PDF-1.4 x"),
      subject: "Contrato <ACME>",
      envelopeId: "env-1",
      sha256: "ab".repeat(32),
      url: "https://app.calasign.test/app/envelopes/env-1",
    });
    expect(ref).toBe("file:501 note:601");
    const file = calls.find((c) => c.url.endsWith("/api/v1/files"))!;
    expect(file.body).toBeInstanceOf(FormData);
    expect((file.body as FormData).get("deal_id")).toBe("42");
    expect(((file.body as FormData).get("file") as File).name).toBe("Contrato - 0192.pdf");
    const note = calls.find((c) => c.url.endsWith("/api/v1/notes"))!;
    expect(note.body.deal_id).toBe(42);
    expect(note.body.content).toContain("ab".repeat(32));
    expect(note.body.content).toContain('href="https://app.calasign.test/app/envelopes/env-1"');
    expect(note.body.content).toContain("Contrato &lt;ACME&gt;");
  });

  it("adjunta a una Person con person_id", async () => {
    await attachSigned(conn(), "contact", "7", { fileName: "a.pdf", pdf: new Uint8Array([37]), subject: "S", envelopeId: "e", sha256: "0", url: "https://x.test" });
    expect((calls.find((c) => c.url.endsWith("/files"))!.body as FormData).get("person_id")).toBe("7");
    expect(calls.find((c) => c.url.endsWith("/notes"))!.body.person_id).toBe(7);
  });
});
