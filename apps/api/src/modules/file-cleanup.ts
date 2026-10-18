// Borrado de archivos que ya no usa nadie (p. ej. el PDF de un borrador eliminado o de una plantilla borrada).
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";

const isForeignKeyViolation = (e: unknown) => (e as { code?: string })?.code === "23503" || /foreign key/i.test(String((e as Error)?.message ?? e));

/**
 * Borra el archivo si nada lo referencia. Las claves foráneas hacia `files` no tienen CASCADE: si otra fila lo usa
 * (una plantilla creada desde el sobre, un sobre creado desde la plantilla, un acuerdo…), el DELETE falla y el archivo
 * se conserva. Va fuera de cualquier transacción, porque ese error abortaría la del llamador. Sin esto, el PDF de un
 * borrador o de una plantilla borrados quedaba en el almacenamiento para siempre (la retención solo purga sobres
 * completados). Devuelve si se borró.
 */
export async function deleteFileIfUnused(db: Db, blobs: BlobStore, fileId: string | null | undefined): Promise<boolean> {
  if (!fileId) return false;
  let row: { storage_key: string } | null;
  try {
    row = await db.one<{ storage_key: string }>(`DELETE FROM files WHERE id = $1 RETURNING storage_key`, [fileId]);
  } catch (e) {
    if (isForeignKeyViolation(e)) return false;
    throw e;
  }
  if (!row) return false;
  await blobs.delete(row.storage_key);
  return true;
}

/** Igual que deleteFileIfUnused para varios archivos; una falla no frena a los demás. */
export async function deleteFilesIfUnused(db: Db, blobs: BlobStore, fileIds: (string | null | undefined)[]) {
  for (const id of new Set(fileIds)) await deleteFileIfUnused(db, blobs, id).catch(() => {});
}
