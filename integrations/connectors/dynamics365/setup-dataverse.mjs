#!/usr/bin/env node
// Prepara un entorno de Dataverse (Dynamics 365 Sales / Customer Service / cualquier app model-driven) para CalaSign:
//   1. publicador "CalaSign" (prefijo calasign) y solución no administrada "CalaSign",
//   2. columnas en la tabla elegida (por defecto opportunity): calasign_sendforsignature (Sí/No), calasign_status,
//      calasign_envelopeid, calasign_templateid (texto) y calasign_completedon (fecha y hora),
//   3. el web resource calasign_/commands.js (botones "Enviar a firmar" / "Ver en CalaSign") y lo publica.
// Es idempotente: lo que ya existe no se toca. Usa la Web API de Dataverse (v9.2).
//
//   DATAVERSE_URL=https://contoso.crm.dynamics.com \
//   DATAVERSE_TOKEN=$(az account get-access-token --resource https://contoso.crm.dynamics.com --query accessToken -o tsv) \
//   node setup-dataverse.mjs [--table opportunity] [--table account] [--dry-run]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "calasign";
export const SOLUTION = "CalaSign";

const label = (text) => ({
  "@odata.type": "Microsoft.Dynamics.CRM.Label",
  LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: text, LanguageCode: 1033 }],
});
const reqLevel = { Value: "None", CanBeChanged: true, ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings" };

/** Definiciones de columnas (AttributeMetadata) que necesita la integración. */
export function columnDefinitions() {
  const text = (name, display, max, description) => ({
    "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    SchemaName: name,
    DisplayName: label(display),
    Description: label(description),
    RequiredLevel: reqLevel,
    MaxLength: max,
    FormatName: { Value: "Text" },
  });
  return [
    {
      "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
      SchemaName: "calasign_SendForSignature",
      DisplayName: label("Send for signature (CalaSign)"),
      Description: label("Set to Yes to send this record for signature with CalaSign (the flow resets it)."),
      RequiredLevel: reqLevel,
      DefaultValue: false,
      OptionSet: {
        TrueOption: { Value: 1, Label: label("Yes") },
        FalseOption: { Value: 0, Label: label("No") },
      },
    },
    text("calasign_Status", "CalaSign status", 50, "requested, sent, completed, declined, voided, expired or error."),
    text("calasign_EnvelopeId", "CalaSign envelope ID", 100, "Identifier of the CalaSign envelope."),
    text("calasign_TemplateId", "CalaSign template ID", 100, "Template to use; empty = the flow default."),
    {
      "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
      SchemaName: "calasign_CompletedOn",
      DisplayName: label("CalaSign completed on"),
      Description: label("When every recipient signed."),
      RequiredLevel: reqLevel,
      Format: "DateAndTime",
    },
  ];
}

export function webResourceDefinition(content) {
  return {
    name: `${PREFIX}_/commands.js`,
    displayname: "CalaSign commands",
    description: "Command bar buttons: send for signature and open in CalaSign.",
    webresourcetype: 3,
    content: Buffer.from(content).toString("base64"),
  };
}

/** Cliente mínimo de la Web API. `fetchImpl` se inyecta en las pruebas. */
export function dataverse(baseUrl, token, fetchImpl = fetch) {
  const api = `${baseUrl.replace(/\/+$/, "")}/api/data/v9.2`;
  return async (method, path, body, headers = {}) => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "odata-version": "4.0",
        "odata-maxversion": "4.0",
        ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error?.message ?? text.slice(0, 300)}`);
    return json ?? { status: res.status, entityId: res.headers.get("odata-entityid") };
  };
}

export async function setup({ call, tables, webResource, dryRun = false, log = console.log }) {
  const done = [];
  const act = async (what, fn) => {
    if (dryRun) {
      log(`(dry-run) ${what}`);
      done.push(what);
      return;
    }
    await fn();
    log(`✔ ${what}`);
    done.push(what);
  };
  // 1. Publicador y solución.
  const pub = await call("GET", `/publishers?$select=publisherid&$filter=uniquename eq '${PREFIX}'`);
  let publisherId = pub?.value?.[0]?.publisherid;
  if (!publisherId) {
    await act("publicador CalaSign", async () => {
      await call("POST", "/publishers", { uniquename: PREFIX, friendlyname: "CalaSign", customizationprefix: PREFIX, customizationoptionvalueprefix: 74210 });
      publisherId = (await call("GET", `/publishers?$select=publisherid&$filter=uniquename eq '${PREFIX}'`))?.value?.[0]?.publisherid;
    });
  }
  const sol = await call("GET", `/solutions?$select=solutionid&$filter=uniquename eq '${SOLUTION}'`);
  if (!sol?.value?.length) {
    await act("solución CalaSign", () =>
      call("POST", "/solutions", { uniquename: SOLUTION, friendlyname: "CalaSign", version: "1.0.0.0", "publisherid@odata.bind": `/publishers(${publisherId ?? "00000000-0000-0000-0000-000000000000"})` }),
    );
  }
  const inSolution = { "MSCRM.SolutionUniqueName": SOLUTION };
  // 2. Columnas.
  for (const table of tables) {
    for (const col of columnDefinitions()) {
      const logical = col.SchemaName.toLowerCase();
      const exists = await call("GET", `/EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${logical}')?$select=LogicalName`);
      if (exists) continue;
      await act(`columna ${table}.${logical}`, () => call("POST", `/EntityDefinitions(LogicalName='${table}')/Attributes`, col, inSolution));
    }
  }
  // 3. Web resource.
  if (webResource) {
    const def = webResourceDefinition(webResource);
    const existing = await call("GET", `/webresourceset?$select=webresourceid&$filter=name eq '${def.name}'`);
    const id = existing?.value?.[0]?.webresourceid;
    if (id) await act(`web resource ${def.name} (actualizado)`, () => call("PATCH", `/webresourceset(${id})`, { content: def.content }));
    else await act(`web resource ${def.name}`, () => call("POST", "/webresourceset", def, inSolution));
  }
  // 4. Publicar.
  const xml = `<importexportxml><entities>${tables.map((t) => `<entity>${t}</entity>`).join("")}</entities><webresources>${webResource ? `<webresource>${webResourceDefinition("").name}</webresource>` : ""}</webresources></importexportxml>`;
  await act("publicar personalizaciones", () => call("POST", "/PublishXml", { ParameterXml: xml }));
  return done;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const tables = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--table") tables.push(args[++i]);
  const url = process.env.DATAVERSE_URL;
  const token = process.env.DATAVERSE_TOKEN;
  if (!url || !token) {
    console.error("Faltan DATAVERSE_URL y DATAVERSE_TOKEN (ver el encabezado de este archivo).");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  await setup({
    call: dataverse(url, token),
    tables: tables.length ? tables : ["opportunity"],
    webResource: readFileSync(join(here, "webresources/calasign_commands.js"), "utf8"),
    dryRun: args.includes("--dry-run"),
  });
}
