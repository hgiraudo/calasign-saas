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
  /**
   * Una conexión fija SIN transacción (pg: un cliente del pool, devuelto al terminar). Para sentencias que no corren
   * en una transacción (CREATE INDEX CONCURRENTLY) y candados de sesión. Sin valor (PGlite, dobles): la misma base.
   */
  session?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
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
  root.session = async (fn) => {
    const client = await pool.connect();
    let broken = false;
    try {
      const inner: Db = wrap(client, root.tx, async () => {});
      return await fn(inner);
    } catch (e) {
      broken = true;
      throw e;
    } finally {
      // Con un error, la conexión se descarta (puede quedar con estado de sesión a medio deshacer).
      client.release(broken ? true : undefined);
    }
  };
  root.dialect = "pg";
  return root;
}

async function createPgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // pg_trgm: el índice trigram de la búsqueda de acuerdos por título (migración 0088), como en Postgres.
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const lite = await PGlite.create(dir, { extensions: { pg_trgm } });
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

/** Marca (primera línea con contenido de la migración) para correrla fuera de una transacción. */
const NO_TX_MARKER = /^\s*--\s*no-transaction\b/i;

/** ¿La migración pide correr fuera de una transacción (`-- no-transaction` como primera línea)? */
export function isNoTransactionMigration(sql: string): boolean {
  return NO_TX_MARKER.test(sql);
}

/** Nombre del índice de un `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <nombre>` (para revisar si quedó inválido). */
export function concurrentIndexName(stmt: string): string | null {
  const m = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("?[\w.]+"?)/i.exec(stmt);
  return m ? m[1] : null;
}

/** Sin CONCURRENTLY (PGlite: una sola conexión, no hay escrituras que esperar; y la sentencia corre en una transacción). */
export function stripConcurrently(stmt: string): string {
  return stmt.replace(/^(\s*(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+)CONCURRENTLY\s+/i, "$1");
}

/**
 * Aplica las migraciones pendientes de migrations/ en orden. Cada migración corre ENTERA en su propia transacción
 * (junto con su registro en schema_migrations y el candado de migraciones), salvo las marcadas con `-- no-transaction`
 * en la primera línea: esas corren sentencia por sentencia en una conexión fija, con el candado de migraciones de
 * sesión, y son para CREATE INDEX CONCURRENTLY sobre tablas grandes (un CREATE INDEX común bloquea las escrituras de la
 * tabla mientras dura, y dentro de una transacción con un ALTER TABLE retiene el ACCESS EXCLUSIVE hasta el commit).
 * Una migración sin transacción debe ser re-ejecutable (`IF NOT EXISTS`): si falla a mitad, lo hecho queda y se
 * reintenta entera en el próximo arranque. Un `CREATE INDEX CONCURRENTLY IF NOT EXISTS` que falló deja el índice
 * INVÁLIDO (y el IF NOT EXISTS lo saltearía): antes de crearlo se borra si está inválido. En PGlite (desarrollo y
 * tests) se quita CONCURRENTLY y corre en una transacción como las demás.
 * Sobre tablas grandes (jobs, evidencia, sobres…) la migración se limita al cambio de esquema (columnas nulables,
 * índices) y los backfills se hacen de a lotes desde el barrido periódico (modules/jobs.ts), no acá: un UPDATE masivo
 * dentro de la migración retiene bloqueos durante todo el arranque. Ver docs/MODELO-DE-DATOS.md.
 */
export async function migrate(db: Db, log: (m: string) => void = () => {}, opts: { dir?: string } = {}) {
  const isPg = db.dialect === "pg";
  const dir = opts.dir ?? migrationsDir;
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
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(resolve(dir, f), "utf8");
    const noTx = isPg && isNoTransactionMigration(sql);
    const done = noTx
      ? await migrateWithoutTx(db, f, sql)
      : await db.tx(async (t) => {
          await prelude(t);
          // Otro proceso pudo aplicarla mientras se esperaba el candado.
          if (isPg && (await t.one(`SELECT 1 FROM schema_migrations WHERE name = $1`, [f]))) return false;
          // Una sentencia por llamada: PGlite y pg con parámetros no aceptan múltiples.
          for (const stmt of splitSql(sql)) await t.query(isPg ? stmt : stripConcurrently(stmt));
          await t.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
          return true;
        });
    if (done) log(`migración aplicada: ${f}`);
  }
}

/** Migración `-- no-transaction` en Postgres: una conexión fija, candado de sesión y sin statement_timeout. */
async function migrateWithoutTx(db: Db, f: string, sql: string): Promise<boolean> {
  const run = db.session ?? ((fn: (d: Db) => Promise<boolean>) => fn(db));
  return run(async (c) => {
    await c.query(`SET statement_timeout = 0`);
    await c.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    try {
      if (await c.one(`SELECT 1 FROM schema_migrations WHERE name = $1`, [f])) return false;
      for (const stmt of splitSql(sql)) {
        const idx = concurrentIndexName(stmt);
        if (idx) {
          // Un CONCURRENTLY anterior que falló (o se cortó) deja el índice inválido: no se usa para consultas pero se
          // mantiene en cada escritura, y el IF NOT EXISTS no lo rehace. Se borra y se vuelve a crear.
          const bad = await c.one(`SELECT 1 FROM pg_index WHERE indexrelid = to_regclass($1) AND NOT indisvalid`, [idx]);
          if (bad) await c.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`);
        }
        await c.query(stmt);
      }
      await c.query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [f]);
      return true;
    } finally {
      await c.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => {});
      await c.query(`RESET statement_timeout`).catch(() => {});
    }
  });
}

function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*(\n|$)/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
