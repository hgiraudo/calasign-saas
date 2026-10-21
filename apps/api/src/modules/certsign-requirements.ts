import type { CertificateRequirements } from "@calasign/shared";

/**
 * Requisitos del certificado de un firmante, con los valores por defecto aplicados. `matchIdDocument` es false salvo
 * que se pida explícitamente, y solo rige si el destinatario tiene número de documento: sin documento no hay con qué
 * comparar (los caminos automáticos y los sobres en curso lo bajan y lo registran en la evidencia; ver idMatchSkipped).
 */
export function normalizeRequirements(raw: any, hasIdDocument: boolean): CertificateRequirements {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    matchIdDocument: r.matchIdDocument === true && hasIdDocument,
    allowedIssuers: Array.isArray(r.allowedIssuers) ? r.allowedIssuers.filter((x: unknown) => typeof x === "string") : [],
    requireQualified: r.requireQualified === true,
  };
}

/**
 * Se había pedido que el certificado corresponda al documento pero el destinatario no tiene número de documento: el
 * control no se aplica (no traba el sobre) y queda constancia en la evidencia. Cubre lo guardado con la marca de un
 * camino automático (`idDocumentMatchSkipped`) y lo que haya quedado pedido sin documento.
 */
export function idMatchSkipped(raw: any, idDocumentNumber: unknown): boolean {
  const r = raw && typeof raw === "object" ? raw : {};
  const hasDoc = String(idDocumentNumber ?? "").trim() !== "";
  return r.idDocumentMatchSkipped === true || (r.matchIdDocument === true && !hasDoc);
}

/**
 * Expresión SQL: los requisitos `req` con el control del documento bajado a false (y la marca para la evidencia) si
 * lo piden y `doc` está vacío. Para caminos automáticos (plantilla → sobre, reemplazos) en vez de fallar.
 */
export function downgradeIdMatchSql(req: string, doc: string) {
  return `CASE WHEN COALESCE((${req}->>'matchIdDocument')::boolean, false) AND COALESCE(btrim(${doc}), '') = ''
    THEN ${req} || '{"matchIdDocument": false, "idDocumentMatchSkipped": true}'::jsonb ELSE ${req} END`;
}
