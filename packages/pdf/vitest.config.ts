import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const support = (f: string) => fileURLToPath(new URL(`../../test-support/${f}`, import.meta.url));

export default defineConfig({
  // 30 s por test: la lectura de texto (pdf.js) corre en procesos aparte, de a 2 por proceso de prueba; con varios
  // archivos de test en paralelo, un test espera su turno y el tope por defecto (5 s) lo cortaba.
  test: { globalSetup: [support("global-tmp.ts")], setupFiles: [support("tmpdir.ts")], testTimeout: 30_000 },
});
