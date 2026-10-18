import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const support = (f: string) => fileURLToPath(new URL(`../../test-support/${f}`, import.meta.url));

export default defineConfig({
  test: { globalSetup: [support("global-tmp.ts")], setupFiles: [support("tmpdir.ts")] },
});
