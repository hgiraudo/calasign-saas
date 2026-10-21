#!/usr/bin/env node
// Códigos de error de la API sin texto en pt-BR/en en la consola (apps/web/src/lib/api.ts: CODE_TEXT, detailText y
// los casos especiales de httpErrorText; y MORE_CODE_TEXT en apps/web/src/lib/api-error-text.ts). En español se muestra el mensaje de la API; en los otros idiomas, sin
// traducción, la persona veía el texto en español.
//
//   node scripts/check-error-codes.mjs          → lista los faltantes (sale con 1 si hay alguno no permitido)
//   node scripts/check-error-codes.mjs --json   → { apiCodes, translated, dynamic, missing, allowlisted }
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

/** Códigos con texto en pt-BR/en en la consola. */
export function collectTranslatedCodes() {
  const src = readFileSync(WEB_API, "utf8");
  const out = new Set();
  const block = (name) => {
    const start = src.indexOf(`const ${name}:`);
    if (start < 0) throw new Error(`${name} no encontrado en ${WEB_API}`);
    const end = src.indexOf("\n};", start);
    return src.slice(start, end);
  };
  // Claves de primer nivel (dos espacios de sangría) de los diccionarios por código.
  for (const name of ["CODE_TEXT", "PROBLEMS_HEADER"]) {
    for (const m of block(name).matchAll(/^ {2}(?:"([^"]+)"|([a-z0-9_]+)):/gm)) out.add(m[1] ?? m[2]);
  }
  // Textos agregados aparte (lib/api-error-text.ts, MORE_CODE_TEXT).
  const more = readFileSync(WEB_MORE, "utf8");
  for (const m of more.matchAll(/^ {2}(?:"([^"]+)"|([a-z0-9_]+)):/gm)) out.add(m[1] ?? m[2]);
  // Casos especiales de detailText / httpErrorText (code === "x" / e.code === "x").
  const fnStart = src.indexOf("function detailText(");
  for (const m of src.slice(fnStart).matchAll(/\bcode === "([a-z0-9_]+)"/g)) out.add(m[1]);
  return out;
}

export function check() {
  const { codes, dynamic } = collectApiCodes();
  const translated = collectTranslatedCodes();
  const missing = [];
  const allowlisted = [];
  for (const [code, file] of [...codes].sort(([a], [b]) => a.localeCompare(b))) {
    if (translated.has(code)) continue;
    if (ALLOWLIST.has(code)) allowlisted.push(code);
    else missing.push({ code, file });
  }
  return { apiCodes: codes.size, translated: translated.size, dynamic, missing, allowlisted };
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
  }
  process.exitCode = r.missing.length ? 1 : 0;
}
