// Tope de PDFs de afuera procesándose a la vez en el proceso (preparePdfUpload / inspectPdf). Cargar, sanear y
// reescribir un PDF con pdf-lib ocupa CPU del hilo de la API y memoria proporcional al documento: sin tope, unas
// cuantas subidas simultáneas (de cualquier organización, o anónimas en los adjuntos del firmante) dejaban al proceso
// sin responder o sin memoria. Lo que no consigue lugar en `queueWaitMs` falla con PdfIngestBusyError (503, reintentable).

export const PDF_INGEST_LIMITS = {
  /** PDFs procesándose a la vez (PDF_INGEST_CONCURRENCY en la API). */
  maxConcurrent: 2,
  /** Cuánto puede esperar lugar una subida antes de rechazarse. */
  queueWaitMs: 5_000,
  /** Cuántas pueden esperar a la vez; las demás se rechazan enseguida. */
  maxQueue: 32,
};

/** No hay lugar para procesar el PDF ahora: conviene reintentar en unos segundos (503 pdf_busy, con Retry-After). */
export class PdfIngestBusyError extends Error {
  readonly code = "pdf_busy";
  readonly retryAfterSeconds = 5;
  constructor() {
    super("Hay muchos documentos procesándose en este momento; probá de nuevo en unos segundos");
    this.name = "PdfIngestBusyError";
  }
}

let active = 0;
interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiting: Waiter[] = [];

async function acquire(): Promise<void> {
  if (active < PDF_INGEST_LIMITS.maxConcurrent && waiting.length === 0) {
    active++;
    return;
  }
  if (waiting.length >= PDF_INGEST_LIMITS.maxQueue) throw new PdfIngestBusyError();
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(new PdfIngestBusyError());
      }, PDF_INGEST_LIMITS.queueWaitMs),
    };
    waiting.push(w);
  });
}

function release() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(); // el lugar pasa directo al siguiente (active no cambia)
    return;
  }
  active--;
}

/** Corre `fn` con un lugar del tope de procesamiento de PDFs. */
export async function withIngestSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Para pruebas: lugares ocupados y en espera. */
export function ingestLoad() {
  return { active, waiting: waiting.length };
}
