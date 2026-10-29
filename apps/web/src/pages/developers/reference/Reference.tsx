// Referencia de la API generada desde /v1/openapi.json (se carga aparte: es la parte más pesada del portal).
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../../../lib/i18n";
import { useDocsText, type DocsT } from "../../../lib/i18n-docs";
import { Spinner } from "../../../components/ui";
import { BASE } from "../constants";
import { apiTabs, type ApiCall } from "../samples";
import {
  deref,
  exampleFor,
  groupByTag,
  refName,
  typeLabel,
  useSpec,
  type JsonSchema,
  type OpEntry,
  type Parameter,
  type ResponseObj,
  type Spec,
  type TagEntry,
} from "../spec";
import { Badge, Code, CodeTabs, CopyButton, DataTable, DocPage, Inline, Md, Method } from "../ui";
import { tagLabel } from "./tags";

// ───────────────────────────── Esquemas ─────────────────────────────

function Constraints({ s }: { s: JsonSchema }) {
  const t = useDocsText();
  const parts: ReactNode[] = [];
  if (s.enum?.length)
    parts.push(
      <span key="e">
        {t("ref.oneOf")}{" "}
        {s.enum.map((v, i) => (
          <code key={i} className="ref-enum">
            {v === null ? "null" : String(v)}
          </code>
        ))}
      </span>,
    );
  if (s.default !== undefined)
    parts.push(
      <span key="d">
        {t("ref.default")} <code>{JSON.stringify(s.default)}</code>
      </span>,
    );
  const range = (lo?: number | boolean, hi?: number | boolean, unit = "") =>
    typeof lo === "number" && typeof hi === "number"
      ? `${lo}–${hi}${unit}`
      : typeof lo === "number"
        ? `≥ ${lo}${unit}`
        : typeof hi === "number"
          ? `≤ ${hi}${unit}`
          : null;
  // Cotas exclusivas se muestran con > / <, no como si fueran inclusivas. Dos formas: número (OpenAPI 3.1) o booleano
  // junto a minimum/maximum (estilo 3.0, el que emite zod-to-json-schema para .positive(): minimum 0 + exclusiveMinimum true).
  const exMin = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum : s.exclusiveMinimum === true ? s.minimum : undefined;
  const exMax = typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum : s.exclusiveMaximum === true ? s.maximum : undefined;
  const incMin = s.exclusiveMinimum === true ? undefined : s.minimum;
  const incMax = s.exclusiveMaximum === true ? undefined : s.maximum;
  const num = [
    incMin !== undefined || incMax !== undefined ? range(incMin, incMax) : null,
    exMin !== undefined ? `> ${exMin}` : null,
    exMax !== undefined ? `< ${exMax}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (num) parts.push(<span key="n">{num}</span>);
  const len = range(s.minLength, s.maxLength, ` ${t("ref.chars")}`);
  if (len) parts.push(<span key="l">{len}</span>);
  const items = range(s.minItems, s.maxItems, ` ${t("ref.items")}`);
  if (items) parts.push(<span key="i">{items}</span>);
  if (s.pattern && s.pattern.length < 60)
    parts.push(
      <span key="p">
        <code>{s.pattern}</code>
      </span>,
    );
  if (!parts.length) return null;
  return (
    <div className="ref-constraints">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </div>
  );
}

function objectProps(spec: Spec, s: JsonSchema): { props: [string, JsonSchema][]; required: Set<string> } {
  const props: [string, JsonSchema][] = [];
  const required = new Set<string>(s.required ?? []);
  const add = (x: JsonSchema | undefined) => {
    const d = deref(spec, x);
    if (!d) return;
    for (const [k, v] of Object.entries(d.properties ?? {})) if (!props.some(([n]) => n === k)) props.push([k, v]);
    for (const r of d.required ?? []) required.add(r);
    for (const part of d.allOf ?? []) add(part);
  };
  add(s);
  return { props, required };
}

/** Hijos navegables de un esquema: propiedades de un objeto, o del objeto que contiene un array. */
function childSchema(spec: Spec, raw: JsonSchema): JsonSchema | null {
  const s = deref(spec, raw);
  if (!s) return null;
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length) {
    const nonNull = alt.filter((a) => deref(spec, a)?.type !== "null");
    if (nonNull.length === 1) return childSchema(spec, nonNull[0]);
    return null;
  }
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (type === "array" && s.items) return childSchema(spec, s.items);
  if (s.properties || s.allOf) return s;
  return null;
}

function SchemaProps({ spec, schema, depth }: { spec: Spec; schema: JsonSchema; depth: number }) {
  const t = useDocsText();
  const s = deref(spec, schema)!;
  const alt = s.anyOf ?? s.oneOf;
  if (alt && alt.filter((a) => deref(spec, a)?.type !== "null").length > 1) {
    return (
      <div className="ref-alts">
        <div className="ref-alts-title">{t("ref.anyOf")}</div>
        {alt.map((a, i) => (
          <details key={i} className="ref-alt" open={i === 0}>
            <summary>
              {t("ref.option")} {i + 1}: <code>{refName(a.$ref) ?? typeLabel(spec, a)}</code>
              {deref(spec, a)?.description && <span className="muted"> — {deref(spec, a)!.description}</span>}
            </summary>
            <SchemaView spec={spec} schema={a} depth={depth + 1} />
          </details>
        ))}
      </div>
    );
  }
  const { props, required } = objectProps(spec, s);
  if (!props.length) {
    if (s.additionalProperties) return <p className="small muted">{t("ref.freeObject")}</p>;
    return null;
  }
  return (
    <ul className={`ref-props depth-${Math.min(depth, 3)}`}>
      {props.map(([name, raw]) => {
        const p = deref(spec, raw)!;
        const child = depth < 5 ? childSchema(spec, raw) : null;
        const childHasProps = child && (objectProps(spec, child).props.length > 0 || (deref(spec, child)?.anyOf ?? deref(spec, child)?.oneOf));
        return (
          <li key={name} className="ref-prop">
            <div className="ref-prop-head">
              <code className="ref-prop-name">{name}</code>
              <span className="ref-prop-type">{typeLabel(spec, raw)}</span>
              {required.has(name) ? <Badge tone="warn">{t("ui.required")}</Badge> : null}
              {p.deprecated && <Badge>deprecated</Badge>}
            </div>
            {p.description && (
              <div className="ref-prop-desc">
                <Inline text={p.description} />
              </div>
            )}
            <Constraints s={p} />
            {childHasProps && (
              <details className="ref-children" open={depth === 0 && props.length <= 4}>
                <summary>{t("ref.showChildren")}</summary>
                <SchemaView spec={spec} schema={child} depth={depth + 1} />
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SchemaView({ spec, schema, depth = 0 }: { spec: Spec; schema: JsonSchema | undefined; depth?: number }) {
  if (!schema) return null;
  const s = deref(spec, schema)!;
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (type === "array" && s.items) {
    const child = childSchema(spec, s.items);
    return child ? (
      <SchemaProps spec={spec} schema={child} depth={depth} />
    ) : (
      <p className="small">
        <code>{typeLabel(spec, s)}</code>
      </p>
    );
  }
  if (s.properties || s.allOf || s.anyOf || s.oneOf || s.additionalProperties) return <SchemaProps spec={spec} schema={s} depth={depth} />;
  return (
    <p className="small">
      <code>{typeLabel(spec, s)}</code>
    </p>
  );
}

// ───────────────────────────── Operación ─────────────────────────────

function params(spec: Spec, e: OpEntry): Parameter[] {
  return (e.op.parameters ?? []).map((p) => deref(spec, p) as Parameter).filter(Boolean);
}

function authBadges(spec: Spec, e: OpEntry, t: DocsT) {
  const sec = e.op.security;
  if (sec && sec.length === 0)
    return [
      <Badge key="p" tone="ok">
        {t("ref.public")}
      </Badge>,
    ];
  const out: ReactNode[] = [];
  for (const req of sec ?? []) {
    for (const [name, scopes] of Object.entries(req)) {
      if (name === "apiKey") out.push(<Badge key="k">API key</Badge>);
      else if (name === "oauth2") out.push(<Badge key={`o${scopes.join()}`}>OAuth{scopes.length ? ` · ${scopes.join(", ")}` : ""}</Badge>);
      else if (name === "clientBasic") out.push(<Badge key="c">client_id + secret</Badge>);
    }
  }
  if (sec && !sec.some((r) => "apiKey" in r || "oauth2" in r || "clientBasic" in r)) out.push(<Badge key="s">{t("ref.sessionOnly")}</Badge>);
  void spec;
  return out;
}

function callFor(spec: Spec, e: OpEntry): ApiCall {
  const ps = params(spec, e);
  const sec = e.op.security;
  const auth: ApiCall["auth"] = sec && sec.length === 0 ? false : sec?.some((r) => "clientBasic" in r) ? "basic" : true;
  const query: Record<string, string> = {};
  for (const p of ps.filter((x) => x.in === "query" && x.required)) query[p.name] = String(p.example ?? exampleFor(spec, p.schema, p.name) ?? "");
  const content = deref(spec, e.op.requestBody)?.content ?? {};
  const call: ApiCall = { method: e.method, path: e.path, auth, query };
  if (ps.some((p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key")) call.idempotencyKey = "mi-clave-unica-123";
  if (content["application/json"]) {
    const mt = content["application/json"];
    call.body = mt.example ?? Object.values(mt.examples ?? {})[0]?.value ?? exampleFor(spec, mt.schema) ?? {};
  } else if (content["application/x-www-form-urlencoded"]) {
    const ex = exampleFor(spec, content["application/x-www-form-urlencoded"].schema);
    call.form = Object.fromEntries(Object.entries((ex ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  } else if (content["multipart/form-data"]) {
    call.multipart = { field: "file", file: "documento.pdf" };
  }
  const [okCode, ok] = Object.entries(e.op.responses ?? {}).find(([c]) => c.startsWith("2")) ?? [];
  const okContent = deref(spec, ok as ResponseObj)?.content ?? {};
  if (okContent["application/pdf"]) call.saveAs = "documento.pdf";
  else if (okContent["text/csv"]) call.saveAs = "export.csv";
  else if (okCode === "204") call.noContent = true;
  return call;
}

function ResponseView({ spec, code, resp }: { spec: Spec; code: string; resp: ResponseObj }) {
  const t = useDocsText();
  const r = deref(spec, resp)!;
  const [ctype, mt] = Object.entries(r.content ?? {})[0] ?? [];
  const example = mt
    ? (mt.example ?? Object.values(mt.examples ?? {})[0]?.value ?? (ctype?.includes("json") ? exampleFor(spec, mt.schema) : undefined))
    : undefined;
  const ok = code.startsWith("2");
  return (
    <details className={`ref-resp ${ok ? "ok" : "err"}`} open={ok}>
      <summary>
        <span className={`ref-status s${code[0]}`}>{code}</span> {r.description ? <Inline text={r.description} /> : null}
        {ctype && <span className="muted small"> · {ctype}</span>}
      </summary>
      {mt?.schema && ctype?.includes("json") && <SchemaView spec={spec} schema={mt.schema} />}
      {example !== undefined && ctype?.includes("json") && <Code lang="json" code={JSON.stringify(example, null, 2)} title={t("ref.example")} />}
      {r.headers && (
        <DataTable
          head={[t("ref.header"), t("ref.description")]}
          rows={Object.entries(r.headers).map(([h, v]) => [<code key="h">{h}</code>, v.description ?? ""])}
        />
      )}
    </details>
  );
}

function OperationView({ spec, e }: { spec: Spec; e: OpEntry }) {
  const t = useDocsText();
  const ps = params(spec, e);
  const body = deref(spec, e.op.requestBody);
  const [bodyType, bodyMt] = Object.entries(body?.content ?? {})[0] ?? [];
  const call = useMemo(() => callFor(spec, e), [spec, e]);
  return (
    <section className="ref-op" aria-labelledby={e.anchor}>
      <div className="ref-op-main">
        <h2 id={e.anchor} className="docs-h2 ref-op-title">
          {e.op.summary ?? `${e.method.toUpperCase()} ${e.path}`}
          <a className="docs-anchor" href={`#${e.anchor}`} aria-label={t("ui.linkTo")}>
            #
          </a>
        </h2>
        <div className="ref-endpoint">
          <Method method={e.method} />
          <code>{e.path}</code>
          <CopyButton text={`${BASE}${e.path}`} label={t("ref.copyUrl")} />
        </div>
        <div className="ref-badges">
          {authBadges(spec, e, t)}
          {call.idempotencyKey && <Badge>Idempotency-Key</Badge>}
          {e.op.deprecated && <Badge tone="warn">deprecated</Badge>}
        </div>
        {e.op.description && <Md text={e.op.description} />}

        {ps.length > 0 && (
          <>
            <h3 className="ref-h">{t("ref.params")}</h3>
            <DataTable
              className="ref-params"
              head={[t("ref.name"), t("ref.in"), t("ref.type"), t("ref.description")]}
              rows={ps.map((p) => [
                <span key="n">
                  <code>{p.name}</code>
                  {p.required && <Badge tone="warn">{t("ui.required")}</Badge>}
                </span>,
                p.in,
                <span key="t" className="ref-prop-type">
                  {typeLabel(spec, p.schema)}
                </span>,
                <span key="d">
                  {p.description && <Inline text={p.description} />}
                  {p.schema && <Constraints s={deref(spec, p.schema)!} />}
                </span>,
              ])}
            />
          </>
        )}

        {body && bodyType && (
          <>
            <h3 className="ref-h">
              {t("ref.body")} <span className="muted small">{bodyType}</span>
            </h3>
            {body.description && <Md text={body.description} />}
            <SchemaView spec={spec} schema={bodyMt?.schema} />
          </>
        )}

        <h3 className="ref-h">{t("ref.responses")}</h3>
        {Object.entries(e.op.responses ?? {}).map(([code, resp]) => (
          <ResponseView key={code} spec={spec} code={code} resp={resp} />
        ))}
      </div>
      <aside className="ref-op-code" aria-label={t("ref.examples")}>
        <CodeTabs tabs={apiTabs(call)} title={t("ref.examples")} />
      </aside>
    </section>
  );
}

// ───────────────────────────── Páginas ─────────────────────────────

function useTags() {
  const { spec, error } = useSpec(true);
  const tags = useMemo(() => (spec ? groupByTag(spec) : []), [spec]);
  return { spec, error, tags };
}

function Loading({ error }: { error: boolean }) {
  const t = useDocsText();
  return error ? <p className="alert alert-error">{t("ref.loadError")}</p> : <Spinner />;
}

export function ReferenceOverview() {
  const t = useDocsText();
  const { locale } = useI18n();
  const { spec, error, tags } = useTags();
  return (
    <DocPage title={t("ref.title")} lead={t("ref.lead")}>
      {locale !== "es" && <p className="docs-note">{t("ref.spanishNote")}</p>}
      <p>
        <a className="btn btn-sm" href="/v1/openapi.json" target="_blank" rel="noopener">
          openapi.json ↗
        </a>
      </p>
      {!spec ? (
        <Loading error={error} />
      ) : (
        <div className="ref-index">
          {tags.map((tag) => (
            <section key={tag.slug} className="ref-index-tag" aria-labelledby={`tag-${tag.slug}`}>
              <h2 id={`tag-${tag.slug}`} className="docs-h2">
                <Link to={`/developers/api/${tag.slug}`}>{tagLabel(tag.name, locale)}</Link>
              </h2>
              {tag.description && <Md text={tag.description} className="muted" />}
              <ul className="ref-index-ops">
                {tag.ops.map((e) => (
                  <li key={e.anchor}>
                    <Link to={`/developers/api/${tag.slug}#${e.anchor}`}>
                      <Method method={e.method} />
                      <code>{e.path}</code>
                      <span className="muted">{e.op.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </DocPage>
  );
}

export function ReferenceTag() {
  const t = useDocsText();
  const { locale } = useI18n();
  const { tag: slug } = useParams();
  const { spec, error, tags } = useTags();
  const tag: TagEntry | undefined = tags.find((x) => x.slug === slug);
  if (!spec) return <Loading error={error} />;
  if (!tag)
    return (
      <DocPage title={t("ref.title")}>
        <p>{t("ui.notFound")}</p>
        <Link to="/developers/api">{t("ref.title")}</Link>
      </DocPage>
    );
  return (
    <DocPage title={tagLabel(tag.name, locale)} lead={tag.description}>
      {locale !== "es" && <p className="docs-note">{t("ref.spanishNote")}</p>}
      {tag.ops.map((e) => (
        <OperationView key={e.anchor} spec={spec} e={e} />
      ))}
    </DocPage>
  );
}

export default ReferenceOverview;
