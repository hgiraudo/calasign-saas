// Cobro ya hecho en un sobre que se cierra sin completarse (anulado, rechazado, vencido). Módulo sin dependencias de
// rutas: lo usan los cierres de envelopes.ts, signing.ts, jobs.ts y agreements/workflows.ts sin ciclos.
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";

/**
 * Llamar en la transacción que pasa el sobre a voided/declined/expired, después del UPDATE. Si el firmante ya había
 * pagado (status 'paid' y no es un pago que llegó con el sobre cerrado, que se reembolsa solo: refund_required_at), deja
 * constancia en la evidencia (payment.settled_on_closed_envelope). NO se reembolsa automáticamente: la política de
 * reembolso es una decisión de producto pendiente (docs/PAGOS-Y-AGENTES.md); el remitente ve el aviso en el detalle del
 * sobre y lo revisa o reembolsa desde el proveedor.
 */
export async function noteSettledPaymentOnClose(
  t: Db,
  envelopeId: string,
  closedStatus: "voided" | "declined" | "expired",
  actor: Actor,
): Promise<void> {
  const p = await t.one<any>(
    `SELECT id, tenant_id, amount, currency, provider, provider_payment_id, recipient_id FROM envelope_payments
      WHERE envelope_id = $1 AND status = 'paid' AND refund_required_at IS NULL`,
    [envelopeId],
  );
  if (!p) return;
  await appendEvent(t, {
    tenantId: p.tenant_id,
    envelopeId,
    type: "payment.settled_on_closed_envelope",
    actor,
    data: {
      paymentId: p.id,
      amount: Number(p.amount),
      currency: p.currency,
      provider: p.provider,
      providerPaymentId: p.provider_payment_id ?? null,
      payerRecipientId: p.recipient_id,
      envelopeStatus: closedStatus,
      refund: "manual",
    },
  });
}
