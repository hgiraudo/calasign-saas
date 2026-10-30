import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// CALASIGN_REPO_ROOT: la raíz del repo cuando los tests corren desde una copia (el sandbox de Stryker,
// scripts/mutacion.sh), donde `../../` ya no apunta al repo.
const repo = process.env.CALASIGN_REPO_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const support = (f: string) => `${repo.replace(/\/$/, "")}/test-support/${f}`;

export default defineConfig({
  // 30 s por test: la lectura de texto (pdf.js) corre en procesos aparte, de a 2 por proceso de prueba; con varios
  // archivos de test en paralelo, un test espera su turno y el tope por defecto (5 s) lo cortaba.
  test: { globalSetup: [support("global-tmp.ts")], setupFiles: [support("tmpdir.ts")], testTimeout: 30_000 },
});
