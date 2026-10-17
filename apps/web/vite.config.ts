import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * pdf.js necesita sus fuentes estándar (Helvetica, Times… no embebidas) y los CMaps (CJK)
 * para dibujar el texto de muchos PDF. Se copian a public/pdfjs/ (no se versiona).
 */
function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    buildStart() {
      const root = dirname(require.resolve("pdfjs-dist/package.json"));
      for (const dir of ["standard_fonts", "cmaps"]) {
        const dest = resolve(__dirname, "public/pdfjs", dir);
        if (!existsSync(dest)) cpSync(resolve(root, dir), dest, { recursive: true });
      }
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
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
