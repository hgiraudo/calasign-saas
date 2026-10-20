// Modo embebido de la página del firmante (/s/:token?embed=1): oculta el marco de CalaSign, avisa a
// la ventana contenedora por postMessage y, si el integrador lo pidió, vuelve a su returnUrl.
import { useEffect, useRef } from "react";
import { originAllowed, type EmbedMessage, type SigningEmbedInfo, type SigningSession } from "@calasign/shared";
import "./embed.css";

const embedKey = (token: string) => `cs-embed:${token}`;

/**
 * Modo embebido: ?embed=1, recordado por pestaña y por link. Al volver de un pago o de la verificación de identidad
 * (el proveedor redirige a /s/:token?payment=… sin embed=1) la página seguía en el iframe pero con todo el marco y
 * sin avisar al integrador.
 */
export function isEmbedded(token?: string): boolean {
  if (typeof window === "undefined") return false;
  // URL "para pestaña" (firmante con OTP): no es embebido (marco completo, proveedores en la misma pestaña); solo
  // conserva la vuelta al returnUrl (ver isTabReturn).
  if (isTabReturn(token)) return false;
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

/** URL de firma "para pestaña" (?embed=1&tab=1): al terminar vuelve al returnUrl del integrador. */
export function isTabReturn(token?: string): boolean {
  if (typeof window === "undefined") return false;
  const key = token ? `${embedKey(token)}:tab` : null;
  const q = new URLSearchParams(window.location.search);
  if (q.get("embed") === "1" && q.get("tab") === "1") {
    if (key)
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        /* sin almacenamiento */
      }
    return true;
  }
  if (key)
    try {
      return window.sessionStorage.getItem(key) === "1";
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

/**
 * Tipos de aviso al integrador. "closed": el sobre terminó sin que este firmante firmara ni rechazara (anulado, vencido,
 * rechazado por otro, completado); lleva `status` con el estado del sobre. Sin él, el iframe quedaba esperando.
 */
type BridgeType = EmbedMessage["type"];
type BridgeMessage = EmbedMessage;

/**
 * Destino de postMessage: el origen del contenedor (location.ancestorOrigins, Chrome/Safari) si está entre los
 * orígenes de la sesión embebida que informa la API. Sin ancestorOrigins (Firefox) o sin orígenes conocidos queda "*":
 * el CSP frame-ancestors ya limita quién puede enmarcar la página y los avisos solo llevan ids y el tipo de evento.
 */
let targetOrigin: Promise<string> = Promise.resolve("*");

function pickTargetOrigin(origins: readonly string[] | undefined): string {
  const parent = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
  if (parent && parent !== "null" && origins?.length && originAllowed(parent, origins)) return parent;
  return "*";
}

function post(type: BridgeType, session: SigningSession | null) {
  const msg: BridgeMessage = {
    source: "calasign",
    type,
    envelopeId: session?.envelope.id ?? null,
    recipientId: session?.recipient.id ?? null,
  };
  if (type === "closed" && session) msg.status = session.envelope.status;
  void targetOrigin.then((target) => {
    try {
      if (window.parent !== window) window.parent.postMessage(msg, target);
    } catch {
      /* el contenedor puede no existir */
    }
  });
}

/** Puente con el integrador. Llamar siempre (antes de cualquier return) en la página del firmante. */
export function useEmbedBridge(token: string, session: SigningSession | null, invalid: boolean) {
  // También en modo pestaña (avisa y vuelve al returnUrl), pero sin ocultar el marco de la página.
  const framed = isEmbedded(token);
  const embedded = framed || isTabReturn(token);
  const sent = useRef<Set<string>>(new Set());
  // Promesa (no el valor): si la sesión ya llega firmada (recarga del iframe), la redirección esperaba 1,2 s y leía
  // returnUrl antes de que respondiera /embed, y el firmante quedaba sin volver al integrador.
  const returnUrl = useRef<Promise<string | null>>(Promise.resolve(null));

  useEffect(() => {
    if (!embedded || !token) return;
    if (framed) document.documentElement.classList.add("cs-embedded");
    const info = fetch(`/v1/signing/${encodeURIComponent(token)}/embed`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<SigningEmbedInfo>) : null))
      .catch(() => null);
    returnUrl.current = info.then((i) => i?.returnUrl ?? null);
    targetOrigin = info.then((i) => pickTargetOrigin(i?.origins));
  }, [embedded, token]);

  useEffect(() => {
    if (!embedded) return;
    const once = (type: BridgeType) => {
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
    // Cierre ajeno a este firmante (anulado, vencido, rechazado por otro, ya completado): la página muestra la pantalla
    // final y se avisa una vez al integrador. Solo postMessage: el returnUrl sigue reservado a firma y rechazo.
    const env = session.envelope.status;
    if (!done && (env === "voided" || env === "expired" || env === "declined" || env === "completed")) once("closed");

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

  return framed;
}
