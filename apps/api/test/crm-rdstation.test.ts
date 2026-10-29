// RD Station CRM (API v2) con un fetch falso (sin red): OAuth (refresh con rotación del refresh token), lectura de
// una negociação con sus contatos y campos personalizados, write-back en un campo de opción, Anexos + anotação.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/lib/util";
import { MappingError, mapPrefill, mapRecipients } from "../src/modules/crm/mapping";
import {
  CrmConn,
  attachSigned,
  fetchRecord,
  oauthApp,
  oauthConfigured,
  testConnection,
  tokenSupported,
  writeStatus,
} from "../src/modules/crm/providers";

const DEAL = "65f0a1b2c3d4e5f6a7b8c9d0";
const C1 = "65f0a1b2c3d4e5f6a7b8c9d1";
const C2 = "65f0a1b2c3d4e5f6a7b8c9d2";
const GONE = "65f0a1b2c3d4e5f6a7b8c9d3";
const API = "https://api.rd.services";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
let calls: Call[] = [];
let token = "rd-at-1";
let noteFails = false;
const real = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fields = [
  { id: "f1", name: "Estado CalaSign", slug: "estado_calasign", type: "option", options: ["Enviado", "Assinado", "Recusado"] },
  { id: "f2", name: "CNPJ", slug: "cnpj", type: "text" },
  { id: "f3", name: "Observação", slug: "observacao", type: "text" },
];

function fakeRd(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init?.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === "string") body = JSON.parse(body);
    calls.push({ method, url, headers, body });
    const u = new URL(url);
    if (u.origin !== API) return json(404, { errors: [{ detail: `host ${u.host}` }] });
    if (u.pathname === "/oauth2/token") {
      if (body.client_id !== "rd-client" || body.client_secret !== "rd-secret") return json(401, { error: "invalid_client" });
      if (body.grant_type === "refresh_token" && body.refresh_token === "rd-rt") {
        token = "rd-at-2";
        return json(200, { access_token: token, refresh_token: "rd-rt-2", expires_in: 7200 });
      }
      return json(400, { error: "invalid_grant" });
    }
    if (headers.authorization !== `Bearer ${token}`) return json(401, { errors: [{ detail: "token inválido" }] });
    const p = u.pathname;
    if (p === "/crm/v2/users") return json(200, { data: [{ id: "u1", name: "Admin", email: "admin@acme.com.br" }] });
    if (p === `/crm/v2/deals/${DEAL}` && method === "GET")
      return json(200, {
        data: {
          id: DEAL,
          name: "Licença anual ACME",
          one_time_price: 1500,
          contact_ids: [C1, GONE, C2, C1],
          custom_fields: { cnpj: "12.345.678/0001-90", estado_calasign: "" },
        },
      });
    if (p === `/crm/v2/deals/${DEAL}` && method === "PUT") return json(200, { data: { id: DEAL } });
    if (p === `/crm/v2/contacts/${C1}`)
      return json(200, {
        data: {
          id: C1,
          name: "Ana Souza",
          job_title: "Diretora",
          emails: [{ email: "ana@acme.com.br" }],
          phones: [
            { phone: "+55 11 3333-4444", type: "work" },
            { phone: "+55 11 99999-0000", type: "mobile" },
          ],
        },
      });
    if (p === `/crm/v2/contacts/${C2}`) return json(200, { data: { id: C2, name: "", emails: [{ email: "beto@acme.com.br" }], phones: [] } });
    if (p === `/crm/v2/contacts/${GONE}`) return json(404, { errors: [{ detail: "Contact not found" }] });
    if (p === "/crm/v2/custom_fields") return json(200, { data: fields, links: {} });
    if (p === `/crm/v2/deals/${DEAL}/files` && method === "POST") return json(201, { data: { id: "file-1", name: "x.pdf" } });
    if (p === `/crm/v2/deals/${DEAL}/notes` && method === "POST")
      return noteFails ? json(500, { errors: [{ detail: "boom" }] }) : json(201, { data: { id: "note-1" } });
    return json(404, { errors: [{ detail: `mock: ${method} ${p}` }] });
  }) as typeof fetch;
}

const conn = (creds: Record<string, unknown> = { access_token: "rd-at-1", refresh_token: "rd-rt", expires_at: Date.now() + 3_600_000 }) =>
  new CrmConn({ id: "c1", provider: "rdstation", auth_type: "oauth", credentials_enc: encrypt(JSON.stringify(creds)), config: {} }, null);

const attach = {
  fileName: "Contrato.pdf",
  pdf: new TextEncoder().encode("%PDF-1.4 x"),
  subject: "Contrato ACME",
  envelopeId: "env-1",
  sha256: "ab".repeat(32),
  url: "https://app.calasign.test/app/envelopes/env-1",
};

beforeEach(() => {
  calls = [];
  token = "rd-at-1";
  noteFails = false;
  process.env.RDSTATION_CLIENT_ID = "rd-client";
  process.env.RDSTATION_CLIENT_SECRET = "rd-secret";
  globalThis.fetch = fakeRd();
});
afterEach(() => {
  globalThis.fetch = real;
  delete process.env.RDSTATION_CLIENT_ID;
  delete process.env.RDSTATION_CLIENT_SECRET;
  delete process.env.RDSTATION_OAUTH_PKCE;
});

describe("RD Station CRM", () => {
  it("solo OAuth (App Store): authorize en accounts.rdstation.com, token en api.rd.services; PKCE apagado salvo variable", () => {
    expect(oauthConfigured("rdstation")).toBe(true);
    expect(tokenSupported("rdstation")).toBe(false);
    const app = oauthApp("rdstation");
    expect(app.authorizeUrl).toBe("https://accounts.rdstation.com/oauth/authorize");
    expect(app.tokenUrl).toBe("https://api.rd.services/oauth2/token");
    expect(app.pkce).toBe(false);
    process.env.RDSTATION_OAUTH_PKCE = "true";
    expect(oauthApp("rdstation").pkce).toBe(true);
    delete process.env.RDSTATION_CLIENT_SECRET;
    expect(oauthConfigured("rdstation")).toBe(false);
  });

  it("prueba de conexión", async () => {
    expect(await testConnection(conn())).toEqual({ label: "RD Station CRM · acme.com.br", config: {} });
  });

  it("lee la negociação: contatos en orden (el primero es el principal), sin repetir y salteando uno borrado; campos por slug y por nombre", async () => {
    const r = await fetchRecord(conn(), "deal", DEAL.toUpperCase(), ["cnpj", "CNPJ", "one_time_price"]);
    expect(r.title).toBe("Licença anual ACME");
    expect(r.contacts).toEqual([
      { id: C1, name: "Ana Souza", email: "ana@acme.com.br", phone: "+55 11 99999-0000", role: "Diretora", primary: true },
      { id: C2, name: "beto@acme.com.br", email: "beto@acme.com.br", phone: null, role: null, primary: false },
    ]);
    expect(r.properties.cnpj).toBe("12.345.678/0001-90");
    expect(r.properties.CNPJ).toBe("12.345.678/0001-90");
    expect(r.properties.custom_fields).toBeUndefined();
    const rec = mapRecipients(r, [
      { role: "Cliente", source: "contact_role", primary: true },
      { role: "Testemunha", source: "contact", index: 1 },
    ] as any);
    expect(rec.map((x) => x.email)).toEqual(["ana@acme.com.br", "beto@acme.com.br"]);
    expect(
      mapPrefill(r, [
        { field: "Valor", property: "one_time_price" },
        { field: "CNPJ", property: "CNPJ" },
      ]),
    ).toEqual({ Valor: "1500", CNPJ: "12.345.678/0001-90" });
  });

  it("sin campos pedidos por nombre no lee la definición de campos", async () => {
    await fetchRecord(conn(), "deal", DEAL, ["cnpj", "name"]);
    expect(calls.some((c) => c.url.includes("/custom_fields"))).toBe(false);
  });

  it("ids que no son de RD → 404 sin llamar a la API; otros tipos de registro no se admiten", async () => {
    await expect(fetchRecord(conn(), "deal", "../users", [])).rejects.toMatchObject({ status: 404 });
    await expect(fetchRecord(conn(), "contact", C1, [])).rejects.toThrow(/no admite/);
    expect(calls).toHaveLength(0);
  });

  it("token vencido: refresca (secreto en el cuerpo) y guarda el refresh token nuevo", async () => {
    const c = conn({ access_token: "viejo", refresh_token: "rd-rt", expires_at: Date.now() - 1000 });
    await fetchRecord(c, "deal", DEAL, []);
    const tok = calls.find((x) => x.url === `${API}/oauth2/token`)!;
    expect(tok.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "rd-rt", client_id: "rd-client" });
    expect(c.creds).toMatchObject({ access_token: "rd-at-2", refresh_token: "rd-rt-2" });
  });

  it("write-back: campo de opción por nombre → texto de la opción; opción o campo inexistente → error de mapeo", async () => {
    await writeStatus(conn(), "deal", DEAL, "Estado CalaSign", "assinado");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`${API}/crm/v2/deals/${DEAL}`);
    expect(put.body).toEqual({ data: { custom_fields: { estado_calasign: "Assinado" } } });
    const list = calls.find((c) => c.url.includes("/custom_fields"))!;
    expect(decodeURIComponent(list.url)).toContain("filter=entity:deal");
    await writeStatus(conn(), "deal", DEAL, "observacao", "completed");
    expect(calls.filter((c) => c.method === "PUT")[1].body).toEqual({ data: { custom_fields: { observacao: "completed" } } });
    await expect(writeStatus(conn(), "deal", DEAL, "estado_calasign", "anulado")).rejects.toBeInstanceOf(MappingError);
    await expect(writeStatus(conn(), "deal", DEAL, "no_existe", "sent")).rejects.toBeInstanceOf(MappingError);
  });

  it("adjunta el PDF (multipart data[file]) y deja una anotação con el hash y el link", async () => {
    expect(await attachSigned(conn(), "deal", DEAL, attach)).toBe("file:file-1 note:note-1");
    const file = calls.find((c) => c.url.endsWith("/files"))!;
    expect(((file.body as FormData).get("data[file]") as File).name).toBe("Contrato.pdf");
    const note = calls.find((c) => c.url.endsWith("/notes"))!;
    expect(note.body.data.description).toContain("ab".repeat(32));
    expect(note.body.data.description).toContain(attach.url);
  });

  it("si la anotação falla, el PDF ya quedó: no se relanza (un reintento lo subiría dos veces)", async () => {
    noteFails = true;
    expect(await attachSigned(conn(), "deal", DEAL, attach)).toBe("file:file-1");
  });
});
