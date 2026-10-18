// Setup de vitest: cada archivo de test usa su propio TMPDIR y se borra al terminar.
// Así los temporales de los tests (bases PGlite, PDFs, claves de prueba) no se acumulan en /tmp.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "calasign-vitest-"));
process.env.TMPDIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
