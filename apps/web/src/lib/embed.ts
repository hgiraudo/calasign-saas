// Modo embebido de la página del firmante (/s/:token?embed=1): oculta el marco de CalaSign, avisa a
// la ventana contenedora por postMessage y, si el integrador lo pidió, vuelve a su returnUrl.
import { useEffect, useRef } from "react";
import type { EmbedMessage, SigningEmbedInfo, SigningSession } from "@calasign/shared";
import "./embed.css";

export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("embed") === "1";
}

function post(type: EmbedMessage["type"], session: SigningSession | null) {
  const msg: EmbedMessage = {
    source: "calasign",
    type,
    envelopeId: session?.envelope.id ?? null,
    recipientId: session?.recipient.id ?? null,
  };
  try {
    if (window.parent !== window) window.parent.postMessage(msg, "*");
  } catch {
    /* el contenedor puede no existir */
  }
}

/** Puente con el integrador. Llamar siempre (antes de cualquier return) en la página del firmante. */
export function useEmbedBridge(token: string, session: SigningSession | null, invalid: boolean) {
  const embedded = isEmbedded();
  const sent = useRef<Set<string>>(new Set());
  // Promesa (no el valor): si la sesión ya llega firmada (recarga del iframe), la redirección esperaba 1,2 s y leía
  // returnUrl antes de que respondiera /embed, y el firmante quedaba sin volver al integrador.
  const returnUrl = useRef<Promise<string | null>>(Promise.resolve(null));

  useEffect(() => {
    if (!embedded || !token) return;
    document.documentElement.classList.add("cs-embedded");
    returnUrl.current = fetch(`/v1/signing/${encodeURIComponent(token)}/embed`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<SigningEmbedInfo>) : null))
      .then((info) => info?.returnUrl ?? null)
      .catch(() => null);
  }, [embedded, token]);

  useEffect(() => {
    if (!embedded) return;
    const once = (type: EmbedMessage["type"]) => {
      if (sent.current.has(type)) return false;
      sent.current.add(type);
      post(type, session);
      return true;
    };
    if (invalid) {
      once("error");
      return;
    }
    if (!session) return;
    once("viewed");
    const st = session.recipient.status;
    let done: "signing_complete" | "declined" | null = null;
    if (st === "signed" || st === "completed") done = "signing_complete";
    if (st === "declined") done = "declined";
    if (done && once(done)) {
      // Dar tiempo a que el contenedor reciba el mensaje antes de navegar.
      const pending = returnUrl.current;
      setTimeout(async () => {
        const url = await pending;
        if (!url) return;
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          return;
        }
        // Solo http(s): un returnUrl "javascript:" ejecutaría código en el origen de CalaSign con el token del firmante.
        if (u.protocol !== "https:" && u.protocol !== "http:") return;
        u.searchParams.set("event", done!);
        u.searchParams.set("envelopeId", session.envelope.id);
        window.location.assign(u.toString());
      }, 1200);
    }
  }, [embedded, session, invalid]);

  return embedded;
}
