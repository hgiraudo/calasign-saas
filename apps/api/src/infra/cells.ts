// Celdas de residencia de datos. Cada organización vive en una celda (tenants.cell / tenant_directory),
// que fija dónde se guardan sus archivos (bucket/región o directorio) y qué despliegue la atiende.
//
// CELLS (JSON) configura las celdas de este despliegue, por ejemplo:
//   {"us": {"label": "Estados Unidos", "region": "us-east-1", "storage": {"driver": "s3", "bucket": "…"}, "default": true},
//    "br": {"label": "Brasil", "region": "sa-east-1", "storage": {"driver": "s3", "bucket": "…", "region": "sa-east-1"},
//           "baseUrl": "https://br.calasign.com"}}
// Sin CELLS hay una sola celda (DEFAULT_CELL, "us") con el almacenamiento de siempre (S3_BUCKET o disco).
// SERVED_CELLS (lista) limita las celdas que atiende este proceso; el resto se responde con 421 y la URL
// de la celda correcta (ver modules/data/cells.ts).
import { resolve } from "node:path";
import { config } from "../config";

export interface CellStorageConfig {
  driver: "local" | "s3";
  bucket?: string;
  prefix?: string;
  region?: string;
  /** Solo driver local: directorio de los archivos. */
  dir?: string;
}

export interface CellConfig {
  id: string;
  label: string;
  region: string | null;
  storage: CellStorageConfig;
  /** URL pública del despliegue que atiende la celda (para redirigir pedidos de otra celda). */
  baseUrl: string | null;
  default: boolean;
}

/** Celdas que se ofrecen aunque no estén configuradas (se muestran como «Próximamente»). */
export const CELL_CATALOG: { id: string; label: string; region: string }[] = [
  { id: "us", label: "Estados Unidos", region: "us-east-1" },
  { id: "br", label: "Brasil", region: "sa-east-1" },
];

const ID_RE = /^[a-z0-9-]{1,40}$/;

export function parseCells(json: string | undefined | null, defaults = { storage: config.storage, dataDir: config.dataDir, defaultId: process.env.DEFAULT_CELL ?? "us" }): CellConfig[] {
  const legacyStorage: CellStorageConfig = {
    driver: defaults.storage.driver,
    bucket: defaults.storage.bucket || undefined,
    prefix: defaults.storage.prefix || undefined,
    region: defaults.storage.region,
    dir: resolve(defaults.dataDir, "blobs"),
  };
  if (!json || !json.trim()) {
    const cat = CELL_CATALOG.find((c) => c.id === defaults.defaultId);
    return [{ id: defaults.defaultId, label: cat?.label ?? defaults.defaultId, region: defaults.storage.driver === "s3" ? defaults.storage.region : cat?.region ?? null, storage: legacyStorage, baseUrl: null, default: true }];
  }
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("CELLS no es JSON válido");
  }
  const entries: [string, any][] = Array.isArray(raw) ? raw.map((c: any) => [c.id, c]) : Object.entries(raw);
  const out: CellConfig[] = [];
  for (const [id, c] of entries) {
    if (!ID_RE.test(id ?? "")) throw new Error(`CELLS: id de celda inválido "${id}"`);
    const st = c.storage ?? {};
    const driver = st.driver === "s3" ? "s3" : "local";
    if (driver === "s3" && !st.bucket) throw new Error(`CELLS: la celda ${id} usa S3 sin bucket`);
    out.push({
      id,
      label: String(c.label ?? CELL_CATALOG.find((x) => x.id === id)?.label ?? id),
      region: c.region ?? st.region ?? null,
      storage: {
        driver,
        bucket: st.bucket,
        prefix: st.prefix,
        region: st.region ?? c.region ?? defaults.storage.region,
        dir: driver === "local" && st.dir ? resolve(st.dir) : undefined,
      },
      baseUrl: c.baseUrl ? String(c.baseUrl).replace(/\/$/, "") : null,
      default: Boolean(c.default),
    });
  }
  if (!out.length) throw new Error("CELLS sin celdas");
  if (!out.some((c) => c.default)) out[0].default = true;
  if (out.filter((c) => c.default).length > 1) throw new Error("CELLS: más de una celda por defecto");
  // En disco, la celda por defecto sigue en var/blobs (donde ya están los archivos); las demás en var/blobs-<id>.
  for (const c of out) if (c.storage.driver === "local" && !c.storage.dir) c.storage.dir = resolve(defaults.dataDir, c.default ? "blobs" : `blobs-${c.id}`);
  return out;
}

let cellsCache: CellConfig[] | null = null;
export function cells(): CellConfig[] {
  cellsCache ??= parseCells(process.env.CELLS);
  return cellsCache;
}
/** Tests: recarga la configuración de celdas. */
export function resetCells() {
  cellsCache = null;
}

export const defaultCell = () => cells().find((c) => c.default)!;

/** Celda configurada para un id; ids viejos o desconocidos (p. ej. "local", "dev") caen en la por defecto. */
export function cellById(id: string | null | undefined): CellConfig {
  return cells().find((c) => c.id === id) ?? defaultCell();
}

export function isConfiguredCell(id: string): boolean {
  return cells().some((c) => c.id === id);
}

/** Celdas que atiende este proceso (SERVED_CELLS; por defecto, todas las configuradas). */
export function servedCells(): Set<string> {
  const list = (process.env.SERVED_CELLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(list.length ? list : cells().map((c) => c.id));
}

/** true si este proceso atiende todas las celdas (el caso de un solo despliegue: el enrutamiento no hace nada). */
export function servesAllCells(): boolean {
  const served = servedCells();
  return cells().every((c) => served.has(c.id));
}
