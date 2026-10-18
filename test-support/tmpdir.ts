// Setup de vitest: cada archivo de test usa su propio TMPDIR y se borra al terminar.
// Así los temporales de los tests (bases PGlite, PDFs, claves de prueba) no se acumulan en /tmp.
// La carpeta va dentro de la de la corrida (global-tmp.ts), que se borra aunque la corrida se corte.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(process.env.CALASIGN_TEST_TMP ?? tmpdir(), "calasign-vitest-"));
process.env.TMPDIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
