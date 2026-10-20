// Ajustes → Plan y facturación: plan actual, uso del mes, planes con precios locales y suscripción.
import { useEffect, useRef, useState } from "react";
import { BILLING_CURRENCIES, PLAN_FEATURES, type BillingOverview, type BillingProvider, type PlanDefinition, type PlanFeature, type PlanId } from "@calasign/shared";
import { useAccess } from "../lib/access";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime, formatNumber, useI18n } from "../lib/i18n";
import { formatMoney, useBillingText, type BillingKey } from "../lib/i18n-billing";
import { ErrorBox, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

const PROVIDER_LABEL: Record<Exclude<BillingProvider, "mock">, string> = { stripe: "Stripe", mercadopago: "Mercado Pago" };

// Estados de suscripción de Stripe y de Mercado Pago (preapproval): se muestran traducidos; uno desconocido, tal cual.
const SUB_STATUS: Record<string, BillingKey> = {
  active: "billing.st.active",
  authorized: "billing.st.active",
  trialing: "billing.st.trialing",
  past_due: "billing.st.past_due",
  unpaid: "billing.st.unpaid",
  canceled: "billing.st.canceled",
  cancelled: "billing.st.canceled",
  incomplete: "billing.st.incomplete",
  incomplete_expired: "billing.st.incomplete_expired",
  paused: "billing.st.paused",
  pending: "billing.st.pending",
};

function UsageBar({ used, max, label }: { used: number; max: number | null; label: string }) {
  const b = useBillingText();
  if (max === null) return null;
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  // aria-valuenow no puede pasar de aria-valuemax: el uso real (que sí puede pasarse, p. ej. tras bajar de plan) va en el texto.
  return (
    <div
      className={`usage-bar${pct >= 80 ? " warn" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(used, max)}
      aria-valuetext={b("usage.barLabel", { label, used, max })}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Sin billing:manage (guarda de ruta en App.tsx): un mensaje en vez del 403 de la API. */
export function BillingNoAccess() {
  const b = useBillingText();
  useTitle(b("billing.title"));
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>{b("billing.title")}</h1>
      </div>
      <p className="card pad" role="alert">
        {b("billing.noPermission")}
      </p>
    </div>
  );
}

// Estado del plan antes de ir al checkout: al volver, "Procesando…" hasta que cambie (lo activa el webhook del proveedor).
const BEFORE_CHECKOUT_KEY = "calasign.billing.beforeCheckout";
const snapshotOf = (d: BillingOverview) =>
  JSON.stringify([d.plan.id, d.defaultPlan, d.subscription.provider, d.subscription.status, d.subscription.renewsAt]);
const ACTIVE_STATUSES = ["active", "authorized", "trialing"];
function readSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(BEFORE_CHECKOUT_KEY);
  } catch {
    return null;
  }
}
function writeSnapshot(v: string | null) {
  try {
    if (v === null) window.sessionStorage.removeItem(BEFORE_CHECKOUT_KEY);
    else window.sessionStorage.setItem(BEFORE_CHECKOUT_KEY, v);
  } catch {
    /* sin almacenamiento: se compara con la primera carga */
  }
}
/** Sondeo tras el checkout: con backoff (2 s, 4 s, 8 s… hasta 20 s entre pedidos), durante unos 2 minutos. */
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 20_000;
const POLL_TOTAL_MS = 120_000;

type CheckoutState = "processing" | "success" | "slow" | "cancel" | null;

export function BillingPage() {
  const b = useBillingText();
  useTitle(b("billing.title"));
  const { locale } = useI18n();
  const { me } = useAuth();
  const [data, setData] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<BillingProvider | "">("");
  // Las funciones del plan que usa el resto de la consola (avisos, botones) se vuelven a leer con cada cambio de plan.
  const { refresh: refreshAccess } = useAccess();
  // ?checkout=… se lee una vez y se quita de la URL (recargar o compartir el link no repite el aviso).
  const checkoutParam = useRef(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("checkout") : null).current;
  const [checkout, setCheckout] = useState<CheckoutState>(checkoutParam === "success" ? "processing" : checkoutParam === "cancel" ? "cancel" : null);

  const apply = (d: BillingOverview) => {
    setData(d);
    // El proveedor elegido puede dejar de servir (otra moneda): se pasa al primero disponible.
    setProvider((p) => (d.providers.some((x) => x.id === p && x.configured) ? p : d.providers.find((x) => x.configured)?.id || ""));
  };
  const load = (): Promise<BillingOverview | null> =>
    api<BillingOverview>("/v1/billing")
      .then((d) => {
        apply(d);
        void refreshAccess();
        return d;
      })
      .catch((e) => {
        setError(errorText(e));
        return null;
      });
  useEffect(() => {
    if (checkoutParam) {
      const u = new URL(window.location.href);
      u.searchParams.delete("checkout");
      window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    }
    let cancelled = false;
    let timer: number | undefined;
    void (async () => {
      const first = await load();
      if (cancelled || checkoutParam !== "success") return;
      // Al volver del checkout el webhook del proveedor puede activar el plan unos segundos (o minutos) después.
      let before = readSnapshot();
      const finish = (state: CheckoutState) => {
        writeSnapshot(null);
        setCheckout(state);
      };
      if (first) {
        if (before === null) {
          // Sin el estado anterior (otra pestaña, almacenamiento bloqueado): ya activo cuenta como listo; si no, se espera un cambio.
          if (!first.defaultPlan && first.plan.id !== "free" && ACTIVE_STATUSES.includes(first.subscription.status ?? "")) return finish("success");
          before = snapshotOf(first);
        } else if (snapshotOf(first) !== before) return finish("success");
      }
      const started = Date.now();
      let delay = POLL_FIRST_MS;
      const tick = async () => {
        if (cancelled) return;
        const d = await load();
        if (cancelled) return;
        if (d && before !== null && snapshotOf(d) !== before) return finish("success");
        if (d && before === null) before = snapshotOf(d);
        if (Date.now() - started >= POLL_TOTAL_MS) return finish("slow");
        delay = Math.min(delay * 2, POLL_MAX_MS);
        timer = window.setTimeout(() => void tick(), delay);
      };
      timer = window.setTimeout(() => void tick(), delay);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>;

  const { plan, usage, currency } = data;
  const sub = data.subscription;
  const providerName = (id: BillingProvider) => (id === "mock" ? b("pay.provider.mock") : PROVIDER_LABEL[id]);
  const openPortal = () => run("portal", async () => window.location.assign((await api<{ url: string }>("/v1/billing/portal", { method: "POST" })).url));
  const portalAvailable = sub.portalAvailable ?? sub.provider === "stripe";
  // Baja programada (Stripe): "Termina el …" en vez de "Se renueva el …".
  const endsAt = sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.renewsAt : null);
  const paymentIssue = sub.status === "past_due" || sub.status === "unpaid" ? sub.status : null;
  const anyProvider = data.providers.some((p) => p.configured);
  const freeUsers = data.plans.find((p) => p.id === "free")?.users ?? null;
  const periodLabel = (() => {
    try {
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${usage.period}-01T00:00:00Z`));
    } catch {
      return usage.period;
    }
  })();
  const n = (v: number) => formatNumber(v, locale);
  const price = (p: PlanDefinition & { price: number | null }) =>
    p.price === 0 ? b("billing.free") : p.price === null ? "—" : formatMoney(p.price, currency, locale, 0);
  const choose = (id: PlanId) =>
    run(`plan-${id}`, async () => {
      if (id === "free") {
        // Stripe: la API rechaza la baja (use_portal); se cancela desde el portal, como en "Administrar".
        if (data.subscription.provider === "stripe") {
          window.location.assign((await api<{ url: string }>("/v1/billing/portal", { method: "POST" })).url);
          return;
        }
        // La política de usuarios no cambia (nadie pierde el acceso): solo se avisa.
        const usersWarn = freeUsers !== null && usage.users > freeUsers ? `\n\n${b("billing.downgradeUsers", { n: usage.users, max: freeUsers })}` : "";
        if (!window.confirm(b("billing.downgradeConfirm") + usersWarn)) return;
        apply(await api<BillingOverview>("/v1/billing/cancel", { method: "POST" }));
        void refreshAccess();
        return;
      }
      const r = await api<{ url: string }>("/v1/billing/checkout", { method: "POST", body: { plan: id, currency, provider: provider || undefined } });
      writeSnapshot(snapshotOf(data));
      window.location.assign(r.url);
    });
  const order: PlanId[] = ["free", "starter", "business", "enterprise"];
  const newFeatures = (i: number): PlanFeature[] => {
    const prev = i > 0 ? data.plans[i - 1].features : [];
    return PLAN_FEATURES.filter((f) => data.plans[i].features.includes(f) && !prev.includes(f));
  };

  return (
    <div className="page stack">
      <div className="page-head">
        <h1>{b("billing.title")}</h1>
      </div>
      <p className="muted">{b("billing.intro")}</p>
      {checkout === "processing" && (
        <p className="card pad" role="status" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> {b("billing.processing")}
        </p>
      )}
      {checkout === "success" && (
        <p className="card pad" role="status">
          ✓ {b("billing.success")}
        </p>
      )}
      {checkout === "slow" && (
        <p className="card pad" role="status">
          {b("billing.processingSlow")}
        </p>
      )}
      {checkout === "cancel" && (
        <p className="card pad" role="alert">
          {b("billing.canceledCheckout")}
        </p>
      )}
      <ErrorBox error={error} />
      {paymentIssue && (
        <div className="card pad row-wrap" role="alert" style={{ justifyContent: "space-between" }}>
          <span>
            {b(paymentIssue === "unpaid" ? "billing.unpaid" : "billing.pastDue")}
            {!portalAvailable && sub.provider ? ` ${b("billing.paymentIssueNoPortal", { provider: providerName(sub.provider) })}` : ""}
          </span>
          {portalAvailable && (
            <button type="button" className="btn btn-primary" disabled={busy !== null} aria-busy={busy === "portal"} onClick={() => void openPortal()}>
              {busy === "portal" ? b("billing.busy") : b("billing.updatePayment")}
            </button>
          )}
        </div>
      )}

      <section className="card pad stack" aria-labelledby="current-plan">
        <div className="row-wrap" style={{ justifyContent: "space-between" }}>
          <div>
            <p className="muted small" style={{ margin: 0 }}>
              {data.defaultPlan ? b("billing.defaultPlan") : b("billing.currentPlan")}
            </p>
            <h2 id="current-plan" style={{ margin: 0 }}>
              {plan.name}
            </h2>
            {sub.provider && (
              <p className="small muted" style={{ margin: "4px 0 0" }}>
                {b("billing.provider", { provider: providerName(sub.provider) })}
                {sub.status ? ` · ${b("billing.status", { status: SUB_STATUS[sub.status] ? b(SUB_STATUS[sub.status]) : sub.status })}` : ""}
                {endsAt
                  ? ` · ${b("billing.endsOn", { date: formatDateTime(endsAt, locale) })}`
                  : sub.renewsAt
                    ? ` · ${b("billing.renews", { date: formatDateTime(sub.renewsAt, locale) })}`
                    : ""}
              </p>
            )}
          </div>
          <div className="row-wrap">
            <label className="field">
              <span>{b("billing.currency")}</span>
              <select
                value={currency}
                onChange={(e) => void run("currency", async () => apply(await api<BillingOverview>("/v1/billing/currency", { method: "PATCH", body: { currency: e.target.value } })))}
                data-testid="billing-currency"
              >
                {BILLING_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {portalAvailable && (
              <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === "portal"} onClick={() => void openPortal()}>
                {busy === "portal" ? b("billing.busy") : b("billing.manage")}
              </button>
            )}
          </div>
        </div>

        <h3 className="h3" style={{ marginBottom: 0 }}>
          {b("billing.usage", { period: periodLabel })}
        </h3>
        <div className="usage-list">
          <div className="usage-item">
            <span className="small strong">{b("usage.envelopes")}</span>
            <span className="small">
              {plan.envelopesPerMonth === null ? b("usage.unlimited", { used: usage.envelopesSent }) : b("usage.of", { used: usage.envelopesSent, max: plan.envelopesPerMonth })}
            </span>
            <UsageBar used={usage.envelopesSent} max={plan.envelopesPerMonth} label={b("usage.envelopes")} />
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.users")}</span>
            <span className="small">
              {plan.users === null ? b("usage.unlimited", { used: usage.users }) : b("usage.of", { used: usage.users, max: plan.users })}{" "}
              <span className="muted">{b("billing.usersIncludePending")}</span>
            </span>
            <UsageBar used={usage.users} max={plan.users} label={b("usage.users")} />
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.messages")}</span>
            <span className="small">
              Email {n(usage.messages.email)} · WhatsApp {n(usage.messages.whatsapp)} · SMS {n(usage.messages.sms)} · Telegram {n(usage.messages.telegram)}
            </span>
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.kyc")}</span>
            <span className="small">{n(usage.kycChecks)}</span>
          </div>
          {usage.aiTokens !== null && (
            <div className="usage-item">
              <span className="small strong">{b("usage.ai")}</span>
              <span className="small">
                {plan.aiTokensPerMonth === null || plan.aiTokensPerMonth === 0
                  ? n(usage.aiTokens)
                  : b("usage.of", { used: usage.aiTokens, max: plan.aiTokensPerMonth })}
              </span>
              {plan.aiTokensPerMonth ? <UsageBar used={usage.aiTokens} max={plan.aiTokensPerMonth} label={b("usage.ai")} /> : null}
            </div>
          )}
        </div>
      </section>

      <section className="stack" aria-labelledby="plans-title">
        <div className="row-wrap" style={{ justifyContent: "space-between" }}>
          <h2 id="plans-title" style={{ margin: 0 }}>
            {b("billing.plans")}
          </h2>
          <label className="field">
            <span>{b("billing.payWith")}</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as BillingProvider)} data-testid="billing-provider">
              {data.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.configured}>
                  {providerName(p.id)}
                  {p.configured ? "" : p.currencies && !p.currencies.includes(currency) ? ` (${b("billing.currencyUnsupported", { currency })})` : ` (${b("billing.notConfigured")})`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!anyProvider && (
          <div className="hint" role="note">
            {b("billing.noProvider", { currency })}
          </div>
        )}
        {provider === "mercadopago" && (
          <div className="hint" role="note">
            {b("billing.mpEmail", { email: me?.user.email ?? "" })}
          </div>
        )}
        <div className="plans-grid">
          {order.map((id, i) => {
            const p = data.plans.find((x) => x.id === id)!;
            const current = p.id === plan.id;
            const feats = newFeatures(i);
            return (
              <article key={id} className={`card pad plan-card${current ? " current" : ""}`} data-testid={`plan-${id}`}>
                <h3 className="h3" style={{ margin: 0 }}>
                  {p.name} {current && <span className="badge badge-ok">{b("billing.current")}</span>}
                </h3>
                <div className="price">
                  {price(p)} {p.price ? <small>{b("billing.perMonth")}</small> : null}
                </div>
                <ul>
                  <li>{p.envelopesPerMonth === null ? b("billing.unlimitedEnvelopes") : b("billing.envelopesPerMonth", { n: p.envelopesPerMonth })}</li>
                  <li>{p.users === null ? b("billing.unlimitedUsers") : b("billing.users", { n: p.users })}</li>
                  <li>
                    {p.aiTokensPerMonth === null
                      ? b("billing.unlimitedAi")
                      : p.aiTokensPerMonth === 0
                        ? b("billing.noAi")
                        : b("billing.aiTokens", { n: p.aiTokensPerMonth.toLocaleString(locale) })}
                  </li>
                  {i > 1 && feats.length > 0 && <li className="muted">{b("billing.everything")}</li>}
                  {feats.map((f) => (
                    <li key={f}>{b(`feature.${f}`)}</li>
                  ))}
                </ul>
                {!current && p.users !== null && usage.users > p.users && (
                  <p className="small hint" role="note" style={{ margin: 0 }}>
                    {b("billing.usersOver", { n: usage.users, max: p.users })}
                  </p>
                )}
                <div className="spacer" />
                {!current && (
                  <button
                    type="button"
                    className={id === "free" ? "btn btn-ghost" : "btn btn-primary"}
                    disabled={busy !== null || (id !== "free" && !provider)}
                    aria-busy={busy === `plan-${id}`}
                    onClick={() => void choose(id)}
                  >
                    {busy === `plan-${id}` ? b("billing.busy") : id === "free" ? b("billing.downgrade") : b("billing.choose", { plan: p.name })}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
