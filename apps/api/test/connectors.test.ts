// Conectores HRIS/CLM y gestores documentales: partes puras y llamadas HTTP contra un fetch falso (sin red).
import { afterEach, describe, expect, it } from "vitest";
import { encrypt } from "../src/lib/util";
import {
  Conn,
  deliverFile,
  fetchRecord,
  normalizeCredentials,
  parseWebhook,
  peopleFromAttributes,
  searchRecords,
  writeStatus,
} from "../src/modules/connectors/providers";
import { ensureBoxFolder, parseSharepointSite } from "../src/modules/storage-export";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
/** fetch falso: registra cada llamada y responde con la función dada. */
function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(c);
    const r = respond(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}
const conn = (provider: any, creds: any, config: any = {}) =>
  new Conn({ id: "c1", provider, auth_type: "api_key", credentials_enc: encrypt(JSON.stringify(creds)), config }, null);
const pdf = { name: "Contrato.pdf", bytes: new TextEncoder().encode("%PDF-1.4 x"), contentType: "application/pdf" };

describe("credenciales", () => {
  it("BambooHR normaliza el subdominio y rechaza lo que no es un subdominio", () => {
    expect(normalizeCredentials("bamboohr", { companyDomain: "https://ACME.bamboohr.com/home", apiKey: "k".repeat(20) }).config).toEqual({
      companyDomain: "acme",
    });
    expect(() => normalizeCredentials("bamboohr", { companyDomain: "acme/../x", apiKey: "k".repeat(20) })).toThrow(/companyDomain/);
    expect(() => normalizeCredentials("bamboohr", { companyDomain: "acme", apiKey: "" })).toThrow(/apiKey/);
  });
  it("Ironclad solo acepta regiones conocidas (la URL no la elige el usuario)", () => {
    expect(normalizeCredentials("ironclad", { apiToken: "t".repeat(20), region: "eu1" }).config).toEqual({ region: "eu1", userEmail: null });
    expect(() => normalizeCredentials("ironclad", { apiToken: "t".repeat(20), region: "evil.com" })).toThrow(/region/);
  });
});

describe("webhooks entrantes", () => {
  it("entiende los cuerpos de cada proveedor y uno genérico", () => {
    expect(
      parseWebhook("bamboohr", {
        employees: [
          { id: 7, action: "Created" },
          { id: 8, action: "Updated" },
        ],
      }),
    ).toEqual([
      { recordId: "7", event: "Created", objectType: "employee" },
      { recordId: "8", event: "Updated", objectType: "employee" },
    ]);
    expect(parseWebhook("ironclad", { event: "workflow_updated_on_sign_step", payload: { workflowID: "wf9" } })).toEqual([
      { recordId: "wf9", event: "workflow_updated_on_sign_step", objectType: "workflow" },
    ]);
    expect(parseWebhook("ironclad", { event: "record_created", payload: { recordId: "r1" } })[0].objectType).toBe("record");
    expect(parseWebhook("juro", { event: "contract.signed", contract: { id: "j1" } })[0].recordId).toBe("j1");
    expect(parseWebhook("hibob", { type: "employee.created", employee: { id: "h1" } })[0]).toEqual({
      recordId: "h1",
      event: "employee.created",
      objectType: "employee",
    });
    expect(parseWebhook("factorial", { recordId: "55", event: "hired" })).toEqual([{ recordId: "55", event: "hired", objectType: null }]);
    expect(parseWebhook("bamboohr", "texto")).toEqual([]);
  });
});

describe("personas de un contrato", () => {
  it("arma pares nombre/correo, con la contraparte primero", () => {
    const p = peopleFromAttributes({
      ownerEmail: "ana@acme.test",
      ownerName: "Ana",
      counterpartySignerEmail: "gina@globex.test",
      counterpartySignerName: "Gina",
      notes: "x",
      badEmail: "no-es-correo",
    });
    expect(p.map((x) => [x.name, x.email, x.primary])).toEqual([
      ["Gina", "gina@globex.test", true],
      ["Ana", "ana@acme.test", false],
    ]);
  });
});

describe("HiBob", () => {
  it("lee el empleado con su jefe y sube al área confidencial por defecto", async () => {
    const calls = fakeFetch((c) => {
      if (c.url.endsWith("/people/42?humanReadable=replace"))
        return {
          json: {
            id: "42",
            displayName: "Hugo Bob",
            email: "hugo@acme.test",
            work: { title: "Dev", reportsTo: { id: "9", displayName: "Jefa Bob", email: "jefa@acme.test" } },
          },
        };
      if (c.url.endsWith("/docs/people/42/confidential/upload")) return { json: { id: "doc1" } };
      return { status: 404, json: {} };
    });
    const c = conn("hibob", { serviceUserId: "SU1", token: "tok-123456" });
    const rec = await fetchRecord(c, "employee", "42");
    expect(rec.contacts.map((x) => [x.name, x.role])).toEqual([
      ["Hugo Bob", "employee"],
      ["Jefa Bob", "manager"],
    ]);
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("SU1:tok-123456").toString("base64")}`);
    expect(await deliverFile(c, "employee", "42", pdf, null, "signed")).toBe("hibob:confidential:doc1");
    expect(calls[1].body).toBeInstanceOf(FormData);
    expect((calls[1].body as FormData).get("file")).toBeTruthy();
  });
});

describe("Factorial", () => {
  it("usa la API versionada con x-api-key y sube al legajo con employee_id y carpeta", async () => {
    const calls = fakeFetch((c) => {
      if (c.url.includes("/resources/employees/employees/5"))
        return { json: { data: { id: 5, full_name: "Flor Fact", email: "flor@acme.test", manager_id: null } } };
      if (c.url.includes("/resources/employees/employees"))
        return {
          json: {
            data: [
              { id: 5, full_name: "Flor Fact", email: "flor@acme.test" },
              { id: 6, full_name: "Otro" },
            ],
          },
        };
      if (c.url.includes("/resources/documents/documents")) return { status: 201, json: { data: { id: 77 } } };
      return { status: 404, json: {} };
    });
    const c = conn("factorial", { apiKey: "fk-123456789" });
    expect((await searchRecords(c, "employee", "flor")).map((x) => x.id)).toEqual(["5"]);
    const rec = await fetchRecord(c, "employee", "5");
    expect(rec.contacts[0]).toMatchObject({ name: "Flor Fact", email: "flor@acme.test", primary: true });
    expect(await deliverFile(c, "employee", "5", pdf, "12", "signed")).toBe("factorial:document:77");
    const up = calls.at(-1)!;
    expect(up.url).toMatch(/\/api\/\d{4}-\d{2}-\d{2}\/resources\/documents\/documents$/);
    expect(up.headers["x-api-key"]).toBe("fk-123456789");
    expect((up.body as FormData).get("employee_id")).toBe("5");
    expect((up.body as FormData).get("folder_id")).toBe("12");
  });
  it("un 401 es credencial rechazada (no se reintenta solo)", async () => {
    fakeFetch(() => ({ status: 401, json: { error: "invalid api key" } }));
    await expect(fetchRecord(conn("factorial", { apiKey: "fk-123456789" }), "employee", "5")).rejects.toMatchObject({
      authFailed: true,
      status: 401,
    });
  });
});

describe("Ironclad record", () => {
  it("escribe el estado como propiedad del registro y sube el adjunto con su clave", async () => {
    const calls = fakeFetch(() => ({ json: {} }));
    const c = conn("ironclad", { apiToken: "ic-123456789" }, { region: "na1" });
    await writeStatus(c, "record", "r1", "calasignStatus", "completed");
    expect(calls[0].method).toBe("PATCH");
    expect(JSON.parse(calls[0].body)).toEqual({ properties: { calasignStatus: { type: "string", value: "completed" } } });
    expect(await deliverFile(c, "record", "r1", pdf, null, "signed")).toBe("ironclad:record:r1:signedCopy");
    expect(calls[1].url).toMatch(/\/public\/api\/v1\/records\/r1\/attachments\/signedCopy$/);
    await expect(deliverFile(c, "workflow", "w1", pdf, null, "evidence")).rejects.toThrow(/solo recibe el documento firmado/);
  });
});

describe("gestores documentales", () => {
  it("SharePoint: valida el sitio y se queda con /sites/<sitio>", () => {
    expect(parseSharepointSite("https://acme.sharepoint.com/sites/Legal/Shared%20Documents/Forms/AllItems.aspx")).toEqual({
      host: "acme.sharepoint.com",
      path: "/sites/Legal",
    });
    expect(parseSharepointSite("https://acme.sharepoint.com")).toEqual({ host: "acme.sharepoint.com", path: "" });
    expect(() => parseSharepointSite("https://evil.example.com/sites/Legal")).toThrow();
    expect(() => parseSharepointSite("http://acme.sharepoint.com/sites/Legal")).toThrow();
  });
  it("Box: crea la carpeta por segmentos y usa la existente ante un 409", async () => {
    let n = 0;
    const calls = fakeFetch((c) => {
      const body = JSON.parse(c.body);
      if (body.name === "CalaSign")
        return { status: 409, json: { code: "item_name_in_use", context_info: { conflicts: [{ id: "111", type: "folder" }] } } };
      return { status: 201, json: { id: String(200 + ++n) } };
    });
    expect(await ensureBoxFolder("tok", "CalaSign/RRHH/2026")).toBe("202");
    expect(calls.map((c) => JSON.parse(c.body).parent.id)).toEqual(["0", "111", "201"]);
  });
});
