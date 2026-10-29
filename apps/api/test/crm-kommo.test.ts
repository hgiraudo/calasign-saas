// Kommo (API v4) con un fetch falso (sin red): dominios de la cuenta y del drive validados (SSRF), refresh en el
// subdominio de la cuenta con JSON, lectura de un lead con sus contactos, write-back en un campo de lista, subida del
// PDF por la Files API (sesión + partes) adjunta al lead y nota con hash y link.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/lib/util";
import { validateKommoDomain, validateKommoDrive } from "../src/modules/crm/kommo";
import { MappingError, mapPrefill, mapRecipients } from "../src/modules/crm/mapping";
import {
  CrmConn,
  attachSigned,
  fetchRecord,
  kommoTokenUrl,
  oauthApp,
  oauthConfigured,
  testConnection,
  tokenSupported,
  writeStatus,
} from "../src/modules/crm/providers";

const ACC = "https://acme.kommo.com";
const DRIVE = "https://drive-c.kommo.com";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
let calls: Call[] = [];
let token = "km-at-1";
let filesScope = true;
let driveUrl = DRIVE;
let uploadNext: string | null = null;
let uploaded: number[] = [];
const real = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/hal+json" } });

const leadFields = [
  {
    id: 501,
    name: "Estado CalaSign",
    code: null,
    type: "select",
    enums: [
      { id: 9001, value: "Enviado" },
      { id: 9002, value: "Firmado" },
    ],
  },
  { id: 502, name: "NIT", code: "NIT", type: "text" },
];

function fakeKommo(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: any = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
    calls.push({ method, url, headers, body });
    const u = new URL(url);
    if (u.origin === ACC && u.pathname === "/oauth2/access_token") {
      if (headers["content-type"] !== "application/json" || body.client_secret !== "km-secret") return json(401, { hint: "invalid client" });
      if (body.grant_type === "refresh_token" && body.refresh_token === "km-rt" && body.redirect_uri) {
        token = "km-at-2";
        return json(200, { token_type: "Bearer", expires_in: 86400, access_token: token, refresh_token: "km-rt-2" });
      }
      return json(400, { hint: "Token has been revoked" });
    }
    if (headers.authorization !== `Bearer ${token}`) return json(401, { title: "Unauthorized", detail: "token" });
    const p = u.pathname;
    if (u.origin === DRIVE || u.origin === "https://drive-x.kommo.com") {
      if (!filesScope) return json(403, { title: "Forbidden", detail: "Access to files" });
      if (p === "/v1.0/sessions")
        return json(200, { session_id: 1, upload_url: uploadNext ?? `${DRIVE}/upload/tok-1`, max_file_size: 1e9, max_part_size: 65536 });
      if (p.startsWith("/upload/")) {
        uploaded.push((body as Uint8Array).length);
        // Hasta recibir el archivo entero responde con la URL de la parte siguiente; al final, el uuid.
        if (uploaded.reduce((a, b) => a + b, 0) < 100_000)
          return json(200, { session_id: 1, next_url: `${DRIVE}/upload/tok-${uploaded.length + 1}` });
        return json(200, { uuid: "file-uuid-1", version_uuid: "ver-1", name: "x.pdf" });
      }
    }
    if (u.origin !== ACC) return json(404, { detail: `host ${u.host}` });
    if (p === "/api/v4/account")
      return json(200, {
        id: 31337,
        name: "ACME",
        subdomain: "acme",
        ...(u.searchParams.get("with") === "drive_url" && driveUrl ? { drive_url: driveUrl } : {}),
      });
    if (p === "/api/v4/leads/42" && method === "GET")
      return json(200, {
        id: 42,
        name: "Licencia Kommo",
        price: 3200,
        custom_fields_values: [{ field_id: 502, field_name: "NIT", field_code: "NIT", field_type: "text", values: [{ value: "900777111" }] }],
        _embedded: {
          contacts: [
            { id: 8, is_main: false },
            { id: 7, is_main: true },
          ],
        },
      });
    if (p === "/api/v4/leads/42" && method === "PATCH") return json(200, { id: 42 });
    if (p === "/api/v4/leads/404") return new Response(null, { status: 204 });
    if (p === "/api/v4/contacts")
      return json(200, {
        _embedded: {
          contacts: [
            {
              id: 7,
              name: "Karen Main",
              custom_fields_values: [
                { field_code: "EMAIL", values: [{ value: "karen@acme.test", enum_code: "WORK" }] },
                {
                  field_code: "PHONE",
                  values: [
                    { value: "+5731", enum_code: "WORK" },
                    { value: "+5730", enum_code: "MOB" },
                  ],
                },
              ],
            },
            {
              id: 8,
              name: "",
              first_name: "Kevin",
              last_name: "Otro",
              custom_fields_values: [{ field_code: "EMAIL", values: [{ value: "kevin@acme.test" }] }],
            },
          ],
        },
      });
    if (p === "/api/v4/leads/custom_fields") return json(200, { _embedded: { custom_fields: leadFields }, _links: {} });
    if (p === "/api/v4/leads/42/files" && method === "PUT") return json(200, {});
    if (p === "/api/v4/leads/notes" && method === "POST") return json(200, { _embedded: { notes: [{ id: 777, entity_id: 42 }] } });
    return json(404, { detail: `mock: ${method} ${p}` });
  }) as typeof fetch;
}

const conn = (creds: Record<string, unknown> = { access_token: "km-at-1", refresh_token: "km-rt", expires_at: Date.now() + 3_600_000 }) =>
  new CrmConn(
    { id: "c1", provider: "kommo", auth_type: "oauth", credentials_enc: encrypt(JSON.stringify(creds)), config: { baseDomain: ACC } },
    null,
  );

const attach = {
  fileName: "Contrato.pdf",
  pdf: new Uint8Array(100_000).fill(37),
  subject: "Contrato ACME",
  envelopeId: "env-1",
  sha256: "cd".repeat(32),
  url: "https://app.calasign.test/app/envelopes/env-1",
};

beforeEach(() => {
  calls = [];
  token = "km-at-1";
  filesScope = true;
  driveUrl = DRIVE;
  uploadNext = null;
  uploaded = [];
  process.env.KOMMO_CLIENT_ID = "km-client";
  process.env.KOMMO_CLIENT_SECRET = "km-secret";
  globalThis.fetch = fakeKommo();
});
afterEach(() => {
  globalThis.fetch = real;
  delete process.env.KOMMO_CLIENT_ID;
  delete process.env.KOMMO_CLIENT_SECRET;
});

describe("Kommo", () => {
  it("valida el dominio de la cuenta (referer) y el del drive", () => {
    expect(validateKommoDomain("acme.kommo.com")).toBe(ACC);
    expect(validateKommoDomain("https://acme.kommo.com/")).toBe(ACC);
    expect(validateKommoDomain("vieja.amocrm.com")).toBe("https://vieja.amocrm.com");
    for (const bad of [
      "evil.test",
      "http://acme.kommo.com",
      "acme.kommo.com.evil.test",
      "a.b.kommo.com",
      "www.kommo.com",
      "drive-c.kommo.com",
      "acme.kommo.com:8443",
      "user@acme.kommo.com",
      "",
    ]) {
      expect(() => validateKommoDomain(bad), bad).toThrow(/Kommo/);
    }
    expect(kommoTokenUrl("acme.kommo.com")).toBe(`${ACC}/oauth2/access_token`);
    expect(validateKommoDrive(DRIVE).origin).toBe(DRIVE);
    for (const bad of ["https://acme.kommo.com", "https://drive-c.kommo.com.evil.test", "http://drive-c.kommo.com", "https://169.254.169.254"]) {
      expect(() => validateKommoDrive(bad), bad).toThrow(/Kommo/);
    }
  });

  it("solo OAuth; authorize global con mode=post_message", () => {
    expect(oauthConfigured("kommo")).toBe(true);
    expect(tokenSupported("kommo")).toBe(false);
    expect(oauthApp("kommo")).toMatchObject({ authorizeUrl: "https://www.kommo.com/oauth", pkce: false, authorizeParams: { mode: "post_message" } });
  });

  it("prueba de conexión: etiqueta con el subdominio", async () => {
    expect(await testConnection(conn())).toEqual({ label: "acme.kommo.com", config: { accountId: "31337" } });
  });

  it("lee el lead: contacto principal primero, email y móvil de los campos EMAIL/PHONE, campos personalizados por nombre, código e id", async () => {
    const r = await fetchRecord(conn(), "deal", "42", ["NIT"]);
    expect(r.title).toBe("Licencia Kommo");
    expect(r.contacts).toEqual([
      { id: "7", name: "Karen Main", email: "karen@acme.test", phone: "+5730", role: null, primary: true },
      { id: "8", name: "Kevin Otro", email: "kevin@acme.test", phone: null, role: null, primary: false },
    ]);
    expect(r.properties.NIT).toBe("900777111");
    expect(r.properties["502"]).toBe("900777111");
    expect(r.properties._embedded).toBeUndefined();
    const contactsCall = calls.find((c) => c.url.includes("/api/v4/contacts"))!;
    expect(decodeURIComponent(contactsCall.url)).toContain("filter[id][]=7&filter[id][]=8");
    const rec = mapRecipients(r, [
      { role: "Cliente", source: "contact_role", primary: true },
      { role: "Otro", source: "contact", index: 1 },
    ] as any);
    expect(rec.map((x) => x.email)).toEqual(["karen@acme.test", "kevin@acme.test"]);
    expect(mapPrefill(r, [{ field: "Monto", property: "price" }])).toEqual({ Monto: "3200" });
  });

  it("lead inexistente (204) o id no numérico → 404; otros tipos no se admiten", async () => {
    await expect(fetchRecord(conn(), "deal", "404", [])).rejects.toMatchObject({ status: 404 });
    await expect(fetchRecord(conn(), "deal", "42/../../account", [])).rejects.toMatchObject({ status: 404 });
    await expect(fetchRecord(conn(), "contact", "7", [])).rejects.toThrow(/no admite/);
  });

  it("token vencido: refresca en el subdominio (JSON con redirect_uri) y guarda el refresh token que rota", async () => {
    const c = conn({ access_token: "viejo", refresh_token: "km-rt", expires_at: Date.now() - 1000 });
    await fetchRecord(c, "deal", "42", []);
    const tok = calls.find((x) => x.url === `${ACC}/oauth2/access_token`)!;
    expect(tok.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "km-rt",
      client_id: "km-client",
      redirect_uri: expect.stringContaining("/v1/crm/oauth/kommo/callback"),
    });
    expect(c.creds).toMatchObject({ access_token: "km-at-2", refresh_token: "km-rt-2" });
  });

  it("un refresh token revocado pide reconectar", async () => {
    const c = conn({ access_token: "viejo", refresh_token: "otro", expires_at: Date.now() - 1000 });
    await expect(fetchRecord(c, "deal", "42", [])).rejects.toMatchObject({ authFailed: true });
  });

  it("write-back: campo de lista por nombre → enum_id; de texto por código; opción o campo inexistente → error de mapeo", async () => {
    await writeStatus(conn(), "deal", "42", "estado calasign", "firmado");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`${ACC}/api/v4/leads/42`);
    expect(patch.body).toEqual({ custom_fields_values: [{ field_id: 501, values: [{ enum_id: 9002 }] }] });
    await writeStatus(conn(), "deal", "42", "nit", "x");
    expect(calls.filter((c) => c.method === "PATCH")[1].body).toEqual({ custom_fields_values: [{ field_id: 502, values: [{ value: "x" }] }] });
    await expect(writeStatus(conn(), "deal", "42", "501", "anulado")).rejects.toBeInstanceOf(MappingError);
    await expect(writeStatus(conn(), "deal", "42", "no existe", "sent")).rejects.toBeInstanceOf(MappingError);
  });

  it("adjunta el PDF: sesión en el drive, partes en crudo, archivo vinculado al lead y nota con hash y link", async () => {
    expect(await attachSigned(conn(), "deal", "42", attach)).toBe("file:file-uuid-1 note:777");
    const session = calls.find((c) => c.url === `${DRIVE}/v1.0/sessions`)!;
    expect(session.body).toEqual({ file_name: "Contrato.pdf", file_size: 100_000, content_type: "application/pdf" });
    expect(uploaded).toEqual([65536, 100_000 - 65536]); // dos partes: la primera devuelve next_url, la segunda el uuid
    expect(calls.find((c) => c.url.endsWith("/api/v4/leads/42/files"))!.body).toEqual([{ file_uuid: "file-uuid-1" }]);
    const note = calls.find((c) => c.url.endsWith("/api/v4/leads/notes"))!;
    expect(note.body[0]).toMatchObject({ entity_id: 42, note_type: "common" });
    expect(note.body[0].params.text).toContain("cd".repeat(32));
    expect(note.body[0].params.text).toContain(attach.url);
  });

  it("sin el permiso de archivos (403) queda solo la nota", async () => {
    filesScope = false;
    expect(await attachSigned(conn(), "deal", "42", attach)).toBe("file:skipped note:777");
    expect(calls.some((c) => c.url.endsWith("/leads/42/files"))).toBe(false);
  });

  it("no sigue un drive_url ni una URL de subida fuera de *.kommo.com / del mismo drive", async () => {
    driveUrl = "https://169.254.169.254";
    await expect(attachSigned(conn(), "deal", "42", attach)).rejects.toThrow(/servidor de archivos/);
    driveUrl = DRIVE;
    uploadNext = "https://drive-x.kommo.com/upload/tok";
    await expect(attachSigned(conn(), "deal", "42", attach)).rejects.toThrow(/fuera del servidor de archivos/);
  });
});
