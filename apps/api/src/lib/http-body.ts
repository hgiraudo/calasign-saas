/** Respuesta de un servicio externo más grande que el tope. */
export class BodyTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`respuesta demasiado grande (más de ${max} bytes)`);
  }
}

/**
 * Lee el cuerpo de una respuesta de fetch cortando en `max` bytes: un servicio externo (o un archivo enorme subido allí)
 * no llena la memoria de la API antes de que se pueda rechazar.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(max);
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const ch of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += ch.length;
    if (size > max) {
      await res.body.cancel().catch(() => {});
      throw new BodyTooLargeError(max);
    }
    chunks.push(ch);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Tope para respuestas JSON o de texto de APIs externas. */
export const MAX_API_RESPONSE_BYTES = 5 * 1024 * 1024;

export async function readCappedText(res: Response, max = MAX_API_RESPONSE_BYTES): Promise<string> {
  return new TextDecoder().decode(await readCapped(res, max));
}

/** Como res.json().catch(() => ({})), con tope: un cuerpo inválido o demasiado grande da {}. */
export async function readCappedJson(res: Response, max = MAX_API_RESPONSE_BYTES): Promise<any> {
  try {
    return JSON.parse(await readCappedText(res, max));
  } catch {
    return {};
  }
}
