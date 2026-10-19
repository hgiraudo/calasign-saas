import { setLanguage, t } from "./i18n.js";
setLanguage(navigator.language);
// Primera página del diálogo de inicio de sesión. Office exige que el diálogo abra en el mismo dominio que el
// panel; desde acá se redirige a la pantalla de consentimiento de CalaSign (siempre del mismo origen: esta página no
// redirige a URLs arbitrarias, solo arma la de /oauth/authorize con parámetros validados).
const ORIGIN = window.location.origin;
const q = new URLSearchParams(window.location.search);
const ok = (v, re) => typeof v === "string" && re.test(v);

const clientId = q.get("client_id");
const challenge = q.get("code_challenge");
const state = q.get("state");
const scope = q.get("scope") || "";

if (ok(clientId, /^[A-Za-z0-9._~-]{1,100}$/) && ok(challenge, /^[A-Za-z0-9_-]{43,128}$/) && ok(state, /^[A-Za-z0-9_-]{8,200}$/) && /^[a-z_: ]{0,500}$/.test(scope)) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${ORIGIN}/integrations/office/callback.html`,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.replace(`${ORIGIN}/oauth/authorize?${p}`);
} else {
  document.getElementById("status").textContent = t("dialogBadParams");
}
