// Lugares para obtener y procesar el PDF de create_envelope (descarga de una URL o base64): como mucho `perCredential`
// a la vez por credencial y `perProcess` en el proceso. Lo que no consigue lugar espera hasta `queueWaitMs` en una cola
// corta y, si no, falla con PdfSlotBusyError (reintentable). Sin esto, muchas llamadas en paralelo (o un lote JSON-RPC)
// hacían que el servidor bajara y tuviera en memoria decenas de PDFs de 10 MB a la vez.

export class PdfSlotBusyError extends Error {
  constructor(readonly retryAfterSeconds = 5) {
    super("El servidor está procesando otros PDFs de esta conexión o de otras en este momento");
    this.name = "PdfSlotBusyError";
  }
}

export interface PdfSlotLimits {
  perCredential: number;
  perProcess: number;
  queueWaitMs: number;
  /** Esperas en cola en total y por credencial. */
  maxQueue: number;
  maxQueuePerCredential: number;
}

export const MCP_PDF_SLOT_LIMITS: PdfSlotLimits = { perCredential: 2, perProcess: 4, queueWaitMs: 3_000, maxQueue: 16, maxQueuePerCredential: 2 };

interface Waiter {
  key: string;
  resolve: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPdfSlots(limits: PdfSlotLimits) {
  let active = 0;
  const perKey = new Map<string, number>();
  const waiting: Waiter[] = [];

  const free = (key: string) => active < limits.perProcess && (perKey.get(key) ?? 0) < limits.perCredential;

  function take(key: string): () => void {
    active++;
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const n = (perKey.get(key) ?? 1) - 1;
      if (n > 0) perKey.set(key, n);
      else perKey.delete(key);
      pump();
    };
  }

  // En orden de llegada, saltando a quien espera por una credencial que ya está en su tope.
  function pump() {
    for (let i = 0; i < waiting.length && active < limits.perProcess; ) {
      const w = waiting[i];
      if (free(w.key)) {
        waiting.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(take(w.key));
      } else i++;
    }
  }

  function acquire(key: string): Promise<() => void> {
    // Con alguien esperando por la misma credencial, no se le adelanta.
    if (free(key) && !waiting.some((w) => w.key === key)) return Promise.resolve(take(key));
    if (waiting.length >= limits.maxQueue || waiting.filter((w) => w.key === key).length >= limits.maxQueuePerCredential) {
      return Promise.reject(new PdfSlotBusyError());
    }
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        key,
        resolve,
        timer: setTimeout(() => {
          const i = waiting.indexOf(w);
          if (i !== -1) waiting.splice(i, 1);
          reject(new PdfSlotBusyError());
        }, limits.queueWaitMs),
      };
      waiting.push(w);
    });
  }

  return {
    acquire,
    /** Ejecuta fn con un lugar de la credencial `key`; lo libera al terminar (también si falla). */
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const release = await acquire(key);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}

/** Los del proceso (create_envelope del MCP). */
export const mcpPdfSlots = createPdfSlots(MCP_PDF_SLOT_LIMITS);
