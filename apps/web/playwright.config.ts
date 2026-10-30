// Tests de la web en navegador (docs/estandares/tests-automatizados.md §6). Corren contra una API efímera que sirve
// la web compilada (e2e/servidor.mjs): ./scripts/qa.sh --web, o desde apps/web:
//   corepack pnpm --filter @calasign/web build && ./node_modules/.bin/playwright test
// WebKit (el motor de Safari) es opcional: E2E_WEBKIT=1, con las librerías del sistema instaladas
// (sudo ./node_modules/.bin/playwright install-deps webkit).
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_WEB_PORT ?? 4197);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // De a uno: comparten la API efímera y la máquina tiene poca RAM.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "dot" : [["list"]],
  outputDir: "../../var/playwright",
  use: {
    baseURL: BASE,
    locale: "es-AR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // El firmante en un celular: es la pantalla que más importa y la que peor se prueba en un escritorio.
    { name: "celular", use: { ...devices["Pixel 7"] }, testMatch: "**/firmante.e2e.ts" },
    ...(process.env.E2E_WEBKIT === "1" ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
  webServer: {
    command: "node e2e/servidor.mjs",
    url: `http://127.0.0.1:${PORT}/healthz`,
    // Nunca contra una API ajena: si el puerto está ocupado (otra sesión), falla en vez de reusarla.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
