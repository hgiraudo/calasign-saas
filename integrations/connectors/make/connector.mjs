// App personalizada de Make. Fuente única: app.json (componentes) + functions.js (funciones IML). El build:
//   - resuelve las referencias "@nombre" a app.shared,
//   - separa cada componente en archivos con el contenido de cada pestaña del editor de Make (Base, Connection,
//     Webhook, Module: Communication / Static parameters / Mappable parameters / Interface / Samples, RPC, Functions)
//     y un makecomapp.json (manifiesto para la extensión "Make Apps Editor" de VS Code, desarrollo local),
//   - publica calasign-make-app.json (todo junto, para revisar) y calasign-make-app.zip.
export const meta = {
  id: "make",
  name: "Make",
  description: "App personalizada de Make: trigger instantáneo por webhook, enviar desde plantilla (campos por RPC), enviar PDF, estado, PDF firmado, anular, buscar.",
};

const j = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);

/** Funciones de functions.js por nombre (cada `function nombre(...) {...}` de primer nivel). */
export function splitFunctions(src) {
  const out = {};
  const re = /^(?:\/\*\*[^\n]*\*\/\n)?function (\w+)\(/gm;
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1], index: m.index }));
  starts.forEach((s, i) => {
    out[s.name] = src.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : undefined).trim() + "\n";
  });
  return out;
}

function resolveRefs(node, shared) {
  if (typeof node === "string" && node.startsWith("@")) {
    const v = shared[node.slice(1)];
    if (v === undefined) throw new Error(`make/app.json: referencia desconocida ${node}`);
    return v;
  }
  if (Array.isArray(node)) return node.map((x) => resolveRefs(x, shared));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, shared)]));
  return node;
}

export async function build(ctx) {
  const raw = JSON.parse(ctx.load("app.json").toString("utf8"));
  const { shared, ...rest } = raw;
  const app = resolveRefs(rest, shared);
  const fnSrc = ctx.load("functions.js").toString("utf8");
  const fns = splitFunctions(fnSrc);
  for (const name of app.functions) if (!fns[name]) throw new Error(`make: falta la función ${name} en functions.js`);

  const files = [];
  const add = (name, data) => files.push({ name, data: Buffer.isBuffer(data) ? data : j(data) });
  add("base.imljson", app.base);
  add("common.imljson", app.commonData);
  const manifest = {
    fileVersion: 1,
    generalCodeFiles: { base: "base.imljson", common: "common.imljson", readme: "README.md" },
    origins: [{ label: "CalaSign (production)", baseUrl: "https://eu1.make.com/api", appId: "calasign", appVersion: 1, apikeyFile: ".secrets/apikey" }],
    components: { connection: {}, webhook: {}, module: {}, rpc: {}, function: {} },
  };
  for (const [id, c] of Object.entries(app.connections)) {
    add(`connections/${id}/api.imljson`, c.communication);
    add(`connections/${id}/parameters.imljson`, c.parameters);
    if (c.scopes) add(`connections/${id}/scope.imljson`, c.scopes);
    manifest.components.connection[id] = { label: c.label, connectionType: c.type, codeFiles: { communication: `connections/${id}/api.imljson`, params: `connections/${id}/parameters.imljson` } };
  }
  for (const [id, w] of Object.entries(app.webhooks)) {
    add(`webhooks/${id}/api.imljson`, w.communication);
    add(`webhooks/${id}/parameters.imljson`, w.parameters);
    add(`webhooks/${id}/attach.imljson`, w.attach);
    add(`webhooks/${id}/detach.imljson`, w.detach);
    manifest.components.webhook[id] = { label: w.label, webhookType: w.type, connection: w.connection, altConnection: w.altConnection };
  }
  for (const [id, r] of Object.entries(app.rpcs)) {
    add(`rpcs/${id}/api.imljson`, r.communication);
    add(`rpcs/${id}/parameters.imljson`, r.parameters ?? []);
    manifest.components.rpc[id] = { label: r.label, connection: r.connection, altConnection: r.altConnection };
  }
  for (const [id, m] of Object.entries(app.modules)) {
    if (m.communication) add(`modules/${id}/api.imljson`, m.communication);
    add(`modules/${id}/parameters.imljson`, m.parameters);
    add(`modules/${id}/expect.imljson`, m.expect);
    add(`modules/${id}/interface.imljson`, m.interface);
    add(`modules/${id}/samples.imljson`, m.samples);
    manifest.components.module[id] = { label: m.label, description: m.description, moduleType: m.typeId, connection: m.connection, altConnection: m.altConnection, ...(m.webhook ? { webhook: m.webhook } : {}) };
  }
  for (const name of app.functions) {
    add(`functions/${name}.js`, Buffer.from(fns[name]));
    manifest.components.function[name] = { codeFiles: { code: `functions/${name}.js` } };
  }
  add("makecomapp.json", manifest);
  add("README.md", ctx.load("README.md"));
  const bundle = { ...app, functionsCode: Object.fromEntries(app.functions.map((n) => [n, fns[n]])) };
  return {
    files: [{ name: "calasign-make-app.json", data: j(bundle) }, { name: "README.md", data: ctx.load("README.md") }],
    artifacts: [{ name: "calasign-make-app.zip", entries: files, description: "Make: app personalizada (componentes, zip)" }],
  };
}
