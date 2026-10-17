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
  const returnUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!embedded || !token) return;
    document.documentElement.classList.add("cs-embedded");
    fetch(`/v1/signing/${encodeURIComponent(token)}/embed`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<SigningEmbedInfo>) : null))
      .then((info) => {
        returnUrl.current = info?.returnUrl ?? null;
      })
      .catch(() => undefined);
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
      setTimeout(() => {
        const url = returnUrl.current;
        if (!url) return;
        const u = new URL(url);
        u.searchParams.set("event", done!);
        u.searchParams.set("envelopeId", session.envelope.id);
        window.location.assign(u.toString());
      }, 1200);
    }
  }, [embedded, session, invalid]);

  return embedded;
}
