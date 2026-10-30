// Vitest para Stryker (scripts/mutacion.sh): sólo los tests unitarios enfocados en los módulos que se mutan (la suite
// entera de la API tarda ~4 min y levanta PGlite por archivo: imposible por mutante).
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, defineConfig({ test: { include: ["test/redact.test.ts", "test/totp.test.ts"] } }));
