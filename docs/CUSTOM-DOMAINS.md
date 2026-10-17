# Dominio propio (white-label)

Una organización puede firmar desde su propio dominio, por ejemplo `firmas.cliente.com`. Los links de firma de sus
correos, WhatsApp y Telegram usan ese dominio, la web muestra su marca según el `Host`, y en ese dominio no abren
links de otras organizaciones.

## Flujo

1. **Ajustes → Dominio propio**: la organización escribe el dominio (`PUT /v1/domains`). No se aceptan subdominios de
   `calasign.com`/`calasign.io` ni un dominio ya registrado por otra organización.
2. Crea en su DNS:
   - **TXT** `_calasign-challenge.firmas.cliente.com` con el valor `calasign-verify=<token>` (verificación de propiedad).
   - **CNAME** `firmas.cliente.com` → el host de la plataforma (`dev.calasign.com` en dev).
3. **Verificar** (`POST /v1/domains/verify`): el TXT se consulta por DNS-over-HTTPS (Cloudflare, y Google si falla).
4. Verificado: Caddy emite el certificado la primera vez que alguien entra (TLS bajo demanda), preguntándole a la API
   si el dominio está autorizado.

## Cambio en Caddy (no aplicado)

`infra/dev/bootstrap.sh` hoy genera un Caddyfile con un solo sitio (`dev.calasign.com`). Para dominios propios hay que
agregar TLS bajo demanda con `ask`:

```caddyfile
{
	on_demand_tls {
		# La API responde 200 solo para dominios verificados (y el propio de la plataforma).
		ask http://127.0.0.1:4000/internal/tls-allowed
	}
}

dev.calasign.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
	header Strict-Transport-Security "max-age=31536000"
}

# Cualquier otro dominio: certificado bajo demanda, solo si la API lo autoriza.
https:// {
	tls {
		on_demand
	}
	encode zstd gzip
	# /internal/* no se expone hacia afuera (la API igual exige loopback directo, sin X-Forwarded-For).
	@internal path /internal/*
	respond @internal 404
	reverse_proxy 127.0.0.1:4000
	header Strict-Transport-Security "max-age=31536000"
}
```

Notas:

- `ask` se llama antes de cada emisión: Let's Encrypt limita a 50 certificados por dominio registrable por semana y
  Caddy reintenta con backoff; sin `ask`, cualquiera podría apuntar un dominio a la IP y hacer emitir certificados.
- La API responde `/internal/tls-allowed` solo a conexiones desde `127.0.0.1` **sin** `X-Forwarded-For` (Caddy lo
  agrega a lo que proxea, no a sus propias consultas `ask`), así que no se puede consultar desde afuera.
- En producción (ECS + ALB) el equivalente es un ALB con certificados de ACM por dominio (cuota de certificados por
  ALB) o CloudFront con SaaS Manager / multi-tenant distributions; el endpoint de verificación es el mismo.

## Qué cambia en la app

| Lugar | Comportamiento |
|---|---|
| Correos, WhatsApp, Telegram | Links `https://<dominio>/s/<token>` y `https://<dominio>/app/envelopes/<id>` (`tenantBaseUrl`). |
| `GET /v1/public/host-branding` | Nombre, color y logo de la organización dueña del `Host` (404 si no es un dominio propio). |
| `/v1/signing/*` por un dominio propio | 404 si el link es de otra organización. |
| Formularios web, URLs embebidas, Telegram | Todavía usan la URL de la plataforma (pendiente). |

## Pruebas locales

En `APP_ENV=local` existe `POST /dev/dns-stub {name, values[]}` para simular el TXT. `scripts/e2e-platform.mjs` lo usa.
