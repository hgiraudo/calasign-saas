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
  type SigningSession,
} from "@calasign/shared";
import { api, errorText, HttpError, isVersionChanged, runVersioned, type VersionedSave } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { formatMoney, useBillingText } from "../lib/i18n-billing";
import { parseAmountText } from "../lib/logic";
import { ErrorBox, Spinner } from "./ui";
import { prepareProviderTab, tokenOfBase } from "../lib/embed";
import { isStaleError } from "./SignerExtras";

/** Estados del sobre con los que ya no se puede pagar ni firmar. */
const CLOSED_ENVELOPE = ["voided", "expired", "declined"];

interface PaymentResponse {
  payment: EnvelopePayment | null;
  providers: PaymentProviderInfo[];
  /** updatedAt del sobre (configurar o quitar el cobro lo cambia). */
  envelopeUpdatedAt?: string;
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

/** Configuración del cobro en el paso de revisión de un borrador. */
export function PaymentOptionsPanel({
  envelopeId,
  recipients,
  onUnsavedChange,
  versioned,
}: {
  envelopeId: string;
  recipients: Recipient[];
  /** Control de versión del editor (configurar o quitar el cobro cambia el updatedAt del sobre). */
  versioned?: VersionedSave;
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

  // Un pagador que ya no es firmante (pasó a copia o aprobador) o un proveedor que dejó de estar configurado: el select
  // mostraba otra opción pero se conservaba el valor guardado, sin aviso de cambios sin guardar. Pasan a la primera
  // opción válida (y el cobro queda marcado como pendiente de guardar).
  useEffect(() => {
    if (signers[0] && !signers.some((s) => s.id === payer)) setPayer(signers[0].id);
  }, [signers, payer]);

  const configured = data?.providers.filter((p) => p.configured) ?? [];
  useEffect(() => {
    if (configured[0] && provider && !configured.some((p) => p.id === provider)) setProvider(configured[0].id);
  }, [configured, provider]);

  const stored = data?.payment ?? null;
  const unsaved =
    !!data &&
    enabled &&
    signers.length > 0 &&
    configured.length > 0 &&
    (!stored ||
      parseAmountText(amount) !== stored.amount ||
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
    const value = parseAmountText(amount);
    if (value === null) {
      setError(b("pay.amountInvalid"));
      return;
    }
    setBusy(true);
    try {
      const r = await runVersioned(
        versioned,
        (headers) =>
          api<PaymentResponse>(`/v1/envelopes/${envelopeId}/payment`, {
            method: "PUT",
            body: { amount: value, currency, description: description.trim(), payerRecipientId: payer, timing, provider },
            headers,
          }),
        (x) => x.envelopeUpdatedAt,
      );
      setData(r);
      setSaved(true);
    } catch (e) {
      // El editor ya avisa que el borrador cambió (con el botón para recargar).
      if (!(versioned && isVersionChanged(e))) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runVersioned(
        versioned,
        (headers) => api<PaymentResponse | undefined>(`/v1/envelopes/${envelopeId}/payment`, { method: "DELETE", headers }),
        (x) => x?.envelopeUpdatedAt,
      );
      // Una API anterior respondía 204 sin cuerpo.
      setData((d) => (r ? r : d ? { ...d, payment: null } : d));
      setEnabled(false);
      setSaved(false);
    } catch (e) {
      if (!(versioned && isVersionChanged(e))) setError(errorText(e));
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
      {/* Cobrado antes de que el sobre se cerrara sin completarse: no se reembolsa solo (docs/PAGOS-Y-AGENTES.md). */}
      {p.status === "paid" && !p.refundRequiredAt && CLOSED_ENVELOPE.includes(envelopeStatus) && (
        <p className="small" role="alert" data-testid="payment-settled-on-closed">
          {b("pay.settledOnClosed", { provider: p.provider === "mock" ? b("pay.provider.mock") : PROVIDER_LABEL[p.provider] })}
        </p>
      )}
    </section>
  );
}

/** Panel de pago del firmante. `info` viene de GET /v1/signing/:token/payment. */
function SignerPaymentPanel({
  base,
  info,
  onPaid,
  onStale,
}: {
  base: string;
  info: SignerPaymentInfo;
  onPaid: () => void;
  /** Vuelve a pedir la sesión del firmante (sobre cerrado, sesión vencida): la página muestra la pantalla que corresponde. */
  onStale: () => unknown;
}) {
  const b = useBillingText();
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Embebido, el pago se abre en otra pestaña: se consulta igual que al volver del proveedor.
  const [openedTab, setOpenedTab] = useState(false);
  const returned = openedTab ? "success" : typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("payment") : null;
  // onPaid suele venir como función inline: con una ref, el sondeo no se reinicia (ni reinicia su tope) en cada render.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;
  // El sondeo vio el pago de vuelta en pendiente o fallado (checkout descartado o rechazado): deja de mostrar
  // "confirmando" (el botón de pagar vuelve a servir).
  const [confirmStopped, setConfirmStopped] = useState(false);
  // Cada pago nuevo abierto en otra pestaña vuelve a arrancar el sondeo (aunque el anterior se haya cortado).
  const [pollRun, setPollRun] = useState(0);
  // Cobrado: pagado o ya reembolsado (el pago se hizo; reembolsado no es "pendiente").
  const settled = info.status === "paid" || info.status === "refunded";

  // Al volver del proveedor, el webhook puede tardar: se consulta hasta ver el pago confirmado. Cada 3 s el primer minuto
  // y medio y después cada 30 s (antes se dejaba de consultar a los 90 s y quedaba "confirmando" para siempre, con la
  // firma bloqueada si el pago era previo, hasta recargar la página).
  useEffect(() => {
    if (returned !== "success" || settled) return;
    setConfirmStopped(false);
    let n = 0;
    let id = 0;
    let done = false;
    const tick = () => {
      api<SignerPaymentInfo>(`${base}/payment`)
        .then(async (r) => {
          if (done) return;
          if (r.status === "paid" || r.status === "refunded") {
            done = true;
            window.clearTimeout(id);
            onPaidRef.current();
            return;
          }
          if (r.status === "pending" || r.status === "failed") {
            done = true;
            window.clearTimeout(id);
            setConfirmStopped(true);
            return;
          }
          if (r.canPay) return;
          // Ya no se puede pagar: si el sobre se cerró (anulado, vencido, rechazado) el pago no va a confirmarse; se deja
          // de consultar y se recarga la sesión para mostrar el cierre (antes quedaba "confirmando" para siempre).
          const closed = await api<SigningSession>(base).then(
            (s) => CLOSED_ENVELOPE.includes(s.envelope.status),
            (e) => e instanceof HttpError && [404, 410].includes(e.status),
          );
          if (closed && !done) {
            done = true;
            window.clearTimeout(id);
            void onStaleRef.current();
          }
        })
        .catch(() => {});
      if (!done) id = window.setTimeout(tick, ++n < 30 ? 3000 : 30000);
    };
    id = window.setTimeout(tick, 3000);
    return () => {
      done = true;
      window.clearTimeout(id);
    };
  }, [returned, settled, base, pollRun]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    const tab = prepareProviderTab(tokenOfBase(base));
    try {
      const r = await api<{ url: string }>(`${base}/payment/checkout`, { method: "POST" });
      if (tab.open(r.url) === "tab") {
        setOpenedTab(true);
        setPollRun((n) => n + 1);
        setBusy(false);
      }
    } catch (e) {
      tab.cancel();
      setError(errorText(e));
      setBusy(false);
      // Ya pagado o en proceso (otra pestaña, el webhook llegó): se vuelve a consultar el pago en lugar de dejar el botón.
      if (e instanceof HttpError && e.status === 409 && (e.code === "already_paid" || e.code === "payment_processing")) onPaid();
      else if (isStaleError(e)) void onStale();
    }
  };

  const amount = formatMoney(info.amount ?? 0, info.currency ?? "USD", locale);
  if (settled) {
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
      {returned === "success" && !confirmStopped && <p className="small" role="status">{b("signerPay.confirming")}</p>}
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
  const [error, setError] = useState<string | null>(null);
  // Solo cuenta la respuesta del último pedido (un reintento no queda pisado por uno anterior que llega tarde).
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    api<SignerPaymentInfo>(`${base}/payment`)
      .then((i) => {
        if (mine !== seq.current) return;
        setInfo(i);
        setError(null);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setInfo(null);
        setError(errorText(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoaded(true);
      });
  }, [base]);
  useEffect(load, [load]);
  /** Reintento después de un error: vuelve al indicador de carga mientras tanto. */
  const retry = useCallback(() => {
    setLoaded(false);
    setError(null);
    load();
  }, [load]);
  return { info, loaded, error, reload: load, retry };
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
      onStale={onPaid}
    />
  );
}

/**
 * Antes de firmar (before_sign): si el pago bloquea la firma, muestra el pago en lugar del flujo de firma.
 * Si no se pudo consultar el pago (429, red, 5xx) se muestra el error con "Reintentar": antes se dejaba pasar al
 * formulario y "Finalizar" fallaba con 402. `check` vuelve a consultar (p. ej. después de ese 402); el flujo de firma
 * queda montado (oculto) mientras se muestra el pago, para no perder lo que el firmante ya completó.
 */
export function PaymentGate({
  base,
  children,
  wrap,
  check = 0,
  onStale,
}: {
  base: string;
  children: ReactNode;
  wrap: (n: ReactNode) => ReactNode;
  check?: number;
  /** Vuelve a pedir la sesión: el pago bloquea la firma pero ya no se puede pagar (sobre cerrado, turno cambiado). */
  onStale: () => unknown;
}) {
  const b = useBillingText();
  const { info, loaded, error, reload, retry } = usePaymentInfo(base);
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;
  // Pago que bloquea la firma pero que no se puede hacer (el sobre se anuló o venció, el firmante ya no está en turno):
  // antes quedaba el panel sin botón. Se recarga la sesión una vez por consulta del pago y, mientras, un indicador; si
  // la página sigue en el flujo, se muestra el panel.
  const needsResync = loaded && !!info?.required && info.blocksSigning && !info.canPay;
  const staleFor = useRef<SignerPaymentInfo | null>(null);
  const [resynced, setResynced] = useState<SignerPaymentInfo | null>(null);
  useEffect(() => {
    if (!needsResync || !info || staleFor.current === info) return;
    staleFor.current = info;
    void Promise.resolve(onStaleRef.current()).finally(() => setResynced(info));
  }, [needsResync, info]);
  const shown = useRef(false);
  const lastCheck = useRef(check);
  useEffect(() => {
    if (lastCheck.current === check) return;
    lastCheck.current = check;
    reload();
  }, [check, reload]);
  const gate = !loaded ? (
    <Spinner />
  ) : info?.required && info.blocksSigning ? (
    needsResync && resynced !== info ? (
      <Spinner />
    ) : (
      <SignerPaymentPanel base={base} info={info} onPaid={reload} onStale={onStale} />
    )
  ) : error ? (
    <div className="card pad stack">
      <ErrorBox error={b("signerPay.loadError", { error })} />
      <button type="button" className="btn btn-primary btn-block" onClick={retry}>
        {b("signerPay.retry")}
      </button>
    </div>
  ) : null;
  if (!gate) shown.current = true;
  // Misma estructura con y sin el paso de pago (el formulario siempre en la segunda posición y dentro del mismo div): si
  // cambiaba, React lo desmontaba y al volver del pago el firmante encontraba el formulario vacío. Oculto mientras se
  // ve el pago; sin el pago, el div no altera el diseño (display: contents).
  return (
    <>
      {gate ? wrap(gate) : null}
      {(shown.current || !gate) && (
        <div hidden={!!gate} style={gate ? undefined : { display: "contents" }}>
          {children}
        </div>
      )}
    </>
  );
}
