// Modo embebido de la página del firmante (/s/:token?embed=1): oculta el marco de CalaSign, avisa a
// la ventana contenedora por postMessage y, si el integrador lo pidió, vuelve a su returnUrl.
import { useEffect, useRef } from "react";
import type { EmbedMessage, SigningEmbedInfo, SigningSession } from "@calasign/shared";
import "./embed.css";

const embedKey = (token: string) => `cs-embed:${token}`;

/**
 * Modo embebido: ?embed=1, recordado por pestaña y por link. Al volver de un pago o de la verificación de identidad
 * (el proveedor redirige a /s/:token?payment=… sin embed=1) la página seguía en el iframe pero con todo el marco y
 * sin avisar al integrador.
 */
export function isEmbedded(token?: string): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("embed") === "1") {
    if (token)
      try {
        window.sessionStorage.setItem(embedKey(token), "1");
      } catch {
        /* sin almacenamiento */
      }
    return true;
  }
  if (token)
    try {
      if (window.sessionStorage.getItem(embedKey(token)) === "1") return true;
    } catch {
      /* sin almacenamiento */
    }
  return false;
}

/**
 * Abre la página de un proveedor (pago, verificación de identidad). Embebido, en otra pestaña: muchos proveedores no
 * cargan dentro de un iframe; la página del firmante sigue consultando hasta ver el resultado.
 * La pestaña se abre en el mismo clic (antes de esperar a la API): abierta después, el navegador la bloquea. Si no se
 * pudo abrir (iframe sin allow-popups), se navega en el mismo marco como antes.
 */
export function prepareProviderTab(token: string): { open(url: string): "tab" | "same"; cancel(): void } {
  const w = isEmbedded(token) ? window.open("about:blank", "_blank") : null;
  return {
    open(url: string) {
      if (w && !w.closed) {
        try {
          w.opener = null;
        } catch {
          /* ignorado */
        }
        w.location.href = url;
        return "tab";
      }
      window.location.assign(url);
      return "same";
    },
    cancel() {
      try {
        w?.close();
      } catch {
        /* ignorado */
      }
    },
  };
}

/** Token de la base de la API del firmante (/v1/signing/<token>). */
export const tokenOfBase = (base: string) => decodeURIComponent(base.split("/")[3] ?? "");

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
  const embedded = isEmbedded(token);
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
    const sess = session;
    once("viewed");
    const st = session.recipient.status;
    // Con firma con certificado, "signed" es solo la etapa electrónica: falta el paso del Firmador. Avisar el fin y
    // volver al returnUrl en ese momento sacaba al firmante antes de firmar con su certificado (el sobre quedaba
    // esperando). La recarga de la sesión cuando el Firmador termina dispara el aviso.
    const certPending = session.certificateSigning != null && session.certificateSigning.status !== "signed";
    let done: "signing_complete" | "declined" | null = null;
    if ((st === "signed" || st === "completed") && !certPending) done = "signing_complete";
    if (st === "declined") done = "declined";
    if (done === "signing_complete" && !sent.current.has(done)) {
      // Con un pago posterior a la firma todavía pendiente, el firmante tiene que pagar acá: el aviso (y la vuelta al
      // returnUrl) espera. Al confirmarse el pago la sesión se recarga y esto se vuelve a evaluar.
      let cancelled = false;
      fetch(`/v1/signing/${encodeURIComponent(token)}/payment`, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<{ canPay?: boolean }>) : null))
        .catch(() => null)
        .then((p) => {
          if (cancelled || p?.canPay) return;
          finish("signing_complete");
        });
      return () => {
        cancelled = true;
      };
    }
    if (done) finish(done);

    function finish(done: "signing_complete" | "declined") {
      if (!once(done)) return;
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
        u.searchParams.set("envelopeId", sess.envelope.id);
        window.location.assign(u.toString());
      }, 1200);
    }
  }, [embedded, session, invalid, token]);

  return embedded;
}
