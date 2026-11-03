// Vitest para Stryker (scripts/mutacion.sh): sólo los tests unitarios (test/integration.test.ts necesita una API
// levantada).
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/unit.test.ts", "test/webhooks.test.ts"] } });
