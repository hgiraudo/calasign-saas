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

// Zonas ya validadas contra Postgres (son unas 600: el conjunto queda acotado).
const knownZones = new Set<string>(["UTC"]);

/**
 * Zona horaria IANA pedida con ?tz= (p. ej. America/Argentina/Buenos_Aires), validada contra pg_timezone_names: la
 * misma lista que usa AT TIME ZONE, así nunca llega a la consulta un nombre que Postgres rechace (sería un 500).
 * Sin valor: null (quien llama decide el valor por defecto, en general UTC).
 */
export async function resolveTimeZone(db: Db, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const tz = String(raw);
  if (tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) throw badRequest("invalid_timezone", "tz: zona horaria inválida");
  if (knownZones.has(tz)) return tz;
  const ok = await db.one(`SELECT 1 AS ok FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!ok) throw badRequest("invalid_timezone", "tz: zona horaria desconocida (usar un nombre IANA, p. ej. America/Argentina/Buenos_Aires)");
  knownZones.add(tz);
  return tz;
}

/** Fecha y hora local en `tz` (AAAA-MM-DD HH:MM:SS), para las columnas *_local: Excel la reconoce como fecha. */
export const localTsSql = (col: string, tzParam: string) => `to_char(${col} AT TIME ZONE ${tzParam}, 'YYYY-MM-DD HH24:MI:SS')`;

/** Cuerpo final: BOM (Excel detecta UTF-8) y fin de línea CRLF. */
export const csvBody = (lines: string[]) => "﻿" + lines.join("\r\n") + "\r\n";
