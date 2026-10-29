#!/usr/bin/env node
// Trinquete de calidad: cuenta por archivo los patrones que docs/estandares/ pide no agregar y falla si algún archivo
// SUBE respecto del baseline (scripts/calidad-baseline.json). No exige llegar a cero: el código existente creció sin
// estas reglas y reescribirlo en masa en un working tree compartido es peor (docs/estandares/decisiones-de-diseno.md §9).
// Cuando un arreglo BAJA una cuenta, el baseline baja el mismo día (--baseline), o el trinquete queda flojo.
// Además verifica la estructura de apps/api/migrations: nombres, números repetidos y migraciones ya versionadas editadas.
//
//   node scripts/check-calidad.mjs              → compara el working tree contra el baseline (sale con 1 si algo subió)
//   node scripts/check-calidad.mjs --staged     → sólo los archivos en stage, con su contenido en stage (pre-commit)
//   node scripts/check-calidad.mjs --baseline   → regenera el baseline con el working tree actual
//   node scripts/check-calidad.mjs --json       → { metricas: { <metrica>: { <archivo>: n } } }
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts/calidad-baseline.json");
const args = new Set(process.argv.slice(2));

/** Código fuente que se mide: lo de producción, no los tests (como unwrap en Rust: en un test es libre). */
const isSource = (f) =>
  /\.(ts|tsx|mts|mjs)$/.test(f) &&
  /^(apps\/(api|web)\/src|packages\/[^/]+\/src|integrations\/(lib|connectors|mcpb|office|site|skill|chatgpt|gemini-cli|gemini-api|claude-code))\//.test(f) &&
  !/(^|\/)(test|tests|__tests__)\//.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(f) &&
  !/\.d\.ts$/.test(f);

/** Quita comentarios y literales de cadena (sin interpolaciones) para no contar "any" dentro de un texto. */
function stripCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

/**
 * Cada métrica: qué se cuenta y por qué (el porqué largo está en el doc que se cita).
 * `code` recibe el fuente sin comentarios ni cadenas; `raw`, el fuente tal cual.
 */
const METRICS = {
  // docs/estandares/codigo-backend.md §3 y codigo-frontend.md §1.2: el contrato vive en @calasign/shared (Zod).
  any: {
    desc: "tipos `any` (`: any`, `as any`, `<any>`, `any[]`)",
    count: ({ code }) => (code.match(/:\s*any\b(?!\w)|\bas\s+any\b|<any\s*[,>]|,\s*any\s*>|\bany\[\]/g) ?? []).length,
  },
  // codigo-backend.md §2.3: un error tragado sin explicar es la ausencia de resultado leída como éxito.
  "catch-vacio": {
    desc: "catch vacío sin comentario (`catch {}`, `.catch(() => {})`)",
    count: ({ raw }) =>
      raw.split("\n").filter((l) => !l.includes("//") && /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/.test(l)).length,
  },
  // codigo-backend.md §5: la API loguea con pino (req.log / app.log), que redacta secretos (lib/redact.ts).
  "console-api": {
    desc: "console.log/info/debug en apps/api/src (usar req.log / app.log)",
    applies: (f) => f.startsWith("apps/api/src/"),
    count: ({ code }) => (code.match(/\bconsole\.(log|info|debug)\s*\(/g) ?? []).length,
  },
  // codigo-backend.md §10: un pendiente sin fecha se pierde. El formato de la casa es TODO(2026-11-10): …
  "todo-sin-fecha": {
    desc: "TODO/FIXME sin fecha (`TODO(AAAA-MM-DD): …`)",
    // Con los dos puntos: "TODO el archivo" o "MÉTODO" son castellano, no pendientes.
    count: ({ raw }) => (raw.match(/(?<![\p{L}\d_])(TODO|FIXME)(\((?!\d{4}-\d{2}-\d{2}\))[^)]*\))?:/gu) ?? []).length,
  },
  // codigo-backend.md §3: silenciar al compilador es saltar la única red que tiene el contrato.
  "ts-ignore": {
    desc: "@ts-ignore / @ts-nocheck (usar @ts-expect-error con motivo)",
    count: ({ raw }) => (raw.match(/@ts-(ignore|nocheck)\b/g) ?? []).length,
  },
};

/** Tamaño: un archivo NUEVO de más de este número de líneas avisa (no falla). Ver codigo-backend.md §8. */
const NEW_FILE_WARN_LINES = 1000;

function git(argv) {
  return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(staged) {
  const out = staged
    ? git(["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["-c", "core.quotePath=false", "ls-files", "-c", "-o", "--exclude-standard"]);
  return out.split("\n").filter(Boolean).filter(isSource);
}

function readSource(f, staged) {
  try {
    return staged ? git(["show", `:${f}`]) : readFileSync(join(ROOT, f), "utf8");
  } catch {
    return null; // borrado en el working tree pero todavía versionado: no cuenta
  }
}

function measure(files, staged) {
  const metricas = Object.fromEntries(Object.keys(METRICS).map((k) => [k, {}]));
  const lines = {};
  for (const f of files) {
    const raw = readSource(f, staged);
    if (raw == null) continue;
    const code = stripCode(raw);
    lines[f] = raw.split("\n").length;
    for (const [k, m] of Object.entries(METRICS)) {
      if (m.applies && !m.applies(f)) continue;
      const n = m.count({ raw, code });
      if (n > 0) metricas[k][f] = n;
    }
  }
  return { metricas, lines };
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const staged = args.has("--staged");
const files = listFiles(staged);
const { metricas, lines } = measure(files, staged);

if (args.has("--json")) {
  console.log(JSON.stringify({ metricas }, null, 2));
  process.exit(0);
}

if (args.has("--baseline")) {
  const data = {
    _nota: "Generado por scripts/check-calidad.mjs --baseline. No editar a mano: bajar una cuenta es arreglar el código y regenerar.",
    archivos: Object.keys(lines).sort(),
    metricas: Object.fromEntries(Object.entries(metricas).map(([k, v]) => [k, sortObj(v)])),
  };
  writeFileSync(BASELINE, JSON.stringify(data, null, 1) + "\n");
  for (const [k, v] of Object.entries(metricas)) console.log(`  ${k.padEnd(15)} ${String(sum(v)).padStart(5)}  ${METRICS[k].desc}`);
  console.log(`baseline regenerado: ${files.length} archivos → scripts/calidad-baseline.json`);
  process.exit(0);
}

let base;
try {
  base = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error("No hay scripts/calidad-baseline.json: generalo con node scripts/check-calidad.mjs --baseline");
  process.exit(2);
}
const known = new Set(base.archivos ?? []);

const fails = [];
const drops = [];
for (const [k, now] of Object.entries(metricas)) {
  const before = base.metricas?.[k] ?? {};
  for (const [f, n] of Object.entries(now)) {
    const b = before[f] ?? 0;
    if (n > b) fails.push({ k, f, b, n, nuevo: !known.has(f) });
  }
  // Las bajas sólo se pueden afirmar mirando todo el árbol (con --staged se ve una parte).
  if (!staged) {
    for (const [f, b] of Object.entries(before)) {
      const n = now[f] ?? 0;
      if (n < b) drops.push({ k, f, b, n });
    }
  }
}

const warns = Object.entries(lines)
  .filter(([f, n]) => !known.has(f) && n > NEW_FILE_WARN_LINES)
  .map(([f, n]) => `  ⚠ ${f}: archivo nuevo de ${n} líneas (objetivo ≤ 400-600; docs/estandares/codigo-backend.md §8)`);
if (warns.length) console.log(warns.join("\n"));

// ── Migraciones (docs/estandares/codigo-sql-y-migraciones.md §4) ──
// El runner las aplica por nombre en orden alfabético y las registra por nombre en schema_migrations. Dos ramas en
// paralelo que toman el mismo número dejan el orden librado al resto del nombre (pasó con la 0052), y editar una ya
// aplicada no la vuelve a correr en ningún entorno donde ya corrió: dev queda distinto de una base nueva.
const MIGRATIONS_DIR = "apps/api/migrations/";
/** Números repetidos que ya se aplicaron en dev: renombrarlos haría que se vuelvan a aplicar. */
const DUP_NUMBERS_ALLOWED = new Set(["0052"]);
const migFails = [];
const migs = git(["-c", "core.quotePath=false", "ls-files", "-c", "-o", "--exclude-standard", "--", MIGRATIONS_DIR])
  .split("\n")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.slice(MIGRATIONS_DIR.length));
const byNumber = new Map();
for (const m of migs) {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(m)) migFails.push(`${m}: el nombre tiene que ser NNNN_descripcion_en_minusculas.sql`);
  const n = m.slice(0, 4);
  byNumber.set(n, [...(byNumber.get(n) ?? []), m]);
}
for (const [n, fs] of byNumber) {
  if (fs.length > 1 && !DUP_NUMBERS_ALLOWED.has(n)) migFails.push(`número ${n} repetido: ${fs.join(", ")} (tomá el siguiente libre)`);
}
// Editar una migración que ya está en HEAD: con --staged falla (salvo que se declare que todavía no se aplicó en
// ningún entorno); sobre el working tree sólo avisa.
const editedMigs = git(["-c", "core.quotePath=false", "diff", ...(staged ? ["--cached"] : ["HEAD"]), "--name-only", "--diff-filter=M", "--", MIGRATIONS_DIR])
  .split("\n")
  .filter((f) => f.endsWith(".sql"));
if (editedMigs.length) {
  const msg = `migración ya versionada modificada: ${editedMigs.join(", ")} — si ya se aplicó en dev, el cambio va en una migración NUEVA`;
  if (staged && process.env.CALIDAD_MIGRACION_EDITABLE !== "1") {
    migFails.push(`${msg}. Si todavía no se deployó a ningún entorno: CALIDAD_MIGRACION_EDITABLE=1 git commit …`);
  } else console.log(`  ⚠ ${msg}`);
}
if (migFails.length) {
  console.log(`✗ migraciones: ${migFails.length} problema(s)`);
  for (const m of migFails) console.log(`  ✗ ${m}`);
  if (!fails.length) process.exit(1);
}

if (fails.length) {
  console.log(`✗ calidad: ${fails.length} cuenta(s) suben respecto del baseline`);
  for (const x of fails) {
    console.log(`  ✗ ${x.f}: ${x.k} ${x.b} → ${x.n}${x.nuevo ? "  (archivo nuevo o renombrado)" : ""}   — ${METRICS[x.k].desc}`);
  }
  console.log("  arreglalos; si es deliberado (o un renombre), regenerá el baseline en el mismo commit:");
  console.log("  node scripts/check-calidad.mjs --baseline   (y anotá el motivo en el mensaje del commit)");
  process.exit(1);
}

const totals = Object.entries(metricas)
  .map(([k, v]) => `${k} ${sum(v)}`)
  .join(" · ");
if (drops.length) {
  console.log(`✓ calidad: nada sube (${staged ? `${files.length} archivo(s) en stage` : totals})`);
  console.log(`  ↓ bajaron ${drops.length} cuenta(s): regenerá el baseline para que el trinquete no quede flojo:`);
  for (const x of drops.slice(0, 10)) console.log(`    ${x.f}: ${x.k} ${x.b} → ${x.n}`);
  if (drops.length > 10) console.log(`    … y ${drops.length - 10} más`);
  console.log("  node scripts/check-calidad.mjs --baseline");
} else {
  console.log(`✓ calidad: nada sube (${staged ? `${files.length} archivo(s) en stage` : totals})`);
}
