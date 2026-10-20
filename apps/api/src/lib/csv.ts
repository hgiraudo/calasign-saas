// Formato de las exportaciones CSV de la consola (sobres, acuerdos, auditoría): separador, zona horaria y cuerpo.
import type { Db } from "../infra/db";
import { badRequest } from "./errors";

export type CsvSep = "," | ";";

/**
 * Separador pedido con ?sep= ("," por defecto). Excel en español o portugués espera ";" (la coma es el separador
 * decimal): con "," abría todo en una sola columna. Se acepta también "semicolon"/"comma" (más cómodos en una URL).
 */
export function csvSep(raw: unknown): CsvSep {
  if (raw === undefined || raw === null || raw === "" || raw === "," || raw === "comma") return ",";
  if (raw === ";" || raw === "semicolon") return ";";
  throw badRequest("invalid_query", "sep: se acepta ',' o ';'");
}

// Zonas ya resueltas contra Postgres, por nombre en minúsculas → nombre canónico (son unas 600: el conjunto queda
// acotado). Las desconocidas también se recuerdan (con tope) para no recorrer pg_timezone_names en cada pedido.
const knownZones = new Map<string, string>([["utc", "UTC"]]);
const unknownZones = new Set<string>();
const UNKNOWN_ZONES_MAX = 1000;

/**
 * Zona horaria IANA pedida con ?tz= (p. ej. America/Argentina/Buenos_Aires), resuelta contra pg_timezone_names (la
 * misma lista que usa AT TIME ZONE, así nunca llega a la consulta un nombre que Postgres rechace) sin distinguir
 * mayúsculas ("america/sao_paulo" → "America/Sao_Paulo"): devuelve el nombre canónico. Una zona que Postgres no conoce
 * (un navegador con tzdata más nueva que la del servidor, un nombre mal escrito) cae a UTC en lugar de un 400: la zona
 * solo cambia cómo se agrupan o muestran las fechas, y quien llama informa la zona usada.
 * Sin valor: null (quien llama decide el valor por defecto, en general UTC).
 */
export async function resolveTimeZone(db: Db, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const tz = String(raw);
  if (tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return "UTC";
  const key = tz.toLowerCase();
  const known = knownZones.get(key);
  if (known) return known;
  if (unknownZones.has(key)) return "UTC";
  // Si hay varias con el mismo nombre salvo mayúsculas (no pasa en tzdata), la que coincide exacto.
  const row = await db.one<{ name: string }>(
    `SELECT name FROM pg_timezone_names WHERE lower(name) = lower($1) ORDER BY (name = $1) DESC, name LIMIT 1`,
    [tz],
  );
  if (!row) {
    if (unknownZones.size < UNKNOWN_ZONES_MAX) unknownZones.add(key);
    return "UTC";
  }
  knownZones.set(key, row.name);
  return row.name;
}

/** Fecha y hora local en `tz` (AAAA-MM-DD HH:MM:SS), para las columnas *_local: Excel la reconoce como fecha. */
export const localTsSql = (col: string, tzParam: string) => `to_char(${col} AT TIME ZONE ${tzParam}, 'YYYY-MM-DD HH24:MI:SS')`;

/** Cuerpo final: BOM (Excel detecta UTF-8) y fin de línea CRLF. */
export const csvBody = (lines: string[]) => "﻿" + lines.join("\r\n") + "\r\n";
