# Datos: BYOK, celdas, archivo a largo plazo y dominios SSO

Código: `apps/api/src/modules/data/`, `apps/api/src/infra/{cells,kms,storage}.ts`, migración `0016_data.sql`.
Pruebas: `apps/api/test/{data,archive}.test.ts` y `scripts/e2e-data.mjs`.

## 1. BYOK (clave KMS del cliente)

Ajustes → **Cifrado con tu clave (BYOK)** (`/v1/settings/byok`, permiso `settings:manage`).

1. La organización agrega a su clave KMS la política que muestra la página (statements `CalaSignDescribe`,
   `CalaSignDirect` y, si la celda usa S3, `CalaSignS3`). Autoriza al rol de la plataforma
   (`BYOK_PLATFORM_PRINCIPAL`) solo con el contexto de cifrado de **esa** organización
   (`kms:EncryptionContext:tenant`) o vía S3 sobre el bucket de su celda.
2. Carga el ARN y «Probar y activar»: se verifica región (misma que los datos), estado/uso/tipo de clave
   (`DescribeKey`), cifrado + descifrado y generación de claves de datos. Si algo falla, no se activa (422 con
   el detalle de cada chequeo).

Con la clave activa:

- **S3:** cada objeto nuevo de la organización se guarda con `SSE-KMS` + `SSEKMSKeyId` = su clave
  (`BucketKeyEnabled`).
- **Disco (local/dev):** el archivo se cifra con AES-256-GCM con una clave de datos generada por su clave
  (`GenerateDataKey`, contexto `purpose=calasign-blob, tenant=<id>`); encabezado `CSBYOK1`.
- **Custodia de certificados:** la clave de datos de cada `.p12` nuevo se envuelve con su clave
  (`key_wrap_method = kms-byok`, contexto `purpose=calasign-tenant-certificate, tenant=<id>`).

**Falla cerrada:** si la clave deja de funcionar (deshabilitada, política cambiada, borrada), guardar o leer
documentos y firmar con certificados en custodia responde **503 `byok_key_unavailable`**; nada se guarda sin
cifrar con su clave. La clave pasa a `failing`, se registra `byok.key_failing` en la auditoría y se avisa por
correo a propietarios y administradores (como mucho cada 6 h). El barrido vuelve a probar las claves activas
cada 6 h y las fallidas cada hora; cuando vuelve a funcionar queda `active` (`byok.key_recovered`).

**Trabajos en segundo plano durante la caída:** un job que falla con `byok_key_unavailable` (sellado, avisos,
exportación a almacenamiento, conectores, CRM, ingesta al repositorio) no gasta un intento: la cola lo pospone
10 minutos, hasta 7 días desde que se encoló, y su lógica de «último intento» (aviso de sellado fallido, soltar
reclamos) no corre mientras se pospone. La extracción automática con IA saltea las organizaciones con la clave en
`failing` y reintenta en una hora un sobre que falló por algo transitorio. Así, una caída larga no deja
exportaciones ni write-backs fallados para siempre: retoman solos cuando la clave vuelve.

**Desactivar** (`DELETE`): lo nuevo vuelve a la clave de la plataforma; lo ya cifrado con la clave del
cliente la sigue necesitando (no hay re-cifrado masivo: queda como trabajo futuro).

En local, `KMS_MOCK=1` usa un KMS simulado determinista (sin AWS); `POST /dev/kms-mock {keyArn, disabled}`
simula una clave caída. Nunca disponible en producción.

## 2. Celdas (residencia de datos)

Cada organización tiene una celda (`tenant_directory.cell`, el directorio global tenant → celda) que fija
dónde se guardan sus archivos. Se elige al darse de alta («Dónde se guardan tus documentos»,
`GET /v1/public/cells`); las celdas del catálogo que no están configuradas se muestran «Próximamente».
El catálogo (`CELL_CATALOG` en `apps/api/src/infra/cells.ts`) tiene **todas las regiones comerciales de AWS** (34 al
29-Oct-2026: Estados Unidos ×4, Canadá ×2, México, Brasil, Europa ×8, Asia-Pacífico ×14, Medio Oriente y África ×4) y
**Chile** (Santiago), que AWS anunció para fines de 2026 y todavía no tiene código de región (`region: null`). La web
las muestra en un desplegable agrupado por zona, con el país traducido (`Intl.DisplayNames`). Una región pasa a estar
disponible cuando se configura en `CELLS` (bucket propio en esa región y, si hace falta, su despliegue).

```bash
CELLS='{"us":{"label":"Estados Unidos","region":"us-east-1","default":true,"storage":{"driver":"s3","bucket":"calasign-us"}},
        "br":{"label":"Brasil","region":"sa-east-1","storage":{"driver":"s3","bucket":"calasign-br","region":"sa-east-1"},
              "baseUrl":"https://br.calasign.com"}}'
SERVED_CELLS=us   # celdas que atiende este proceso (por defecto: todas las configuradas)
```

- Sin `CELLS` hay una sola celda (`DEFAULT_CELL`, «us») con el almacenamiento de siempre. Ids viejos
  (`local`, `dev`) caen en la celda por defecto.
- En disco, la celda por defecto sigue en `var/blobs`; las demás en `var/blobs-<id>` (o `storage.dir`).
- **Enrutamiento:** si un proceso no atiende la celda de la organización (API key, token OAuth, sesión o link
  de firma de otra celda), responde **421 `wrong_cell`** con `location` = `baseUrl` de la celda correcta. Con
  un solo despliegue que atiende todo, no se consulta nada. Si la celda de la organización no está configurada en ese
  despliegue, responde **503 `wrong_cell`** (falla cerrada, nunca la celda por defecto): es de configuración, así que
  los SDKs no lo reintentan.
- **Fuera de alcance:** mover una organización existente de celda (copiar archivos, re-cifrar, cambiar el
  directorio). Hoy la celda se fija en el alta.
- Producción: la base de cada celda es independiente; el directorio global debería vivir en una base
  compartida (hoy lo comparte el mismo Postgres). La organización AWS limita regiones (`limitar-regiones`):
  una celda en `sa-east-1` exige cambiar esa SCP primero.

## 3. Renovación de sellos de archivo (PAdES B-LTA)

Ver también `EVIDENCIA.md` §2. El barrido (`archiveSweep`, en el worker, como mucho una vez por hora):

1. A cada sobre completado sin revisar (o cuya revisión falló hace más de un día: BYOK o almacenamiento caídos)
   le calcula `archive_valid_until` = vencimiento del certificado de la TSA
   del **último** sello de tiempo (sello de documento o, si no hay, el de la firma). Solo los PDF con DSS
   (B-LT/B-LTA) tienen vigencia de archivo; los B-B y los B-T elegidos así por la organización no se renuevan.
   Un sobre B-T (con sello de tiempo, sin DSS) en una organización con nivel B-LT/B-LTA es un LTV que falló al
   finalizar (TSA u OCSP caídos): queda marcado "LTV pendiente" y el mismo barrido lo completa a B-LTA (DSS +
   sello de documento), con el evento `envelope.archive_renewed` con `upgrade: true`. Si falla, el error queda a la
   vista en el sobre y se reintenta una vez por día. Por pasada se completan como mucho `ARCHIVE_RENEWAL_BATCH`
   sobres y se corta ante la primera falla (con la TSA caída, cada uno haría todas las consultas OCSP/CRL).
2. Si vence dentro de `ARCHIVE_RENEWAL_DAYS` (180), agrega DSS (OCSP/CRL de hoy, incluida la cadena de esa
   TSA) + un **sello de documento nuevo** como revisión incremental, valida el resultado (todas las firmas
   íntegras y un sello de documento más), guarda la nueva versión y actualiza `signed_file_id`.
3. Historial en `envelope_signed_versions` (v1 = original, v2… = renovaciones); la versión anterior se
   conserva y `/v1/verify` encuentra cualquiera por hash. Evento `envelope.archive_renewed` con ambos hashes.
   En la misma transacción, el acuerdo del repositorio y los enlaces de descarga vigentes pasan a la versión
   nueva (el chequeo de duplicados del repositorio compara contra todas las versiones). Las copias ya exportadas
   a almacenamiento (Drive, Dropbox, OneDrive, SharePoint, Box, S3) se vuelven a subir con el PDF renovado: el
   evento encola una exportación por conexión activa, y el trabajo compara el sha256 subido con el vigente (una
   subida del PDF anterior todavía en curso no la deja como hecha). Drive reemplaza el contenido del mismo archivo y
   S3 lo pisa en la misma clave; Dropbox, OneDrive, SharePoint y Box, que nunca pisan, dejan la versión renovada
   al lado con otro nombre. Lo enviado a conectores no se vuelve
   a mandar. El JSON de evidencia que acompaña a cada exportación lleva el hash del PDF que efectivamente se subió.
4. No se vuelve a renovar el mismo sobre antes de `ARCHIVE_RENEWAL_MIN_INTERVAL_DAYS` (30). Si la TSA vigente
   vence igual o antes que la anterior, se deja `archive_error` (conviene configurar otra TSA); no aplica al
   completar un B-T a B-LTA (no hay sello de archivo anterior con el que comparar).

API: `GET /v1/envelopes/:id/archive` (vigencia y versiones), `POST /v1/envelopes/:id/archive/renew` (manual).
La web lo muestra en el detalle del sobre completado. En local, `POST /dev/archive/sweep {days, envelopeId}`.

## 4. Dominios SSO verificados

Un dominio cargado en SSO queda **pendiente** hasta publicar `TXT _calasign-sso.<dominio> =
calasign-sso-verify=<token>` y verificarlo (`POST /v1/settings/sso/domains/:domain/verify`). Pendiente, no se
usa para el descubrimiento por correo («Continuar con SSO»). Varias organizaciones pueden reclamar el mismo
dominio mientras ninguna lo verifique; verificado, es de una sola (409 `domain_taken` para las demás).
Guardar la configuración de SSO conserva la verificación de los dominios que siguen. Los dominios que existían
antes de la migración quedan sin verificar.

## 5. Otros ajustes

- **SCIM respeta el cupo de usuarios del plan:** una alta o reactivación sin cupo responde 402 con el esquema
  de error de SCIM (`scimType: "plan_limit"`).
- **SCIM solo administra correos de dominios verificados:** crear o vincular un usuario (`POST /Users`) y cambiar
  su correo exigen que el dominio esté verificado en la organización; si no, 403. Igual que el alta JIT por SSO:
  sin esto, un token SCIM podría reservar el correo de cualquier persona o sumar la cuenta de un usuario de otra
  organización y abrir sesiones como esa persona con un IdP propio. Para sumar a alguien de otro dominio, se lo
  invita desde la consola (la persona acepta con su cuenta).
- **Las llamadas al IdP de OIDC** (descubrimiento, JWKS, token) pasan por el cliente HTTP seguro (`safeRequest`):
  sin destinos internos, sin seguir redirecciones y con tope de tamaño.
- **Dominio propio en todos los links:** formularios web, URL de firma embebida, Telegram, regreso de la
  verificación de identidad y «verificá este documento» del certificado usan el dominio verificado de la
  organización (`tenantBaseUrl`). Un test (`apps/api/test/data.test.ts`) falla si un link público vuelve a
  armarse con `APP_URL` fijo.

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `BYOK_PLATFORM_PRINCIPAL` | marcador | ARN del rol de la app que la política del cliente autoriza |
| `KMS_MOCK` | apagado | KMS simulado (solo fuera de producción) |
| `CELLS` | una celda | Celdas de este despliegue (JSON) |
| `DEFAULT_CELL` | `us` | Celda por defecto sin `CELLS` |
| `SERVED_CELLS` | todas | Celdas que atiende este proceso |
| `ARCHIVE_RENEWAL_ENABLED` | `true` | Barrido de renovación |
| `ARCHIVE_RENEWAL_DAYS` | `180` | Umbral de vencimiento |
| `ARCHIVE_RENEWAL_MIN_INTERVAL_DAYS` | `30` | Intervalo mínimo entre renovaciones de un sobre |
| `ARCHIVE_RENEWAL_BATCH` | `10` | Sobres por barrido |

## Permisos de IAM para el rol de la app (dev)

- **BYOK en S3:** nada nuevo en el rol propio (S3 usa la clave del cliente con la política del cliente).
- **BYOK directo** (custodia y disco): `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`, `kms:DescribeKey`
  sobre `arn:aws:kms:*:*:key/*` (claves de otras cuentas: el permiso efectivo lo da la política de la clave del
  cliente). Conviene limitarlo con `kms:EncryptionContextKeys` = `purpose`, `tenant`: es el contexto que usan
  tanto los archivos en disco como la custodia de certificados (la clave de cada certificado queda atada además al
  certificado por el AAD de AES-GCM, no por el contexto de KMS).
  **Aplicar esa condición recién después de re-cifrar las claves viejas.** Las claves de certificados guardadas con un
  `certificate` en el contexto (versión anterior) se abren con ese contexto y, al usarlas, se vuelven a cifrar con
  `purpose`, `tenant`. Con la condición ya aplicada, KMS rechaza (AccessDenied) el contexto anterior y esos
  certificados dejan de firmar. Antes de aplicarla, cada certificado en custodia subido antes de este cambio tiene que
  haberse usado al menos una vez (firma XML o sello de PDF) después del despliegue (`lastUsedAt` en
  `GET /v1/certificates`) o volver a subirse. Si el re-cifrado falló (KMS caído, falta `kms:Encrypt`), se reintenta
  en el próximo uso pasada una hora: confirmarlo en CloudTrail (Encrypt con el contexto nuevo) antes de aplicar la
  condición.
- **Celdas S3 adicionales:** los mismos permisos de S3 que hoy (`s3:GetObject/PutObject/ListBucket`,
  `ListBucketVersions`, `DeleteObject`, `DeleteObjectVersion`) sobre cada bucket de celda.
