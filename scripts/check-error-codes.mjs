#!/usr/bin/env node
// Códigos de error de la API sin texto en pt-BR/en en la consola (apps/web/src/lib/api.ts: CODE_TEXT, detailText y
// los casos especiales de httpErrorText; y MORE_CODE_TEXT en apps/web/src/lib/api-error-text.ts). En español se muestra el mensaje de la API; en los otros idiomas, sin
// traducción, la persona veía el texto en español.
//
//   node scripts/check-error-codes.mjs          → lista los faltantes (sale con 1 si hay alguno no permitido)
//   node scripts/check-error-codes.mjs --json   → { apiCodes, translated, dynamic, missing, allowlisted, incomplete }
//
// Lo usa apps/api/test/error-codes-i18n.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(ROOT, "apps/api/src");
const WEB_API = join(ROOT, "apps/web/src/lib/api.ts");
const WEB_MORE = join(ROOT, "apps/web/src/lib/api-error-text.ts");

/**
 * Códigos que la consola y el firmante no muestran nunca (errores internos de protocolos máquina a máquina) o que
 * tienen texto propio en otro lado. Agregar acá con el motivo.
 */
export const ALLOWLIST = new Map([
  ["internal_error", "500 genérico (error inesperado): no hay un texto mejor que el de la API"],
  // Webhooks entrantes (Mercado Pago, Stripe, verificación de identidad): los recibe un proveedor, no una persona.
  ["invalid_notification", "webhook de pagos"],
  ["not_configured", "webhook de pagos sin secreto configurado"],
  ["event_in_progress", "webhook de pagos"],
  ["invalid_signature", "firma de un webhook entrante"],
  ["invalid_payload", "webhook de verificación de identidad"],
  // Protocolos máquina a máquina.
  ["invalid_target", "MCP: recurso (resource indicator) desconocido"],
  ["range_not_satisfiable", "pedidos Range de pdf.js (el visor reintenta sin rango)"],
  ["too_many_streams", "streams de eventos de la API pública"],
  ["invalid_idempotency_key", "encabezado Idempotency-Key de la API pública"],
  ["unauthorized_client", "endpoint de tokens OAuth"],
  // Procesos internos (barridos y reintentos): no llegan a una pantalla.
  ["archive_changed", "barrido de renovación del sello de archivo"],
  ["bulk_unavailable", "reintento interno del envío masivo"],
]);

/** Códigos armados en tiempo de ejecución (`invitation_${status}`…): sus valores posibles. */
export const DYNAMIC_CODES = new Map([
  ["invitation_${status}", ["invitation_accepted", "invitation_revoked", "invitation_expired"]],
  ["form_${reason}", ["form_inactive", "form_expired", "form_exhausted"]],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Códigos que la API puede responder, con el primer archivo donde aparecen. */
export function collectApiCodes() {
  const codes = new Map();
  const dynamic = [];
  const add = (code, file) => {
    if (!codes.has(code)) codes.set(code, relative(ROOT, file));
  };
  const patterns = [
    /\b(?:badRequest|conflict)\(\s*"([a-z0-9_]+)"/g,
    /\bnew AppError\(\s*[^,()]+,\s*"([a-z0-9_]+)"/g,
    /\berror:\s*\{\s*code:\s*"([a-z0-9_]+)"/g,
  ];
  for (const file of walk(API_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const re of patterns) for (const m of src.matchAll(re)) add(m[1], file);
    // Helpers con código fijo.
    if (/\bnotFound\(/.test(src)) add("not_found", file);
    if (/\bforbidden\(/.test(src)) add("forbidden", file);
    if (/\bunauthorized\(\)/.test(src)) add("unauthorized", file);
    // Códigos armados en tiempo de ejecución: se informan para revisar a mano.
    for (const m of src.matchAll(/\bnew AppError\(\s*[^,()]+,\s*`([^`]+)`/g)) {
      const known = DYNAMIC_CODES.get(m[1]);
      if (known) for (const c of known) add(c, file);
      else dynamic.push(`${relative(ROOT, file)}: ${m[1]}`);
    }
  }
  // Errores de PDF (packages/pdf) que la API devuelve con su propio código (badRequest(e.code, …)).
  const pdfErrors = join(ROOT, "packages/pdf/src");
  try {
    for (const file of walk(pdfErrors)) {
      for (const m of readFileSync(file, "utf8").matchAll(/new InvalidPdfError\(\s*"([a-z0-9_]+)"/g)) add(m[1], file);
    }
  } catch {
    // Sin el paquete (checkout parcial): solo la API.
  }
  return { codes, dynamic };
}

/**
 * Fuente del objeto literal asignado a `const NAME` (con o sin export y con cualquier anotación de tipo), desde la "{"
 * hasta su "}" de cierre. Se saltean strings y comentarios al contar llaves (un texto con "}" no corta el bloque).
 */
function objectLiteral(src, name, file) {
  const decl = new RegExp(`\\b(?:export\\s+)?const ${name}\\b`).exec(src);
  if (!decl) throw new Error(`${name} no encontrado en ${file}`);
  const eq = src.indexOf("=", decl.index);
  const open = src.indexOf("{", eq);
  if (eq < 0 || open < 0) throw new Error(`${name} en ${file} no es un objeto literal`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`${name} en ${file}: no se encontró el cierre del objeto`);
}

/** Entradas de primer nivel (clave → fuente del valor) de la fuente de un objeto literal (sin las llaves externas). */
function topLevelEntries(body) {
  const keys = [...body.matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z0-9_]+)):/gm)];
  return keys.map((m, i) => [m[1] ?? m[2], body.slice(m.index + m[0].length, i + 1 < keys.length ? keys[i + 1].index : body.length)]);
}

/** Códigos con texto en pt-BR/en en la consola; `incomplete`: entradas sin alguno de los idiomas que exige su diccionario. */
export function collectTranslations() {
  const src = readFileSync(WEB_API, "utf8");
  const more = readFileSync(WEB_MORE, "utf8");
  const out = new Set();
  const incomplete = [];
  const dicts = [
    { name: "CODE_TEXT", src, file: WEB_API, locales: ["pt-BR", "en"] },
    { name: "PROBLEMS_HEADER", src, file: WEB_API, locales: ["es", "pt-BR", "en"] },
    // Textos agregados aparte (lib/api-error-text.ts): solo el objeto MORE_CODE_TEXT, no el resto del archivo.
    { name: "MORE_CODE_TEXT", src: more, file: WEB_MORE, locales: ["pt-BR", "en"] },
  ];
  for (const d of dicts) {
    for (const [code, value] of topLevelEntries(objectLiteral(d.src, d.name, d.file))) {
      const lacking = d.locales.filter((l) => !new RegExp(`(?:^|[\\s{,])(?:"${l}"|${l.includes("-") ? "(?!)" : l})\\s*:`).test(value));
      if (lacking.length) incomplete.push({ code, dict: d.name, lacking });
      else out.add(code);
    }
  }
  // Casos especiales de detailText / httpErrorText (code === "x" / e.code === "x").
  const fnStart = src.indexOf("function detailText(");
  if (fnStart < 0) throw new Error(`detailText no encontrado en ${WEB_API}`);
  for (const m of src.slice(fnStart).matchAll(/\bcode === "([a-z0-9_]+)"/g)) out.add(m[1]);
  return { translated: out, incomplete };
}

/** Códigos con texto en pt-BR/en en la consola. */
export function collectTranslatedCodes() {
  return collectTranslations().translated;
}

export function check() {
  const { codes, dynamic } = collectApiCodes();
  const { translated, incomplete } = collectTranslations();
  const missing = [];
  const allowlisted = [];
  for (const [code, file] of [...codes].sort(([a], [b]) => a.localeCompare(b))) {
    if (translated.has(code)) continue;
    if (ALLOWLIST.has(code)) allowlisted.push(code);
    else missing.push({ code, file });
  }
  return { apiCodes: codes.size, translated: translated.size, dynamic, missing, allowlisted, incomplete };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = check();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    console.log(`Códigos en la API: ${r.apiCodes} · con traducción: ${r.translated} · permitidos sin texto: ${r.allowlisted.length}`);
    if (r.dynamic.length) console.log(`Códigos dinámicos (revisar a mano):\n  ${r.dynamic.join("\n  ")}`);
    if (r.missing.length) {
      console.log(`Sin texto en pt-BR/en (${r.missing.length}):`);
      for (const m of r.missing) console.log(`  ${m.code}  (${m.file})`);
    } else console.log("Todos los códigos tienen texto.");
    if (r.incomplete.length) {
      console.log(`Entradas sin todos sus idiomas (${r.incomplete.length}):`);
      for (const i of r.incomplete) console.log(`  ${i.code} en ${i.dict}: falta ${i.lacking.join(", ")}`);
    }
  }
  process.exitCode = r.missing.length || r.incomplete.length ? 1 : 0;
}
