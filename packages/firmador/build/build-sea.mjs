// Binario autocontenido del Firmador con Node SEA (Single Executable Applications).
//   node build/build-sea.mjs linux-x64     → usa el node de esta máquina (tiene que ser Linux x64)
//   node build/build-sea.mjs windows-x64   → descarga el node.exe oficial de la misma versión y le inyecta el blob
// Salida: dist/calasign-firmador-<plataforma>[.exe]. Firma de código: PENDIENTE (Authenticode en Windows,
// codesign + notarización en macOS); sin firmar, Windows SmartScreen muestra una advertencia.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "linux-x64";
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}/dist`;
const require = createRequire(import.meta.url);
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [`${root}/build/bundle.mjs`], { stdio: "inherit" });
writeFileSync(
  `${dist}/sea-config.json`,
  JSON.stringify({ main: `${dist}/firmador.cjs`, output: `${dist}/sea-prep.blob`, disableExperimentalSEAWarning: true, useCodeCache: false }),
);
execFileSync(process.execPath, ["--experimental-sea-config", `${dist}/sea-config.json`], { stdio: "inherit" });

let out;
if (target === "linux-x64") {
  out = `${dist}/calasign-firmador-linux-x64`;
  // Hace falta el binario oficial (estático, con el fusible de SEA): el node de las distros suele ser un
  // envoltorio de libnode.so. Se descarga el de la misma versión.
  const url = `https://nodejs.org/dist/${process.version}/node-${process.version}-linux-x64.tar.xz`;
  console.log(`descargando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`no se pudo descargar node (${res.status})`);
  const tarball = `${dist}/node-linux-x64.tar.xz`;
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xJf", tarball, "-C", dist, "--strip-components=2", `node-${process.version}-linux-x64/bin/node`]);
  copyFileSync(`${dist}/node`, out);
  rmSync(`${dist}/node`, { force: true });
  rmSync(tarball, { force: true });
} else if (target === "windows-x64") {
  out = `${dist}/calasign-firmador-windows-x64.exe`;
  const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
  console.log(`descargando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`no se pudo descargar node.exe (${res.status})`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
} else {
  throw new Error(`plataforma no soportada: ${target}`);
}

const postject = require.resolve("postject/dist/cli.js");
execFileSync(
  process.execPath,
  [postject, out, "NODE_SEA_BLOB", `${dist}/sea-prep.blob`, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", "--overwrite"],
  { stdio: "inherit" },
);
if (target === "linux-x64") chmodSync(out, 0o755);

// Soporte de tokens PKCS#11: pkcs11js es nativo y no entra en el blob. Si está compilado para esta plataforma, se
// copia al lado del ejecutable (node_modules/pkcs11js) y el Firmador lo carga desde ahí.
if (target === "linux-x64") {
  const src = `${root}/node_modules/pkcs11js`;
  const side = `${dist}/linux-x64-pkcs11/node_modules/pkcs11js`;
  rmSync(`${dist}/linux-x64-pkcs11`, { recursive: true, force: true });
  if (existsSync(`${src}/build/Release/pkcs11.node`)) {
    cpSync(src, side, { recursive: true, dereference: true });
    console.log(`soporte PKCS#11 en ${side} (copiar junto al ejecutable)`);
  }
}
rmSync(`${dist}/sea-prep.blob`, { force: true });
console.log(out);
