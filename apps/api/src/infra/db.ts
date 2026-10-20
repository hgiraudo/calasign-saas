import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config";

/** Acceso mínimo a SQL, igual sobre node-postgres (producción) o PGlite (desarrollo). */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Transacción. Anidada: reutiliza la transacción en curso. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Motor: "pg" (node-postgres, producción) o "pglite" (desarrollo). Sin valor (dobles de test): se trata como PGlite. */
  dialect?: "pg" | "pglite";
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

function wrap(q: Queryable, txImpl: Db["tx"], close: () => Promise<void>): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await q.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params) {
      const rows = await db.query(sql, params);
      return (rows[0] as any) ?? null;
    },
    tx: txImpl,
    close,
  };
  return db;
}

// bigint → number (los ids de jobs y eventos entran holgados en 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

const envMs = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : def;
};

async function createPgDb(url: string): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Sin tope, una base caída o saturada dejaba cada petición esperando una conexión para siempre.
    connectionTimeoutMillis: envMs("DB_CONNECT_TIMEOUT_MS", 10_000),
    // Parámetros de sesión (0 = sin límite). Una consulta desbocada o una transacción olvidada abierta (bloqueos
    // tomados) ya no retienen la conexión indefinidamente. Las migraciones lo desactivan con SET LOCAL (ver migrate).
    statement_timeout: envMs("DB_STATEMENT_TIMEOUT_MS", 60_000),
    idle_in_transaction_session_timeout: envMs("DB_IDLE_IN_TX_TIMEOUT_MS", 300_000),
  });
  // Un cliente inactivo del pool que pierde la conexión (reinicio de Postgres, failover, idle_in_transaction) emite
  // 'error' en el pool: sin listener, Node lo trata como excepción no capturada y tumba el proceso.
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "error en una conexión inactiva del pool de Postgres", err: String(err) })));
  const close = () => pool.end();
  const root: Db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = wrap(client, (f) => f(inner), async () => {});
        const res = await fn(inner);
        await client.query("COMMIT");
        return res;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close,
  );
  root.dialect = "pg";
  return root;
}

async function createPgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  const close = () => lite.close();
  const root: Db = wrap(
    lite as unknown as Queryable,
    (fn) =>
      lite.transaction(async (t) => {
        const inner: Db = wrap(t as unknown as Queryable, (f) => f(inner), async () => {});
        return fn(inner);
      }) as Promise<any>,
    close,
  );
  root.dialect = "pglite";
  return root;
}

export async function createDb(): Promise<Db> {
  if (config.databaseUrl) return createPgDb(config.databaseUrl);
  return createPgliteDb(resolve(config.dataDir, "pglite"));
}

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Clave del candado de migraciones (pg_advisory_xact_lock): dos procesos que arrancan a la vez no aplican la misma dos veces. */
const MIGRATION_LOCK_KEY = 0x63616c61; // "cala"

/**
 * Aplica las migraciones pendientes de migrations/ en orden. Cada migración corre ENTERA en su propia transacción
 * (junto con su registro en schema_migrations y el candado de migraciones): no puede usar sentencias que no corren en
 * una transacción, como CREATE INDEX CONCURRENTLY (un CREATE INDEX común bloquea las escrituras de la tabla mientras
 * dura). Sobre tablas grandes (jobs, evidencia, sobres…) la migración se limita al cambio de esquema (columnas
 * nulables, índices) y los backfills se hacen de a lotes desde el barrido periódico (modules/jobs.ts), no acá: un
 * UPDATE masivo dentro de la migración retiene bloqueos durante todo el arranque. Ver docs/MODELO-DE-DATOS.md.
 */
export async function migrate(db: Db, log: (m: string) => void = () => {}) {
  const isPg = db.dialect === "pg";
  // Candado por transacción (no de sesión: con el pool, el unlock podía ir por otra conexión). Cada paso lo toma y
  // relee lo aplicado adentro, así una API y un worker que arrancan juntos se serializan. Sin límite de tiempo por
  // sentencia: una migración que reescribe una tabla grande puede pasar legítimamente el statement_timeout del pool.
  const prelude = async (t: Db) => {
    if (!isPg) return;
    await t.query(`SET LOCAL statement_timeout = 0`);
    await t.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK_KEY]);
  };
  await db.tx(async (t) => {
    await prelude(t);
    await t.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  const applied = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(resolve(migrationsDir, f), "utf8");
    const done = await db.tx(async (t) => {
      await prelude(t);
      // Otro proceso pudo aplicarla mientras se esperaba el candado.
      if (isPg && (await t.one(`SELECT 1 FROM schema_migrations WHERE name = $1`, [f]))) return false;
      // Una sentencia por llamada: PGlite y pg con parámetros no aceptan múltiples.
      for (const stmt of splitSql(sql)) await t.query(stmt);
      await t.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
      return true;
    });
    if (done) log(`migración aplicada: ${f}`);
  }
}

function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*(\n|$)/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
