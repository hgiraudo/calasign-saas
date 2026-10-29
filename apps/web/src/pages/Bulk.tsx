// Envío masivo (Fase 4): listado, asistente (plantilla → CSV → revisar y enviar) y detalle con progreso.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { BulkSend, BulkSendItem, BulkValidationResult, TemplateDetail, TemplateSummary } from "@calasign/shared";
import { api, errorText, HttpError, uuid } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { downloadCsv } from "../lib/csv";
import { useScaleText } from "../lib/i18n-scale";
import { ErrorBox, Modal, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

function BulkStatus({ status }: { status: BulkSend["status"] }) {
  const st = useScaleText();
  const cls =
    status === "completed" ? "badge-completed" : status === "cancelled" ? "badge-voided" : status === "running" ? "badge-finalizing" : "badge-sent";
  return <span className={`badge ${cls}`}>{st(`bulk.status.${status}` as "bulk.status.queued")}</span>;
}

function BulkBar({ b }: { b: BulkSend }) {
  const pct = (n: number) => `${b.total ? (n / b.total) * 100 : 0}%`;
  return (
    <div className="bulk-bar" aria-hidden="true">
      <span className="bulk-bar-sent" style={{ width: pct(b.sent) }} />
      <span className="bulk-bar-failed" style={{ width: pct(b.failed) }} />
      <span className="bulk-bar-cancelled" style={{ width: pct(b.cancelled) }} />
    </div>
  );
}

// ───────────────────────────── Listado ─────────────────────────────

export function BulkListPage() {
  const { locale } = useI18n();
  const st = useScaleText();
  useTitle(st("bulk.title"));
  const [items, setItems] = useState<BulkSend[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const load = useCallback(
    () =>
      api<{ items: BulkSend[] }>("/v1/bulk-sends")
        .then((r) => {
          if (!alive.current) return;
          setItems(r.items);
          setError(null); // un corte de red pasajero no deja el error a la vista mientras el refresco ya responde
        })
        .catch((e) => alive.current && setError(errorText(e))),
    [],
  );
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  // Solo se refresca mientras haya envíos en cola o en curso (antes pedía la lista cada 4 s para siempre). Si la carga
  // inicial falló, también se reintenta.
  const active = items === null || items.some((b) => b.status === "queued" || b.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{st("bulk.title")}</h1>
          <p className="muted">{st("bulk.intro")}</p>
        </div>
        <Link className="btn btn-primary" to="/app/bulk/new">
          + {st("bulk.new")}
        </Link>
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{st("bulk.empty")}</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{st("bulk.name")}</th>
                <th>{st("bulk.template")}</th>
                <th>{st("bulk.progress")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/app/bulk/${b.id}`}>
                      <strong>{b.name || formatDateTime(b.createdAt, locale)}</strong>
                    </Link>
                    <div className="muted small">{formatDateTime(b.createdAt, locale)}</div>
                  </td>
                  <td>{b.templateName}</td>
                  <td style={{ minWidth: 180 }}>
                    <BulkBar b={b} />
                    <div className="small muted">
                      {b.sent}/{b.total} · {st("bulk.failed")}: {b.failed}
                    </div>
                  </td>
                  <td>
                    <BulkStatus status={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Asistente ─────────────────────────────

/**
 * Texto del CSV elegido: UTF-8 si lo es (con o sin BOM); si no, Windows-1252, como lo guarda Excel en Windows con
 * "CSV (delimitado por comas)". Antes se leía siempre como UTF-8 y las letras con tilde llegaban como "�" a los sobres.
 */
function decodeCsv(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export function BulkNewPage() {
  const st = useScaleText();
  const { t } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState(params.get("template") ?? "");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<BulkValidationResult | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CSV con fetch: un error se muestra traducido (con <a href download> se guardaba el JSON del error como archivo).
  const [downloading, setDownloading] = useState(false);
  const downloadSkeleton = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadCsv(`/v1/templates/${templateId}/bulk-csv`, "envio-masivo.csv");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const wanted = params.get("template") ?? "";
    (async () => {
      const r = await api<{ items: TemplateSummary[] }>("/v1/templates");
      let items = r.items;
      // La lista trae hasta 200: una plantilla de la URL que no está ahí se pide aparte. Si no existe o no hay acceso,
      // se avisa y no se elige ninguna (antes quedaba elegida la primera de la lista sin decir nada).
      if (wanted && !items.some((x) => x.id === wanted)) {
        try {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) throw new HttpError(404, "not_found", "");
          const d = await api<TemplateDetail>(`/v1/templates/${encodeURIComponent(wanted)}`);
          const extra: TemplateSummary = {
            ...d.template,
            documentCount: d.documents.length,
            roles: d.roles.map((x) => ({ name: x.name, role: x.role })),
          };
          items = [extra, ...items];
        } catch (e) {
          // Un corte de red o un 5xx no es "no existe": se muestra ese error.
          if (!(e instanceof HttpError) || e.status === 0 || e.status >= 500) throw e;
          if (!alive) return;
          setTemplateId("");
          setError(st("bulk.templateMissing"));
        }
      }
      if (!alive) return;
      setTemplates(items);
      if (!wanted) setTemplateId((cur) => cur || (items[0]?.id ?? ""));
    })().catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
    // Solo al entrar: la plantilla de la URL es la inicial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cada cambio del CSV o de la plantilla invalida la validación, también la que todavía está en camino: si no, una
  // respuesta lenta mostraba el resultado (y la cantidad a enviar) del CSV anterior.
  const inputRev = useRef(0);
  useEffect(() => {
    inputRev.current++;
    setResult(null);
  }, [csv, templateId]);

  const body = () => ({
    templateId,
    csv,
    skipInvalid,
    name: name.trim() || null,
    subject: subject.trim() || null,
    message: message.trim() || null,
  });

  const validate = async () => {
    setBusy(true);
    setError(null);
    const mine = inputRev.current;
    try {
      const r = await api<BulkValidationResult>("/v1/bulk-sends/validate", { method: "POST", body: body() });
      if (mine === inputRev.current) setResult(r);
    } catch (e) {
      // El error de la validación de un CSV que ya cambió no es de lo que está en pantalla.
      if (mine === inputRev.current) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const [idemKey, setIdemKey] = useState(uuid);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api<BulkSend>("/v1/bulk-sends", { method: "POST", body: body(), headers: { "Idempotency-Key": idemKey } });
      nav(`/app/bulk/${b.id}`);
    } catch (e) {
      // Respuesta de error: se puede corregir y volver a enviar con otra clave (un corte o un 5xx reintenta con la misma).
      // Clave nueva solo ante un rechazo de los datos: con idempotency_in_progress/mismatch el primer pedido ya llegó al
      // servidor, y una clave nueva podía crear (y enviar) un segundo envío.
      if (e instanceof HttpError && e.status > 0 && e.status < 500 && !["idempotency_in_progress", "idempotency_mismatch"].includes(e.code))
        setIdemKey(uuid());
      if (e instanceof HttpError && e.code === "rows_invalid") setResult(e.details as BulkValidationResult);
      setError(errorText(e));
      setBusy(false);
    }
  };

  // Solo vale la lectura del último archivo elegido: si una lectura anterior terminaba después, quedaba el CSV de un
  // archivo con el nombre de otro. Un archivo que no se puede leer (movido, sin permiso) muestra el error en lugar de
  // un rechazo sin manejar.
  const fileSeq = useRef(0);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const mine = ++fileSeq.current;
    setFileName(f.name);
    try {
      const text = decodeCsv(await f.arrayBuffer());
      if (mine !== fileSeq.current) return;
      setCsv(text);
      // El error de un archivo anterior que no se pudo leer no queda a la vista con el nuevo ya cargado.
      setError(null);
    } catch (e) {
      if (mine === fileSeq.current) setError(errorText(e));
    }
  };

  const sendCount = result ? (skipInvalid ? result.valid : result.invalid === 0 ? result.total : 0) : 0;

  // Si la lista de plantillas no carga, se muestra el error (antes quedaba el spinner para siempre).
  if (templates === null)
    return error ? (
      <div className="page narrow">
        <ErrorBox error={error} />
      </div>
    ) : (
      <Spinner />
    );
  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>{st("bulk.new")}</h1>
      </div>
      <ErrorBox error={error} />
      {templates.length === 0 ? (
        <div className="empty">
          {st("bulk.noTemplates")} <Link to="/app/templates">{t("nav.templates")}</Link>
        </div>
      ) : (
        <div className="stack">
          <section className="card pad stack">
            <h2>{st("bulk.step1")}</h2>
            <label className="field">
              <span>{st("bulk.template")}</span>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {!templateId && <option value="">{st("bulk.chooseTemplate")}</option>}
                {templates.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name} — {tp.roles.map((r) => r.name).join(", ")}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="card pad stack">
            <h2>{st("bulk.step2")}</h2>
            <p className="muted small">{st("bulk.skeletonHint")}</p>
            <div className="row-wrap">
              <button type="button" className="btn btn-sm" disabled={downloading} onClick={() => void downloadSkeleton()}>
                ⬇ {st("bulk.downloadSkeleton")}
              </button>
              <label className="btn btn-sm file-btn">
                ⬆ {st("bulk.uploadCsv")}
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Vaciado: volver a elegir el mismo archivo (después de editar el texto pegado) no disparaba onChange.
                    e.target.value = "";
                    void onFile(f);
                  }}
                />
              </label>
              {fileName && <span className="small muted">{fileName}</span>}
            </div>
            <label className="field">
              <span className="muted small">{st("bulk.orPaste")}</span>
              <textarea rows={6} className="mono" value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
            </label>
            <div>
              <button type="button" className="btn" disabled={busy || !csv.trim() || !templateId} onClick={validate}>
                {busy && !result ? st("bulk.validating") : st("bulk.validate")}
              </button>
            </div>
            {result && (
              <div className="stack">
                <p>
                  <strong>{result.total}</strong> {st("bulk.rows")} ·{" "}
                  <span className="ok-text">
                    {result.valid} {st("bulk.valid")}
                  </span>
                  {result.invalid > 0 && (
                    <>
                      {" "}
                      ·{" "}
                      <span className="err-text">
                        {result.invalid} {st("bulk.invalid")}
                      </span>
                    </>
                  )}
                </p>
                {(result.duplicates?.length ?? 0) > 0 && (
                  <p className="small warn-text" role="status">
                    ⚠{" "}
                    {st("bulk.duplicates", {
                      n: result.duplicates!.length,
                      rows:
                        result
                          .duplicates!.slice(0, 10)
                          .map((d) => `${d.row} (= ${d.sameAs})`)
                          .join(", ") + (result.duplicates!.length > 10 ? "…" : ""),
                    })}
                  </p>
                )}
                {result.quotaRemaining != null && result.valid > result.quotaRemaining && (
                  <p className="small err-text" role="status">
                    ⚠ {st("bulk.quotaShort", { valid: result.valid, remaining: result.quotaRemaining })}
                  </p>
                )}
                {result.invalid === 0 ? (
                  <p className="ok-text small">✓ {st("bulk.allValid")}</p>
                ) : (
                  <div className="table-wrap scroll-y">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{st("bulk.row")}</th>
                          <th>{st("bulk.errors")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.slice(0, 200).map((e) => (
                          <tr key={e.row}>
                            <td>
                              {e.row}
                              {e.line !== undefined && <div className="muted small">{st("bulk.line", { n: String(e.line) })}</div>}
                            </td>
                            <td className="small">{e.errors.join(" · ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="card pad stack">
            <h2>{st("bulk.step3")}</h2>
            <label className="field">
              <span>{st("bulk.name")}</span>
              <input value={name} maxLength={200} placeholder={st("bulk.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{st("bulk.subject")}</span>
              <input value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
            </label>
            <label className="field">
              <span>{st("bulk.message")}</span>
              <textarea rows={3} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            {result && result.invalid > 0 && (
              <label className="check">
                <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
                {st("bulk.skipInvalid")}
              </label>
            )}
            <div>
              <button type="button" className="btn btn-primary" disabled={busy || !result || sendCount === 0} onClick={send}>
                {busy && result ? st("bulk.sending") : st("bulk.send", { n: sendCount })}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Detalle ─────────────────────────────

export function BulkDetailPage() {
  const { id } = useParams();
  const { locale } = useI18n();
  const st = useScaleText();
  const { t } = useI18n();
  const [b, setB] = useState<BulkSend | null>(null);
  const [items, setItems] = useState<BulkSendItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Error del refresco periódico, aparte del de cancelar: el refresco lo limpia sin borrar el mensaje del modal.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Resultados en CSV con fetch: un error se muestra traducido en lugar de descargarse como archivo.
  const [downloading, setDownloading] = useState(false);
  const downloadResults = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadCsv(`/v1/bulk-sends/${id}/results.csv`, `envio-masivo-${id}.csv`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDownloading(false);
    }
  };

  // Solo se aplica la respuesta más reciente: al cambiar de filtro, una respuesta vieja no pisa la lista nueva.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [bulk, list] = await Promise.all([
        api<BulkSend>(`/v1/bulk-sends/${id}`),
        api<{ items: BulkSendItem[]; total: number }>(`/v1/bulk-sends/${id}/items?limit=500${filter ? `&status=${filter}` : ""}`),
      ]);
      if (mine !== seq.current) return;
      setB(bulk);
      setItems(list.items);
      setTotal(list.total);
      setLoadError(null);
    } catch (e) {
      if (mine === seq.current) setLoadError(errorText(e));
    }
  }, [id, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = b?.status === "queued" || b?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      setB(await api<BulkSend>(`/v1/bulk-sends/${id}/cancel`, { method: "POST" }));
      setConfirm(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Filas fallidas por un problema del momento (cupo, plantilla, error interno): se vuelven a encolar.
  const retryFailed = async () => {
    setBusy(true);
    setError(null);
    try {
      setB(await api<BulkSend>(`/v1/bulk-sends/${id}/retry-failed`, { method: "POST" }));
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const filters = useMemo(() => ["", "sent", "failed", "pending", "cancelled"], []);

  if (!b) return loadError ? <ErrorBox error={loadError} /> : <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="muted small">
            <Link to="/app/bulk">← {st("bulk.title")}</Link>
          </p>
          <h1>{b.name || b.templateName}</h1>
          <p className="muted small">
            {b.templateName} · {formatDateTime(b.createdAt, locale)} · <BulkStatus status={b.status} />
          </p>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn" disabled={downloading} onClick={() => void downloadResults()}>
            ⬇ {st("bulk.downloadResults")}
          </button>
          {/* Solo si hay fallidas que se pueden reintentar (las que fallaron por sus datos se corrigen en un envío nuevo). */}
          {b.status !== "cancelled" && (b.retryable ?? 0) > 0 && (
            <button type="button" className="btn" disabled={busy} onClick={retryFailed}>
              ↻ {st("bulk.retryFailed")} ({b.retryable})
            </button>
          )}
          {running && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
              {st("bulk.cancel")}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={confirm ? loadError : (error ?? loadError)} />
      <div className="card pad stack">
        <BulkBar b={b} />
        <div className="stats">
          <div>
            <strong>{b.total}</strong>
            <span>{st("bulk.total")}</span>
          </div>
          <div className="ok-text">
            <strong>{b.sent}</strong>
            <span>{st("bulk.sent")}</span>
          </div>
          <div className="err-text">
            <strong>{b.failed}</strong>
            <span>{st("bulk.failed")}</span>
          </div>
          <div>
            <strong>{b.pending}</strong>
            <span>{st("bulk.pending")}</span>
          </div>
          <div className="muted">
            <strong>{b.cancelled}</strong>
            <span>{st("bulk.cancelled")}</span>
          </div>
        </div>
      </div>

      <div className="row-between" style={{ marginTop: "1.5rem" }}>
        <h2>
          {st("bulk.items")} <span className="muted small">({total})</span>
        </h2>
        <div className="tabs">
          {filters.map((f) => (
            <button key={f || "all"} type="button" className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f ? st(`bulk.item.${f}` as "bulk.item.sent") : st("bulk.filterAll")}
            </button>
          ))}
        </div>
      </div>
      <div className="card table-wrap">
        {/* La API devuelve hasta 500 filas: con más, se avisa (el CSV tiene todas). */}
        {total > items.length && <p className="muted small">{st("bulk.partial", { n: String(items.length), total: String(total) })}</p>}
        <table className="table">
          <thead>
            <tr>
              <th>{st("bulk.row")}</th>
              <th>{st("bulk.recipients")}</th>
              <th />
              <th>{st("bulk.envelope")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  {it.row}
                  {it.line != null && <div className="muted small">{st("bulk.line", { n: String(it.line) })}</div>}
                </td>
                <td>
                  {it.recipients.join(", ") || "—"}
                  {it.error && <div className="err-text small">{it.error}</div>}
                </td>
                <td>
                  <span
                    className={`badge ${it.status === "sent" ? "badge-completed" : it.status === "failed" ? "badge-declined" : it.status === "cancelled" ? "badge-voided" : "badge-sent"}`}
                  >
                    {st(`bulk.item.${it.status}` as "bulk.item.sent")}
                  </span>
                </td>
                <td>{it.envelopeId ? <Link to={`/app/envelopes/${it.envelopeId}`}>→</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirm && (
        <Modal
          title={st("bulk.cancel")}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={cancel}>
                {st("bulk.cancel")}
              </button>
            </>
          }
        >
          <p>{st("bulk.cancelConfirm")}</p>
          <ErrorBox error={error} />
        </Modal>
      )}
    </div>
  );
}
