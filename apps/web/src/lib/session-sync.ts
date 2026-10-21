// Aviso entre pestañas de que la sesión cambió (cambio de organización, invitación aceptada, ingreso, cierre de sesión): la
// cookie es una sola, así que las demás pestañas quedaban mostrando la organización anterior y lo que guardaban iba a
// parar a la nueva. BroadcastChannel y, si no existe, el evento storage de localStorage.

export type SessionChange = { kind: "switch" | "accept" | "login" | "logout"; tenantId: string | null; userId: string | null };

const CHANNEL = "calasign-session";
const STORAGE_KEY = "calasign:session-change";
/** Identifica a esta pestaña: el evento storage no llega a quien escribe, pero BroadcastChannel tampoco; por las dudas. */
const TAB_ID = Math.random().toString(36).slice(2);

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

export function broadcastSessionChange(change: SessionChange): void {
  if (typeof window === "undefined") return;
  const msg = { ...change, from: TAB_ID, at: Date.now() };
  const ch = channel();
  if (ch) {
    try {
      ch.postMessage(msg);
    } finally {
      ch.close();
    }
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sin almacenamiento (modo privado): queda el control del servidor (409 tenant_mismatch).
  }
}

/** Escucha los cambios de sesión hechos en OTRAS pestañas. Devuelve la función para dejar de escuchar. */
export function onSessionChange(cb: (change: SessionChange) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (raw: unknown) => {
    const m = raw as (SessionChange & { from?: string }) | null;
    if (!m || typeof m !== "object" || m.from === TAB_ID) return;
    if (m.kind !== "switch" && m.kind !== "accept" && m.kind !== "login" && m.kind !== "logout") return;
    cb({ kind: m.kind, tenantId: typeof m.tenantId === "string" ? m.tenantId : null, userId: typeof m.userId === "string" ? m.userId : null });
  };
  const ch = channel();
  if (ch) {
    ch.onmessage = (e) => handle(e.data);
    return () => ch.close();
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      handle(JSON.parse(e.newValue));
    } catch {
      // ignorado
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
