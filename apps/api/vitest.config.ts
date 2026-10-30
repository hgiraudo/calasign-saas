import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// CALASIGN_REPO_ROOT: la raíz del repo cuando los tests corren desde una copia (el sandbox de Stryker,
// scripts/mutacion.sh), donde `../../` ya no apunta al repo.
const repo = process.env.CALASIGN_REPO_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const support = (f: string) => `${repo.replace(/\/$/, "")}/test-support/${f}`;

export default defineConfig({
  // 30 s por test: con la suite completa en paralelo, importar un módulo grande dentro del test superaba los 5 s por
  // defecto (fallas intermitentes de los tests de carreras de CRM y conectores).
  test: { globalSetup: [support("global-tmp.ts")], setupFiles: [support("tmpdir.ts")], testTimeout: 30_000 },
});
