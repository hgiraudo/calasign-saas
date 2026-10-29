#!/usr/bin/env node
// Genera el repo independiente del paquete comunitario n8n-nodes-calasign, listo para publicar en npm desde GitHub
// Actions con provenance (requisito de n8n para nodos verificados). Las fuentes viven acá, en el monorepo; el repo
// exportado es el que se sube a GitHub. Volver a correrlo actualiza el repo (no borra .git ni node_modules).
//
//   node integrations/connectors/n8n/export-repo.mjs [--out ../n8n-nodes-calasign] [--base-url https://app.calasign.com]
//                                                    [--repo hgiraudo/n8n-nodes-calasign]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const out = resolve(arg("out", join(here, "../../../../n8n-nodes-calasign")));
const baseUrl = arg("base-url", process.env.CALASIGN_BASE_URL ?? "https://dev.calasign.com").replace(/\/$/, "");
const repo = arg("repo", "hgiraudo/n8n-nodes-calasign");
const version = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")).version;

// Solo los placeholders del build; las expresiones de n8n (={{$credentials…}}) quedan intactas.
const fill = (s) => s.replaceAll("{{BASE_URL}}", baseUrl).replaceAll("{{VERSION}}", version);
const write = (rel, data) => {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

mkdirSync(out, { recursive: true });
for (const d of ["credentials", "nodes", "dist"]) rmSync(join(out, d), { recursive: true, force: true });

for (const f of [
  "credentials/CalaSignApi.credentials.ts",
  "credentials/CalaSignOAuth2Api.credentials.ts",
  "nodes/GenericFunctions.ts",
  "nodes/CalaSign/CalaSign.node.ts",
  "nodes/CalaSignTrigger/CalaSignTrigger.node.ts",
])
  write(f, fill(readFileSync(join(here, f), "utf8")));
// Ícono junto a cada nodo (n8n lo busca relativo al .node.js).
for (const n of ["nodes/CalaSign", "nodes/CalaSignTrigger", "credentials"]) cpSync(join(here, "nodes/calasign.svg"), join(out, `${n}/calasign.svg`));
cpSync(join(here, "nodes/calasign.svg"), join(out, "nodes/calasign.svg"));

// quicksend: lógica compartida con los otros conectores (CommonJS); en el repo va como módulo propio con sus tipos.
write("nodes/quicksend.js", readFileSync(join(here, "../_lib/quicksend.cjs"), "utf8"));
write("nodes/quicksend.d.ts", readFileSync(join(here, "nodes/quicksend.d.ts"), "utf8"));

const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
pkg.version = version;
pkg.homepage = `${baseUrl}/developers/connectors#n8n`;
pkg.repository = { type: "git", url: `git+https://github.com/${repo}.git` };
pkg.bugs = { url: `https://github.com/${repo}/issues` };
pkg.engines = { node: ">=20.15" };
pkg.publishConfig = { access: "public", provenance: true };
pkg.packageManager = "pnpm@9.15.9";
// Ninguna dependencia necesita scripts de instalación para lint/build: isolated-vm (de n8n-workflow) es nativo y
// fallaba al compilar en CI.
pkg.pnpm = { onlyBuiltDependencies: [] };
pkg.files = ["dist"];
pkg.scripts = { ...pkg.scripts, "build:watch": "tsc --watch", dev: "n8n-node dev", "lint:fix": "n8n-node lint --fix" };
pkg.devDependencies = { ...pkg.devDependencies, "@n8n/node-cli": "^0.52.6", prettier: "3.6.2", "release-it": "^21.1.0", "@types/node": "^22.0.0" };
write("package.json", JSON.stringify(pkg, null, 2) + "\n");

write("README.md", fill(readFileSync(join(here, "README.md"), "utf8")));
const tsconfig = JSON.parse(readFileSync(join(here, "tsconfig.json"), "utf8"));
tsconfig.compilerOptions.allowJs = true;
tsconfig.include = ["credentials/**/*.ts", "nodes/**/*.ts", "nodes/**/*.js"];
write("tsconfig.json", JSON.stringify(tsconfig, null, 2) + "\n");

const [owner, name] = repo.split("/");
for (const f of [
  "LICENSE.md",
  "CHANGELOG.md",
  "RELEASING.md",
  ".gitignore",
  "eslint.config.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/publish.yml",
]) {
  if (f === "CHANGELOG.md" && existsSync(join(out, f))) continue; // el changelog lo mantiene `release` en el repo
  const text = fill(readFileSync(join(here, "repo", f), "utf8"));
  write(f, text.replaceAll("{{REPO_OWNER}}", owner).replaceAll("{{REPO_NAME}}", name).replaceAll("{{REPO}}", repo));
}

console.log(`n8n-nodes-calasign ${version} exportado en ${out} (base ${baseUrl}, repo ${repo})`);
