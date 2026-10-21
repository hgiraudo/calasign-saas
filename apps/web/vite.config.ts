import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * pdf.js necesita sus fuentes estándar (Helvetica, Times… no embebidas) y los CMaps (CJK)
 * para dibujar el texto de muchos PDF. Se copian a public/pdfjs/ (no se versiona). Son los mismos para la build normal y
 * la "legacy" que usa la app (están en la raíz del paquete). Se marca la versión copiada: al actualizar pdfjs-dist se
 * vuelven a copiar (antes, con la carpeta ya creada, quedaban los de la versión anterior para siempre).
 */
function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    buildStart() {
      const root = dirname(require.resolve("pdfjs-dist/package.json"));
      const version = String((JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string }).version);
      const base = resolve(__dirname, "public/pdfjs");
      const stamp = resolve(base, "VERSION");
      const current = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
      for (const dir of ["standard_fonts", "cmaps"]) {
        const dest = resolve(base, dir);
        if (current !== version || !existsSync(dest)) {
          rmSync(dest, { recursive: true, force: true });
          cpSync(resolve(root, dir), dest, { recursive: true });
        }
      }
      if (current !== version) writeFileSync(stamp, `${version}\n`);
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets(), react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:4000",
      "/dev": "http://localhost:4000",
    },
  },
  // pdf.js (legacy, ~1,4 MB entre la biblioteca y su worker) y el portal de desarrolladores se cargan aparte; el aviso
  // de tamaño vuelve a un tope cercano al de Vite para notar si algo grande vuelve al archivo de entrada.
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 600 },
});
