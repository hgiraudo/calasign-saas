// Carga y utilidades de la especificación OpenAPI (/v1/openapi.json) para la referencia, la barra lateral y la búsqueda.
import { useEffect, useState } from "react";

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  readOnly?: boolean;
  deprecated?: boolean;
};

export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
}

export interface MediaType {
  schema?: JsonSchema;
  example?: unknown;
  examples?: Record<string, { value?: unknown; summary?: string }>;
}

export interface ResponseObj {
  $ref?: string;
  description?: string;
  content?: Record<string, MediaType>;
  headers?: Record<string, { description?: string; schema?: JsonSchema }>;
}

export interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: (Parameter & { $ref?: string })[];
  requestBody?: { $ref?: string; required?: boolean; description?: string; content?: Record<string, MediaType> };
  responses?: Record<string, ResponseObj>;
  security?: Record<string, string[]>[];
  deprecated?: boolean;
}

export interface Spec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  webhooks?: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    responses?: Record<string, ResponseObj>;
    parameters?: Record<string, Parameter>;
    requestBodies?: Record<string, Operation["requestBody"]>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface OpEntry {
  method: string;
  path: string;
  op: Operation;
  tag: string;
  tagSlug: string;
  anchor: string;
}

export interface TagEntry {
  name: string;
  slug: string;
  description?: string;
  ops: OpEntry[];
}

const METHODS = ["get", "post", "put", "patch", "delete"];

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function opAnchor(method: string, path: string, op: Operation): string {
  return op.operationId ? `op-${slugify(op.operationId)}` : `op-${method}-${slugify(path)}`;
}

/** Resuelve un $ref local (#/components/...). */
export function resolveRef<T = unknown>(spec: Spec, ref: string): T | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    else return undefined;
  }
  return cur as T;
}

export function deref<T extends { $ref?: string }>(spec: Spec, x: T | undefined, depth = 0): T | undefined {
  if (!x || !x.$ref || depth > 10) return x;
  const r = resolveRef<T>(spec, x.$ref);
  return r ? deref(spec, { ...r, ...omitRef(x) } as T, depth + 1) : x;
}

function omitRef<T extends { $ref?: string }>(x: T): Partial<T> {
  const { $ref: _r, ...rest } = x;
  return rest as Partial<T>;
}

export function refName(ref?: string): string | null {
  return ref ? (ref.split("/").pop() ?? null) : null;
}

/** Agrupa las operaciones por tag, en el orden de `spec.tags` y después en el de aparición. */
export function groupByTag(spec: Spec): TagEntry[] {
  const order = new Map<string, TagEntry>();
  for (const t of spec.tags ?? []) order.set(t.name, { name: t.name, slug: slugify(t.name), description: t.description, ops: [] });
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? "API";
      if (!order.has(tag)) order.set(tag, { name: tag, slug: slugify(tag), ops: [] });
      const entry = order.get(tag)!;
      entry.ops.push({ method, path, op, tag, tagSlug: entry.slug, anchor: opAnchor(method, path, op) });
    }
  }
  return [...order.values()].filter((t) => t.ops.length > 0);
}

// ───────────────────────────── Carga (una sola vez por visita) ─────────────────────────────

let cache: Promise<Spec> | null = null;

export function loadSpec(): Promise<Spec> {
  cache ??= fetch("/v1/openapi.json", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? (r.json() as Promise<Spec>) : Promise.reject(new Error(String(r.status)))))
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

export function useSpec(enabled = true): { spec: Spec | null; error: boolean } {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled || spec) return;
    let alive = true;
    loadSpec()
      .then((s) => alive && setSpec(s))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [enabled, spec]);
  return { spec, error };
}

// ───────────────────────────── Ejemplos a partir del esquema ─────────────────────────────

const NAME_EXAMPLES: Record<string, unknown> = {
  email: "ana@example.com",
  name: "Ana Pérez",
  subject: "Contrato de servicios",
  message: "Hola Ana, te comparto el contrato para firmar.",
  phone: "+5491122334455",
  url: "https://api.tuempresa.com/webhooks/calasign",
  returnUrl: "https://app.tuempresa.com/firma-lista",
  description: "Producción",
  reason: "El cliente pidió cambios",
  locale: "es",
  domain: "firmas.tuempresa.com",
  primaryColor: "#0d9488",
  text: "[[firma]]",
  label: "Monto",
  role: "signer",
  password: "una-contraseña-larga",
  organization: "Inmobiliaria Caribe",
  currency: "BRL",
  amount: 150.5,
};

function primaryType(s: JsonSchema): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== "null");
  return s.type;
}

/** Valor de ejemplo plausible para un esquema (con profundidad limitada). */
export function exampleFor(spec: Spec, raw: JsonSchema | undefined, name = "", depth = 0): unknown {
  const s = deref(spec, raw);
  if (!s || depth > 6) return undefined;
  if (s.example !== undefined) return s.example;
  if (s.examples?.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined && s.default !== null && !(Array.isArray(s.default) && !s.default.length)) return s.default;
  if (s.enum?.length) return s.enum.find((v) => v !== null) ?? s.enum[0];
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length) return exampleFor(spec, alt.find((a) => primaryType(deref(spec, a) ?? {}) !== "null") ?? alt[0], name, depth);
  if (s.allOf?.length) {
    const merged: Record<string, unknown> = {};
    for (const part of s.allOf) Object.assign(merged, exampleFor(spec, part, name, depth) as object);
    return merged;
  }
  const type = primaryType(s) ?? (s.properties ? "object" : undefined);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = Object.entries(s.properties ?? {});
      const req = new Set(s.required ?? []);
      const few = props.length <= 6;
      for (const [k, v] of props) {
        if (!req.has(k) && !(depth === 0 && few) && !(depth === 0 && k in NAME_EXAMPLES)) continue;
        const ex = exampleFor(spec, v, k, depth + 1);
        if (ex !== undefined) out[k] = ex;
      }
      if (!props.length && s.additionalProperties) return { clave: "valor" };
      return out;
    }
    case "array": {
      const it = exampleFor(spec, s.items, name.replace(/s$/, ""), depth + 1);
      return it === undefined ? [] : [it];
    }
    case "string": {
      if (name in NAME_EXAMPLES && typeof NAME_EXAMPLES[name] === "string") return NAME_EXAMPLES[name];
      if (s.format === "uuid" || /Id$|^id$/.test(name)) return "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
      if (s.format === "date-time" || /At$/.test(name)) return "2026-10-18T14:30:00.000Z";
      if (s.format === "email") return "ana@example.com";
      if (s.format === "uri" || s.format === "url") return "https://example.com";
      if (s.format === "binary") return "<archivo>";
      return name ? `${name}` : "string";
    }
    case "integer":
      return typeof s.minimum === "number" ? Math.max(1, s.minimum) : 1;
    case "number":
      return name in NAME_EXAMPLES ? NAME_EXAMPLES[name] : typeof s.minimum === "number" ? s.minimum : 0.5;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return undefined;
  }
}

/** Etiqueta legible del tipo: string · uuid, array<object>, integer | null… */
export function typeLabel(spec: Spec, raw: JsonSchema | undefined): string {
  if (!raw) return "any";
  const named = refName(raw.$ref);
  const s = deref(spec, raw)!;
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length) {
    const parts = [...new Set(alt.map((a) => typeLabel(spec, a)))];
    return parts.join(" | ");
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ["object"] : [];
  const nullable = s.nullable || types.includes("null");
  const base = types.filter((t) => t !== "null");
  let label = base.length ? base.join(" | ") : named ?? "any";
  if (base[0] === "array") label = `array<${typeLabel(spec, s.items)}>`;
  else if (base[0] === "object" && named) label = named;
  else if (s.format && base[0] !== "object") label += ` · ${s.format}`;
  return nullable ? `${label} | null` : label;
}
