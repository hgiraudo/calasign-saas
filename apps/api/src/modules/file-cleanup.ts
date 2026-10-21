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
 * En dos fases:
 * 1. Transacción corta: DELETE de la fila (las claves foráneas comprueban que nada la usa) y, en la misma, la anotación
 *    en pending_file_deletions con la clave del almacenamiento. Al confirmar, la fila ya no existe: nada puede volver a
 *    referenciarla (un INSERT que la apunte falla por la clave foránea), así que no hay carrera con quien la reuse.
 * 2. Fuera de la transacción: el borrado en el almacenamiento (puede necesitar otra conexión, p. ej. el resolver BYOK,
 *    y no retiene una conexión del pool mientras habla con el almacenamiento) y, si salió bien, se quita la anotación.
 *    Si falla, la anotación (con la clave) queda y el barrido lo reintenta: el archivo no queda huérfano.
 * Antes el blob se borraba dentro de la transacción abierta: con el pool justo y el resolver BYOK esperando otra
 * conexión se trababa, y si el COMMIT fallaba después de borrar el blob la fila quedaba apuntando a un archivo que ya no
 * existía.
 */
export async function deleteFileIfUnused(db: Db, blobs: BlobStore, fileId: string | null | undefined): Promise<boolean> {
  if (!fileId) return false;
  let key: string | null;
  try {
    key = await db.tx(async (t) => {
      const row = await t.one<{ storage_key: string }>(`DELETE FROM files WHERE id = $1 RETURNING storage_key`, [fileId]);
      if (!row) return null;
      await t.query(
        `INSERT INTO pending_file_deletions (file_id, storage_key) VALUES ($1, $2)
         ON CONFLICT (file_id) DO UPDATE SET storage_key = EXCLUDED.storage_key`,
        [fileId, row.storage_key],
      );
      return row.storage_key;
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) return false;
    // La primera fase falló (base): la fila sigue; el barrido repite el borrado entero (varios llamadores ignoran el error).
    await db
      .query(`INSERT INTO pending_file_deletions (file_id, error) VALUES ($1, $2) ON CONFLICT (file_id) DO UPDATE SET error = EXCLUDED.error`, [fileId, errText(e)])
      .catch(() => {});
    throw e;
  }
  if (key === null) return false;
  await deleteBlobAndMark(db, blobs, fileId, key);
  return true;
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000);

/** Segunda fase: borra el archivo del almacenamiento y la anotación; si falla, la anotación queda con el error. */
async function deleteBlobAndMark(db: Db, blobs: BlobStore, fileId: string, key: string) {
  try {
    await blobs.delete(key);
  } catch (e) {
    await db.query(`UPDATE pending_file_deletions SET error = $2 WHERE file_id = $1`, [fileId, errText(e)]).catch(() => {});
    throw e;
  }
  await db.query(`DELETE FROM pending_file_deletions WHERE file_id = $1`, [fileId]);
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
 * espera una hora). Con la clave anotada (la fila de `files` ya se borró), solo el archivo del almacenamiento. Sin clave
 * (primera fase fallida o anotación anterior al borrado en dos fases), el borrado entero: la anotación se descarta si
 * la fila ya no existe o la volvió a usar algo. Una anotación recién hecha (menos de 5 minutos) se deja: su llamador
 * está borrando el archivo en este momento.
 */
export async function retryPendingFileDeletions(db: Db, blobs: BlobStore, limit = 100) {
  const rows = await db.query<{ file_id: string; storage_key: string | null }>(
    `SELECT file_id, storage_key FROM pending_file_deletions
      WHERE (attempted_at IS NULL AND queued_at < now() - interval '5 minutes') OR attempted_at < now() - interval '1 hour'
      ORDER BY attempted_at NULLS FIRST, queued_at LIMIT $1`,
    [limit],
  );
  let deleted = 0;
  for (const r of rows) {
    try {
      if (r.storage_key) {
        await deleteBlobAndMark(db, blobs, r.file_id, r.storage_key);
        deleted++;
        continue;
      }
      if (await deleteFileIfUnused(db, blobs, r.file_id)) deleted++;
      else await db.query(`DELETE FROM pending_file_deletions WHERE file_id = $1 AND storage_key IS NULL`, [r.file_id]);
    } catch (err) {
      await db.query(`UPDATE pending_file_deletions SET attempted_at = now(), error = $2 WHERE file_id = $1`, [r.file_id, errText(err)]).catch(() => {});
    }
  }
  return { deleted, seen: rows.length };
}
