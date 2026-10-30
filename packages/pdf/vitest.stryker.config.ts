// Vitest para Stryker (scripts/mutacion.sh): sólo los tests unitarios enfocados en los módulos que se mutan. Con todos
// los tests de pdf cada mutante corría 194 tests (2,5 min la corrida en seco) y un bucle mutado esperaba al timeout.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, defineConfig({ test: { include: ["test/byterange.test.ts"] } }));
