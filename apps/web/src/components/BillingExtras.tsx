// Cobro al firmar: panel del remitente (borrador), resumen en el detalle y panel/puerta del firmante.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PAYMENT_CURRENCIES,
  PAYMENT_METHOD_CODES,
  type EnvelopePayment,
  type PaymentProvider,
  type PaymentProviderInfo,
  type PaymentTiming,
  type Recipient,
  type SignerPaymentInfo,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { formatMoney, useBillingText } from "../lib/i18n-billing";
import { ErrorBox, Spinner } from "./ui";

interface PaymentResponse {
  payment: EnvelopePayment | null;
  providers: PaymentProviderInfo[];
}

const PROVIDER_LABEL: Record<Exclude<PaymentProvider, "mock">, string> = { stripe: "Stripe", mercadopago: "Mercado Pago" };

/**
 * Medios del proveedor traducidos por código (`methodCodes`). `methods` es texto en español de la API: se usa solo si
 * una API vieja no manda los códigos, o para un código que esta versión de la web todavía no conoce.
 */
function methodLabels(p: PaymentProviderInfo | undefined, b: ReturnType<typeof useBillingText>): string {
  if (!p) return "";
  const codes = p.methodCodes ?? [];
  if (!codes.length) return p.methods.join(", ");
  return codes
    .map((c, i) => ((PAYMENT_METHOD_CODES as readonly string[]).includes(c) ? b(`pay.method.${c}` as "pay.method.card") : p.methods[i] ?? c))
    .join(", ");
}

/**
 * Monto escrito por el remitente, con el mismo criterio que la API: 1.234,56 · 1,234.56 · 1.500.000. Antes se hacía
 * Number(amount.replace(",", ".")): "1.500,00" (el formato habitual en Brasil, la moneda por defecto) daba NaN, que
 * viaja como null, y el cobro no se podía guardar ("Expected number, received null").
 */
function parsePaymentAmount(raw: string): number | null {
  let s = raw.trim().replace(/[^\d,.-]/g, "");
  if (!/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (/^-?\d{1,3}([.,])\d{3}(?:\1\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Configuración del cobro en el paso de revisión de un borrador. */
export function PaymentOptionsPanel({
  envelopeId,
  recipients,
  onUnsavedChange,
}: {
  envelopeId: string;
  recipients: Recipient[];
  /** Avisa si hay un cobro cargado sin guardar (el envío no lo toma: se guarda con su propio botón). */
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const b = useBillingText();
  const signers = recipients.filter((r) => r.role === "signer");
  const [data, setData] = useState<PaymentResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("BRL");
  const [description, setDescription] = useState("");
  const [payer, setPayer] = useState("");
  const [timing, setTiming] = useState<PaymentTiming>("after_sign");
  const [provider, setProvider] = useState<PaymentProvider | "">("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PaymentResponse>(`/v1/envelopes/${envelopeId}/payment`)
      .then((r) => {
        setData(r);
        const p = r.payment;
        if (p) {
          setEnabled(true);
          setAmount(String(p.amount));
          setCurrency(p.currency);
          setDescription(p.description);
          setPayer(p.payerRecipientId);
          setTiming(p.timing);
          setProvider(p.provider);
        } else {
          const first = r.providers.find((x) => x.configured);
          if (first) setProvider(first.id);
        }
      })
      .catch((e) => setError(errorText(e)));
  }, [envelopeId]);

  useEffect(() => {
    if (!payer && signers[0]) setPayer(signers[0].id);
  }, [signers, payer]);

  const configured = data?.providers.filter((p) => p.configured) ?? [];

  const stored = data?.payment ?? null;
  const unsaved =
    !!data &&
    enabled &&
    signers.length > 0 &&
    configured.length > 0 &&
    (!stored ||
      parsePaymentAmount(amount) !== stored.amount ||
      currency !== stored.currency ||
      description.trim() !== stored.description ||
      payer !== stored.payerRecipientId ||
      timing !== stored.timing ||
      provider !== stored.provider);
  const onUnsavedRef = useRef(onUnsavedChange);
  onUnsavedRef.current = onUnsavedChange;
  useEffect(() => onUnsavedRef.current?.(unsaved), [unsaved]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const value = parsePaymentAmount(amount);
    if (value === null) {
      setError(b("pay.amountInvalid"));
      return;
    }
    setBusy(true);
    try {
      const r = await api<PaymentResponse>(`/v1/envelopes/${envelopeId}/payment`, {
        method: "PUT",
        body: { amount: value, currency, description: description.trim(), payerRecipientId: payer, timing, provider },
      });
      setData(r);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/envelopes/${envelopeId}/payment`, { method: "DELETE" });
      setData((d) => (d ? { ...d, payment: null } : d));
      setEnabled(false);
      setSaved(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <ErrorBox error={error} /> : null;
  return (
    <section className="card pad stack" aria-labelledby="payment-options-title">
      <h2 id="payment-options-title" className="h3">
        {b("pay.panelTitle")}
      </h2>
      <p className="muted small">{b("pay.panelIntro")}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            // Con un cobro guardado, se destilda solo si el borrado salió bien (remove lo hace): si fallaba, la casilla
            // quedaba destildada pero el sobre seguía cobrando al enviarse.
            if (!e.target.checked && data.payment) void remove();
            else setEnabled(e.target.checked);
          }}
          data-testid="payment-enable"
        />
        {b("pay.enable")}
      </label>
      {enabled &&
        (signers.length === 0 ? (
          <p className="muted small">{b("pay.noSigners")}</p>
        ) : configured.length === 0 ? (
          <p className="muted small">{b("pay.noProviders")}</p>
        ) : (
          <>
            <div className="row-wrap">
              <label className="field grow">
                <span>{b("pay.amount")}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150,00" data-testid="payment-amount" />
              </label>
              <label className="field">
                <span>{b("pay.currency")}</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {PAYMENT_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>{b("pay.description")}</span>
              <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} data-testid="payment-description" />
            </label>
            <div className="row-wrap">
              <label className="field grow">
                <span>{b("pay.payer")}</span>
                <select value={payer} onChange={(e) => setPayer(e.target.value)}>
                  {signers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>{b("pay.provider")}</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value as PaymentProvider)}>
                  {configured.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === "mock" ? b("pay.provider.mock") : PROVIDER_LABEL[p.id]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {provider && <p className="muted small">{b("pay.methods", { methods: methodLabels(configured.find((p) => p.id === provider), b) })}</p>}
            <fieldset className="stack-sm">
              <legend className="small strong">{b("pay.timing")}</legend>
              {(["after_sign", "before_sign"] as const).map((x) => (
                <label key={x} className="check">
                  <input type="radio" name="payment-timing" checked={timing === x} onChange={() => setTiming(x)} />
                  {b(`pay.timing.${x}`)}
                </label>
              ))}
            </fieldset>
            <div className="row-wrap">
              <button
                type="button"
                className="btn"
                disabled={busy || !amount || !description.trim() || !payer || !provider}
                onClick={() => void save()}
                data-testid="payment-save"
              >
                {b("pay.save")}
              </button>
              {data.payment && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
                  {b("pay.remove")}
                </button>
              )}
              {saved && (
                <span className="small" role="status">
                  ✓ {b("pay.saved")}
                </span>
              )}
            </div>
          </>
        ))}
      <ErrorBox error={error} />
    </section>
  );
}

/** Estado del cobro en el detalle del sobre. No muestra nada si el sobre no cobra. */
export function EnvelopePaymentSummary({ envelopeId, recipients, envelopeStatus }: { envelopeId: string; recipients: Recipient[]; envelopeStatus: string }) {
  const b = useBillingText();
  const { locale } = useI18n();
  const [p, setP] = useState<EnvelopePayment | null>(null);
  useEffect(() => {
    api<PaymentResponse>(`/v1/envelopes/${envelopeId}/payment`)
      .then((r) => setP(r.payment))
      .catch(() => setP(null));
  }, [envelopeId, envelopeStatus]);
  if (!p) return null;
  const payer = recipients.find((r) => r.id === p.payerRecipientId)?.name ?? "—";
  const allSigned = recipients.filter((r) => r.role === "signer").every((r) => r.status === "signed" || r.status === "completed");
  return (
    <section className="card pad stack-sm" aria-labelledby="payment-summary-title" data-testid="payment-summary">
      <h2 id="payment-summary-title" className="h3">
        {b("pay.detailTitle")}{" "}
        <span className={`badge ${p.status === "paid" ? "badge-ok" : p.status === "refunded" ? "badge-voided" : ""}`}>{b(`pay.status.${p.status}`)}</span>
      </h2>
      <p className="small">{b("pay.detailLine", { amount: formatMoney(p.amount, p.currency, locale), description: p.description, payer })}</p>
      {p.status === "refunded" && <p className="small muted">{b("pay.refundedLine")}</p>}
      {p.status !== "paid" && envelopeStatus === "sent" && allSigned && <p className="small muted">{b("pay.waitingEnvelope")}</p>}
    </section>
  );
}

/** Panel de pago del firmante. `info` viene de GET /v1/signing/:token/payment. */
function SignerPaymentPanel({ base, info, onPaid }: { base: string; info: SignerPaymentInfo; onPaid: () => void }) {
  const b = useBillingText();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returned = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("payment") : null;
  // onPaid suele venir como función inline: con una ref, el sondeo no se reinicia (ni reinicia su tope) en cada render.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  // Al volver del proveedor, el webhook puede tardar unos segundos: se consulta hasta ver el pago confirmado.
  useEffect(() => {
    if (returned !== "success" || info.status === "paid") return;
    let n = 0;
    const id = window.setInterval(() => {
      n++;
      api<SignerPaymentInfo>(`${base}/payment`)
        .then((r) => {
          if (r.status === "paid") {
            window.clearInterval(id);
            onPaidRef.current();
          }
        })
        .catch(() => {});
      if (n > 30) window.clearInterval(id);
    }, 3000);
    return () => window.clearInterval(id);
  }, [returned, info.status, base]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>(`${base}/payment/checkout`, { method: "POST" });
      window.location.assign(r.url);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const amount = formatMoney(info.amount ?? 0, info.currency ?? "USD", locale);
  if (info.status === "paid") {
    return (
      <p className="small" role="status" data-testid="signer-payment-paid">
        ✓ {b("signerPay.paid")}
      </p>
    );
  }
  return (
    <section className="card pad stack" aria-labelledby="signer-pay-title" data-testid="signer-payment">
      <h2 id="signer-pay-title" className="h3">
        {b("signerPay.title")}
      </h2>
      <p>{info.timing === "before_sign" ? b("signerPay.before") : b("signerPay.after")}</p>
      <p className="small muted">{info.description}</p>
      <p style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>{amount}</p>
      {returned === "success" && <p className="small" role="status">{b("signerPay.confirming")}</p>}
      {returned === "cancel" && <p className="small" role="alert">{b("signerPay.canceled")}</p>}
      {info.canPay && (
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void pay()} data-testid="signer-pay-button">
          {busy ? b("signerPay.redirecting") : b("signerPay.button", { amount })}
        </button>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

function usePaymentInfo(base: string) {
  const [info, setInfo] = useState<SignerPaymentInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    api<SignerPaymentInfo>(`${base}/payment`)
      .then(setInfo)
      .catch(() => setInfo(null))
      .finally(() => setLoaded(true));
  }, [base]);
  useEffect(load, [load]);
  return { info, loaded, reload: load };
}

/** Después de firmar (after_sign): muestra el pago pendiente, si le toca a este firmante. */
export function SignerPaymentAfterSign({ base, onPaid }: { base: string; onPaid: () => void }) {
  const { info, reload } = usePaymentInfo(base);
  if (!info?.required) return null;
  return (
    <SignerPaymentPanel
      base={base}
      info={info}
      onPaid={() => {
        reload();
        onPaid();
      }}
    />
  );
}

/** Antes de firmar (before_sign): si el pago bloquea la firma, muestra el pago en lugar del flujo de firma. */
export function PaymentGate({ base, children, wrap }: { base: string; children: ReactNode; wrap: (n: ReactNode) => ReactNode }) {
  const { info, loaded, reload } = usePaymentInfo(base);
  if (!loaded) return <>{wrap(<Spinner />)}</>;
  if (info?.required && info.blocksSigning) return <>{wrap(<SignerPaymentPanel base={base} info={info} onPaid={reload} />)}</>;
  return <>{children}</>;
}
