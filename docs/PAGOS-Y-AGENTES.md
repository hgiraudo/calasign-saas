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
`payment.failed`, `payment.completed`. El comprobante (monto, pagador, medio, referencia, fecha) va en el certificado de finalización.

**Cambios del pagador y cierres** (barrido periódico del worker):

- Si el pagador cambia (delegación, reasignación o corrección de su correo o teléfono), el cobro pasa al nuevo
  destinatario y el checkout armado para el anterior se guarda como descartado (`stale_checkout_id`) y se cierra
  en el proveedor. Si el proveedor ya no lo conoce (404), se suelta; si falla por otra cosa, se reintenta al final
  de la cola. La clave de idempotencia de Stripe incluye el link vigente del pagador.
- Un sobre anulado, rechazado o vencido cierra su checkout abierto (`payment.checkout_closed`).
- Un pago que se acredita con el sobre ya cerrado se reembolsa en el proveedor (`refund_required_at`). Un segundo
  cobro del mismo sobre (dos checkouts pagados) también se reembolsa, en Stripe y en Mercado Pago.
- Un sobre que superó su vencimiento no se corrige, reasigna ni delega.

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

Cada evento se procesa una vez (`payment_webhook_events`); si el procesamiento falla se borra la marca para que el proveedor reintente.
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
- **Uso del mes**: se calcula de las tablas de negocio (sobres enviados, usuarios + invitaciones, mensajes por canal,
  verificaciones de identidad y tokens de IA si existe la tabla `ai_usage`).
- **Suscripción**: `POST /v1/billing/checkout` → Stripe Billing (Checkout `mode=subscription` + portal) o Mercado Pago
  (`preapproval`), o el simulado. Baja: `POST /v1/billing/cancel` (Mercado Pago/simulado) o el portal de Stripe.
  Permiso `billing:manage` (propietarios y administradores).

## 3. Servidor MCP para agentes de IA

`POST /mcp` — Streamable HTTP, sin sesión, respuestas JSON. Credencial: `Authorization: Bearer <access token OAuth | API key>`.
Descubrimiento OAuth: `/.well-known/oauth-protected-resource` (RFC 9728) y `/.well-known/oauth-authorization-server` (RFC 8414).

Herramientas: `list_envelopes`, `get_envelope`, `get_signing_status`, `list_templates`, `get_account`,
`create_envelope_from_template` y `create_envelope` (desde un PDF en base64 o URL https; crean en borrador), `send_envelope`,
`void_envelope` y `remind_recipients` (**exigen `confirm: true`**: sin eso devuelven el resumen para que el usuario apruebe),
`download_signed_pdf` (URL temporal, `MCP_DOWNLOAD_TTL_SEC`, por defecto 15 min). Todas llevan anotaciones MCP
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`).

Conectarlo desde Claude, ChatGPT, Claude Code o Gemini CLI con solo la URL (registro dinámico de clientes OAuth):
ver [MCP-CONECTORES.md](MCP-CONECTORES.md).

Cada herramienta llama a la API v1 por dentro con la misma credencial: valen los scopes del token, el rol, los límites del
plan y la misma evidencia; las acciones quedan con actor **«agente IA (&lt;app o key&gt;)»**.

## 4. Variables de entorno

| Variable | Uso |
|---|---|
| `BILLING_DEFAULT_PLAN` | Plan de las organizaciones sin suscripción. |
| `PAYMENTS_MOCK_ENABLED` | Habilita el proveedor simulado en producción (no recomendado). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE` | Stripe (claves de test `sk_test_…` en dev). |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_API_BASE` | Mercado Pago (token `TEST-…` usa el sandbox). En producción sin `MP_WEBHOOK_SECRET` el webhook responde 503. |
| `MCP_DOWNLOAD_TTL_SEC` | Vida de las URLs de descarga del MCP. |
