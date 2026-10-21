// Recarga única después de un deploy: una pestaña abierta antes pide archivos con hash (trozos lazy de la app, el worker
// de pdf.js) que ya no existen. Se recarga una sola vez por minuto (si el error persiste no entra en un bucle).

let reloading = false;

/**
 * Recarga la página para tomar la versión nueva. Devuelve true si se recarga (o ya se está recargando): quien llama no
 * muestra el error mientras tanto. false: ya se recargó hace menos de un minuto (o no hay almacenamiento para evitar un
 * bucle), el error se muestra.
 */
export function reloadAfterDeploy(): boolean {
  if (reloading) return true;
  try {
    const last = Number(window.sessionStorage.getItem("cs-reload-after-deploy") ?? 0);
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem("cs-reload-after-deploy", String(Date.now()));
  } catch {
    // Sin almacenamiento (p. ej. iframe con datos bloqueados) no hay cómo evitar un bucle: no se recarga.
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}
