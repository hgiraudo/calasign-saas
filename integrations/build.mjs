#!/usr/bin/env node
// Compila las integraciones descargables de CalaSign en apps/web/public/integrations/ (Vite las copia a dist y la API
// las sirve en <base>/integrations/…). Es determinista: misma fuente → mismos bytes (el marketplace de Claude Code
// fija el sha256 del zip del plugin).
//
//   node integrations/build.mjs                         # https://dev.calasign.com
//   CALASIGN_BASE_URL=https://app.calasign.com node integrations/build.mjs
//   node integrations/build.mjs --plugin-repo ../claude-plugins   # además, el árbol para publicar como repo git
//
// Variables: CALASIGN_BASE_URL (sin / final), CALASIGN_PRIVACY_URL (por defecto <base>/privacy),
// CALASIGN_INTEGRATIONS_OUT (carpeta de salida).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { makeZip } from "./lib/zip.mjs";
import { buildConnectors } from "./connectors/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BASE_URL = (process.env.CALASIGN_BASE_URL || "https://dev.calasign.com").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(BASE_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL)) {
  throw new Error(`CALASIGN_BASE_URL inválida: ${BASE_URL} (https://host, sin ruta)`);
}
const VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
const VARS = {
  BASE_URL,
  VERSION,
  OFFICE_VERSION: `${VERSION}.0`, // los manifiestos de Office piden 4 números
  PRIVACY_URL: process.env.CALASIGN_PRIVACY_URL || `${BASE_URL}/privacy`,
};
const OUT = resolve(process.env.CALASIGN_INTEGRATIONS_OUT || join(ROOT, "apps/web/public/integrations"));
const args = process.argv.slice(2);
const pluginRepoArg = args.includes("--plugin-repo") ? args[args.indexOf("--plugin-repo") + 1] : null;
// Sin carpeta, resolve("") era el directorio actual: el build borraba y escribía plugins/calasign ahí.
if (pluginRepoArg !== null && (!pluginRepoArg || pluginRepoArg.startsWith("--"))) throw new Error("--plugin-repo necesita una carpeta");
const pluginRepoDir = pluginRepoArg ? resolve(pluginRepoArg) : null;

// ───────── Utilidades ─────────

const TEXT = /\.(md|json|html|css|js|mjs|py|txt|xml|svg)$/i;

/** Reemplaza {{VARIABLE}}; una variable desconocida corta el build (mejor que publicar un placeholder). */
function render(text, file = "") {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in VARS)) throw new Error(`Variable desconocida ${m} en ${file}`);
    return VARS[k];
  });
}

/** Archivos de una carpeta (rutas relativas con "/"), en orden. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p).map((x) => `${name}/${x}`));
    else out.push(name);
  }
  return out;
}

/** Lee un archivo fuente: los de texto pasan por render(). */
function load(path) {
  const buf = readFileSync(path);
  return TEXT.test(path) ? Buffer.from(render(buf.toString("utf8"), relative(ROOT, path))) : buf;
}

function write(rel, data) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const artifacts = [];
function artifact(rel, data, description) {
  write(rel, data);
  artifacts.push({ path: `/integrations/${rel}`, url: `${BASE_URL}/integrations/${rel}`, bytes: data.length, sha256: sha256(data), description });
}

async function bundle(entry, opts) {
  const r = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    charset: "utf8",
    ...opts,
  });
  return Buffer.from(r.outputFiles[0].contents);
}

// ───────── 1. Skill (Agent Skills) ─────────

const SKILL_DIR = join(HERE, "skill/calasign");

function checkSkill() {
  const md = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error("SKILL.md sin frontmatter YAML");
  // Claves de primer nivel permitidas fuera de Claude Code (claude.ai / API de Skills).
  const allowed = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  const keys = m[1].split("\n").filter((l) => /^[a-z-]+:/.test(l)).map((l) => l.split(":")[0]);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`SKILL.md: clave de frontmatter no permitida: ${k}`);
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1].trim();
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1].trim();
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name) || name !== "calasign") throw new Error(`SKILL.md: name inválido (${name})`);
  if (!description || description.length > 200) throw new Error(`SKILL.md: description vacía o de más de 200 caracteres (${description?.length})`);
  if (/[<>]/.test(description)) throw new Error("SKILL.md: la description no puede tener < ni >");
  if (md.split("\n").length > 500) throw new Error("SKILL.md: más de 500 líneas");
  // Los links a references/ tienen que existir.
  for (const [, link] of md.matchAll(/\]\((references\/[^)]+)\)/g)) {
    if (!existsSync(join(SKILL_DIR, link))) throw new Error(`SKILL.md: link roto ${link}`);
  }
}

function skillEntries(prefix) {
  return walk(SKILL_DIR).map((f) => ({ name: `${prefix}${f}`, data: load(join(SKILL_DIR, f)) }));
}

// ───────── 2. Plugin de Claude Code + marketplace ─────────

function pluginEntries() {
  const dir = join(HERE, "claude-code/plugin");
  return [...walk(dir).map((f) => ({ name: f, data: load(join(dir, f)) })), ...skillEntries("skills/calasign/")];
}

function marketplace(source) {
  return {
    name: "calasign",
    owner: { name: "CalaSign", url: BASE_URL },
    metadata: { description: "CalaSign e-signature for Claude Code", version: VERSION },
    plugins: [
      {
        name: "calasign",
        description: "Send PDFs for e-signature, track signers and download signed documents with CalaSign.",
        version: VERSION,
        author: { name: "CalaSign" },
        homepage: `${BASE_URL}/developers`,
        category: "productivity",
        keywords: ["e-signature", "pdf", "mcp"],
        source,
      },
    ],
  };
}

// ───────── 3. MCPB (Claude Desktop) ─────────

async function mcpbEntries() {
  const server = await bundle(join(HERE, "mcpb/src/server.mjs"), {
    platform: "node",
    format: "esm",
    target: "node18",
    // Dependencias CommonJS dentro de un bundle ESM: necesitan un require real para los módulos de Node.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  const code = server.toString("utf8").replaceAll("__VERSION__", VERSION).replaceAll("__DEFAULT_BASE_URL__", BASE_URL);
  return [
    { name: "manifest.json", data: load(join(HERE, "mcpb/manifest.json")) },
    { name: "icon.png", data: readFileSync(join(HERE, "assets/icon-512.png")) },
    { name: "server/index.mjs", data: Buffer.from(code) },
    { name: "README.md", data: Buffer.from(`# CalaSign para Claude Desktop\n\nProxy local (stdio) al servidor MCP ${BASE_URL}/mcp. Versión ${VERSION}.\n`) },
  ];
}

// ───────── 4. Gemini CLI ─────────

function geminiContext() {
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  const refs = walk(join(SKILL_DIR, "references")).map((f) => {
    const body = readFileSync(join(SKILL_DIR, "references", f), "utf8").replace(/^# (.*)$/m, "## Reference: $1");
    return `\n---\n\n<!-- references/${f} -->\n${body.replace(/^## (?!Reference)/gm, "### ")}`;
  });
  const intro =
    "<!-- Generado desde integrations/skill/calasign por integrations/build.mjs: no editar a mano. -->\n" +
    "In Gemini CLI the CalaSign tools come from the `calasign` MCP server of this extension. If a tool call fails " +
    "with 401, ask the user to run `/mcp auth calasign`. Links like references/x.md below are sections of this same file.\n";
  return render(`${intro}${skill}${refs.join("")}`, "GEMINI.md");
}

function geminiEntries() {
  return [
    { name: "gemini-extension.json", data: load(join(HERE, "gemini-cli/gemini-extension.json")) },
    { name: "GEMINI.md", data: Buffer.from(geminiContext()) },
  ];
}

// ───────── 5. Complemento de Office ─────────

async function officeFiles() {
  const dir = join(HERE, "office");
  const files = [];
  for (const f of ["taskpane.html", "taskpane.css", "auth-start.html", "callback.html", "manifest.xml", "manifest-outlook.xml", "index.html"]) {
    files.push({ name: f, data: load(join(dir, f)) });
  }
  // Navegadores de Office: WebView2 (Windows), WKWebView (Mac/iPad), navegadores actuales (web).
  const browser = { platform: "browser", format: "iife", target: ["es2019", "safari13"] };
  files.push({ name: "taskpane.js", data: await bundle(join(dir, "src/taskpane.js"), browser) });
  files.push({ name: "auth-start.js", data: await bundle(join(dir, "src/auth-start.js"), browser) });
  files.push({ name: "callback.js", data: await bundle(join(dir, "src/callback.js"), browser) });
  for (const s of [16, 32, 64, 80, 128]) files.push({ name: `assets/icon-${s}.png`, data: readFileSync(join(HERE, `assets/icon-${s}.png`)) });
  return files;
}

// ───────── Build ─────────

async function main() {
  checkSkill();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1. Skill: el zip tiene la carpeta de la skill en la raíz (calasign/SKILL.md), como pide claude.ai.
  artifact("calasign-skill.zip", makeZip(skillEntries("calasign/")), "Skill de Claude (claude.ai, Claude Desktop, Claude Code, API)");

  // 2. Plugin de Claude Code: zip del plugin + marketplace.json con fuente "archive" (sha256 fijo).
  const pluginZip = makeZip(pluginEntries());
  const pluginZipName = `calasign-plugin-${VERSION}.zip`;
  artifact(`claude-code/${pluginZipName}`, pluginZip, "Plugin de Claude Code (zip)");
  const mk = marketplace({ source: "archive", url: `${BASE_URL}/integrations/claude-code/${pluginZipName}`, sha256: sha256(pluginZip) });
  artifact("claude-code/marketplace.json", Buffer.from(`${JSON.stringify(mk, null, 2)}\n`), "Marketplace de Claude Code (URL)");
  write("claude-code/index.html", load(join(HERE, "claude-code/index.html")));
  // Árbol expandido (para inspeccionarlo o validarlo con `claude plugin validate`).
  for (const e of pluginEntries()) write(`claude-code/calasign/${e.name}`, e.data);

  if (pluginRepoDir) {
    // Repo git publicable (p. ej. github.com/calasign/claude-plugins): marketplace con ruta relativa.
    rmSync(join(pluginRepoDir, "plugins/calasign"), { recursive: true, force: true });
    const repoMk = marketplace("./plugins/calasign");
    mkdirSync(join(pluginRepoDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginRepoDir, ".claude-plugin/marketplace.json"), `${JSON.stringify(repoMk, null, 2)}\n`);
    for (const e of pluginEntries()) {
      const p = join(pluginRepoDir, "plugins/calasign", e.name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.data);
    }
    console.log(`  repo del plugin en ${pluginRepoDir}`);
  }

  // 3. MCPB
  artifact("calasign.mcpb", makeZip(await mcpbEntries()), "Extensión de Claude Desktop (MCPB)");

  // 4. Gemini CLI: carpeta servida + zip con gemini-extension.json en la raíz.
  const gem = geminiEntries();
  for (const e of gem) write(`gemini-cli/${e.name}`, e.data);
  artifact("calasign-gemini-extension.zip", makeZip(gem), "Extensión de Gemini CLI (zip)");

  // 5. Office
  for (const e of await officeFiles()) write(`office/${e.name}`, e.data);
  artifacts.push({ path: "/integrations/office/manifest.xml", url: `${BASE_URL}/integrations/office/manifest.xml`, description: "Complemento de Word (manifiesto XML)" });
  artifacts.push({ path: "/integrations/office/manifest-outlook.xml", url: `${BASE_URL}/integrations/office/manifest-outlook.xml`, description: "Complemento de Outlook (manifiesto XML)" });

  // Ejemplos y guías.
  write("gemini-api/example.py", load(join(HERE, "gemini-api/example.py")));
  write("chatgpt/README.md", load(join(HERE, "chatgpt/README.md")));
  write("index.html", load(join(HERE, "site/index.html")));
  write("site.css", load(join(HERE, "site/site.css")));
  // ───────── Conectores out-of-the-box (connectors/<id>/connector.mjs, ver connectors/registry.mjs) ─────────
  await buildConnectors({ here: HERE, root: ROOT, vars: VARS, render, makeZip, bundle, write, artifact });

  write("index.json", `${JSON.stringify({ version: VERSION, baseUrl: BASE_URL, artifacts }, null, 2)}\n`);

  console.log(`✔ integraciones ${VERSION} para ${BASE_URL} → ${relative(ROOT, OUT) || OUT}`);
  for (const a of artifacts) console.log(`  ${a.path}${a.bytes ? `  ${(a.bytes / 1024).toFixed(1)} KB` : ""}`);
}

await main();
