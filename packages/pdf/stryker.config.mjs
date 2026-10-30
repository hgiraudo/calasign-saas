// Mutation testing de packages/pdf (docs/estandares/tests-automatizados.md §8). Correr con scripts/mutacion.sh.
// Sólo módulos de evidencia con tests unitarios enfocados (vitest.stryker.config.ts): un mutante que sobrevive es un
// cambio de comportamiento que ningún test detecta.
import { createRequire } from "node:module";

// Con pnpm los plugins no quedan al lado de @stryker-mutator/core: se pasan resueltos desde este paquete.
const resolve = createRequire(import.meta.url).resolve;

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  plugins: [resolve("@stryker-mutator/vitest-runner")],
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "perTest",
  mutate: ["src/signatures.ts"],
  concurrency: 2,
  timeoutMS: 10_000,
  tempDirName: "../../var/stryker-tmp/pdf",
  incremental: true,
  incrementalFile: "../../var/mutacion/pdf-incremental.json",
  reporters: ["clear-text", "html", "json"],
  htmlReporter: { fileName: "../../var/mutacion/pdf.html" },
  jsonReporter: { fileName: "../../var/mutacion/pdf.json" },
  // break: el piso medido (puntaje total, con los mutantes sin cobertura). Si baja de acá la corrida falla; si sube,
  // se sube el piso el mismo día (trinquete, como check-calidad.mjs). Medido el 2026-10-29.
  thresholds: { high: 80, low: 60, break: 38 },
};
