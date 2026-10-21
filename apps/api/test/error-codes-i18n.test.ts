// Cada código de error que la API puede responder tiene texto en pt-BR y en en la consola (apps/web/src/lib/api.ts y
// api-error-text.ts); si no, quien usa la consola en esos idiomas ve el mensaje en español. Los que nunca llegan a una
// pantalla (webhooks entrantes, protocolos máquina a máquina) van en ALLOWLIST de scripts/check-error-codes.mjs.
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/check-error-codes.mjs", import.meta.url));

describe("textos de los códigos de error de la API", () => {
  it("todos los códigos tienen traducción (o están en la lista de internos)", async () => {
    const mod = await import(pathToFileURL(script).href);
    const r = mod.check() as { apiCodes: number; dynamic: string[]; missing: { code: string; file: string }[] };
    // La extracción encontró códigos (si el patrón dejara de coincidir, el test pasaría sin revisar nada).
    expect(r.apiCodes).toBeGreaterThan(200);
    expect(r.missing.map((m) => `${m.code} (${m.file})`)).toEqual([]);
    // Un código armado en tiempo de ejecución nuevo: declarar sus valores en DYNAMIC_CODES.
    expect(r.dynamic).toEqual([]);
  });
});
