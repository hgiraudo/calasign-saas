// TOTVS Protheus (ERP) con un REST falso (sin red): todas las llamadas van por safeRequest (la URL base la carga la
// organización), así que se reemplaza safeRequest. Token OAuth2 password con usuario y contraseña en encabezados (nunca
// en la URL), tenantId, nuevo token al vencer y ante un 401, búsqueda del cliente por CPF/CNPJ verificada contra la
// respuesta (un servidor que ignora el filtro no vincula otro cliente) y anotação con el hash y el link.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
const calls: Call[] = [];
let token = "tv-at-1";
let tokenStatus = 200;
/** El servidor ignora el filtro de documento (versiones que no implementan el filtro simple). */
let ignoresFilter = false;
let notesStatus = 201;

const BASE = "https://erp.acme.test:8400/rest";
const reply = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify(body)),
});

const CUSTOMERS = [
  {
    branchId: "01",
    code: "000123",
    storeId: "01",
    name: "ACME INDÚSTRIA LTDA",
    governmentalInformation: [
      { name: "CNPJ", scope: "Federal", id: "11222333000181" },
      { name: "INSCRICAO ESTADUAL", scope: "State", id: "110042490114" },
    ],
  },
  {
    branchId: "01",
    code: "000124",
    storeId: "02",
    name: "BETA ME",
    governmentalInformation: [{ name: "CPF", scope: "Federal", id: ["12345678909"] }],
  },
];

function fakeTotvs(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) {
  const method = opts.method ?? "GET";
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = typeof opts.body === "string" && opts.body ? JSON.parse(opts.body) : opts.body;
  calls.push({ method, url, headers, body });
  const u = new URL(url);
  if (u.origin !== "https://erp.acme.test:8400" || !u.pathname.startsWith("/rest/")) return reply(404, { code: "404", message: `host ${u.host}` });
  const p = u.pathname.slice("/rest".length);
  if (p === "/api/oauth2/v1/token") {
    if (method !== "POST" || u.searchParams.get("grant_type") !== "password") return reply(400, { code: "400", message: "grant_type" });
    if (tokenStatus !== 200) return reply(tokenStatus, { code: String(tokenStatus), message: "Usuário ou senha inválidos" });
    if (headers.username !== "integracao" || headers.password !== "s3nha-Protheus")
      return reply(401, { code: "401", message: "Usuário ou senha inválidos" });
    token = `tv-at-${calls.filter((c) => c.url.includes("/oauth2/")).length + 1}`;
    return reply(200, { access_token: token, refresh_token: "tv-rt", scope: "default", token_type: "Bearer", expires_in: 3600, hasMFA: false });
  }
  if (headers.authorization !== `Bearer ${token}`) return reply(401, { code: "401", message: "token inválido" });
  if (p === "/api/crm/v1/customerVendor/Customer" && method === "GET") {
    const doc = u.searchParams.get("governmentalInformation.id");
    if (doc === "99888777000166") return reply(500, { code: "500", message: "erro interno" });
    const items = !doc || ignoresFilter ? CUSTOMERS : CUSTOMERS.filter((c) => JSON.stringify(c.governmentalInformation).includes(doc));
    if (!items.length) return reply(404, { code: "404", message: "Entidade não localizada na base!" });
    return reply(200, { items: u.searchParams.get("pageSize") === "1" ? items.slice(0, 1) : items, hasNext: false });
  }
  if (p === "/api/crm/v1/notes" && method === "POST") {
    if (notesStatus !== 201) return reply(notesStatus, { code: String(notesStatus), message: "erro na inclusão" });
    return reply(201, { ...body, Code: "000045", InternalId: "01000045" });
  }
  return reply(404, { code: "404", message: `mock: ${method} ${p}` });
}

vi.mock("../src/modules/webhooks", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/modules/webhooks")>();
  return { ...orig, safeRequest: vi.fn(async (url: string, opts: any) => fakeTotvs(url, opts)) };
});

const { encrypt } = await import("../src/lib/util");
const { CRM_KIND, CRM_PROVIDER_OBJECTS } = await import("@calasign/shared");
const { CrmConn, CrmError, attachSigned, fetchRecord, findByIdentification, testConnection, tokenSupported, oauthConfigured } = await import(
  "../src/modules/crm/providers"
);
const { parseTotvsCustomerKey, validateTotvsBaseUrl, totvsNote } = await import("../src/modules/crm/totvs");

const conn = (creds: Record<string, unknown> = {}, cfg: Record<string, unknown> = { baseUrl: BASE }) =>
  new CrmConn(
    {
      id: "c1",
      provider: "totvs",
      auth_type: "token",
      credentials_enc: encrypt(JSON.stringify({ username: "integracao", password: "s3nha-Protheus", ...creds })),
      config: cfg,
    },
    null,
  );

const attach = {
  fileName: "Contrato.pdf",
  pdf: new TextEncoder().encode("%PDF-1.4 x"),
  subject: "Contrato de fornecimento ACME",
  envelopeId: "0190f1a2-0000-7000-8000-000000000001",
  sha256: "ab".repeat(32),
  url: "https://app.calasign.test/app/envelopes/0190f1a2-0000-7000-8000-000000000001",
};

beforeEach(() => {
  calls.length = 0;
  token = "tv-at-1";
  tokenStatus = 200;
  ignoresFilter = false;
  notesStatus = 201;
});
afterEach(() => vi.clearAllMocks());

describe("TOTVS Protheus", () => {
  it("es un ERP por token (usuario y contraseña) que admite clientes", () => {
    expect(CRM_KIND.totvs).toBe("erp");
    expect(CRM_PROVIDER_OBJECTS.totvs).toEqual(["customer"]);
    expect(tokenSupported("totvs")).toBe(true);
    expect(oauthConfigured("totvs")).toBe(false);
  });

  it("URL del REST: https con puerto y contexto (sin barra final); sin credenciales, query ni fragmento", () => {
    expect(validateTotvsBaseUrl(" https://erp.acme.test:8400/rest/ ")).toBe(BASE);
    expect(validateTotvsBaseUrl("https://acme.protheus.cloudtotvs.com.br:4050")).toBe("https://acme.protheus.cloudtotvs.com.br:4050");
    expect(() => validateTotvsBaseUrl("http://erp.acme.test/rest")).toThrow(/https/);
    expect(() => validateTotvsBaseUrl("https://user:pass@erp.acme.test/rest")).toThrow(/usuario ni contraseña/);
    expect(() => validateTotvsBaseUrl("https://erp.acme.test/rest?x=1")).toThrow(/parámetros/);
    expect(() => validateTotvsBaseUrl("ftp://erp.acme.test")).toThrow(/https/);
    expect(() => validateTotvsBaseUrl("no es una url")).toThrow(/no es válida/);
  });

  it("prueba de conexión: token con usuario y contraseña en encabezados (no en la URL), tenantId y Bearer", async () => {
    const c = conn({}, { baseUrl: BASE, tenantId: "01,0101" });
    expect(await testConnection(c)).toEqual({ label: "TOTVS Protheus · erp.acme.test:8400 · 01,0101", config: {} });
    const tok = calls[0];
    expect(tok.method).toBe("POST");
    expect(tok.url).toBe(`${BASE}/api/oauth2/v1/token?grant_type=password`);
    expect(tok.headers).toMatchObject({ username: "integracao", password: "s3nha-Protheus", tenantid: "01,0101" });
    // Ni el usuario ni la contraseña en ninguna URL (quedarían en los logs de acceso del servidor de la organización).
    expect(calls.some((x) => /s3nha|integracao/.test(x.url))).toBe(false);
    const list = calls[1];
    expect(list.url).toBe(`${BASE}/api/crm/v1/customerVendor/Customer?page=1&pageSize=1`);
    expect(list.headers).toMatchObject({ authorization: "Bearer tv-at-2", tenantid: "01,0101" });
    expect(c.creds).toMatchObject({ access_token: "tv-at-2" });
    expect(c.creds.expires_at).toBeGreaterThan(Date.now() + 3_500_000);
    // El refresh token de TOTVS va en la query: no se guarda ni se usa.
    expect(c.creds.refresh_token).toBeUndefined();
  });

  it("token vigente: no pide otro; vencido: pide uno nuevo; un 401 renueva una vez y reintenta", async () => {
    await testConnection(conn({ access_token: "tv-at-1", expires_at: Date.now() + 3_000_000 }));
    expect(calls.some((x) => x.url.includes("/oauth2/"))).toBe(false);

    calls.length = 0;
    await testConnection(conn({ access_token: "tv-at-1", expires_at: Date.now() - 1000 }));
    expect(calls[0].url).toContain("/api/oauth2/v1/token");

    calls.length = 0;
    token = "tv-at-9"; // el servidor invalidó el token guardado (reinicio del REST)
    await testConnection(conn({ access_token: "tv-at-1", expires_at: Date.now() + 3_000_000 }));
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      "/rest/api/crm/v1/customerVendor/Customer",
      "/rest/api/oauth2/v1/token",
      "/rest/api/crm/v1/customerVendor/Customer",
    ]);
  });

  it("credenciales rechazadas → hay que reconectar; el REST caído (5xx) es transitorio", async () => {
    const bad = conn({ password: "otra" });
    const err = await testConnection(bad).catch((e) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect(err).toMatchObject({ status: 401, authFailed: true });
    expect(err.message).toContain("Usuário ou senha inválidos");
    expect(err.message).not.toContain("otra");
    tokenStatus = 503;
    await expect(testConnection(conn())).rejects.toMatchObject({ status: 503, authFailed: false });
  });

  it("una conexión sin URL o con una URL inválida guardada no llama a nadie", async () => {
    await expect(testConnection(conn({}, {}))).rejects.toThrow(/sin la URL/);
    await expect(testConnection(conn({}, { baseUrl: "http://erp.acme.test/rest" }))).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("busca el cliente por CNPJ o CPF (con o sin puntuación) y devuelve filial|código|loja", async () => {
    expect(await findByIdentification(conn(), "customer", "11.222.333/0001-81")).toBe("01|000123|01");
    const q = calls.find((x) => x.url.includes("customerVendor"))!;
    expect(new URL(q.url).searchParams.get("governmentalInformation.id")).toBe("11222333000181");
    expect(await findByIdentification(conn(), "customer", "123.456.789-09")).toBe("01|000124|02");
  });

  it("sin resultados (404 de la API) → null; un servidor que ignora el filtro no vincula otro cliente", async () => {
    expect(await findByIdentification(conn(), "customer", "99.999.999/0001-99")).toBeNull();
    ignoresFilter = true;
    expect(await findByIdentification(conn(), "customer", "99.999.999/0001-99")).toBeNull();
    // La inscrição estadual de ACME no es un CPF/CNPJ: no se compara.
    expect(await findByIdentification(conn(), "customer", "110042490114")).toBeNull();
    expect(await findByIdentification(conn(), "customer", "11222333000181")).toBe("01|000123|01");
  });

  it("un error en la búsqueda no lleva el CPF/CNPJ en el mensaje (va a last_error y al log del worker)", async () => {
    const err = await findByIdentification(conn(), "customer", "99.888.777/0001-66").catch((e) => e);
    expect(err).toMatchObject({ status: 500, authFailed: false });
    expect(err.message).toContain("governmentalInformation.id=***");
    expect(err.message).not.toContain("99888777000166");
  });

  it("deja una anotação en el cliente (SA1, clave filial+código+loja) con el hash y el link", async () => {
    expect(await attachSigned(conn(), "customer", "01|000123|01", attach)).toBe("note:000045");
    const post = calls.find((x) => x.method === "POST" && x.url.endsWith("/api/crm/v1/notes"))!;
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toMatchObject({ ResourceType: "SA1", ResourceCode: "01000123" + "01" });
    expect(post.body.Description).toBe("CalaSign: «Contrato de fornecimento ACME» assinado");
    expect(post.body.Content).toContain(attach.sha256);
    expect(post.body.Content).toContain(attach.url);
    expect(post.body.Date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Vinculado a mano con "código|loja" (tabla de clientes compartida, sin filial).
    await attachSigned(conn(), "customer", "000124|02", attach);
    expect(calls.filter((x) => x.url.endsWith("/notes"))[1].body.ResourceCode).toBe("00012402");
  });

  it("los campos de la anotação respetan los 250 caracteres de AOB_TITULO y AOB_CONTEU", () => {
    const n = totvsNote({ ...attach, subject: "x".repeat(400), url: `https://firmas.acme.test/${"y".repeat(300)}` });
    expect(n.Description.length).toBe(250);
    expect(n.Content.length).toBe(250);
    expect(n.Content.startsWith(`SHA-256 do PDF: ${attach.sha256}`)).toBe(true);
  });

  it("anotação rechazada → error con el mensaje de TOTVS; ids vacíos → 404 sin llamar; otros tipos no se admiten", async () => {
    notesStatus = 400;
    await expect(attachSigned(conn(), "customer", "01|000123|01", attach)).rejects.toThrow(/HTTP 400 erro na inclusão/);
    calls.length = 0;
    expect(() => parseTotvsCustomerKey("01||01")).toThrow(/no existe/);
    await expect(attachSigned(conn(), "customer", "||", attach)).rejects.toMatchObject({ status: 404 });
    await expect(attachSigned(conn(), "invoice", "01|000123|01", attach)).rejects.toThrow(/no admite/);
    await expect(fetchRecord(conn(), "customer", "01|000123|01", [])).rejects.toThrow(/no admite/);
    expect(calls).toHaveLength(0);
  });
});
