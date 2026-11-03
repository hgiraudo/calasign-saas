// Mutation testing de packages/sdk-node (docs/estandares/tests-automatizados.md §8). Correr con scripts/mutacion.sh.
// Sólo la verificación de la firma de los webhooks entrantes (el resto de src/index.ts está entre comentarios
// «Stryker disable all»), con los tests unitarios (vitest.stryker.config.ts): un mutante que sobrevive es una firma
// falsa, vieja o de otro secreto que el SDK podría aceptar sin que ningún test lo note.
import { createRequire } from "node:module";

// Con pnpm los plugins no quedan al lado de @stryker-mutator/core: se pasan resueltos desde este paquete.
const resolve = createRequire(import.meta.url).resolve;

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  plugins: [resolve("@stryker-mutator/vitest-runner")],
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "perTest",
  mutate: ["src/index.ts"],
  concurrency: 2,
  timeoutMS: 10_000,
  tempDirName: "../../var/stryker-tmp/sdk",
  incremental: true,
  incrementalFile: "../../var/mutacion/sdk-incremental.json",
  reporters: ["clear-text", "html", "json"],
  htmlReporter: { fileName: "../../var/mutacion/sdk.html" },
  jsonReporter: { fileName: "../../var/mutacion/sdk.json" },
  // break: el piso medido (puntaje total, con los mutantes sin cobertura). Si baja de acá la corrida falla; si sube,
  // se sube el piso el mismo día (trinquete, como check-calidad.mjs). Medido el 2026-11-03.
  thresholds: { high: 80, low: 60, break: 96 },
};
