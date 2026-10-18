// globalSetup de vitest: una carpeta temporal por corrida, que se borra al terminar.
// Los archivos de test crean la suya adentro (tmpdir.ts). Si la corrida se corta (Ctrl+C, `timeout`), los
// afterAll de cada archivo no llegan a correr y los workers pueden seguir escribiendo un instante después de que
// sale el proceso principal. Por eso la carpeta lleva el PID: cada corrida nueva borra las de procesos que ya no
// existen (sin tocar las de corridas en paralelo).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "calasign-vitest-run-";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export default function setup() {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    const m = name.startsWith(PREFIX) ? /^(\d+)-/.exec(name.slice(PREFIX.length)) : null;
    if (!m || alive(Number(m[1]))) continue;
    // Una carpeta vieja que no se puede borrar (de otro usuario en el /tmp compartido, o de una corrida con sudo)
    // no puede frenar la corrida: rmSync con force igual lanza EACCES/EPERM y vitest cortaba todos los tests.
    try {
      rmSync(join(base, name), { recursive: true, force: true });
    } catch {
      /* se saltea */
    }
  }
  const run = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
  const clean = () => rmSync(run, { recursive: true, force: true });
  // Los workers heredan este entorno (se lanzan después del globalSetup).
  process.env.CALASIGN_TEST_TMP = run;
  process.once("exit", clean);
  return clean;
}
