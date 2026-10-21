// Lugares para create_envelope del MCP, por clave (la organización: tenantId; antes era la credencial y una organización
// con varias API keys o apps OAuth multiplicaba su cupo) y por proceso. Lo que no consigue lugar espera hasta
// `queueWaitMs` en una cola corta y, si no, falla con PdfSlotBusyError (reintentable). Sin esto, muchas llamadas en
// paralelo (o un lote JSON-RPC) hacían que el servidor bajara y tuviera en memoria decenas de PDFs de 10 MB a la vez.
// Dos juegos:
//   mcpCreateSlots → sobres en curso por organización (2), desde que se obtiene el PDF hasta que se crea el sobre: acota
//                    los PDFs decodificados que una organización tiene en memoria (inspección y alta incluidas).
//   mcpPdfSlots    → descargas/decodificaciones a la vez en el proceso (8): solo mientras se obtienen los bytes (la
//                    descarga tiene su propio plazo corto), no durante la inspección ni el alta del sobre. Antes el lugar
//                    del proceso se tenía todo el recorrido y cuatro altas lentas bloqueaban a todas las organizaciones.

export class PdfSlotBusyError extends Error {
  constructor(readonly retryAfterSeconds = 5) {
    super("El servidor está procesando otros PDFs de esta conexión o de otras en este momento");
    this.name = "PdfSlotBusyError";
  }
}

export interface PdfSlotLimits {
  /** Lugares por clave (la organización). */
  perCredential: number;
  perProcess: number;
  queueWaitMs: number;
  /** Esperas en cola en total y por credencial. */
  maxQueue: number;
  maxQueuePerCredential: number;
}

/** Obtener los bytes del PDF (descarga o base64): por organización y por proceso. */
export const MCP_PDF_SLOT_LIMITS: PdfSlotLimits = { perCredential: 2, perProcess: 8, queueWaitMs: 3_000, maxQueue: 16, maxQueuePerCredential: 2 };
/** Plazo de la descarga del PDF dentro del lugar (más corto que el general de fetchPdf). */
export const MCP_PDF_FETCH_TIMEOUT_MS = 15_000;
/** Sobres en curso (PDF en memoria) por organización y por proceso. */
export const MCP_CREATE_SLOT_LIMITS: PdfSlotLimits = { perCredential: 2, perProcess: 16, queueWaitMs: 3_000, maxQueue: 32, maxQueuePerCredential: 2 };

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
export const mcpCreateSlots = createPdfSlots(MCP_CREATE_SLOT_LIMITS);
