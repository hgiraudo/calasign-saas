# Cobros, planes y agentes de IA (Fase 6)

## 1. Cobro al firmar

Un sobre puede cobrarle a uno de sus firmantes (`PUT /v1/envelopes/:id/payment`, solo en borrador):

| Campo | Qué es |
|---|---|
| `amount`, `currency` | Monto en unidades (150.50) y moneda ISO (BRL, COP, DOP, HNL, USD, MXN, ARS, EUR). |
| `payerRecipientId` | Firmante que paga. |
| `timing` | `after_sign` (por defecto): firma y después paga; **el sobre recién se completa y se sella cuando el pago se confirma**. `before_sign`: no puede completar la firma hasta pagar (402 `payment_required`). |
| `provider` | `stripe`, `mercadopago` o `mock` (solo fuera de producción). |

Flujo del firmante: `GET /v1/signing/:token/payment` (si le toca pagar, monto y estado) → `POST /v1/signing/:token/payment/checkout`
→ redirección al proveedor → vuelve a `/s/:token?payment=success`. La confirmación **solo** llega por webhook verificado
(o por la página del proveedor simulado). Eventos: `payment.configured`, `payment.checkout_created`, `envelope.awaiting_payment`,
`payment.failed`, `payment.completed`, `payment.refunded`, `payment.partially_refunded`, `payment.disputed`. El comprobante (monto, pagador, medio, referencia, fecha) va en el certificado de finalización.

**Cambios del pagador y cierres** (barrido periódico del worker):

- Si el pagador cambia (delegación, reasignación o corrección de su correo o teléfono), el cobro pasa al nuevo
  destinatario y el checkout armado para el anterior se descarta: va a la cola de cierre (`stale_checkout_ids`, se
  acumulan si se descartan varios antes del barrido) y a la lista permanente `discarded_checkout_refs`. El barrido los
  cierra en el proveedor; si el proveedor ya no lo conoce (404), se suelta; si falla por otra cosa, se reintenta al
  final de la cola. Un pago que igual llegue por un checkout descartado se reembolsa y el cobro sigue pendiente, también
  cuando el pagador es el mismo destinatario con el contacto corregido (`checkout_ref`: id de la sesión en Stripe,
  referencia propia en el `external_reference` de Mercado Pago). La clave de idempotencia de Stripe incluye el link
  vigente del pagador.
- Dos pedidos de checkout simultáneos no dejan dos checkouts cobrables: si otro se guardó mientras tanto, se entrega
  ese y el nuevo se cierra. El checkout no se ofrece con el sobre vencido aunque el barrido no lo haya marcado.
- Un sobre anulado, rechazado o vencido cierra su checkout abierto (`payment.checkout_closed`).
- Un pago que se acredita con el sobre ya cerrado se reembolsa en el proveedor (`refund_required_at`). Un segundo
  cobro del mismo sobre (dos checkouts pagados) también se reembolsa, en Stripe y en Mercado Pago.
- Un sobre que superó su vencimiento no se corrige, reasigna ni delega.
- **Reembolsos y contracargos hechos en el proveedor** (Stripe `charge.refunded` y `charge.dispute.created`; Mercado
  Pago, pagos en `refunded` o `charged_back`): sobre el pago acreditado del cobro. Reembolso total → el cobro pasa a
  `refunded` (`payment.refunded`, `reason: "provider"`); parcial → solo `payment.partially_refunded`; disputa →
  `disputedAt` y `payment.disputed`. **El estado del sobre no cambia**: un cobro reembolsado cuenta como ya pagado (no
  traba la firma ni la finalización). No hay eventos de webhook de salida para cobros (no existe un tipo adecuado).
  Límites conocidos:
  - Un reembolso o contracargo hecho por el vendedor desde el panel del proveedor **antes de que se firme** tampoco
    traba la firma: el firmante sigue pudiendo firmar sin haber pagado efectivamente. Queda registrado en el cobro y la
    evidencia; si eso debe volver a exigir el pago es una **decisión pendiente del producto**.
  - En Mercado Pago solo se registran los reembolsos **totales** (el pago pasa a `refunded`); los parciales no cambian
    el estado del pago en la notificación y no se registran.
  - Las preferencias de Mercado Pago creadas antes de la migración 0063 no llevan la referencia del checkout
    (`checkoutRef`) en el `external_reference`: un pago tardío por una preferencia vieja descartada por una corrección
    de contacto del mismo pagador no se puede distinguir de la vigente y se acredita como antes (sin reembolso).
- **Plan**: enviar un borrador con cobro exige que el plan incluya `payments` (402 `plan_limit`) y que el proveedor
  esté configurado (400 `provider_not_configured`), en todos los caminos de envío.

### Medios de pago por país

| Proveedor | Cómo se cobra | Medios locales |
|---|---|---|
| **Mercado Pago** (Checkout Pro) | Preferencia + `init_point`; notificación `payment` → se consulta `GET /v1/payments/{id}` | **Pix** (Brasil), **PSE** (Colombia), boleto (Brasil), tarjetas, efectivo según país. Disponible en Brasil y Colombia; **no opera en República Dominicana ni Honduras**. |
| **Stripe** (Checkout) | Checkout Session `mode=payment`; webhook `checkout.session.completed` / `async_payment_succeeded` | Tarjeta y billeteras en todos los países donde la cuenta opera; **Pix** solo en cuentas de Stripe de Brasil (se habilita en el Dashboard: no se fija `payment_method_types`, así que los medios salen de la configuración de la cuenta). Stripe no ofrece PSE. |

Para RD y Honduras: Stripe (tarjeta) o un procesador local que se agregue como adaptador nuevo (`modules/billing/providers.ts`).

**Perú:** Mercado Pago opera en Perú (tarjetas y medios locales según la cuenta); Yape/Plin y procesadores como Niubiz, Izipay o Culqi quedan como adaptadores futuros. Verificar disponibilidad de Stripe para empresas peruanas antes de ofrecerlo. Los planes tienen precio en **PEN** (`BILLING_CURRENCIES`) y los cobros dentro de la firma aceptan PEN.

### Webhooks

| Proveedor | URL | Verificación |
|---|---|---|
| Stripe | `POST /v1/integrations/payments/stripe/webhook` | `Stripe-Signature` (`t=…,v1=HMAC-SHA256(secret, "t.body")`), tolerancia 5 min, cuerpo crudo |
| Mercado Pago | `POST /v1/integrations/payments/mercadopago/webhook` | `x-signature` (`ts=…,v1=HMAC-SHA256(secret, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;")`); el estado se lee de la API, nunca del cuerpo |

Cada evento se procesa hasta terminar una vez (`payment_webhook_events`, `processed_at` al terminar): uno ya procesado
responde 200 `duplicate`; uno recibido y en curso hace menos de 10 minutos (`WEBHOOK_IN_PROGRESS_SECONDS`, holgado
frente a los timeouts de 20 s de cada llamada al proveedor) responde **409 `event_in_progress`** (el proveedor
reintenta); uno sin terminar más viejo (el proceso murió) se reprocesa (los manejadores son idempotentes). Cada toma
lleva su marca (`claim_id`): si el procesamiento falla se borra la marca para que el proveedor reintente, pero solo si
sigue siendo la propia (si otro pedido lo retomó, no se le borra); al terminar bien se marca procesado aunque otro lo
haya retomado (o se vuelve a crear la fila si ya no está).

Cambio de suscripción (una nueva confirmada con otra vigente): con la organización bloqueada se aplica la nueva y la
anterior queda registrada como pendiente de cancelar (`subscription_cancellations`); después, fuera del bloqueo, se
cancela en el proveedor y se borra la marca. Así el aviso de baja de la anterior (Stripe
`customer.subscription.deleted`, Mercado Pago `cancelled`) llega cuando ya no es la vigente y se ignora (antes podía
llegar entre la cancelación y el alta y bajar la organización a Free). Si la cancelación falla, el evento igual se da
por procesado y el barrido periódico la reintenta (las que llevan más de un minuto sin intento); una que volvió a ser
la vigente no se cancela. En Mercado Pago, si la autorizada es de un checkout más viejo que la vigente, se cancela esa
y la vigente queda.
El monto y la moneda pagados se comparan con el cobro antes de acreditarlo.

## 2. Planes

| Plan | Sobres/mes | Usuarios | Incluye |
|---|---|---|---|
| Free | 5 | 1 | Firma web |
| Starter | 50 | 3 | + API (keys, OAuth, MCP), webhooks, marca |
| Business | 1.000 | 50 | + cobro al firmar, envío masivo, formularios web, verificación de identidad |
| Enterprise | ilimitado | ilimitado | + SSO, SCIM, dominio propio |

Precios mensuales por moneda en `packages/shared/src/billing.ts` (`PLAN_PRICES`; lista local, no conversión diaria).

- **Control central**: `enforcePlanForRequest` (desde `access.ts`) para acceso por API y rutas de escritura de cada funcionalidad;
  `enforceEnvelopeQuota` dentro de `sendEnvelope` (cubre web, API, envío masivo y formularios). Respuesta: **402 `plan_limit`**
  con `details: { plan, limit|feature, used, max, suggestedPlan, upgradeUrl }`. Las lecturas nunca se bloquean.
- **Plan por defecto** (organizaciones sin suscripción): `BILLING_DEFAULT_PLAN`; si no se define, `free` en producción y
  `enterprise` fuera de producción (las pruebas no chocan con límites). Las organizaciones existentes al migrar quedaron en Business.
- **Mes de cupo**: del día 1 a las 00:00 **UTC** (no en la zona de la organización): en UTC-3 el cupo se renueva el
  último día del mes a las 21:00 hora local.
- **Uso del mes**: se calcula de las tablas de negocio (sobres enviados, usuarios + invitaciones, mensajes por canal,
  verificaciones de identidad y tokens de IA si existe la tabla `ai_usage`).
- **Suscripción**: `POST /v1/billing/checkout` → Stripe Billing (Checkout `mode=subscription` + portal) o Mercado Pago
  (`preapproval`), o el simulado (nunca en producción, aunque `PAYMENTS_MOCK_ENABLED` esté prendida). Baja:
  `POST /v1/billing/cancel` (Mercado Pago/simulado) o el portal de Stripe. El portal de Stripe sigue disponible
  después de cancelar (`portalAvailable`: la organización conserva su cliente de Stripe, para ver facturas o volver a
  suscribirse). Una suscripción de Stripe en `unpaid` baja la organización a Free pero queda vinculada: si se paga
  la factura y vuelve a `active`, recupera el plan. Permiso `billing:manage` (propietarios y administradores).

## 3. Servidor MCP para agentes de IA

`POST /mcp` — Streamable HTTP, sin sesión, respuestas JSON. Credencial: `Authorization: Bearer <access token OAuth | API key>`.
Descubrimiento OAuth: `/.well-known/oauth-protected-resource` (RFC 9728) y `/.well-known/oauth-authorization-server` (RFC 8414).

Herramientas: `list_envelopes`, `get_envelope`, `get_signing_status`, `list_templates`, `get_account`,
`create_envelope_from_template` y `create_envelope` (desde un PDF en base64 o URL https; por defecto crean en borrador; con
`send: true` lo crean y lo envían en una sola llamada; aceptan `locale`: es, pt-BR, en; son idempotentes: los mismos
argumentos, o el mismo `requestId`, devuelven el mismo sobre), `send_envelope`, `void_envelope` y `remind_recipients`.
Las acciones con efecto (y la creación con `send: true`) van en **dos pasos**: sin `confirmToken` devuelven una vista
previa con un `confirmToken` (HMAC con clave derivada de `SECRET_KEY` de acción + sobre o argumentos + `updatedAt` +
credencial, 5 min); con él ejecutan, y enviar/anular/recordar mandan `X-Expected-Updated-At` con la versión aprobada
(409 `version_changed` si el sobre cambió). El texto de terceros (asuntos, nombres, motivos, actores) vuelve como
`{"untrusted": …}` con un `_notice`. `download_signed_pdf`: URL temporal (`MCP_DOWNLOAD_TTL_SEC`, por defecto 15 min),
hasta 3 descargas y solo mientras la credencial que la pidió siga vigente. `get_account` devuelve el uso del mes solo
con `envelopes:view_all` o `billing:manage`. Todas llevan anotaciones MCP
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`).

Conectarlo desde Claude, ChatGPT, Claude Code o Gemini CLI con solo la URL (registro dinámico de clientes OAuth):
ver [MCP-CONECTORES.md](MCP-CONECTORES.md).

Cada herramienta llama a la API v1 por dentro con la misma credencial: valen los scopes del token, el rol, los límites del
plan y la misma evidencia; las acciones quedan con actor **«agente IA (&lt;app o key&gt;)»**.

## 4. Variables de entorno

| Variable | Uso |
|---|---|
| `BILLING_DEFAULT_PLAN` | Plan de las organizaciones sin suscripción. |
| `PAYMENTS_MOCK_ENABLED` | Habilita el proveedor simulado de los cobros al firmar en producción (no recomendado; fuera de producción siempre está). No afecta las suscripciones: la simulada nunca se ofrece en producción. |
| `IDV_MOCK_ENABLED` | `1` habilita en producción el proveedor simulado de verificación de identidad (aprueba sin verificar; fuera de producción siempre está). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE` | Stripe (claves de test `sk_test_…` en dev). |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_API_BASE` | Mercado Pago (token `TEST-…` usa el sandbox). En producción sin `MP_WEBHOOK_SECRET` el webhook responde 503. |
| `MCP_DOWNLOAD_TTL_SEC` | Vida de las URLs de descarga del MCP. |
