// Reportes de la organización: totales, sobres por mes (barras apiladas en SVG), remitentes y notificaciones.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportsSummary } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useExpText } from "../lib/i18n-experience";
import { ErrorBox, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

const SERIES = [
  { key: "completed", color: "#0f766e" },
  { key: "inProgress", color: "#2563eb" },
  { key: "closed", color: "#b45309" },
  { key: "draft", color: "#94a3b8" },
] as const;
type SeriesKey = (typeof SERIES)[number]["key"];

function monthStart(offset: number) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}
/** Fecha local (YYYY-MM-DD): con toISOString, de noche en América el "hoy" ya era mañana. */
const toInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function ReportsPage() {
  const x = useExpText();
  useTitle(x("reports.title"));
  const { locale } = useI18n();
  const [from, setFrom] = useState(toInput(monthStart(-5)));
  const [to, setTo] = useState(toInput(new Date()));
  const [data, setData] = useState<ReportsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => {
    const q = new URLSearchParams();
    // Días locales del usuario: con límites en UTC, "hasta el 31" dejaba afuera lo creado ese día desde las 19-21 h
    // (UTC-3 a UTC-5) y "desde el 1" sumaba la noche anterior.
    if (from) q.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) q.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    return q.toString();
  }, [from, to]);

  // Rango de lo que está en pantalla: el CSV exporta eso, no las fechas editadas sin apretar "Ver".
  const [shownRange, setShownRange] = useState(range);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<ReportsSummary>(`/v1/reports/summary?${range}`));
      setShownRange(range);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
    // Solo al entrar: después, con el botón "Ver".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nf = new Intl.NumberFormat(locale);
  const pf = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const avg = data?.totals.avgHoursToComplete;
  const avgText = avg == null ? "—" : avg >= 48 ? x("reports.days", { n: nf.format(Math.round((avg / 24) * 10) / 10) }) : x("reports.hours", { n: nf.format(avg) });

  return (
    <div className="page reports">
      <div className="page-head">
        <div>
          <h1>{x("reports.title")}</h1>
          <p className="muted">{x("reports.intro")}</p>
        </div>
        <form
          className="row-wrap reports-range"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label className="field">
            <span>{x("reports.from")}</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>{x("reports.to")}</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {x("reports.apply")}
          </button>
          <a className="btn" href={`/v1/reports/envelopes.csv?${shownRange}`}>
            ⬇ {x("reports.csv")}
          </a>
        </form>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        loading && <Spinner />
      ) : (
        <>
          <div className="kpis" aria-live="polite">
            <Kpi label={x("reports.created")} value={nf.format(data.totals.created)} />
            <Kpi label={x("reports.sent")} value={nf.format(data.totals.sent)} />
            <Kpi label={x("reports.completed")} value={nf.format(data.totals.completed)} />
            <Kpi label={x("reports.rate")} value={data.totals.completionRate == null ? "—" : pf.format(data.totals.completionRate)} />
            <Kpi label={x("reports.avg")} value={avgText} />
            <Kpi label={x("reports.inProgress")} value={nf.format(data.totals.inProgress)} />
          </div>

          <section className="card pad">
            <h2>{x("reports.byMonth")}</h2>
            <MonthChart data={data} />
          </section>

          <div className="grid-2">
            <section className="card pad">
              <h2>{x("reports.topSenders")}</h2>
              {data.topSenders.length === 0 ? (
                <p className="muted">{x("reports.noData")}</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{x("reports.sender")}</th>
                      <th scope="col" className="num">
                        {x("reports.sent")}
                      </th>
                      <th scope="col" className="num">
                        {x("reports.completed")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topSenders.map((s) => (
                      <tr key={s.userId ?? "api"}>
                        <td>
                          {s.name}
                          {s.email && <div className="muted small">{s.email}</div>}
                        </td>
                        <td className="num">{nf.format(s.sent)}</td>
                        <td className="num">{nf.format(s.completed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card pad">
              <h2>{x("reports.notifications")}</h2>
              <ChannelBars data={data} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi card">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function MonthChart({ data }: { data: ReportsSummary }) {
  const x = useExpText();
  const { locale } = useI18n();
  const rows = data.byMonth.map((m) => ({
    month: m.month,
    values: { completed: m.completed, inProgress: m.inProgress, closed: m.declined + m.voided + m.expired, draft: m.draft } as Record<SeriesKey, number>,
    total: m.created,
  }));
  const max = Math.max(1, ...rows.map((r) => r.total));
  const label = (k: SeriesKey) => x(`reports.s.${k}` as Parameters<typeof x>[0]);
  const monthName = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, 1)));
  };
  // El ancho del SVG sigue al contenedor (1 unidad = 1 px): el texto no se agranda ni se achica con la pantalla.
  const box = useRef<HTMLElement>(null);
  const hasData = !rows.every((r) => r.total === 0);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
  if (!hasData) return <p className="muted">{x("reports.noData")}</p>;

  const H = 220;
  const pad = { l: 36, r: 8, t: 10, b: 28 };
  const bw = (W - pad.l - pad.r) / rows.length;
  const scale = (v: number) => (v / max) * (H - pad.t - pad.b);
  // Con max = 1, ceil(max / 2) = max: sin el Set, dos marcas "1" superpuestas y la misma key repetida.
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];

  return (
    <figure className="chart" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={x("reports.chartLabel")} className="chart-svg">
        {ticks.map((tk) => {
          const y = H - pad.b - scale(tk);
          return (
            <g key={tk}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="chart-grid" />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" className="chart-axis">
                {tk}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          let y = H - pad.b;
          const x0 = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={r.month}>
              {SERIES.map((s) => {
                const h = scale(r.values[s.key]);
                y -= h;
                return h > 0 ? (
                  <rect key={s.key} x={x0} y={y} width={w} height={h} fill={s.color} rx={2}>
                    <title>{`${monthName(r.month)} · ${label(s.key)}: ${r.values[s.key]}`}</title>
                  </rect>
                ) : null;
              })}
              <text x={x0 + w / 2} y={H - pad.b + 16} textAnchor="middle" className="chart-axis">
                {monthName(r.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="chart-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} aria-hidden="true" /> {label(s.key)}
          </span>
        ))}
      </figcaption>
      {/* Los mismos datos en tabla, para lectores de pantalla. */}
      <table className="sr-only">
        <caption>{x("reports.byMonth")}</caption>
        <thead>
          <tr>
            <th scope="col">{x("reports.month")}</th>
            {SERIES.map((s) => (
              <th key={s.key} scope="col">
                {label(s.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row">{monthName(r.month)}</th>
              {SERIES.map((s) => (
                <td key={s.key}>{r.values[s.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function ChannelBars({ data }: { data: ReportsSummary }) {
  const x = useExpText();
  const { locale } = useI18n();
  const nf = new Intl.NumberFormat(locale);
  if (data.notifications.length === 0) return <p className="muted">{x("reports.noData")}</p>;
  const max = Math.max(1, ...data.notifications.map((n) => n.sent + n.failed));
  return (
    <ul className="channel-bars">
      {data.notifications.map((n) => (
        <li key={n.channel}>
          <div className="row-between small">
            <strong>{n.channel}</strong>
            <span>
              {x("reports.ok")}: {nf.format(n.sent)} · {x("reports.failed")}: {nf.format(n.failed)}
            </span>
          </div>
          <div className="channel-track" aria-hidden="true">
            <span className="channel-ok" style={{ width: `${(n.sent / max) * 100}%` }} />
            <span className="channel-fail" style={{ width: `${(n.failed / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
