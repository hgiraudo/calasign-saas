import { PDFDocument } from "pdf-lib";

/** Verifica que una imagen PNG/JPG se pueda incrustar en un PDF (lanza si está dañada). */
export async function assertEmbeddableImage(bytes: Uint8Array, contentType: "image/png" | "image/jpeg"): Promise<void> {
  const doc = await PDFDocument.create();
  if (contentType === "image/png") await doc.embedPng(bytes);
  else await doc.embedJpg(bytes);
}
