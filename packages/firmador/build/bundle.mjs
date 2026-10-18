// Empaqueta el Firmador en un solo archivo CommonJS (lo que necesita Node SEA). pkcs11js queda afuera: es un
// módulo nativo y se carga, si está, desde la carpeta del ejecutable (ver README).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(`${root}/dist`, { recursive: true });

await build({
  entryPoints: [`${root}/src/cli.ts`],
  outfile: `${root}/dist/firmador.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["pkcs11js"],
  // import.meta.url no existe en CommonJS: se usa la ruta del archivo (o del ejecutable, dentro del binario).
  banner: {
    js: 'var __calasign_meta_url = require("node:url").pathToFileURL(typeof __filename === "string" && __filename ? __filename : process.execPath).href;',
  },
  define: { "import.meta.url": "__calasign_meta_url", __CALASIGN_BUNDLE__: "true" },
  legalComments: "none",
  logLevel: "warning",
});
console.log("dist/firmador.cjs");
