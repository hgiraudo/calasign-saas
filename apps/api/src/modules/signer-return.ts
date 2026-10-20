// Vuelta del firmante desde un proveedor externo (checkout de pago, verificación de identidad por redirección).
//
// Antes la URL de vuelta que se le daba al proveedor llevaba el token con el que se inició (/s/<token>): un checkout
// reutilizado (sesión de Stripe abierta, preferencia de Mercado Pago, pago simulado) o una verificación retomada volvían
// al token del PRIMER inicio, que puede ser un token de sesión del canje embebido ya vencido (404) o el link permanente
// dentro del iframe. Ahora el proveedor vuelve a una ruta neutra (/v1/payments/return/:id, /v1/identity/return/:id) que
// resuelve a qué link mandar al firmante:
//   1. la cookie de corta vida que deja el inicio o la reanudación desde la página del firmante (HttpOnly, SameSite=Lax,
//      Path limitado a esa ruta): el token con el que se está firmando AHORA en este navegador, si sigue siendo válido
//      para el mismo destinatario;
//   2. fallback (la cookie no está: el iframe embebido en un sitio de terceros no la guarda —cookies de terceros
//      bloqueadas o SameSite=Lax en contexto cruzado— y la vuelta llega en la pestaña que abrió el proveedor): el último
//      token con el que se inició o retomó (guardado cifrado), solo si la URL trae la clave `k` (HMAC del id, el
//      destinatario y su link vigente) y ese token sigue valiendo para el mismo destinatario. Equivale a la URL con el
//      token que se le daba antes al proveedor, pero lleva al token vigente y deja de valer al rotar el link;
//   3. si no, una página neutra que pide volver a la ventana o al link original.
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import { decrypt, hmacEqual, hmacSign } from "../lib/util";
import { resolveToken } from "./signing";

export const SIGNER_RETURN_COOKIE = "cs_signer_return";
/** Vida de la cookie de vuelta: alcanza para completar un checkout o una verificación. */
const RETURN_COOKIE_SECONDS = 2 * 3600;

export type ReturnKind = "payments" | "identity";

export const signerReturnPath = (kind: ReturnKind, id: string) => `/v1/${kind}/return/${encodeURIComponent(id)}`;

/** Clave `k` de la URL de vuelta: ligada al id, al destinatario y a su link vigente (rotarlo la invalida). */
export function signerReturnKey(kind: ReturnKind, id: string, recipientId: string, accessTokenHash: string | null | undefined): string {
  return hmacSign(`signer-return:${kind}`, `${id}:${recipientId}:${accessTokenHash ?? ""}`);
}

/** URL de vuelta que se le da al proveedor (en el dominio del sobre: ahí vive la cookie). */
export function signerReturnUrl(base: string, kind: ReturnKind, id: string, recipient: { id: string; access_token_hash: string | null }, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ ...extra, k: signerReturnKey(kind, id, recipient.id, recipient.access_token_hash) });
  return `${base}${signerReturnPath(kind, id)}?${q.toString()}`;
}

/** Cookie con el token actual del firmante, al iniciar o retomar desde su página (mismo host que la URL de vuelta). */
export function setSignerReturnCookie(reply: FastifyReply, kind: ReturnKind, id: string, token: string) {
  reply.setCookie(SIGNER_RETURN_COOKIE, token, {
    path: signerReturnPath(kind, id),
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: RETURN_COOKIE_SECONDS,
  });
}

/**
 * Token al que se manda al firmante de vuelta, o null (página neutra). `recipientId`: el destinatario del pago o la
 * verificación; `storedTokenEnc`: el último token con el que se inició o retomó (cifrado).
 */
export async function resolveSignerReturn(
  db: Db,
  req: FastifyRequest,
  o: { kind: ReturnKind; id: string; recipientId: string; envelopeId: string; storedTokenEnc: string | null; key: string | undefined },
): Promise<string | null> {
  const valid = async (token: string | null | undefined) => {
    if (!token) return null;
    try {
      const { recipient } = await resolveToken(db, token);
      return recipient.id === o.recipientId && recipient.envelope_id === o.envelopeId ? (recipient as { access_token_hash: string }) : null;
    } catch {
      return null;
    }
  };
  const cookie = req.cookies?.[SIGNER_RETURN_COOKIE];
  if (await valid(cookie)) return cookie!;
  if (!o.key || !o.storedTokenEnc) return null;
  let stored: string;
  try {
    stored = decrypt(o.storedTokenEnc);
  } catch {
    return null;
  }
  const r = await valid(stored);
  if (!r) return null;
  return hmacEqual(o.key, signerReturnKey(o.kind, o.id, o.recipientId, r.access_token_hash)) ? stored : null;
}

/** Página neutra cuando no se puede saber a qué link volver. */
export function neutralReturnPage(reply: FastifyReply, kind: ReturnKind) {
  const what = kind === "payments" ? ["El pago", "The payment"] : ["La verificación de identidad", "The identity verification"];
  return reply
    .code(200)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CalaSign</title>` +
        `<body style="font-family:sans-serif;padding:32px;color:#0b1f3a;max-width:560px">` +
        `<h1>${what[0]} volvió a CalaSign</h1><p>Podés cerrar esta pestaña y volver a la ventana donde estabas firmando, o abrir de nuevo el link de firma que recibiste.</p>` +
        `<p lang="en">${what[1]} returned to CalaSign. You can close this tab and go back to the window where you were signing, or open your signing link again.</p>` +
        `<p lang="pt">Você pode fechar esta aba e voltar à janela onde estava assinando, ou abrir novamente o link de assinatura recebido.</p>`,
    );
}
