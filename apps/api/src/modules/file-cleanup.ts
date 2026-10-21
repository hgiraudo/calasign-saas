// Borrado de archivos que ya no usa nadie (p. ej. el PDF de un borrador eliminado o de una plantilla borrada).
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";

const isForeignKeyViolation = (e: unknown) => (e as { code?: string })?.code === "23503" || /foreign key/i.test(String((e as Error)?.message ?? e));

/**
 * Borra el archivo si nada lo referencia. Las claves foráneas hacia `files` no tienen CASCADE: si otra fila lo usa
 * (una plantilla creada desde el sobre, un sobre creado desde la plantilla, un acuerdo…), el DELETE falla y el archivo
 * se conserva. Va fuera de cualquier transacción del llamador, porque ese error abortaría la suya. Sin esto, el PDF de
 * un borrador o de una plantilla borrados quedaba en el almacenamiento para siempre (la retención solo purga sobres
 * completados). Devuelve si se borró.
 *
 * La fila se borra en una transacción propia que se confirma recién después de borrar el archivo del almacenamiento:
 * si ese borrado falla, la fila vuelve (la transacción se deshace), queda anotado en pending_file_deletions para que el
 * barrido lo reintente y el error sale. Antes se borraba la fila primero y
 * un fallo del almacenamiento dejaba el archivo sin nada que lo referenciara (y los llamadores ignoraban el error).
 */
export async function deleteFileIfUnused(db: Db, blobs: BlobStore, fileId: string | null | undefined): Promise<boolean> {
  if (!fileId) return false;
  try {
    return await db.tx(async (t) => {
      const row = await t.one<{ storage_key: string }>(`DELETE FROM files WHERE id = $1 RETURNING storage_key`, [fileId]);
      if (!row) return false;
      await blobs.delete(row.storage_key);
      return true;
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) return false;
    // El barrido lo reintenta (retryPendingFileDeletions): varios llamadores ignoran el error.
    await db
      .query(`INSERT INTO pending_file_deletions (file_id, error) VALUES ($1, $2) ON CONFLICT (file_id) DO UPDATE SET error = EXCLUDED.error`, [
        fileId,
        String((e as Error)?.message ?? e).slice(0, 1000),
      ])
      .catch(() => {});
    throw e;
  }
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

/**
 * Igual que deleteFileIfUnused para varios archivos; una falla no frena a los demás. Un archivo cuyo borrado falla
 * (almacenamiento caído) queda en pending_file_deletions (deleteFileIfUnused) y el barrido lo reintenta: no se pierde
 * aunque el llamador ya haya dado los archivos por borrados. Devuelve cuántos fallaron.
 */
export async function deleteFilesIfUnused(db: Db, blobs: BlobStore, fileIds: (string | null | undefined)[]): Promise<number> {
  let failed = 0;
  for (const id of new Set(fileIds)) {
    if (!id) continue;
    try {
      await deleteFileIfUnused(db, blobs, id);
    } catch {
      failed++; // queda en pending_file_deletions
    }
  }
  return failed;
}

/**
 * Barrido: reintenta los borrados de pending_file_deletions (de a `limit`, primero los nunca reintentados; uno que falló
 * espera una hora). La fila se descarta si el archivo ya no existe o lo volvió a usar algo (deleteFileIfUnused no lo
 * borra), o al borrarlo.
 */
export async function retryPendingFileDeletions(db: Db, blobs: BlobStore, limit = 100) {
  const rows = await db.query<{ file_id: string }>(
    `SELECT file_id FROM pending_file_deletions WHERE attempted_at IS NULL OR attempted_at < now() - interval '1 hour'
      ORDER BY attempted_at NULLS FIRST, queued_at LIMIT $1`,
    [limit],
  );
  let deleted = 0;
  for (const r of rows) {
    try {
      if (await deleteFileIfUnused(db, blobs, r.file_id)) deleted++;
      await db.query(`DELETE FROM pending_file_deletions WHERE file_id = $1`, [r.file_id]);
    } catch (err) {
      await db
        .query(`UPDATE pending_file_deletions SET attempted_at = now(), error = $2 WHERE file_id = $1`, [r.file_id, String((err as Error)?.message ?? err).slice(0, 1000)])
        .catch(() => {});
    }
  }
  return { deleted, seen: rows.length };
}
