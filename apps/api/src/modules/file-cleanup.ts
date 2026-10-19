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

/**
 * Descarta los adjuntos que subió un destinatario (como cuando él mismo quita uno): marca los archivos como purgados y
 * vacía sus campos. Devuelve las claves a borrar del almacenamiento con deleteBlobsQuietly DESPUÉS de confirmar la
 * transacción del llamador. Lo usan los caminos en que el lugar del destinatario pasa a otra persona (delegación,
 * reasignación, corrección del contacto): si no, completaba la firma con el archivo de otra persona (p. ej. la foto de
 * su documento) y el PDF final lo anexaba a nombre de la nueva.
 */
export async function discardRecipientAttachments(db: Db, recipientId: string): Promise<string[]> {
  const discarded = await db.query<{ storage_key: string }>(
    `UPDATE files SET purged_at = now() WHERE kind = 'attachment' AND purged_at IS NULL
       AND id IN (SELECT attachment_file_id FROM fields WHERE recipient_id = $1 AND attachment_file_id IS NOT NULL) RETURNING storage_key`,
    [recipientId],
  );
  await db.query(`UPDATE fields SET attachment_file_id = NULL, value = NULL, filled_at = NULL WHERE recipient_id = $1 AND attachment_file_id IS NOT NULL`, [
    recipientId,
  ]);
  return discarded.map((f) => f.storage_key);
}

/** Borra del almacenamiento archivos ya marcados como purgados (o que nada referencia); los errores se ignoran. */
export async function deleteBlobsQuietly(blobs: BlobStore, keys: string[]) {
  await Promise.all(keys.map((k) => blobs.delete(k).catch(() => {})));
}

/**
 * Corre `fn` (la transacción que registra archivos ya subidos con `keys`); si falla, los borra del almacenamiento y
 * relanza el error. Sin fila en `files` nada los referencia y la retención nunca los vería.
 */
export async function discardBlobsOnFailure<T>(blobs: BlobStore, keys: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await deleteBlobsQuietly(blobs, keys);
    throw err;
  }
}

/** Igual que deleteFileIfUnused para varios archivos; una falla no frena a los demás. */
export async function deleteFilesIfUnused(db: Db, blobs: BlobStore, fileIds: (string | null | undefined)[]) {
  for (const id of new Set(fileIds)) await deleteFileIfUnused(db, blobs, id).catch(() => {});
}
