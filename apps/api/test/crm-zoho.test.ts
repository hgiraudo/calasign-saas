// Conector de Zoho CRM / Bigin: centros de datos, OAuth y llamadas HTTP contra un fetch falso (sin red).
import { afterEach, describe, expect, it } from "vitest";
import { StartCrmOAuthInput } from "@calasign/shared";
import { encrypt } from "../src/lib/util";
import {
  CrmConn,
  attachSigned,
  fetchRecord,
  oauthApp,
  oauthConfigured,
  testConnection,
  tokenSupported,
  validateZohoAccounts,
  validateZohoApiDomain,
  writeStatus,
  zohoAccountsBase,
  zohoModule,
} from "../src/modules/crm/providers";

const realFetch = globalThis.fetch;
const ZOHO_ENV = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_OAUTH_PKCE", "ZOHO_ACCOUNTS_URL"];
const envBackup = Object.fromEntries(ZOHO_ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  // Se muta process.env (providers.ts guarda la referencia al objeto): reasignarlo no tendría efecto.
  for (const k of ZOHO_ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(c);
    const r = respond(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const API = "https://www.zohoapis.eu";
const conn = (cfg: Record<string, unknown> = {}, creds: Record<string, unknown> = {}) =>
  new CrmConn(
    {
      id: "c1",
      provider: "zoho",
      auth_type: "oauth",
      credentials_enc: encrypt(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_at: Date.now() + 3_600_000, ...creds })),
      config: { accountsServer: "https://accounts.zoho.eu", apiDomain: API, product: "crm", ...cfg },
    },
    null,
  );

describe("Zoho: centros de datos", () => {
  it("arma el servidor de cuentas de cada región (Canadá en zohocloud.ca)", () => {
    delete process.env.ZOHO_ACCOUNTS_URL;
    expect(zohoAccountsBase()).toBe("https://accounts.zoho.com");
    expect(zohoAccountsBase("eu")).toBe("https://accounts.zoho.eu");
    expect(zohoAccountsBase("com.au")).toBe("https://accounts.zoho.com.au");
    expect(zohoAccountsBase("ca")).toBe("https://accounts.zohocloud.ca");
    expect(zohoAccountsBase("jp")).toBe("https://accounts.zoho.jp");
  });

  it("solo acepta accounts-server y api_domain de Zoho por https", () => {
    for (const ok of [
      "https://accounts.zoho.com",
      "https://accounts.zoho.eu/",
      "https://accounts.zoho.in",
      "https://accounts.zoho.com.au",
      "https://accounts.zohocloud.ca",
      "https://accounts.zoho.jp",
    ]) {
      expect(validateZohoAccounts(ok)).toBe(ok.replace(/\/$/, ""));
    }
    for (const bad of [
      "http://accounts.zoho.eu",
      "https://accounts.zoho.com.evil.test",
      "https://evil.test/accounts.zoho.com",
      "https://accounts.zoho.com:8443",
      "https://xaccounts.zoho.com",
      "no es url",
    ]) {
      expect(() => validateZohoAccounts(bad), bad).toThrow();
    }
    expect(validateZohoApiDomain("https://www.zohoapis.com")).toBe("https://www.zohoapis.com");
    expect(validateZohoApiDomain("https://www.zohoapis.com.au")).toBe("https://www.zohoapis.com.au");
    expect(validateZohoApiDomain("https://zohoapis.eu")).toBe("https://zohoapis.eu");
    for (const bad of ["https://www.zohoapis.com.evil.test", "http://www.zohoapis.com", "https://evil.zohoapis.com", "https://www.zohoapis.xyz"]) {
      expect(() => validateZohoApiDomain(bad), bad).toThrow();
    }
  });

  it("módulo por producto: Deals en Zoho CRM, Pipelines en Bigin", () => {
    expect(zohoModule("crm", "deal")).toBe("Deals");
    expect(zohoModule("bigin", "deal")).toBe("Pipelines");
    expect(zohoModule(undefined, "contact")).toBe("Contacts");
    expect(() => zohoModule("crm", "invoice")).toThrow();
  });

  it("StartCrmOAuthInput valida región y producto", () => {
    expect(StartCrmOAuthInput.parse({ name: "Z", region: "eu", product: "bigin" })).toEqual({ name: "Z", region: "eu", product: "bigin" });
    expect(() => StartCrmOAuthInput.parse({ name: "Z", region: "evil.com" })).toThrow();
  });
});

describe("Zoho: OAuth", () => {
  it("app con PKCE, acceso offline y scopes por producto", () => {
    process.env.ZOHO_CLIENT_ID = "cid";
    process.env.ZOHO_CLIENT_SECRET = "sec";
    const crm = oauthApp("zoho", { accounts: "https://accounts.zoho.eu", product: "crm" });
    expect(crm.authorizeUrl).toBe("https://accounts.zoho.eu/oauth/v2/auth");
    expect(crm.tokenUrl).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(crm.pkce).toBe(true);
    expect(crm.authorizeParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(crm.scope).toContain("ZohoCRM.modules.ALL");
    expect(oauthApp("zoho", { product: "bigin" }).scope).toContain("ZohoBigin.modules.ALL");
    expect(oauthConfigured("zoho")).toBe(true);
    expect(tokenSupported("zoho")).toBe(false);
    process.env.ZOHO_OAUTH_PKCE = "false";
    expect(oauthApp("zoho").pkce).toBe(false);
    delete process.env.ZOHO_CLIENT_SECRET;
    expect(oauthConfigured("zoho")).toBe(false);
  });

  it("ante un 401 refresca en el accounts-server de la conexión y reintenta con Zoho-oauthtoken", async () => {
    process.env.ZOHO_CLIENT_ID = "cid";
    process.env.ZOHO_CLIENT_SECRET = "sec";
    let token = "at-1";
    const calls = fakeFetch((c) => {
      if (c.url === "https://accounts.zoho.eu/oauth/v2/token") {
        token = "at-2";
        return { json: { access_token: "at-2", api_domain: API, expires_in: 3600 } };
      }
      if (c.headers.authorization !== `Zoho-oauthtoken ${token}` || token === "at-1")
        return { status: 401, json: { code: "INVALID_TOKEN", message: "invalid oauth token", status: "error" } };
      return { json: { org: [{ id: "org1", company_name: "ACME" }] } };
    });
    const c = conn();
    const t = await testConnection(c);
    expect(t).toEqual({ label: "ACME", config: { orgId: "org1" } });
    expect(calls.map((x) => x.url)).toEqual([`${API}/crm/v7/org`, "https://accounts.zoho.eu/oauth/v2/token", `${API}/crm/v7/org`]);
    expect(String(calls[1].body)).toContain("grant_type=refresh_token");
    expect(c.creds.refresh_token).toBe("rt-1"); // Zoho no devuelve uno nuevo: se conserva
  });

  it("refresh token revocado (200 con error invalid_code) → pide reconectar", async () => {
    process.env.ZOHO_CLIENT_ID = "cid";
    process.env.ZOHO_CLIENT_SECRET = "sec";
    fakeFetch((c) => (c.url.endsWith("/oauth/v2/token") ? { json: { error: "invalid_code" } } : { status: 401, json: { code: "INVALID_TOKEN" } }));
    await expect(testConnection(conn())).rejects.toMatchObject({ authFailed: true });
  });

  it("un accounts-server guardado que no es de Zoho no recibe el client secret", async () => {
    process.env.ZOHO_CLIENT_ID = "cid";
    process.env.ZOHO_CLIENT_SECRET = "sec";
    const calls = fakeFetch(() => ({ status: 401, json: { code: "INVALID_TOKEN" } }));
    await expect(testConnection(conn({ accountsServer: "https://evil.test" }))).rejects.toThrow(/accounts-server/);
    expect(calls.some((c) => c.url.startsWith("https://evil.test"))).toBe(false);
  });
});

describe("Zoho: registros", () => {
  it("Deal: contacto principal (Contact_Name) + roles de contacto, sin duplicar", async () => {
    const calls = fakeFetch((c) => {
      if (c.url === `${API}/crm/v7/Deals/z1`)
        return { json: { data: [{ id: "z1", Deal_Name: "Renovación", Amount: 10, Contact_Name: { id: "c1", name: "Ana" } }] } };
      if (c.url === `${API}/crm/v7/Contacts/c1`)
        return { json: { data: [{ id: "c1", First_Name: "Ana", Last_Name: "Pérez", Email: "ana@x.co", Phone: "+57 300 111 2233" }] } };
      if (c.url.startsWith(`${API}/crm/v7/Deals/z1/Contact_Roles`))
        return {
          json: {
            data: [
              { id: "c1", Full_Name: "Ana Pérez", Contact_Role: { name: "Decision Maker" } },
              { id: "c2", Full_Name: "Luis", Email: "luis@x.co", Mobile: "3001", Contact_Role: { name: "Legal" } },
            ],
          },
        };
      return { status: 404, json: {} };
    });
    const r = await fetchRecord(conn(), "deal", "z1", []);
    expect(r.properties.Deal_Name).toBe("Renovación");
    expect(r.contacts).toEqual([
      { id: "c1", name: "Ana Pérez", email: "ana@x.co", phone: "+57 300 111 2233", role: "Decision Maker", primary: true },
      { id: "c2", name: "Luis", email: "luis@x.co", phone: "3001", role: "Legal", primary: false },
    ]);
    expect(calls[0].headers.authorization).toBe("Zoho-oauthtoken at-1");
  });

  it("sin permiso a Contact_Roles alcanza con el principal; un Zoho caído corta", async () => {
    let rolesStatus = 403;
    fakeFetch((c) => {
      if (c.url.endsWith("/Deals/z1")) return { json: { data: [{ id: "z1", Contact_Name: { id: "c1" } }] } };
      if (c.url.endsWith("/Contacts/c1")) return { json: { data: [{ id: "c1", Full_Name: "Ana", Email: "a@x.co" }] } };
      return { status: rolesStatus, json: { code: "NO_PERMISSION" } };
    });
    expect((await fetchRecord(conn(), "deal", "z1", [])).contacts.map((x) => x.id)).toEqual(["c1"]);
    rolesStatus = 500;
    await expect(fetchRecord(conn(), "deal", "z1", [])).rejects.toMatchObject({ status: 500 });
  });

  it("registro inexistente (204) → 404; Bigin lee Pipelines por /bigin/v2", async () => {
    const calls = fakeFetch((c) => (c.url.includes("/bigin/v2/Pipelines/b1") ? { json: { data: [{ id: "b1", Deal_Name: "B" }] } } : { status: 204 }));
    await expect(fetchRecord(conn(), "deal", "nada", [])).rejects.toMatchObject({ status: 404 });
    const b = await fetchRecord(conn({ product: "bigin" }), "deal", "b1", []);
    expect(b.contacts).toEqual([]);
    expect(calls.at(-1)!.url).toBe(`${API}/bigin/v2/Pipelines/b1`);
    expect(calls.some((c) => c.url.includes("Contact_Roles"))).toBe(false);
  });

  it("Contact: el propio contacto es el destinatario principal", async () => {
    fakeFetch(() => ({ json: { data: [{ id: "c9", First_Name: "Zoe", Last_Name: "Z", Email: "zoe@x.co", Mobile: "+573001112233" }] } }));
    const r = await fetchRecord(conn(), "contact", "c9", []);
    expect(r.contacts).toEqual([{ id: "c9", name: "Zoe Z", email: "zoe@x.co", phone: "+573001112233", role: null, primary: true }]);
  });

  it("write-back: PUT con trigger vacío; un error de Zoho en data[0] se informa", async () => {
    const calls = fakeFetch((c) =>
      JSON.parse(String(c.body)).data[0].Malo
        ? { status: 202, json: { data: [{ code: "INVALID_DATA", message: "invalid data", status: "error", details: { api_name: "Malo" } }] } }
        : { json: { data: [{ status: "success", code: "SUCCESS" }] } },
    );
    await writeStatus(conn(), "deal", "z1", "CalaSign_Status", "Firmado");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(`${API}/crm/v7/Deals/z1`);
    expect(JSON.parse(String(calls[0].body))).toEqual({ data: [{ CalaSign_Status: "Firmado" }], trigger: [] });
    await expect(writeStatus(conn(), "deal", "z1", "Malo", "x")).rejects.toThrow(/INVALID_DATA/);
  });

  it("adjunta el PDF (multipart) y crea una nota en el registro; si la nota falla, el adjunto vale igual", async () => {
    let noteOk = true;
    const calls = fakeFetch((c) => {
      if (c.url.endsWith("/Attachments")) return { json: { data: [{ status: "success", details: { id: "att9" } }] } };
      if (c.url.endsWith("/Notes"))
        return noteOk
          ? { status: 201, json: { data: [{ status: "success", details: { id: "n9" } }] } }
          : { status: 400, json: { code: "INVALID_MODULE" } };
      return { status: 404 };
    });
    const a = {
      fileName: "Contrato.pdf",
      pdf: new TextEncoder().encode("%PDF-1.4"),
      subject: "Contrato",
      envelopeId: "e1",
      sha256: "ab".repeat(32),
      url: "https://app/x",
    };
    expect(await attachSigned(conn(), "deal", "z1", a)).toBe("attachment:att9 note:n9");
    expect(calls[0].url).toBe(`${API}/crm/v7/Deals/z1/Attachments`);
    expect(calls[0].body).toBeInstanceOf(FormData);
    const note = JSON.parse(String(calls[1].body)).data[0];
    expect(note.Parent_Id).toEqual({ module: { api_name: "Deals" }, id: "z1" });
    expect(note.Note_Content).toContain("SHA-256");
    noteOk = false;
    expect(await attachSigned(conn({ product: "bigin" }), "deal", "b1", a)).toBe("attachment:att9");
    expect(calls[2].url).toBe(`${API}/bigin/v2/Pipelines/b1/Attachments`);
  });
});
