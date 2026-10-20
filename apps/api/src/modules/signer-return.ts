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
import { decrypt, encrypt, hmacEqual, hmacSign } from "../lib/util";
import { PLATFORM_NAME } from "../notifications/templates";
import { resolveToken } from "./signing";
import { brandForHost, productLabel, resolveBrand, type ResolvedBrand } from "./white-label/brand";

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
 * Valor cifrado a guardar como token de vuelta (fallback sin cookie) al iniciar o retomar con `token`. Un token de
 * sesión del canje embebido guardado y todavía vigente para el mismo destinatario no se pisa con el link permanente:
 * el fallback sirve justamente para el iframe de terceros (sin cookie), donde se firma con el de sesión, y abrir el
 * link permanente en otra pestaña (que sí guarda su cookie) no tiene que mandar la vuelta del iframe al permanente.
 */
export async function returnTokenEncToStore(
  db: Db,
  o: { token: string; sessionToken: boolean; storedTokenEnc: string | null | undefined; recipientId: string },
): Promise<string> {
  if (!o.sessionToken && o.storedTokenEnc) {
    try {
      const stored = decrypt(o.storedTokenEnc);
      if (stored !== o.token) {
        const r = await resolveToken(db, stored);
        if (r.sessionToken && r.recipient.id === o.recipientId) return o.storedTokenEnc;
      }
    } catch {
      // Ilegible, vencido o de otro destinatario: se reemplaza.
    }
  }
  return encrypt(o.token);
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

type ReturnLocale = "es" | "en" | "pt";

const NEUTRAL_TEXTS: Record<ReturnLocale, { what: Record<ReturnKind, string>; title: (what: string, product: string) => string; body: string }> = {
  es: {
    what: { payments: "El pago", identity: "La verificación de identidad" },
    title: (what, product) => `${what} volvió a ${product}`,
    body: "Podés cerrar esta pestaña y volver a la ventana donde estabas firmando, o abrir de nuevo el link de firma que recibiste.",
  },
  en: {
    what: { payments: "The payment", identity: "The identity verification" },
    title: (what, product) => `${what} returned to ${product}`,
    body: "You can close this tab and go back to the window where you were signing, or open the signing link you received again.",
  },
  pt: {
    what: { payments: "O pagamento", identity: "A verificação de identidade" },
    title: (what, product) => `${what} voltou para ${product}`,
    body: "Você pode fechar esta aba e voltar à janela onde estava assinando, ou abrir novamente o link de assinatura que recebeu.",
  },
};

/** Idioma de la página neutra: el del destinatario/sobre si se conoce, si no el primero soportado de Accept-Language. */
export function neutralReturnLocale(preferred: string | null | undefined, acceptLanguage: string | undefined): ReturnLocale {
  const norm = (l: string | null | undefined) => {
    const b = String(l ?? "").trim().toLowerCase().slice(0, 2);
    return b === "es" || b === "en" || b === "pt" ? (b as ReturnLocale) : null;
  };
  const own = norm(preferred);
  if (own) return own;
  for (const part of String(acceptLanguage ?? "").split(",")) {
    const l = norm(part.split(";")[0]);
    if (l) return l;
  }
  return "es";
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Página neutra cuando no se puede saber a qué link volver (con la marca y el idioma que se puedan resolver). */
export function neutralReturnPage(
  reply: FastifyReply,
  kind: ReturnKind,
  o: { brand?: Pick<ResolvedBrand, "productName" | "whiteLabel" | "name" | "theme"> | null; locale?: ReturnLocale } = {},
) {
  const t = NEUTRAL_TEXTS[o.locale ?? "es"];
  const product = o.brand ? productLabel(o.brand) : PLATFORM_NAME;
  const color = o.brand?.theme?.primaryColor && SAFE_COLOR.test(o.brand.theme.primaryColor) ? o.brand.theme.primaryColor : "#0b1f3a";
  return reply
    .code(200)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="${o.locale ?? "es"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(product)}</title>` +
        `<body style="font-family:sans-serif;padding:32px;color:#0b1f3a;max-width:560px">` +
        `<h1 style="color:${color}">${esc(t.title(t.what[kind], product))}</h1><p>${esc(t.body)}</p></body></html>`,
    );
}

/**
 * Página neutra con la marca del sobre del pago o la verificación (`row`), o la del Host si el id no existe, y el
 * idioma del destinatario (o del sobre, o Accept-Language).
 */
export async function sendNeutralReturn(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  kind: ReturnKind,
  row: { envelope_id: string; recipient_id: string } | null,
) {
  let brand: ResolvedBrand | null = null;
  let preferred: string | null = null;
  try {
    if (row) {
      const e = await db.one<{ tenant_id: string; brand_id: string | null; locale: string | null }>(
        `SELECT e.tenant_id, e.brand_id, COALESCE(r.locale, e.locale) AS locale FROM envelopes e LEFT JOIN recipients r ON r.id = $2 AND r.envelope_id = e.id WHERE e.id = $1`,
        [row.envelope_id, row.recipient_id],
      );
      if (e) {
        brand = await resolveBrand(db, e.tenant_id, e.brand_id);
        preferred = e.locale;
      }
    }
    if (!brand) {
      const h = await brandForHost(db, req.headers.host);
      if (h) brand = await resolveBrand(db, h.tenantId, h.brandId);
    }
  } catch {
    brand = null;
  }
  const al = req.headers["accept-language"];
  return neutralReturnPage(reply, kind, { brand, locale: neutralReturnLocale(preferred, Array.isArray(al) ? al[0] : al) });
}
