#!/usr/bin/env node
// API efímera para los tests en navegador (playwright.config.ts → webServer): PGlite en una carpeta temporal, buzón
// de desarrollo, sin TSA (sello sin red) y la web compilada de apps/web/dist. Se borra todo al salir.
// La web tiene que estar compilada antes (scripts/qa.sh --web lo hace).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.E2E_WEB_PORT ?? 4197);
if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
  console.error("Falta apps/web/dist: compilá la web antes (corepack pnpm --filter @calasign/web build)");
  process.exit(1);
}
// La carpeta lleva el PID y cada arranque borra las de servidores que ya no existen: si Playwright lo mata sin dejarlo
// limpiar, la carpeta (~45 MB de PGlite) quedaba para siempre en /tmp, que es tmpfs. Así se juntaron 1,7 GB y el
// QA nocturno del 10 y 11-Nov-2026 se quedó sin disco (ENOSPC en PGlite) y se colgó.
const PREFIX = "calasign-web-e2e-";
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
for (const name of readdirSync(tmpdir())) {
  const m = name.startsWith(PREFIX) ? /^(\d+)-/.exec(name.slice(PREFIX.length)) : null;
  if (!m || vivo(Number(m[1]))) continue;
  try {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  } catch {
    // de otro usuario en un /tmp compartido: se saltea
  }
}
const data = mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`));
const api = spawn(join(ROOT, "apps/api/node_modules/.bin/tsx"), [join(ROOT, "scripts/e2e-api-entry.mts")], {
  cwd: join(ROOT, "apps/api"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "local",
    PORT: String(PORT),
    HOST: "127.0.0.1",
    APP_URL: `http://localhost:${PORT}`,
    DATA_DIR: data,
    DATABASE_URL: "",
    LOG_LEVEL: "warn",
    TSA_URL: "",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const salir = () => {
  try {
    api.kill("SIGTERM");
  } catch {
    // ya terminó
  }
  if (process.env.E2E_KEEP_DATA !== "1") rmSync(data, { recursive: true, force: true });
};
process.on("exit", salir);
for (const [sig, n] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
])
  process.on(sig, () => process.exit(128 + n));
api.on("exit", (code) => process.exit(code ?? 1));
