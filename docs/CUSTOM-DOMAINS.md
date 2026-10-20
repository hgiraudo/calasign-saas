# Dominio propio (white-label)

Una organización puede firmar desde su propio dominio, por ejemplo `firmas.cliente.com`. Los links de firma de sus
correos, WhatsApp y Telegram usan ese dominio, la web muestra su marca según el `Host`, y en ese dominio no abren
links de otras organizaciones.

## Flujo

1. **Ajustes → Dominio propio**: la organización escribe el dominio (`PUT /v1/domains`). Registrarlo y verificarlo
   exigen el dominio propio en el plan (402 `plan_limit`, Enterprise); quitarlo no. No se aceptan los hosts de la
   plataforma (el de `APP_URL` y los de `PLATFORM_HOSTS`), subdominios del dominio de la plataforma o de
   `calasign.com`/`calasign.io` (400 `reserved_domain`) ni un dominio ya verificado por otra organización.
2. Crea en su DNS:
   - **TXT** `_calasign-challenge.firmas.cliente.com` con el valor `calasign-verify=<token>` (verificación de propiedad).
   - **CNAME** `firmas.cliente.com` → el host de la plataforma (`dev.calasign.com` en dev).
3. **Verificar** (`POST /v1/domains/verify`): por DNS-over-HTTPS (Cloudflare, y Google si falla) se consultan el TXT
   **y** que el dominio apunte a la plataforma (la misma regla que la re-verificación). Hasta que el CNAME propague,
   la verificación responde "el dominio todavía no apunta a CalaSign". En el entorno local solo se mira el TXT.
4. Verificado: Caddy emite el certificado la primera vez que alguien entra (TLS bajo demanda), preguntándole a la API
   si el dominio está autorizado.
5. Re-verificación cada 6 h: el TXT tiene que seguir publicado **y** el dominio tiene que seguir apuntando a la
   plataforma (CNAME al host de la plataforma, o una dirección A de la plataforma). El TXT solo no alcanza: es público
   y quien se quede con un dominio vencido puede volver a publicarlo. Cada control fallido suma puntos (falta o no
   apunta: 2; error de DNS: 1) y con 4 el dominio vuelve a "pendiente" y los links pasan al dominio de la plataforma.
   Por eso el CNAME no puede estar detrás de un proxy (en Cloudflare, "solo DNS"): un proxy esconde el destino real.

## Cambio en Caddy (no aplicado)

El Caddyfile del host es `infra/dev/host/Caddyfile` (lo instala `scripts/deploy-dev.sh` en cada deploy, validándolo
antes de recargar Caddy, y `bootstrap.sh` en el primer arranque) y hoy tiene un solo sitio (`dev.calasign.com`). Para
dominios propios hay que agregarle TLS bajo demanda con `ask`:

```caddyfile
{
	on_demand_tls {
		# La API responde 200 solo para dominios verificados (y el propio de la plataforma).
		# tls-allowed-brand: dominios de organizaciones Y de sub-marcas (docs/MARCA-BLANCA.md).
		ask http://127.0.0.1:4000/internal/tls-allowed-brand
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
- **La cuenta solo existe en el host de la plataforma** (el de `APP_URL`, más los de `PLATFORM_HOSTS`, separados por
  coma; en local también `localhost`, `127.0.0.1` y `[::1]`). Cualquier otro `Host` recibe el trato de un dominio
  propio (ver abajo). Por eso: el health check del balanceador va a `/healthz` (no a `/`, que redirige), y un proxy
  delante de la API tiene que conservar el `Host` original (o agregarlo a `PLATFORM_HOSTS`).

## Qué cambia en la app

| Lugar | Comportamiento |
|---|---|
| Correos, WhatsApp, Telegram | Links `https://<dominio>/s/<token>` y `https://<dominio>/app/envelopes/<id>` (`tenantBaseUrl`). |
| `GET /v1/public/host-branding` | Nombre, color y logo de la organización dueña del `Host` (404 si no es un dominio propio). |
| `/v1/signing/*` por un dominio propio | 404 si el link es de otra organización. |
| URLs embebidas, Telegram, Firmador | Usan el dominio de la marca del sobre (sub-marca con dominio propio, o el de la organización). |
| Formularios web | Usan el dominio propio de la organización (`tenantBaseUrl`); no tienen sub-marca. |
| La cuenta en cualquier host que no sea el de la plataforma (dominio propio, de sub-marca, uno que dejó de estar verificado o cualquier otro) | **No se sirve.** `/`, `/app`, `/login`, `/signup`, `/forgot`, `/reset`, `/invite`, `/oauth/authorize` y `/developers` redirigen (302) al dominio de la plataforma; `/v1/auth`, `/v1/invite`, `/v1/oauth/authorize`, `/v1/me` y `/v1/integrations/sso` responden 401 `use_platform_host`, y la cookie de sesión `cs_session` se ignora. La organización controla el DNS de su dominio: si se sirviera el login ahí podría quedarse con sesiones que valen en la plataforma y en otras organizaciones. API keys y tokens OAuth (`Authorization: Bearer`) funcionan igual. El Host se normaliza (sin puerto ni punto final). |
| Toda la web en el dominio propio | `index.html` con el tema, título y favicon de la marca; manifest y página sin conexión propios (ver [MARCA-BLANCA.md](MARCA-BLANCA.md)). |

## Pruebas locales

En `APP_ENV=local` existe `POST /dev/dns-stub {name, values[]}` para simular el TXT. `scripts/e2e-platform.mjs` lo usa.
