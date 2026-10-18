// pdf.js corre en procesos aparte, con tiempo, memoria y cantidad de lecturas simultáneas acotados.
// En el mismo hilo que la API, un PDF de pocos KB la dejaba sin responder: con un stream de contenido muy comprimido
// pdf.js bloqueaba el hilo más de un minuto, y con un formulario chico dibujado cientos de miles de veces tardaba 40 s y
// ocupaba casi 1 GB. Un proceso y no un worker thread: al llegar al límite de memoria, V8 puede abortar todo el proceso
// (pasaba con un worker thread y resourceLimits), y así lo que se cae es solo el lector. Un lector que se pasa de
// tiempo se mata (eso frena la CPU). El tope de descompresión (text-budget.ts) acota además la memoria fuera del heap.
// Los lectores quedan vivos entre lecturas (arrancar uno cuesta ~200 ms) y se cierran solos después de un rato sin uso.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InvalidPdfError } from "./inspect";
import { assertTextReadable } from "./text-budget";

export interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface RawTextPage {
  width: number;
  height: number;
  /** Transformación del viewport (escala 1): espacio de usuario → página mostrada. */
  transform: number[];
  items: RawTextItem[];
}

export const PDFJS_LIMITS = {
  timeoutMs: 20_000,
  heapMb: 384,
  maxConcurrent: 2,
  maxItems: 300_000,
  idleMs: 30_000,
};

interface Slot {
  worker: ChildProcess;
  busy: boolean;
  dead?: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

const pool: Slot[] = [];
const waiting: ((s: Slot) => void)[] = [];

function spawn(): Slot {
  const worker = fork(fileURLToPath(new URL("./pdfjs-worker.mjs", import.meta.url)), [], {
    execArgv: [`--max-old-space-size=${PDFJS_LIMITS.heapMb}`],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // Un lector ocioso no mantiene vivo el proceso de la API.
  worker.unref();
  worker.channel?.unref();
  const slot: Slot = { worker, busy: true };
  // Un worker que muere solo (sin trabajo en curso) sale del pool.
  worker.on("exit", () => discard(slot));
  worker.on("error", () => discard(slot));
  pool.push(slot);
  return slot;
}

function discard(slot: Slot) {
  if (slot.dead) return; // terminate() dispara "exit": se descarta una sola vez
  slot.dead = true;
  const i = pool.indexOf(slot);
  if (i >= 0) pool.splice(i, 1);
  if (slot.idle) clearTimeout(slot.idle);
  slot.worker.kill("SIGKILL");
  // Lugar libre: si alguien espera, arranca un worker nuevo para él.
  const next = waiting.shift();
  if (next) next(spawn());
}

async function acquire(): Promise<Slot> {
  const free = pool.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    if (free.idle) clearTimeout(free.idle);
    return free;
  }
  if (pool.length < PDFJS_LIMITS.maxConcurrent) return spawn();
  return new Promise((resolve) => waiting.push(resolve));
}

function release(slot: Slot) {
  slot.worker.channel?.unref();
  const next = waiting.shift();
  if (next) return next(slot);
  slot.busy = false;
  slot.idle = setTimeout(() => discard(slot), PDFJS_LIMITS.idleMs);
  slot.idle.unref();
}

const tooHeavy = () => new InvalidPdfError("unreadable", "El PDF es demasiado pesado para leer su texto");

/** Texto en bruto de las páginas (hasta maxPages, o hasta juntar maxChars caracteres). */
export async function readPdfTextPages(pdf: Uint8Array, opts: { maxPages?: number; maxChars?: number } = {}): Promise<{ numPages: number; pages: RawTextPage[] }> {
  await assertTextReadable(pdf);
  const slot = await acquire();
  const { worker } = slot;
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    // Resultado del trabajo: el worker sigue en el pool solo si terminó bien.
    const finish = (healthy: boolean, fn: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      if (healthy) release(slot);
      else discard(slot);
      fn();
    };
    const onMessage = (m: { ok: boolean; result?: { numPages: number; pages: RawTextPage[]; tooMuch: boolean }; message?: string; name?: string }) => {
      if (!m.ok) return finish(true, () => reject(Object.assign(new Error(m.message), { name: m.name })));
      const r = m.result!;
      finish(true, () => (r.tooMuch ? reject(tooHeavy()) : resolve({ numPages: r.numPages, pages: r.pages })));
    };
    const onError = (err: Error) => finish(false, () => reject(err));
    // Se cayó (p. ej. sin memoria): lo que leía era demasiado pesado.
    const onExit = () => finish(false, () => reject(tooHeavy()));
    const timer = setTimeout(() => finish(false, () => reject(tooHeavy())), PDFJS_LIMITS.timeoutMs);
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    // Mientras lee, el canal sí mantiene vivo el proceso (si no, un script que solo espera esto terminaría antes).
    worker.channel?.ref();
    worker.send({ data: new Uint8Array(pdf), maxPages: opts.maxPages ?? 500, maxChars: opts.maxChars ?? 0, maxItems: PDFJS_LIMITS.maxItems });
  });
}

/** Punto del espacio de usuario en la página mostrada (lo mismo que viewport.convertToViewportPoint de pdf.js). */
export function toViewport(m: number[], x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}
