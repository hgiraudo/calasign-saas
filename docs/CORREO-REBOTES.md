# Rebotes, quejas y supresión de correos (Amazon SES + SNS)

La API recibe los rebotes y las quejas de SES por un tema SNS y deja de escribirle a las direcciones que rebotan de
forma permanente o que marcaron un correo como spam. **Esta infraestructura no está aplicada**: abajo está lo que hay
que crear (Terraform o consola) y la configuración de la API.

## Qué hace la API

- `POST /v1/integrations/ses/sns` (público, sin sesión; SNS manda JSON con `Content-Type: text/plain`).
  - Verifica la firma SNS (`SignatureVersion` 1 = SHA1withRSA y 2 = SHA256withRSA) con el certificado de
    `SigningCertURL`, que tiene que ser `https://sns.<región>.amazonaws.com/….pem` con la misma región del `TopicArn`.
  - Acepta solo los temas de `SES_SNS_TOPIC_ARNS` (lista blanca; vacía = rechaza todo con 403).
  - `SubscriptionConfirmation`: visita `SubscribeURL` (también en `sns.<región>.amazonaws.com`) solo si el mensaje pasó
    la verificación. La suscripción queda confirmada sola al crearla.
  - `Bounce` con `bounceType = Permanent` → supresión (`email_suppressions`, motivo `bounce`); transitorio → solo queda el
    detalle en el aviso (`notifications.feedback_detail`).
  - `Complaint` → supresión (motivo `complaint`).
  - El aviso enviado se encuentra por `notifications.provider_message_id` (el id de SES, que la API toma de la respuesta
    SMTP `250 Ok <id>`) y pasa a `status = 'bounced'` / `'complained'`. Si es de un sobre, se agrega
    `notification.bounced` / `notification.complained` a su actividad (destino enmascarado).
- Antes de cada correo (avisos de sobres, al equipo y de acuerdos/negociaciones) se consulta la supresión: si la
  dirección está suprimida, no se envía y queda una fila `notifications.status = 'suppressed'` (y
  `notification.suppressed` en la actividad del sobre).
- Acepta tanto las notificaciones de identidad (`notificationType`) como las de un configuration set (`eventType`).

Pendiente (no incluido): los códigos de verificación (otp.ts), el envío masivo y los formularios web todavía no consultan
la supresión (usar `isSuppressed()` de `src/notifications/outbound.ts`); no hay pantalla para quitar una dirección de la
supresión (hoy: `DELETE FROM email_suppressions WHERE address = '…'`).

## Infraestructura a crear (por entorno)

Región: la de SES (hoy `us-east-1`).

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

El endpoint queda fuera del control de `Origin` (`/v1/integrations/*`) y tiene su propio rate limit (600/min).
