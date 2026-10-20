/** Códigos de rechazo de un PDF de afuera (la API los devuelve como `error.code`). */
export type InvalidPdfCode =
  | "not_pdf"
  | "encrypted"
  | "pdf_restricted"
  | "empty"
  | "too_many_pages"
  | "unreadable"
  | "ambiguous_pdf"
  | "pdf_hidden_layers"
  | "pdf_form_unsupported";

export class InvalidPdfError extends Error {
  constructor(
    readonly code: InvalidPdfCode,
    message: string,
  ) {
    super(message);
  }
}

export function hiddenLayersError(context: "upload" | "seal"): InvalidPdfError {
  return new InvalidPdfError(
    "pdf_hidden_layers",
    context === "upload"
      ? "El PDF tiene capas ocultas (contenido opcional apagado): exportalo de nuevo sin capas o imprimilo a PDF y volvé a subirlo."
      : "El documento tiene capas ocultas (contenido opcional apagado): no se sella porque el PDF final mostraría contenido que el firmante no vio.",
  );
}

export function formUnsupportedError(): InvalidPdfError {
  return new InvalidPdfError(
    "pdf_form_unsupported",
    "El PDF tiene un formulario cuyos campos no se pueden fijar tal como se ven: imprimilo a PDF y volvé a subirlo.",
  );
}
