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
    } catch {
      /* almacenamiento bloqueado: la sesión dura lo que el panel */
    }
  },
};
let memoryTokens = null;

export function currentTokens() {
  return memoryTokens ?? store.get(K.tokens);
}
function saveTokens(t) {
  memoryTokens = t;
  store.set(K.tokens, t);
}
export function signOut() {
  const t = currentTokens();
  saveTokens(null);
  memoryTokens = null;
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
  try {
    const rs = Office.context.roamingSettings;
    if (rs) {
      rs.set("calasignClientId", body.client_id);
      rs.saveAsync();
    }
  } catch {
    /* Word no tiene roamingSettings */
  }
  return body.client_id;
}

function roamingClientId() {
  try {
    return Office.context.roamingSettings?.get("calasignClientId") || null;
  } catch {
    return null;
  }
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
            reject(new Error("Respuesta inválida del inicio de sesión"));
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
    if (!w) return reject(new Error("popup bloqueado"));
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
    if (result.error === "invalid_client" || result.error === "unauthorized_client") store.set(K.client, null);
    throw new Error(result.error_description || result.error);
  }
  if (result.state !== state) throw new Error("state no coincide");
  const tok = await tokenRequest({ grant_type: "authorization_code", code: result.code, redirect_uri: REDIRECT_URI, client_id: cid, code_verifier: verifier });
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
    if (body.error === "invalid_client") store.set(K.client, null);
    throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
  }
  return { kind: "oauth", access_token: body.access_token, refresh_token: body.refresh_token ?? null, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

let refreshing = null;
/** Renueva el access token con el refresh token (una sola renovación en vuelo a la vez). */
export async function refresh() {
  const t = currentTokens();
  const client = store.get(K.client);
  if (t?.kind !== "oauth" || !t.refresh_token || !client?.client_id) return null;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id })
    .then((n) => {
      saveTokens(n);
      return n;
    })
    .catch(() => {
      saveTokens(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Access token vigente (renovado si está por vencer), o null si hay que iniciar sesión. */
export async function accessToken() {
  const t = currentTokens();
  if (!t) return null;
  if (t.kind === "oauth" && t.expires_at && t.expires_at - Date.now() < 60_000) return (await refresh())?.access_token ?? null;
  return t.access_token;
}
