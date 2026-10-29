import { t } from "./i18n.js";
// Inicio de sesión del complemento: OAuth 2.0 authorization code + PKCE (S256) con un cliente público.
// - El client_id se obtiene una sola vez con registro dinámico (RFC 7591, POST /oauth/register) y se guarda.
// - La pantalla de consentimiento se abre con Office.context.ui.displayDialogAsync: el diálogo arranca en
//   auth-start.html (mismo dominio que el panel, como exige Office), que redirige a /oauth/authorize; CalaSign vuelve
//   a callback.html, que le pasa el code al panel con messageParent. El canje del code se hace acá (el verifier
//   nunca sale del panel).
// - Alternativa: una API key pegada a mano (cuando el diálogo no se puede usar).
// Todo queda en localStorage del panel (el dominio es el de CalaSign).

const ORIGIN = window.location.origin;
export const REDIRECT_URI = `${ORIGIN}/integrations/office/callback.html`;
const SCOPES = "envelopes:read envelopes:write offline_access";
const K = {
  client: `calasign.office.client:${ORIGIN}`,
  tokens: `calasign.office.tokens:${ORIGIN}`,
};

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || "null");
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      /* almacenamiento bloqueado: la sesión dura lo que el panel */
      return false;
    }
  },
};
// Solo cuando localStorage no anda. Si anda, manda lo guardado: otro panel del mismo origen (otro documento, Word y
// Outlook) puede haber rotado el refresh token, y reusar una copia vieja en memoria hace que el servidor detecte la
// reutilización y revoque toda la familia (todos los paneles quedan sin sesión).
let memoryTokens = null;

export function currentTokens() {
  return store.get(K.tokens) ?? memoryTokens;
}
function saveTokens(t) {
  if (store.set(K.tokens, t)) {
    memoryTokens = null;
    return;
  }
  memoryTokens = t;
  // La escritura falló (p. ej. cuota llena) pero la lectura anda: lo guardado antes taparía lo de memoria en
  // currentTokens() y se volvería a canjear un refresh token ya rotado (el servidor revocaría toda la familia).
  store.set(K.tokens, null);
}
export function signOut() {
  const t = currentTokens();
  saveTokens(null);
  // Revoca el refresh token (y con él la familia) sin esperar la respuesta.
  const client = store.get(K.client);
  if (t?.refresh_token && client?.client_id) {
    fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token, client_id: client.client_id }),
    }).catch(() => {});
  }
}

export function useApiKey(key) {
  saveTokens({ kind: "api_key", access_token: key.trim() });
}

// ───────── PKCE ─────────

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n = 48) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
async function challengeFor(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// ───────── Registro dinámico ─────────

async function clientId() {
  const saved = store.get(K.client);
  if (saved?.client_id && saved.redirect_uri === REDIRECT_URI) return saved.client_id;
  const res = await fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Solo los campos mínimos de RFC 7591 (grant_types y scope quedan con los valores por defecto del servidor:
    // authorization code + PKCE; los scopes se piden en /oauth/authorize).
    body: JSON.stringify({ client_name: "CalaSign para Office", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw new Error(body.error_description || body.error?.message || body.error || `HTTP ${res.status}`);
  store.set(K.client, { client_id: body.client_id, redirect_uri: REDIRECT_URI });
  // Outlook: también en la configuración itinerante, para no registrar otro cliente en cada equipo.
  setRoamingClientId(body.client_id);
  return body.client_id;
}

// La clave lleva el origen: el Id del manifiesto es el mismo en todos los entornos (dev, app…), así que la
// configuración itinerante es compartida y un client_id de otro entorno no existe en este.
const ROAMING_KEY = `calasignClientId:${ORIGIN}`;

function roamingClientId() {
  try {
    return globalThis.Office?.context?.roamingSettings?.get(ROAMING_KEY) || null;
  } catch {
    return null;
  }
}

function setRoamingClientId(id) {
  try {
    const rs = globalThis.Office?.context?.roamingSettings;
    if (!rs) return;
    if (id) rs.set(ROAMING_KEY, id);
    else rs.remove(ROAMING_KEY);
    rs.saveAsync();
  } catch {
    /* Word no tiene roamingSettings */
  }
}

/** Cliente borrado o revocado del lado de CalaSign: se olvida (también el itinerante) y se registra otro. */
function forgetClient() {
  store.set(K.client, null);
  setRoamingClientId(null);
}

// ───────── Diálogo ─────────

/** Abre el diálogo y resuelve con el mensaje que manda callback.html ({code, state} o {error}). */
function openDialog(url) {
  return new Promise((resolve, reject) => {
    const ui = globalThis.Office?.context?.ui;
    if (ui?.displayDialogAsync) {
      ui.displayDialogAsync(url, { height: 70, width: 35, promptBeforeOpen: false }, (r) => {
        if (r.status !== Office.AsyncResultStatus.Succeeded) {
          reject(Object.assign(new Error(r.error?.message || "dialog"), { dialogCode: r.error?.code }));
          return;
        }
        const dialog = r.value;
        dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
          dialog.close();
          try {
            resolve(JSON.parse(arg.message));
          } catch {
            reject(new Error(t("loginBadResponse")));
          }
        });
        // 12006: la persona cerró la ventana. Otros códigos: la página no cargó.
        dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
          reject(Object.assign(new Error(`dialog ${arg.error}`), { dialogCode: arg.error, closed: arg.error === 12006 }));
        });
      });
      return;
    }
    // Fuera de Office (probar el panel en un navegador): ventana emergente y postMessage.
    const w = window.open(url, "calasign-login", "width=520,height=720");
    if (!w) return reject(new Error(t("popupBlocked")));
    const onMsg = (ev) => {
      if (ev.origin !== ORIGIN || ev.data?.type !== "calasign-oauth") return;
      window.removeEventListener("message", onMsg);
      resolve(ev.data.payload);
    };
    window.addEventListener("message", onMsg);
  });
}

/** Flujo completo: registro (si hace falta), consentimiento, canje del code. */
export async function signIn() {
  let cid = null;
  const roaming = roamingClientId();
  if (roaming && !store.get(K.client)) store.set(K.client, { client_id: roaming, redirect_uri: REDIRECT_URI });
  cid = await clientId();
  const verifier = randomString(48);
  const state = randomString(16);
  const params = new URLSearchParams({ client_id: cid, code_challenge: await challengeFor(verifier), state, scope: SCOPES });
  const result = await openDialog(`${ORIGIN}/integrations/office/auth-start.html?${params}`);
  if (result.error) {
    // Cliente borrado o revocado del lado de CalaSign: se registra otro la próxima vez.
    if (result.error === "invalid_client" || result.error === "unauthorized_client") forgetClient();
    throw new Error(result.error_description || result.error);
  }
  if (result.state !== state) throw new Error(t("loginState"));
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code: result.code,
    redirect_uri: REDIRECT_URI,
    client_id: cid,
    code_verifier: verifier,
  });
  saveTokens(tok);
  return tok;
}

async function tokenRequest(form) {
  const res = await fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_client") forgetClient();
    throw Object.assign(new Error(body.error_description || body.error || `HTTP ${res.status}`), { status: res.status, oauthError: body.error });
  }
  return {
    kind: "oauth",
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

let refreshing = null;
/**
 * Renueva el access token con el refresh token. Una sola renovación a la vez, también entre paneles del mismo origen
 * (dos documentos de Word, Word y Outlook): el servidor revoca toda la familia si el mismo refresh token se canjea dos
 * veces, así que la renovación corre bajo un Web Lock y relee lo guardado; si otro panel ya renovó, se usa eso.
 * @param {string} [stale] access token que el servidor acaba de rechazar (401), si lo hay
 */
export async function refresh(stale) {
  refreshing ??= withRefreshLock(() => doRefresh(stale)).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function withRefreshLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(`calasign.office.refresh:${ORIGIN}`, fn) : fn();
}

async function doRefresh(stale) {
  const t = currentTokens();
  if (t?.kind !== "oauth" || !t.refresh_token) return null;
  // Otro panel renovó mientras se esperaba el lock (o antes del 401): lo guardado ya es un token nuevo y vigente.
  if (t.access_token !== stale && t.expires_at && t.expires_at - Date.now() >= 60_000) return t;
  const client = store.get(K.client);
  if (!client?.client_id) {
    // Sin el cliente registrado no hay renovación posible: se cierra la sesión para volver a iniciarla (si no, el panel
    // quedaba para siempre en "no se pudo renovar la sesión").
    saveTokens(null);
    return null;
  }
  try {
    const n = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id });
    saveTokens(n);
    return n;
  } catch (e) {
    // Solo un rechazo del servidor (refresh token vencido, revocado o reusado) cierra la sesión, y solo si nadie guardó
    // otra mientras tanto. Un error de red o un 5xx es pasajero: se conserva el refresh token para reintentar después.
    if ((e?.oauthError === "invalid_grant" || e?.oauthError === "invalid_client") && currentTokens()?.refresh_token === t.refresh_token)
      saveTokens(null);
    return null;
  }
}

/** Access token vigente (renovado si está por vencer), o null si hay que iniciar sesión. */
export async function accessToken() {
  const t = currentTokens();
  if (!t) return null;
  if (t.kind === "oauth" && t.expires_at && t.expires_at - Date.now() < 60_000) return (await refresh())?.access_token ?? null;
  return t.access_token;
}
