// Registro de conectores out-of-the-box (low-code, iPaaS, CRM/ERP, HRIS, CLM, gestores documentales…).
// Cada subcarpeta con un `connector.mjs` exporta:
//   meta  = { id, name, description }
//   build(ctx) → { files: [{ name, data }], artifacts?: [{ name, entries?: [{ name, data }], data?, description }] }
// `files` se publican en <base>/integrations/connectors/<id>/<name>; cada artefacto es un zip (entries) o un binario
// (data) en esa misma carpeta, y queda en index.json con tamaño y sha256. Además se genera connectors/index.json.
// Las carpetas que empiezan con "_" (p. ej. _lib, código compartido) no son conectores.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {object} env  { here, root, vars, render, makeZip, bundle, write, artifact }
 */
export async function buildConnectors(env) {
  const dir = join(env.here, "connectors");
  const ids = readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, "connector.mjs")))
    .sort();
  const host = new URL(env.vars.BASE_URL).host;
  const index = [];
  for (const id of ids) {
    const cdir = join(dir, id);
    const mod = await import(pathToFileURL(join(cdir, "connector.mjs")).href);
    if (mod.meta?.id !== id) throw new Error(`connectors/${id}: meta.id tiene que ser "${id}"`);
    const renderText = (text, file) => env.render(text.replaceAll("{{HOST}}", host), file);
    const ctx = {
      dir: cdir,
      vars: { ...env.vars, HOST: host },
      /** Archivo de la carpeta del conector; los de texto pasan por las variables ({{BASE_URL}}, {{HOST}}, {{VERSION}}…). */
      load: (rel) => {
        const p = join(cdir, rel);
        const buf = readFileSync(p);
        return /\.(md|json|html|css|js|cjs|mjs|ts|txt|xml|svg|imljson|yml|yaml|ps1)$/i.test(p)
          ? Buffer.from(renderText(buf.toString("utf8"), relative(env.root, p)))
          : buf;
      },
      /** Archivos de una subcarpeta (rutas relativas con "/"), en orden. */
      walk: (rel) => walk(join(cdir, rel)),
      asset: (name) => readFileSync(join(env.here, "assets", name)),
      shared: (name) => readFileSync(join(dir, "_lib", name)),
      render: renderText,
      bundle: env.bundle,
      makeZip: env.makeZip,
    };
    const out = await mod.build(ctx);
    for (const f of out.files ?? []) env.write(`connectors/${id}/${f.name}`, f.data);
    const arts = [];
    for (const a of out.artifacts ?? []) {
      const data = a.data ?? env.makeZip(a.entries);
      env.artifact(`connectors/${id}/${a.name}`, data, a.description);
      arts.push(`/integrations/connectors/${id}/${a.name}`);
    }
    index.push({
      id,
      name: mod.meta.name,
      description: mod.meta.description,
      folder: `/integrations/connectors/${id}/`,
      artifacts: arts,
      files: (out.files ?? []).map((f) => f.name),
    });
  }
  env.write("connectors/index.json", Buffer.from(`${JSON.stringify({ version: env.vars.VERSION, connectors: index }, null, 2)}\n`));
  return index;
}

function walk(d) {
  const out = [];
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...walk(p).map((x) => `${name}/${x}`));
    else out.push(name);
  }
  return out;
}
