import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const support = (f: string) => fileURLToPath(new URL(`../../test-support/${f}`, import.meta.url));

export default defineConfig({
  // 30 s por test: con la suite completa en paralelo, importar un módulo grande dentro del test superaba los 5 s por
  // defecto (fallas intermitentes de los tests de carreras de CRM y conectores).
  test: { globalSetup: [support("global-tmp.ts")], setupFiles: [support("tmpdir.ts")], testTimeout: 30_000 },
});
