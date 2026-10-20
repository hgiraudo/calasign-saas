// Ajustes → Plan y facturación: plan actual, uso del mes, planes con precios locales y suscripción.
import { useEffect, useState } from "react";
import { BILLING_CURRENCIES, PLAN_FEATURES, type BillingOverview, type BillingProvider, type PlanDefinition, type PlanFeature, type PlanId } from "@calasign/shared";
import { useAccess } from "../lib/access";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
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

function UsageBar({ used, max }: { used: number; max: number | null }) {
  if (max === null) return null;
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className={`usage-bar${pct >= 80 ? " warn" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function BillingPage() {
  const b = useBillingText();
  useTitle(b("billing.title"));
  const { locale } = useI18n();
  const [data, setData] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<BillingProvider | "">("");
  // Las funciones del plan que usa el resto de la consola (avisos, botones) se vuelven a leer con cada cambio de plan.
  const { refresh: refreshAccess } = useAccess();
  const checkout = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("checkout") : null;

  const load = () =>
    api<BillingOverview>("/v1/billing")
      .then((d) => {
        setData(d);
        void refreshAccess();
        setProvider((p) => p || d.providers.find((x) => x.configured)?.id || "");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    // Al volver del checkout el webhook del proveedor puede activar el plan unos segundos después.
    if (checkout !== "success") return;
    const timers = [4000, 15000].map((ms) => window.setTimeout(() => void load(), ms));
    return () => timers.forEach((x) => window.clearTimeout(x));
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
        if (!window.confirm(b("billing.downgradeConfirm"))) return;
        setData(await api<BillingOverview>("/v1/billing/cancel", { method: "POST" }));
        void refreshAccess();
        return;
      }
      const r = await api<{ url: string }>("/v1/billing/checkout", { method: "POST", body: { plan: id, currency, provider: provider || undefined } });
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
      {checkout === "success" && (
        <p className="card pad" role="status">
          ✓ {b("billing.success")}
        </p>
      )}
      {checkout === "cancel" && (
        <p className="card pad" role="alert">
          {b("billing.canceledCheckout")}
        </p>
      )}
      <ErrorBox error={error} />

      <section className="card pad stack" aria-labelledby="current-plan">
        <div className="row-wrap" style={{ justifyContent: "space-between" }}>
          <div>
            <p className="muted small" style={{ margin: 0 }}>
              {data.defaultPlan ? b("billing.defaultPlan") : b("billing.currentPlan")}
            </p>
            <h2 id="current-plan" style={{ margin: 0 }}>
              {plan.name}
            </h2>
            {data.subscription.provider && (
              <p className="small muted" style={{ margin: "4px 0 0" }}>
                {b("billing.provider", { provider: (data.subscription.provider === "mock" ? b("pay.provider.mock") : PROVIDER_LABEL[data.subscription.provider]) })}
                {data.subscription.status ? ` · ${b("billing.status", { status: SUB_STATUS[data.subscription.status] ? b(SUB_STATUS[data.subscription.status]) : data.subscription.status })}` : ""}
                {data.subscription.renewsAt ? ` · ${b("billing.renews", { date: formatDateTime(data.subscription.renewsAt, locale) })}` : ""}
              </p>
            )}
          </div>
          <div className="row-wrap">
            <label className="field">
              <span>{b("billing.currency")}</span>
              <select
                value={currency}
                onChange={(e) => void run("currency", async () => setData(await api<BillingOverview>("/v1/billing/currency", { method: "PATCH", body: { currency: e.target.value } })))}
                data-testid="billing-currency"
              >
                {BILLING_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {(data.subscription.portalAvailable ?? data.subscription.provider === "stripe") && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void run("portal", async () => window.location.assign((await api<{ url: string }>("/v1/billing/portal", { method: "POST" })).url))}
              >
                {b("billing.manage")}
              </button>
            )}
          </div>
        </div>

        <h3 className="h3" style={{ marginBottom: 0 }}>
          {b("billing.usage", { period: usage.period })}
        </h3>
        <div className="usage-list">
          <div className="usage-item">
            <span className="small strong">{b("usage.envelopes")}</span>
            <span className="small">
              {plan.envelopesPerMonth === null ? b("usage.unlimited", { used: usage.envelopesSent }) : b("usage.of", { used: usage.envelopesSent, max: plan.envelopesPerMonth })}
            </span>
            <UsageBar used={usage.envelopesSent} max={plan.envelopesPerMonth} />
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.users")}</span>
            <span className="small">{plan.users === null ? b("usage.unlimited", { used: usage.users }) : b("usage.of", { used: usage.users, max: plan.users })}</span>
            <UsageBar used={usage.users} max={plan.users} />
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.messages")}</span>
            <span className="small">
              Email {usage.messages.email} · WhatsApp {usage.messages.whatsapp} · SMS {usage.messages.sms} · Telegram {usage.messages.telegram}
            </span>
          </div>
          <div className="usage-item">
            <span className="small strong">{b("usage.kyc")}</span>
            <span className="small">{usage.kycChecks}</span>
          </div>
          {usage.aiTokens !== null && (
            <div className="usage-item">
              <span className="small strong">{b("usage.ai")}</span>
              <span className="small">
                {plan.aiTokensPerMonth === null || plan.aiTokensPerMonth === 0
                  ? usage.aiTokens.toLocaleString(locale)
                  : b("usage.of", { used: usage.aiTokens.toLocaleString(locale), max: plan.aiTokensPerMonth.toLocaleString(locale) })}
              </span>
              {plan.aiTokensPerMonth ? <UsageBar used={usage.aiTokens} max={plan.aiTokensPerMonth} /> : null}
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
                  {p.id === "mock" ? b("pay.provider.mock") : PROVIDER_LABEL[p.id]}
                  {p.configured ? "" : ` (${b("billing.notConfigured")})`}
                </option>
              ))}
            </select>
          </label>
        </div>
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
                <div className="spacer" />
                {!current && (
                  <button
                    type="button"
                    className={id === "free" ? "btn btn-ghost" : "btn btn-primary"}
                    disabled={busy !== null || (id !== "free" && !provider)}
                    onClick={() => void choose(id)}
                  >
                    {busy === `plan-${id}` ? "…" : id === "free" ? b("billing.downgrade") : b("billing.choose", { plan: p.name })}
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
