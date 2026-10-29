#!/usr/bin/env node
// Pruebas del add-on de Google Workspace (sin red): corre el build en una carpeta temporal, carga el proyecto de Apps
// Script del zip en un contexto `vm` con los servicios simulados (CardService, GmailApp, UrlFetchApp, PropertiesService,
// la librería OAuth2…) y verifica:
//   1. el manifiesto (scopes mínimos exactos, allowlists, triggers que existen, librería OAuth2 con PKCE),
//   2. que no queden {{PLACEHOLDER}} y que el código no use DriveApp/DocumentApp (Apps Script inferiría scopes amplios),
//   3. los textos es/en/pt (mismas claves; toda clave usada existe),
//   4. la lógica pura: destinatarios, anclas, ubicación y el pedido de una llamada,
//   5. los flujos: Gmail (adjunto → POST /v1/envelopes), automático con caída a la última página, Docs con anclas,
//      Drive con guardado del firmado (carpeta original, copia, carpeta CalaSign), OAuth con registro dinámico y PKCE,
//      API key y sesión vencida.
//
//   node integrations/test/google-workspace.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "calasign-gws-"));
const OUT = join(TMP, "out");
const BASE = "https://example.calasign.test";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✘ ${name}\n  ${e?.stack ?? e}`);
  }
}

function readZip(buf) {
  const files = new Map();
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const csize = buf.readUInt32LE(o + 18);
    const nlen = buf.readUInt16LE(o + 26);
    const xlen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    o += 30 + nlen + xlen + csize;
  }
  return files;
}

execFileSync(process.execPath, [join(HERE, "../build.mjs")], {
  env: { ...process.env, CALASIGN_BASE_URL: BASE, CALASIGN_INTEGRATIONS_OUT: OUT },
  stdio: "pipe",
});
const DIR = join(OUT, "connectors", "google-workspace");
const zip = readZip(readFileSync(join(DIR, "calasign-google-workspace-addon.zip")));
const manifest = JSON.parse(zip.get("appsscript.json").toString("utf8"));
const SOURCES = [...zip.keys()].filter((n) => /^src\/[^/]+\.js$/.test(n)).sort();
const CODE = SOURCES.map((n) => zip.get(n).toString("utf8")).join("\n");

// ───────── Simulación de Apps Script ─────────

/** Bytes como los da Apps Script (array de enteros con signo). */
const toAsBytes = (buf) => Array.from(new Int8Array(Buffer.from(buf)));
const fromAsBytes = (arr) => Buffer.from(Int8Array.from(arr).buffer);

/** Builder de Card Service que registra cada llamada (setX/addX…) y devuelve el mismo objeto. */
function builder(kind) {
  const rec = { kind, calls: [] };
  const proxy = new Proxy(rec, {
    get(t, prop) {
      if (prop === "kind" || prop === "calls") return t[prop];
      if (prop === "build") return () => ({ kind, calls: rec.calls, built: true });
      if (typeof prop !== "string") return undefined;
      return (...args) => {
        rec.calls.push([prop, ...args]);
        return proxy;
      };
    },
  });
  return proxy;
}

const CardService = new Proxy(
  {},
  {
    get(_, prop) {
      if (typeof prop === "string" && prop.startsWith("new")) return () => builder(prop.slice(3));
      return new Proxy({}, { get: (__, v) => `${String(prop)}.${String(v)}` });
    },
  },
);

/** Recorre una tarjeta (o respuesta) y llama a fn con cada builder. */
function walk(node, fn, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn, seen));
  if (node.calls) {
    fn(node);
    for (const c of node.calls) for (const a of c.slice(1)) walk(a, fn, seen);
  }
}
const nodes = (card, kind) => {
  const out = [];
  walk(card, (n) => n.kind === kind && out.push(n));
  return out;
};
const arg = (node, method) => node.calls.find((c) => c[0] === method)?.[1];
const allText = (card) => {
  const out = [];
  walk(card, (n) => n.calls.forEach((c) => c.slice(1).forEach((a) => typeof a === "string" && out.push(a))));
  return out.join("\n");
};
const inputValue = (card, field) =>
  arg(
    nodes(card, "TextInput").find((n) => arg(n, "setFieldName") === field),
    "setValue",
  );
const actionParams = (card, fnName) => {
  const a = nodes(card, "Action").find((n) => arg(n, "setFunctionName") === fnName);
  return a ? (arg(a, "setParameters") ?? {}) : null;
};

function store(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getProperty: (k) => (m.has(k) ? m.get(k) : null),
    setProperty: (k, v) => (m.set(k, String(v)), undefined),
    setProperties: (o) => Object.entries(o).forEach(([k, v]) => m.set(k, String(v))),
    deleteProperty: (k) => m.delete(k),
  };
}

function response(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? ""));
  return { getResponseCode: () => status, getContentText: () => buf.toString("utf8"), getContent: () => toAsBytes(buf), getHeaders: () => headers };
}

/**
 * Contexto nuevo con el proyecto cargado. `routes(url, params)` responde los UrlFetchApp.fetch.
 */
function load({ userProps = {}, scriptProps = {}, routes = () => response(404, {}), oauth = {}, gmail = {}, self = "yo@empresa.com" } = {}) {
  const fetches = [];
  const services = [];
  const user = store(userProps);
  const script = store(scriptProps);
  const cache = new Map();
  const oauthState = {
    access: !!oauth.access,
    token: oauth.token ?? (oauth.access ? { access_token: "oauth-token", refresh_token: "rt-1" } : null),
    resets: 0,
  };
  const OAuth2 = {
    getRedirectUri: (id) => `https://script.google.com/macros/d/${encodeURIComponent(id)}/usercallback`,
    createService(name) {
      const svc = { kind: "OAuthService", calls: [] };
      const real = {
        hasAccess: () => oauthState.access,
        getAccessToken: () => oauthState.token?.access_token,
        getToken: () => oauthState.token,
        reset: () => {
          oauthState.resets++;
          oauthState.access = false;
          oauthState.token = null;
        },
        getAuthorizationUrl: () =>
          `${arg(svc, "setAuthorizationBaseUrl")}?client_id=${arg(svc, "setClientId")}&code_challenge=x&code_challenge_method=${arg(svc, "setCodeChallengeMethod")}`,
        handleCallback: () => true,
      };
      // Los setters se registran y devuelven el mismo servicio (encadenables, como en la librería).
      const proxy = new Proxy(
        {},
        {
          get(_, p) {
            if (p in real) return real[p];
            return (...a) => {
              svc.calls.push([p, ...a]);
              return proxy;
            };
          },
        },
      );
      services.push({ name, svc });
      return proxy;
    },
  };

  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    CardService,
    PropertiesService: { getUserProperties: () => user, getScriptProperties: () => script },
    CacheService: { getUserCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
      getUserLock: () => ({ waitLock() {}, releaseLock() {}, tryLock: () => true }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => self }), getActiveUserLocale: () => "es" },
    ScriptApp: { getScriptId: () => "SCRIPT123", getOAuthToken: () => "google-token" },
    HtmlService: { createHtmlOutput: (html) => ({ html }) },
    Utilities: {
      base64Encode: (b) => (typeof b === "string" ? Buffer.from(b) : fromAsBytes(b)).toString("base64"),
      getUuid: () => randomUUID(),
      newBlob: (s) => ({ getBytes: () => toAsBytes(Buffer.from(s, "utf8")) }),
      computeDigest: (_alg, s) => toAsBytes(createHash("sha256").update(String(s), "utf8").digest()),
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
    },
    GmailApp: {
      tokens: [],
      setCurrentMessageAccessToken(tok) {
        this.tokens.push(tok);
      },
      getMessageById: (id) => {
        const m = gmail[id];
        if (!m) throw new Error(`mensaje ${id} inexistente`);
        return {
          getFrom: () => m.from,
          getTo: () => m.to ?? "",
          getCc: () => m.cc ?? "",
          getSubject: () => m.subject ?? "",
          getAttachments: () =>
            (m.attachments ?? []).map((a) => ({ getName: () => a.name, getContentType: () => a.type, getBytes: () => toAsBytes(a.data) })),
        };
      },
    },
    UrlFetchApp: {
      fetch(url, params = {}) {
        fetches.push({ url, params });
        return routes(url, params, fetches);
      },
    },
    OAuth2,
  };
  vm.createContext(ctx);
  for (const n of SOURCES) vm.runInContext(zip.get(n).toString("utf8"), ctx, { filename: n });
  return { ctx, fetches, user, script, cache, services, oauthState };
}

/** Evento de Card Service. */
function ev(host, { params, inputs, gmail, docs, drive, locale = "es" } = {}) {
  const formInputs = {};
  for (const [k, v] of Object.entries(inputs ?? {})) formInputs[k] = { stringInputs: { value: [v] } };
  return { commonEventObject: { hostApp: host, userLocale: locale, parameters: params ?? {}, formInputs }, gmail, docs, drive };
}

const PDF = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const detail = (over = {}) => ({
  envelope: { id: "env-1", subject: "Contrato", status: "sent", ...over },
  documents: [{ id: "doc-1", name: "contrato.pdf", pageCount: 3 }],
  recipients: [
    { id: "rec-1", role: "signer", email: "ana@cliente.com" },
    { id: "rec-2", role: "signer", email: "beto@cliente.com" },
  ],
});
const LIST = {
  items: [{ id: "env-9", subject: "NDA <ACME>", status: "completed", createdAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-02T10:00:00Z" }],
};
const json = (p) => JSON.parse(p.params.payload);
/** Objetos del contexto vm a objetos de este (deepEqual compara prototipos). */
const plain = (x) => JSON.parse(JSON.stringify(x));

// ───────── 1. Manifiesto ─────────

const EXPECTED_SCOPES = [
  "https://www.googleapis.com/auth/drive.addons.metadata.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
  "https://www.googleapis.com/auth/gmail.addons.execute",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.locale",
  "https://www.googleapis.com/auth/userinfo.email",
];

await test("manifiesto: V8, scopes mínimos exactos y ninguno amplio o restringido", () => {
  assert.equal(manifest.runtimeVersion, "V8");
  assert.deepEqual([...manifest.oauthScopes].sort(), EXPECTED_SCOPES);
  for (const s of manifest.oauthScopes) {
    assert.doesNotMatch(s, /auth\/(drive|drive\.readonly|gmail\.readonly|gmail\.modify|documents|spreadsheets|script\.scriptapp)$/, s);
    assert.ok(!s.startsWith("https://mail.google.com"), s);
  }
});

await test("manifiesto: allowlists con la URL base, https y barra final", () => {
  assert.deepEqual(manifest.urlFetchWhitelist, [`${BASE}/`, "https://www.googleapis.com/"]);
  const c = manifest.addOns.common;
  assert.equal(c.logoUrl, `${BASE}/integrations/connectors/google-workspace/icon-128.png`);
  assert.ok(c.openLinkUrlPrefixes.includes(`${BASE}/`));
  for (const u of [...manifest.urlFetchWhitelist, ...c.openLinkUrlPrefixes]) assert.match(u, /^https:\/\/[^/]+\/$/, u);
  assert.equal(c.useLocaleFromApp, true, "idioma del usuario (script.locale)");
  assert.equal(c.universalActions.find((a) => a.openLink)?.openLink, `${BASE}/app`);
});

await test("manifiesto: Gmail, Docs y Drive con triggers que existen en el código", () => {
  const { ctx } = load();
  const a = manifest.addOns;
  const fns = [
    a.common.homepageTrigger.runFunction,
    ...a.common.universalActions.filter((u) => u.runFunction).map((u) => u.runFunction),
    ...a.gmail.contextualTriggers.map((t) => t.onTriggerFunction),
    a.docs.homepageTrigger.runFunction,
    a.docs.onFileScopeGrantedTrigger.runFunction,
    a.drive.homepageTrigger.runFunction,
    a.drive.onItemsSelectedTrigger.runFunction,
    "authCallback", // callback de la librería OAuth2 (setCallbackFunction)
  ];
  assert.ok(a.gmail.contextualTriggers[0].unconditional, "Gmail: trigger contextual");
  for (const f of fns) assert.equal(typeof ctx[f], "function", f);
  // Cada acción de las tarjetas apunta a una función global pública (sin _ final: Apps Script no deja llamarlas).
  for (const [, f] of CODE.matchAll(/action_\('(\w+)'/g)) {
    assert.equal(typeof ctx[f], "function", f);
    assert.ok(!f.endsWith("_"), `${f} es privada`);
  }
});

await test("manifiesto: librería OAuth2 de Apps Script con PKCE (≥ v43)", () => {
  const lib = manifest.dependencies.libraries.find((l) => l.userSymbol === "OAuth2");
  assert.equal(lib.libraryId, "1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF");
  assert.ok(Number(lib.version) >= 43, "generateCodeVerifier/setCodeChallengeMethod");
});

// ───────── 2. Artefacto ─────────

await test("zip: proyecto para clasp, sin placeholders y con la URL base", () => {
  assert.ok(zip.has(".claspignore") && zip.has("README.md"));
  assert.ok(SOURCES.length >= 5, SOURCES.join(","));
  for (const [name, data] of zip) assert.doesNotMatch(data.toString("utf8"), /\{\{[A-Z_]+\}\}/, name);
  const { ctx } = load();
  assert.equal(ctx.CS_BASE_URL, BASE);
  for (const f of ["appsscript.json", "README.md", "icon-128.png"]) assert.ok(readFileSync(join(DIR, f)).length > 0, f);
  const idx = JSON.parse(readFileSync(join(OUT, "connectors/index.json"), "utf8"));
  assert.ok(
    idx.connectors
      .find((c) => c.id === "google-workspace")
      ?.artifacts.includes("/integrations/connectors/google-workspace/calasign-google-workspace-addon.zip"),
  );
});

await test("código: sin DriveApp/DocumentApp/SpreadsheetApp (Apps Script inferiría scopes amplios)", () => {
  assert.doesNotMatch(CODE, /\b(DriveApp|DocumentApp|SpreadsheetApp|MailApp)\./);
});

// ───────── 3. Textos ─────────

await test("i18n: es/en/pt con las mismas claves y todas las claves usadas definidas", () => {
  const { ctx } = load();
  const M = ctx.CS_MESSAGES;
  const keys = Object.keys(M.es).sort();
  assert.deepEqual(Object.keys(M.en).sort(), keys);
  assert.deepEqual(Object.keys(M.pt).sort(), keys);
  const used = new Set([...CODE.matchAll(/t_\(\w+, '([\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith(".")));
  for (const m of CODE.matchAll(/new CsInputError\('(\w+)'/g)) used.add(m[1]);
  for (const k of used) assert.ok(keys.includes(k), `falta la clave ${k}`);
  for (const s of ["draft", "sent", "finalizing", "completed", "declined", "voided", "expired", "awaiting_certificates"])
    assert.ok(keys.includes(`status.${s}`));
  assert.equal(ctx.langOf_("pt-BR"), "pt");
  assert.equal(ctx.langOf_("es-419"), "es");
  assert.equal(ctx.langOf_("fr"), "es");
  assert.equal(ctx.t_("en", "sentText", { subject: "X", n: 2 }), "The envelope “X” was sent to 2 signer(s).");
});

// ───────── 4. Lógica ─────────

await test("destinatarios: listas con comillas, nombres y correos inválidos", () => {
  const { ctx } = load();
  assert.deepEqual(plain(ctx.splitAddressList_('"Pérez, Juan" <juan@x.com>, ana@x.com; Beto <b@x.com>')), [
    '"Pérez, Juan" <juan@x.com>',
    "ana@x.com",
    "Beto <b@x.com>",
  ]);
  assert.deepEqual({ ...ctx.parseAddress_('"Pérez, Juan" <Juan@X.com>') }, { name: "Pérez, Juan", email: "juan@x.com" });
  assert.deepEqual({ ...ctx.parseAddress_("maria.lopez@x.com") }, { name: "Maria Lopez", email: "maria.lopez@x.com" });
  assert.equal(ctx.parseAddress_("no es un correo"), null);
  const r = ctx.parseSignerLines_('Ana <ana@x.com>\n"Pérez, Juan" <juan@x.com>\n\nbeto@x.com, carla@x.com\nANA@x.com\nmal\n');
  assert.deepEqual(plain(r.signers.map((s) => s.email)), ["ana@x.com", "juan@x.com", "beto@x.com", "carla@x.com"]);
  assert.deepEqual([...r.invalid], ["mal"]);
  assert.equal(ctx.formatAddress_({ name: "Pérez, Juan", email: "juan@x.com" }), '"Pérez, Juan" <juan@x.com>');
  // Ida y vuelta: lo que precarga la tarjeta se vuelve a leer igual.
  const back = ctx.parseSignerLines_(
    [
      { name: "Pérez, Juan", email: "juan@x.com" },
      { name: 'Dice "hola"', email: "h@x.com" },
    ]
      .map(ctx.formatAddress_)
      .join("\n"),
  );
  assert.deepEqual(plain(back.signers.map((s) => s.name)), ["Pérez, Juan", 'Dice "hola"']);
});

await test("destinatarios sugeridos de un correo: remitente, Para y CC sin uno mismo ni no-reply", () => {
  const { ctx } = load();
  const got = ctx.suggestSigners_(
    {
      from: "Ana Gómez <ana@cliente.com>",
      to: "Yo <YO@empresa.com>, beto@cliente.com",
      cc: "no-reply@sistema.com, Ana <ana@cliente.com>, Carla <carla@cliente.com>",
    },
    "yo@empresa.com",
  );
  assert.deepEqual(plain(got.map((s) => `${s.name}|${s.email}`)), ["Ana Gómez|ana@cliente.com", "Beto|beto@cliente.com", "Carla|carla@cliente.com"]);
  // Correo enviado por uno mismo: quedan los destinatarios.
  assert.deepEqual(plain(ctx.suggestSigners_({ from: "Yo <yo@empresa.com>", to: "cliente@x.com" }, "yo@empresa.com").map((s) => s.email)), [
    "cliente@x.com",
  ]);
});

await test("anclas: [[firma]], [[firma_N]], variantes en inglés y portugués", () => {
  const { ctx } = load();
  const a = ctx.findAnchors_("Firma: [[firma]] ... [[ firma_2 ]] y [[signature_3]] [[assinatura 4]] [[firma_2]] [[firma_0]] [[otra]]");
  assert.deepEqual(JSON.parse(JSON.stringify(a)), {
    1: ["[[firma]]"],
    2: ["[[ firma_2 ]]", "[[firma_2]]"],
    3: ["[[signature_3]]"],
    4: ["[[assinatura 4]]"],
  });
  assert.equal(ctx.resolvePlacement_("auto", a, 4, true), "anchors");
  assert.equal(ctx.resolvePlacement_("auto", a, 5, true), "lastPage");
  assert.equal(ctx.resolvePlacement_("auto", null, 2, false), "auto-pdf");
  assert.equal(ctx.resolvePlacement_("draft", a, 1, true), "draft");
  assert.equal(ctx.envelopeLocale_("pt-BR"), "pt-BR");
  assert.equal(ctx.envelopeLocale_("en-GB"), "en");
  assert.equal(ctx.signedFileName_("Contrato.PDF", "firmado"), "Contrato (firmado).pdf");
});

await test("pedido de una llamada: documento, firmantes en orden, campos por ancla y send", () => {
  const { ctx } = load();
  const signers = [
    { name: "Ana", email: "ana@x.com" },
    { name: "Beto", email: "beto@x.com" },
  ];
  const req = JSON.parse(
    JSON.stringify(
      ctx.buildEnvelopeRequest_({
        subject: "  Contrato  ",
        message: "Hola",
        locale: "es",
        documentName: "Contrato",
        pdfBase64: "QUJD",
        signers,
        sequential: true,
        placement: "anchors",
        anchors: { 1: ["[[firma_1]]"], 2: ["[[firma_2]]"] },
        metadata: { source: "t" },
      }),
    ),
  );
  assert.deepEqual(req.documents, [{ name: "Contrato.pdf", base64: "QUJD" }]);
  assert.equal(req.subject, "Contrato");
  assert.deepEqual(
    req.recipients.map((r) => [r.routingOrder, r.role, r.email, r.channels[0], r.locale]),
    [
      [1, "signer", "ana@x.com", "email", "es"],
      [2, "signer", "beto@x.com", "email", "es"],
    ],
  );
  assert.deepEqual(req.fields, [
    { recipient: 0, type: "signature", anchor: { text: "[[firma_1]]", width: 150, height: 40, offsetY: -36 } },
    { recipient: 1, type: "signature", anchor: { text: "[[firma_2]]", width: 150, height: 40, offsetY: -36 } },
  ]);
  assert.equal(req.send, true);
  const draft = ctx.buildEnvelopeRequest_({ subject: "X", locale: "es", documentName: "a.pdf", pdfBase64: "QQ==", signers, placement: "lastPage" });
  assert.equal(draft.send, false);
  assert.equal(draft.fields.length, 0);
  assert.deepEqual(
    draft.recipients.map((r) => r.routingOrder),
    [1, 1],
  );
  const errCode = (p) => {
    try {
      ctx.buildEnvelopeRequest_(p);
    } catch (e) {
      return e.code;
    }
    return null;
  };
  const ok = { subject: "X", locale: "es", documentName: "a", pdfBase64: "QQ==", signers, placement: "anchors", anchors: { 1: ["[[firma]]"] } };
  assert.equal(errCode(ok), "errAnchorMissing");
  assert.equal(errCode({ ...ok, subject: " " }), "errSubject");
  assert.equal(errCode({ ...ok, signers: [] }), "errNoSigners");
  // Campos de la última página con los ids que devuelve CalaSign.
  const f = JSON.parse(JSON.stringify(ctx.lastPageFields_(detail(), [{ name: "Beto", email: "beto@cliente.com" }])));
  assert.deepEqual(
    f.map((x) => [x.documentId, x.recipientId, x.page, x.type]),
    [["doc-1", "rec-2", 2, "signature"]],
  );
});

// ───────── 5. Flujos ─────────

const KEY = "cs_test_abcdefghijklmnop";
const signedIn = { [`calasign.apiKey`]: KEY };

await test("gmail: tarjeta con el PDF adjunto y firmantes precargados; envío en UNA llamada", () => {
  const gmail = {
    m1: {
      from: "Ana Gómez <ana@cliente.com>",
      to: "yo@empresa.com",
      cc: "Beto <beto@cliente.com>",
      subject: "Contrato de servicios",
      attachments: [
        { name: "logo.png", type: "image/png", data: Buffer.from("x") },
        { name: "contrato.pdf", type: "application/pdf", data: PDF },
        { name: "anexo.PDF", type: "application/octet-stream", data: PDF },
      ],
    },
  };
  const routes = (url, p) => {
    if (url === `${BASE}/v1/envelopes?limit=8`) return response(200, LIST);
    if (url === `${BASE}/v1/envelopes` && p.method === "post") return response(201, detail({ subject: "Contrato de servicios" }));
    return response(404, {});
  };
  const { ctx, fetches } = load({ userProps: signedIn, gmail, routes });
  const card = ctx.onGmailMessage(ev("GMAIL", { gmail: { messageId: "m1", accessToken: "tok-1" } }));
  assert.equal(ctx.GmailApp.tokens[0], "tok-1", "token del mensaje actual");
  assert.equal(inputValue(card, "subject"), "Contrato de servicios");
  assert.equal(inputValue(card, "signers"), "Ana Gómez <ana@cliente.com>\nBeto <beto@cliente.com>");
  const dd = nodes(card, "SelectionInput").find((n) => arg(n, "setFieldName") === "attachment");
  assert.deepEqual(
    dd.calls.filter((c) => c[0] === "addItem").map((c) => c[1]),
    ["contrato.pdf", "anexo.PDF"],
  );
  assert.match(allText(card), /NDA &lt;ACME&gt;/, "recientes (escapados)");
  const params = actionParams(card, "onSend");
  assert.equal(params.source, "gmail");
  assert.equal(params.messageId, "m1");

  const res = ctx.onSend(
    ev("GMAIL", {
      params,
      gmail: { messageId: "m1", accessToken: "tok-2" },
      inputs: {
        subject: "Contrato de servicios",
        signers: inputValue(card, "signers"),
        attachment: "1",
        placement: "anchors",
        sequential: "1",
        message: "Por favor firmar",
      },
    }),
  );
  const posts = fetches.filter((f) => f.url === `${BASE}/v1/envelopes`);
  assert.equal(posts.length, 1, "una sola llamada");
  const p = posts[0].params;
  assert.equal(p.headers.Authorization, `Bearer ${KEY}`);
  assert.match(p.headers["Idempotency-Key"], /^gws-[\w-]+-a-[0-9a-f]{32}$/);
  assert.equal(p.contentType, "application/json");
  const body = json(posts[0]);
  assert.equal(Buffer.from(body.documents[0].base64, "base64").toString(), PDF.toString(), "el PDF elegido, en base64");
  assert.equal(body.documents[0].name, "anexo.PDF");
  assert.deepEqual(
    body.recipients.map((r) => [r.name, r.email, r.routingOrder]),
    [
      ["Ana Gómez", "ana@cliente.com", 1],
      ["Beto", "beto@cliente.com", 2],
    ],
  );
  // PDF: anclas convencionales, las que no están se ignoran.
  assert.deepEqual(
    body.fields.map((f) => [f.recipient, f.anchor.text, f.anchor.ignoreIfNotPresent]),
    [
      [0, "[[firma]]", true],
      [0, "[[firma_1]]", true],
      [1, "[[firma_2]]", true],
    ],
  );
  assert.equal(body.send, true);
  assert.equal(body.message, "Por favor firmar");
  assert.equal(body.metadata.source, "google-workspace-gmail");
  const pushed = res.calls.find((c) => c[0] === "setNavigation")[1];
  assert.match(allText(pushed), /se envió a 2 firmante/);
  assert.match(allText(pushed), new RegExp(`${BASE}/app/envelopes/env-1`));

  // Doble clic con el mismo formulario: misma Idempotency-Key.
  ctx.onSend(
    ev("GMAIL", {
      params,
      gmail: { messageId: "m1", accessToken: "tok-2" },
      inputs: {
        subject: "Contrato de servicios",
        signers: inputValue(card, "signers"),
        attachment: "1",
        placement: "anchors",
        sequential: "1",
        message: "Por favor firmar",
      },
    }),
  );
  const again = fetches.filter((f) => f.url === `${BASE}/v1/envelopes`);
  assert.equal(again[1].params.headers["Idempotency-Key"], p.headers["Idempotency-Key"]);
});

await test("gmail: correo sin PDF → aviso; firmante inválido → notificación sin llamar a la API", () => {
  const gmail = {
    m2: { from: "a@x.com", attachments: [{ name: "a.docx", type: "application/msword", data: PDF }] },
    m3: { from: "a@x.com", attachments: [{ name: "a.pdf", type: "application/pdf", data: PDF }] },
  };
  const routes = (url) => (url.includes("limit=8") ? response(200, { items: [] }) : response(500, {}));
  const { ctx, fetches } = load({ userProps: signedIn, gmail, routes });
  assert.match(allText(ctx.onGmailMessage(ev("GMAIL", { gmail: { messageId: "m2", accessToken: "t" } }))), /no tiene PDF adjuntos/);
  const res = ctx.onSend(
    ev("GMAIL", {
      params: { source: "gmail", cardKey: "k", messageId: "m3" },
      gmail: { messageId: "m3", accessToken: "t" },
      inputs: { subject: "X", signers: "Ana <ana@x.com>\nsin-arroba" },
    }),
  );
  assert.match(allText(res), /Revisá estos firmantes: sin-arroba/);
  assert.equal(fetches.filter((f) => f.params.method === "post").length, 0);
});

await test("automático en un PDF sin anclas: la llamada atómica falla (422) → borrador, campos en la última página y envío", () => {
  const gmail = {
    m1: { from: "Ana <ana@cliente.com>", cc: "beto@cliente.com", subject: "S", attachments: [{ name: "c.pdf", type: "application/pdf", data: PDF }] },
  };
  const routes = (url, p) => {
    if (url.endsWith("limit=8")) return response(200, LIST);
    if (url === `${BASE}/v1/envelopes`) {
      const b = JSON.parse(p.payload);
      if (b.send) return response(422, { error: { code: "envelope_incomplete", message: "Ana no tiene campo de firma" } });
      return response(201, detail({ status: "draft" }));
    }
    if (url === `${BASE}/v1/envelopes/env-1/fields`) return response(200, { fields: [] });
    if (url === `${BASE}/v1/envelopes/env-1/send`) return response(200, detail());
    return response(404, {});
  };
  const { ctx, fetches } = load({ userProps: signedIn, gmail, routes });
  ctx.onSend(
    ev("GMAIL", {
      params: { source: "gmail", cardKey: "k1", messageId: "m1" },
      gmail: { messageId: "m1", accessToken: "t" },
      inputs: { subject: "S", signers: "Ana <ana@cliente.com>\nbeto@cliente.com", placement: "auto" },
    }),
  );
  const seq = fetches.filter((f) => !f.url.includes("limit=")).map((f) => `${f.params.method.toUpperCase()} ${f.url.replace(BASE, "")}`);
  assert.deepEqual(seq, ["POST /v1/envelopes", "POST /v1/envelopes", "PUT /v1/envelopes/env-1/fields", "POST /v1/envelopes/env-1/send"]);
  const [first, second] = fetches.filter((f) => f.url === `${BASE}/v1/envelopes`);
  assert.notEqual(first.params.headers["Idempotency-Key"], second.params.headers["Idempotency-Key"]);
  assert.equal(json(second).send, false);
  const fields = json(fetches.find((f) => f.url.endsWith("/fields"))).fields;
  assert.deepEqual(
    fields.map((f) => [f.recipientId, f.page, f.type]),
    [
      ["rec-1", 2, "signature"],
      ["rec-2", 2, "signature"],
    ],
  );
  for (const f of fields) assert.ok(f.x >= 0 && f.x + f.width <= 1 && f.y >= 0 && f.y + f.height <= 1);
  // Con "anclas" elegido a mano, el 422 se muestra (no cae a la última página).
  const n = fetches.length;
  const res = ctx.onSend(
    ev("GMAIL", {
      params: { source: "gmail", cardKey: "k2", messageId: "m1" },
      gmail: { messageId: "m1", accessToken: "t" },
      inputs: { subject: "S", signers: "Ana <ana@cliente.com>", placement: "anchors" },
    }),
  );
  assert.match(allText(res), /Faltan firmas para algunos firmantes: Ana no tiene campo de firma/);
  assert.equal(fetches.length, n + 1);
});

await test("docs: pide acceso al documento; con acceso, exporta a PDF y firma en las anclas [[firma_N]]", () => {
  const text = "Contrato\nEl cliente: [[firma_1]]\nEl proveedor: [[firma_2]]\n";
  const routes = (url, p) => {
    if (url.endsWith("limit=8")) return response(200, LIST);
    if (url === "https://www.googleapis.com/drive/v3/files/DOC1/export?mimeType=text%2Fplain") return response(200, text);
    if (url === "https://www.googleapis.com/drive/v3/files/DOC1/export?mimeType=application%2Fpdf") return response(200, PDF);
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/DOC1?fields="))
      return response(200, { id: "DOC1", name: "Contrato marco", mimeType: "application/vnd.google-apps.document", parents: ["FOLDER1"] });
    if (url === `${BASE}/v1/envelopes` && p.method === "post") return response(201, detail({ subject: "Contrato marco" }));
    return response(404, {});
  };
  const { ctx, fetches, user } = load({ userProps: signedIn, routes });
  const noAccess = ctx.onDocsHomepage(ev("DOCS", { docs: { addonHasFileScopePermission: false } }));
  assert.ok(actionParams(noAccess, "onRequestDocScope"), "botón para pedir acceso");
  assert.equal(nodes(ctx.onRequestDocScope(), "EditorFileScopeActionResponseBuilder")[0].calls[0][0], "requestFileScopeForActiveDocument");

  const card = ctx.onDocsFileScopeGranted(ev("DOCS", { docs: { id: "DOC1", title: "Contrato marco", addonHasFileScopePermission: true } }));
  assert.match(allText(card), /Anclas encontradas: \[\[firma_1\]\], \[\[firma_2\]\]/);
  const drv = fetches.filter((f) => f.url.startsWith("https://www.googleapis.com/"));
  assert.ok(
    drv.every((f) => f.params.headers.Authorization === "Bearer google-token"),
    "Drive con el token del add-on",
  );
  const params = actionParams(card, "onSend");
  assert.deepEqual([params.source, params.fileId], ["docs", "DOC1"]);
  ctx.onSend(
    ev("DOCS", {
      params,
      docs: { id: "DOC1" },
      inputs: { subject: "Contrato marco", signers: "Ana <ana@cliente.com>\nBeto <beto@cliente.com>", placement: "auto", saveBack: "1" },
    }),
  );
  const post = fetches.find((f) => f.url === `${BASE}/v1/envelopes`);
  const body = json(post);
  assert.equal(body.documents[0].name, "Contrato marco.pdf");
  assert.deepEqual(
    body.fields.map((f) => [f.recipient, f.anchor.text, f.anchor.ignoreIfNotPresent]),
    [
      [0, "[[firma_1]]", undefined],
      [1, "[[firma_2]]", undefined],
    ],
  );
  assert.equal(body.send, true);
  assert.deepEqual(body.metadata, { source: "google-workspace-docs", driveFileId: "DOC1" });
  const pending = JSON.parse(user.getProperty("calasign.pendingSaves"));
  assert.deepEqual(
    pending.map((x) => [x.envelopeId, x.fileId, x.parentId, x.pdf]),
    [["env-1", "DOC1", "FOLDER1", false]],
  );
});

await test("drive: selección (uno, tipo, permiso) y envío de un PDF", () => {
  const routes = (url, p) => {
    if (url.endsWith("limit=8")) return response(200, LIST);
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/PDF1?fields="))
      return response(200, { id: "PDF1", name: "oferta.pdf", mimeType: "application/pdf", parents: ["F1"] });
    if (url === "https://www.googleapis.com/drive/v3/files/PDF1?alt=media&supportsAllDrives=true") return response(200, PDF);
    if (url === `${BASE}/v1/envelopes` && p.method === "post") return response(201, detail({ subject: "oferta" }));
    return response(404, {});
  };
  const { ctx, fetches } = load({ userProps: signedIn, routes });
  const two = ctx.onDriveItemsSelected(ev("DRIVE", { drive: { selectedItems: [{ id: "a" }, { id: "b" }] } }));
  assert.match(allText(two), /Seleccioná un solo archivo/);
  const xls = ctx.onDriveItemsSelected(
    ev("DRIVE", { drive: { selectedItems: [{ id: "x", title: "a.xlsx", mimeType: "application/vnd.ms-excel" }] } }),
  );
  assert.match(allText(xls), /«a.xlsx» no se puede enviar/);
  const ask = ctx.onDriveItemsSelected(
    ev("DRIVE", { drive: { selectedItems: [{ id: "PDF1", title: "oferta.pdf", mimeType: "application/pdf", addonHasFileScopePermission: false }] } }),
  );
  const askParams = actionParams(ask, "onRequestDriveScope");
  assert.equal(askParams.fileId, "PDF1");
  assert.deepEqual(nodes(ctx.onRequestDriveScope(ev("DRIVE", { params: askParams })), "DriveItemsSelectedActionResponseBuilder")[0].calls[0], [
    "requestFileScope",
    "PDF1",
  ]);
  const card = ctx.onDriveItemsSelected(
    ev("DRIVE", { drive: { selectedItems: [{ id: "PDF1", title: "oferta.pdf", mimeType: "application/pdf", addonHasFileScopePermission: true }] } }),
  );
  assert.equal(inputValue(card, "subject"), "oferta");
  assert.ok(nodes(card, "SelectionInput").some((n) => arg(n, "setFieldName") === "saveBack"));
  ctx.onSend(ev("DRIVE", { params: actionParams(card, "onSend"), inputs: { subject: "oferta", signers: "ana@cliente.com", placement: "anchors" } }));
  const body = json(fetches.find((f) => f.url === `${BASE}/v1/envelopes`));
  assert.equal(Buffer.from(body.documents[0].base64, "base64").toString(), PDF.toString());
  assert.deepEqual(
    body.recipients.map((r) => [r.name, r.email]),
    [["Ana", "ana@cliente.com"]],
  );
});

await test("drive: guardar el firmado al abrir (carpeta original → copia → carpeta CalaSign) y limpiar pendientes", () => {
  const pending = [
    { envelopeId: "E1", fileId: "PDF1", name: "oferta.pdf", pdf: true, parentId: "F1" },
    { envelopeId: "E2", fileId: "PDF2", name: "otro.pdf", pdf: true, parentId: "F2" },
    { envelopeId: "E3", fileId: "DOC3", name: "Doc", pdf: false, parentId: "F3" },
    { envelopeId: "E4", fileId: "X", name: "anulado.pdf", pdf: true, parentId: "F4" },
    { envelopeId: "E5", fileId: "Y", name: "en-curso.pdf", pdf: true, parentId: "F5" },
  ];
  const SIGNED = Buffer.from("%PDF-1.7 firmado");
  const uploads = [];
  const routes = (url, p) => {
    if (url.endsWith("limit=8")) return response(200, LIST);
    const m = /\/v1\/envelopes\/(E\d)(\/signed\.pdf)?$/.exec(url);
    if (m && m[2]) return response(200, SIGNED);
    if (m) return response(200, { envelope: { id: m[1], status: { E4: "voided", E5: "sent" }[m[1]] ?? "completed" } });
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")) {
      const raw = fromAsBytes(p.payload).toString("latin1");
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/.exec(raw)[1]);
      uploads.push({ meta, hasPdf: raw.includes(SIGNED.toString("latin1")), contentType: p.contentType });
      if (meta.parents[0] === "F1")
        return response(200, { id: "N1", name: meta.name, parents: ["F1"], webViewLink: "https://drive.google.com/file/d/N1/view" });
      if (meta.parents[0] === "APPF") return response(200, { id: "N3", name: meta.name, parents: ["APPF"] });
      return response(404, { error: { message: "File not found" } });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/PDF2/copy"))
      return response(200, { id: "C2", name: JSON.parse(p.payload).name, parents: ["F2"] });
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files/C2?uploadType=media")) {
      assert.equal(fromAsBytes(p.payload).toString(), SIGNED.toString());
      return response(200, { id: "C2", name: "otro (firmado).pdf", parents: ["F2"] });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?fields=id")) return response(200, { id: "APPF" });
    return response(404, {});
  };
  const { ctx, user, fetches, cache } = load({ userProps: { ...signedIn, "calasign.pendingSaves": JSON.stringify(pending) }, routes });
  const card = ctx.onDriveHomepage(ev("DRIVE"));
  const text = allText(card);
  assert.match(text, /Firmados guardados en Drive/);
  assert.match(text, /«oferta \(firmado\)\.pdf» guardado\./);
  assert.match(text, /«otro \(firmado\)\.pdf» guardado\./);
  assert.match(text, /«Doc \(firmado\)\.pdf» guardado en la carpeta «CalaSign»/);
  assert.equal(uploads[0].meta.name, "oferta (firmado).pdf");
  assert.ok(uploads.every((u) => u.hasPdf && /^multipart\/related; boundary=/.test(u.contentType)));
  assert.equal(user.getProperty("calasign.folderId"), "APPF");
  // Quedó solo el que sigue en curso; el anulado se descartó.
  assert.deepEqual(
    JSON.parse(user.getProperty("calasign.pendingSaves")).map((x) => x.envelopeId),
    ["E5"],
  );
  // Throttle: otra apertura enseguida no vuelve a consultar.
  const n = fetches.length;
  ctx.onDriveHomepage(ev("DRIVE"));
  assert.equal(fetches.filter((f) => /E5/.test(f.url)).length, 1);
  assert.ok(fetches.length > n && cache.has("calasign.syncedAt"));
});

await test("oauth: sin sesión → tarjeta de login; registro dinámico (una vez) y servicio con PKCE S256", () => {
  const routes = (url, _p) => {
    if (url === `${BASE}/oauth/register`) return response(201, { client_id: "cid-123" });
    return response(404, {});
  };
  const { ctx, fetches, script, services } = load({ routes });
  const card = ctx.onHomepage(ev("GMAIL"));
  const reg = fetches.filter((f) => f.url === `${BASE}/oauth/register`);
  assert.equal(reg.length, 1);
  const body = json(reg[0]);
  assert.deepEqual(body.redirect_uris, ["https://script.google.com/macros/d/SCRIPT123/usercallback"]);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(body.scope, "envelopes:read envelopes:write offline_access");
  assert.equal(script.getProperty("CALASIGN_CLIENT_ID"), "cid-123");
  const svc = services.at(-1).svc;
  assert.equal(arg(svc, "setAuthorizationBaseUrl"), `${BASE}/oauth/authorize`);
  assert.equal(arg(svc, "setTokenUrl"), `${BASE}/oauth/token`);
  assert.equal(arg(svc, "setClientId"), "cid-123");
  assert.equal(arg(svc, "setCallbackFunction"), "authCallback");
  assert.ok(svc.calls.some((c) => c[0] === "generateCodeVerifier"));
  assert.equal(arg(svc, "setCodeChallengeMethod"), "S256");
  const auth = nodes(card, "AuthorizationAction")[0];
  assert.match(arg(auth, "setAuthorizationUrl"), new RegExp(`^${BASE}/oauth/authorize\\?client_id=cid-123.*code_challenge_method=S256`));
  assert.ok(
    nodes(card, "TextInput").some((n) => arg(n, "setFieldName") === "apiKey"),
    "alternativa con API key",
  );
  // Segunda vez: no se vuelve a registrar.
  ctx.onHomepage(ev("GMAIL"));
  assert.equal(fetches.filter((f) => f.url === `${BASE}/oauth/register`).length, 1);
  // Cliente público: no se manda client_secret vacío.
  const payload = ctx.stripEmptySecret_({ code: "c", client_secret: undefined, code_verifier: "v" });
  assert.ok(!("client_secret" in payload) && payload.code_verifier === "v");
  assert.match(ctx.authCallback({ parameter: { code: "c" } }).html, /CalaSign quedó conectado/);
});

await test("oauth: con token usa Bearer del token; cerrar sesión revoca el refresh token", () => {
  const routes = (url) => (url.endsWith("limit=8") ? response(200, LIST) : response(200, {}));
  const { ctx, fetches, oauthState } = load({ routes, scriptProps: { CALASIGN_CLIENT_ID: "cid-fijo" }, oauth: { access: true } });
  ctx.onHomepage(ev("DRIVE"));
  assert.equal(fetches.find((f) => f.url.endsWith("limit=8")).params.headers.Authorization, "Bearer oauth-token");
  assert.equal(fetches.filter((f) => f.url.endsWith("/oauth/register")).length, 0, "client_id fijado a mano");
  const res = ctx.onSignOut(ev("DRIVE"));
  const rev = fetches.find((f) => f.url === `${BASE}/oauth/revoke`);
  assert.deepEqual({ ...rev.params.payload }, { token: "rt-1", client_id: "cid-fijo" });
  assert.equal(oauthState.resets, 1);
  assert.match(allText(res), /Cerraste la sesión/);
});

await test("api key: se valida contra CalaSign antes de guardarla; 401 después la borra y vuelve al login", () => {
  let valid = true;
  const routes = (url, _p) => {
    if (url === `${BASE}/oauth/register`) return response(201, { client_id: "cid" });
    if (url.endsWith("limit=1")) return response(valid ? 200 : 401, { items: [] });
    if (url.endsWith("limit=8")) return response(200, LIST);
    if (url === `${BASE}/v1/envelopes`) return response(401, { error: { code: "unauthorized", message: "API key revocada" } });
    return response(404, {});
  };
  const { ctx, user, fetches } = load({
    routes,
    gmail: { m: { from: "a@x.com", attachments: [{ name: "a.pdf", type: "application/pdf", data: PDF }] } },
  });
  assert.match(allText(ctx.onSaveApiKey(ev("DRIVE", { inputs: { apiKey: "no-es-una-key" } }))), /no es válida/);
  assert.equal(fetches.filter((f) => f.url.endsWith("limit=1")).length, 0, "formato inválido: ni se consulta");
  valid = false;
  assert.match(allText(ctx.onSaveApiKey(ev("DRIVE", { inputs: { apiKey: KEY } }))), /no es válida/);
  valid = true;
  const ok = ctx.onSaveApiKey(ev("DRIVE", { inputs: { apiKey: ` ${KEY} ` } }));
  assert.equal(user.getProperty("calasign.apiKey"), KEY);
  assert.match(allText(ok), /Sesión iniciada/);
  const res = ctx.onSend(
    ev("GMAIL", {
      params: { source: "gmail", cardKey: "k", messageId: "m" },
      gmail: { messageId: "m", accessToken: "t" },
      inputs: { subject: "S", signers: "a@x.com", placement: "anchors" },
    }),
  );
  assert.equal(user.getProperty("calasign.apiKey"), null, "401: credenciales olvidadas");
  assert.match(allText(res), /La sesión de CalaSign venció/);
  assert.ok(nodes(res, "AuthorizationAction").length, "vuelve a la tarjeta de inicio de sesión");
});

await test("i18n en las tarjetas: inglés y portugués según userLocale", () => {
  const routes = (url) => (url.endsWith("limit=8") ? response(200, LIST) : response(404, {}));
  const { ctx } = load({ userProps: signedIn, routes });
  assert.match(allText(ctx.onDriveHomepage(ev("DRIVE", { locale: "en-US" }))), /Recent envelopes[\s\S]*Completed · 2026-10-02/);
  assert.match(allText(ctx.onDriveHomepage(ev("DRIVE", { locale: "pt-BR" }))), /Envios recentes[\s\S]*Concluído/);
});

rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} prueba(s) del add-on de Google Workspace fallaron`);
  process.exit(1);
}
console.log("\nGoogle Workspace: todas las pruebas pasaron");
