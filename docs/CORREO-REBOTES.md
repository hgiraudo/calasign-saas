# Rebotes, quejas y supresión de correos (Amazon SES + SNS)

La API recibe los rebotes y las quejas de SES por un tema SNS y deja de escribirle a las direcciones que rebotan de
forma permanente o que marcaron un correo como spam. Lo que ya existe está en «Dónde está SES hoy»; «Infraestructura a
crear» es la referencia para armarlo en otra cuenta.

## Dónde está SES hoy

SES **no** está en la organización de AWS de CalaSign: vive en la cuenta 006121953992, región **us-east-2**, armado
por CLI (sin Terraform) junto con el relay de `dynamic-form`. El historial está en `~/cala/calasign-setup`
(`README.md`, `aws-ses-production-access.md`). La arquitectura de la CA (`~/cala/calasign/docs/13-correo-y-entregabilidad.md`)
planea otra cosa (`avisos.calasign.com` en la cuenta compartida); migrar es una decisión pendiente.

| Pieza | Valor |
|---|---|
| Identidad | `calasign.com` (Easy DKIM 2048, MAIL FROM `bounce.calasign.com`), remitente `no-reply@calasign.com` |
| Configuration set | `calasign-notify` (por defecto de la identidad): eventos a SNS y métricas a CloudWatch |
| Tema SNS | `arn:aws:sns:us-east-2:006121953992:ses-notifications` (lo comparten `formularios-notify` y las alarmas de reputación: la API ignora lo que no es un evento de SES) |
| Sandbox de SES | Sí, hasta que AWS apruebe el caso 179115865500671: solo entrega a direcciones verificadas |

**Dev** (`infra/dev`): `SES_CONFIGURATION_SET` y `SES_SNS_TOPIC_ARNS` son parámetros de SSM en Terraform. `SMTP_URL`
lo carga `scripts/set-dev-smtp.sh` desde el CSV de credenciales SMTP de SES. Con `DEV_MAILBOX=true` el correo va al
buzón y además sale por SES; si SES lo rechaza (sandbox), queda solo en el buzón. Los correos a dominios reservados
para pruebas (`example.com`/`.net`/`.org` y los TLD `.test`, `.example`, `.invalid`, `.localhost`, que usan las
suites e2e) quedan solo en el buzón (`isReservedTestAddress` en `notifications/channels.ts`): por SES serían un
rebote duro cada uno y bajarían la reputación de la cuenta. La suscripción HTTPS de
`ses-notifications` a `https://dev.calasign.com/v1/integrations/ses/sns` se crea después del deploy (con el tema ya en
`SES_SNS_TOPIC_ARNS`, si no la confirmación se rechaza con 403).

### Pendientes (30-Oct-2026)

1. **Acceso de producción de SES** (caso 179115865500671, us-east-2). La respuesta del 29-Oct a AWS salió con valores
   de relleno y contradice la del 17-Oct; falta mandar la corrección: 5.000 correos/día con la tasa por defecto,
   ~2.500 por mes (menos de 100 en un día típico), solo transaccionales, formularios y firma con la misma identidad
   (`no-reply@calasign.com`) y el mismo configuration set, con supresión de cuenta, SNS, métricas de reputación y
   alarmas de rebotes (5 %) y quejas (0,1 %). El historial del caso está en `~/cala/calasign-setup`.
2. **Website de la cuenta de SES**: todavía dice `https://formularios.biz`. `aws sesv2 put-account-details` reenvía
   el pedido de producción: no correrlo con el caso abierto; cambiarlo después de la aprobación.
3. **Direcciones `@calasign.com` que no existen.** Las organizaciones de prueba de dev usan direcciones
   `@calasign.com` que no son casillas de Google Workspace (el MX del dominio): cada aviso a una de ellas rebota
   (5.1.3) y la deja suprimida en SES y en `email_suppressions`. Arreglo propuesto: un catch-all en la consola de
   Workspace (Gmail → Enrutamiento → Enrutamiento predeterminado: cambiar el destinatario del sobre a una casilla
   existente, solo para mensajes no reconocidos). Después, quitar las supresiones de cada dirección afectada:
   - SES: `aws sesv2 delete-suppressed-destination --email-address <dirección> --region us-east-2`;
   - dev: `DELETE FROM email_suppressions WHERE tenant_id IS NULL AND address = lower('<dirección>');`.
4. **Entregabilidad**: confirmar que los avisos de dev llegan a la bandeja de entrada y no a spam (en Gmail,
   «Mostrar original»: SPF, DKIM y DMARC en `PASS`).
5. **Suscripción por correo de `ses-notifications`**: además de la HTTPS de dev, el tema tiene una suscripción EMAIL a
   una casilla personal que recibe todo (rebotes de formularios y de CalaSign, alarmas). Opcional: una política de
   filtro o quitarla cuando la API sea la única destinataria.
6. **Métricas**: el perfil de CLI de esa cuenta no puede leer CloudWatch (`cloudwatch:GetMetricStatistics`) ni
   suscribir a SNS; las alarmas y métricas de reputación se ven en la consola.
7. **Migrar SES a la organización de AWS** (decisión pendiente): región (la SCP solo permite `us-east-1`; el diseño de
   la CA dice `sa-east-1`), dominio (`avisos.calasign.com`) y un pedido de producción nuevo en esa cuenta. La
   infraestructura sería la de «Infraestructura a crear», en Terraform.

## Qué hace la API

- `POST /v1/integrations/ses/sns` (público, sin sesión; SNS manda JSON con `Content-Type: text/plain`).
  - Verifica la firma SNS (`SignatureVersion` 1 = SHA1withRSA y 2 = SHA256withRSA) con el certificado de
    `SigningCertURL`, que tiene que ser `https://sns.<región>.amazonaws.com/….pem` con la misma región del `TopicArn`.
  - Acepta solo los temas de `SES_SNS_TOPIC_ARNS` (lista blanca; vacía = rechaza todo con 403).
  - `SubscriptionConfirmation`: visita `SubscribeURL` (también en `sns.<región>.amazonaws.com`) solo si el mensaje pasó
    la verificación. La suscripción queda confirmada sola al crearla.
  - Mensajes con `Timestamp` de más de 24 horas (o más de 5 minutos en el futuro) se rechazan (403 `stale`). La
    ventana es amplia a propósito: SNS reintenta una entrega fallida durante horas (más con una política de reintentos
    propia) y con una ventana de 1 hora se perdían rebotes y quejas reales después de una caída de la API. Un mensaje
    firmado capturado y reenviado dentro de la ventana no hace daño: el procesamiento es idempotente (renueva la misma
    supresión, no vuelve a marcar el aviso ni a registrar el evento). El certificado queda en caché hasta su `validTo`;
    después se descarga y valida de nuevo.
  - `Bounce` con `bounceType = Permanent` → supresión **global** (`email_suppressions`, motivo `bounce`, `tenant_id`
    NULL) que **vence** a los `EMAIL_BOUNCE_SUPPRESSION_DAYS` días (60 por defecto; un rebote nuevo la renueva);
    transitorio → solo queda el detalle en el aviso (`notifications.feedback_detail`).
  - `Complaint` → supresión **solo para la organización** del envío (motivo `complaint`, sin vencimiento). La
    organización es la del aviso con ese `provider_message_id` o, si el correo no dejó fila en `notifications`, la de
    la etiqueta `tenant` del correo (`mail.tags.tenant` del evento del configuration set): la API manda
    `X-SES-MESSAGE-TAGS: tenant=<id>` en todo correo de una organización enviado por SES (configuration set
    configurado o SMTP `email-smtp.<región>.amazonaws.com`; SES quita el encabezado antes de entregar). Una queja sin
    aviso ni etiqueta (p. ej. restablecer contraseña, que no es de una organización) no suprime. Las notificaciones
    de identidad (`notificationType`) no traen etiquetas: con ellas solo vale el aviso registrado.
  - El aviso enviado se encuentra por `notifications.provider_message_id` (el id de SES, que la API toma de la respuesta
    SMTP `250 Ok <id>`) y pasa a `status = 'bounced'` / `'complained'`. Si es de un sobre, se agrega
    `notification.bounced` / `notification.complained` a su actividad (destino enmascarado).
- Antes de cada correo (avisos de sobres, al equipo y de acuerdos/negociaciones) se consulta la supresión: si la
  dirección está suprimida, no se envía y queda una fila `notifications.status = 'suppressed'` (y
  `notification.suppressed` en la actividad del sobre).
- Acepta tanto las notificaciones de identidad (`notificationType`) como las de un configuration set (`eventType`).

- Código de verificación por correo (otp.ts): lo frena solo una queja contra esa organización (el mensaje lo ve solo
  quien tiene el link). Un rebote no lo frena (la persona lo pide en ese momento, con los topes de envío); si valida
  el código, el rebote de esa dirección se borra.
- Invitaciones al equipo: con la dirección suprimida no sale el correo (el link de aceptación vuelve igual); la
  respuesta no lo dice (sería información de otra organización), queda en el log del servidor. Las invitaciones y las
  alertas de BYOK quedan registradas en `notifications` (plantillas `invitation`, `byok_key_failing`).

### Quitar una supresión

- **Quejas de la organización**: `GET /v1/settings/email-suppressions` (lista) y
  `DELETE /v1/settings/email-suppressions/:address` (con `settings:manage`; queda en la auditoría como
  `email_suppression.removed`). Sin una queja propia para esa dirección responde 404, también si la dirección tiene
  un rebote global (no se revela: es información de otras organizaciones).
- **Rebotes globales**: no hay administración de plataforma. Vencen solos, se borran cuando la persona valida un
  código por correo, o a mano:
  `DELETE FROM email_suppressions WHERE tenant_id IS NULL AND address = lower('…');`

## Infraestructura a crear (por entorno)

Región: la de SES (hoy `us-east-2`; ver «Dónde está SES hoy»).

1. **Tema SNS** `calasign-<entorno>-ses-feedback` (estándar, no FIFO).
   - Política del tema: permitir `SNS:Publish` al principal `ses.amazonaws.com` con condición
     `AWS:SourceAccount = <cuenta>` (y `AWS:SourceArn` = ARN del configuration set).
2. **Suscripción HTTPS** del tema a `https://<APP_URL>/v1/integrations/ses/sns`, con
   `raw_message_delivery = false` (la API necesita el sobre SNS firmado) y la política de reintentos por defecto.
3. **Configuration set de SES** `calasign-<entorno>` con un *event destination* SNS hacia ese tema para los eventos
   `BOUNCE` y `COMPLAINT` (opcional `DELIVERY`, que la API ignora).
4. Que los correos usen el configuration set: con SMTP, encabezado `X-SES-CONFIGURATION-SET: calasign-<entorno>` o,
   más simple, ponerlo como **configuration set por defecto** de cada identidad verificada (dominio de la plataforma y
   dominios propios de las organizaciones). Alternativa sin configuration set: notificaciones de identidad
   (`aws_ses_identity_notification_topic` para `Bounce` y `Complaint`) hacia el mismo tema.
5. Opcional: desactivar el reenvío de rebotes por correo (`forwarding_enabled = false`) una vez que el tema funcione.

Ejemplo (no aplicado):

```hcl
resource "aws_sns_topic" "ses_feedback" {
  name = "calasign-${var.env}-ses-feedback"
}

resource "aws_sns_topic_policy" "ses_feedback" {
  arn = aws_sns_topic.ses_feedback.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.ses_feedback.arn
      Condition = { StringEquals = { "AWS:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_sns_topic_subscription" "ses_feedback_api" {
  topic_arn              = aws_sns_topic.ses_feedback.arn
  protocol               = "https"
  endpoint               = "https://${var.app_host}/v1/integrations/ses/sns"
  endpoint_auto_confirms = true
}

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = "calasign-${var.env}"
}

resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "sns-feedback"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination { topic_arn = aws_sns_topic.ses_feedback.arn }
  }
}
```

## Configuración de la API

| Variable | Valor |
|---|---|
| `SES_SNS_TOPIC_ARNS` | ARN del tema (o varios, separados por coma). Sin valor el endpoint rechaza todo. |
| `SES_CONFIGURATION_SET` | Opcional: nombre del configuration set; la API lo manda en `X-SES-CONFIGURATION-SET` (no hace falta si es el de por defecto de la identidad). |
| `EMAIL_BOUNCE_SUPPRESSION_DAYS` | Días que un rebote permanente suprime la dirección para toda la plataforma (60 por defecto). |

El endpoint queda fuera del control de `Origin` (`/v1/integrations/*`) y tiene su propio rate limit (600/min).
