// Vuelta de /oauth/authorize: le pasa el resultado ({code, state} o {error}) al panel y se cierra.
// En Office: Office.context.ui.messageParent. Fuera de Office (pruebas en un navegador): postMessage a quien abrió.
const ORIGIN = window.location.origin;
const q = new URLSearchParams(window.location.search);
const payload = q.get("code")
  ? { code: q.get("code"), state: q.get("state") }
  : { error: q.get("error") || "unknown_error", error_description: q.get("error_description") || "", state: q.get("state") };
// El code no queda en el historial ni en el Referer de nada que cargue después.
history.replaceState(null, "", window.location.pathname);

function done(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function viaOpener() {
  if (window.opener) {
    window.opener.postMessage({ type: "calasign-oauth", payload }, ORIGIN);
    window.close();
    return true;
  }
  return false;
}

function send() {
  try {
    if (globalThis.Office?.context?.ui?.messageParent) {
      Office.context.ui.messageParent(JSON.stringify(payload));
      done("Listo. Podés cerrar esta ventana.");
      return;
    }
  } catch {
    /* sigue con la alternativa */
  }
  if (!viaOpener()) done("No se pudo volver al complemento. Cerrá esta ventana e intentá de nuevo.");
}

if (globalThis.Office?.onReady) Office.onReady(() => send());
else send();
