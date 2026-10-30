# Evidencia fuerte (Fase 5)

Cómo CalaSign hace que una firma se pueda verificar dentro de 10 o 20 años, cómo firma XML de facturación
electrónica y cómo custodia los certificados de las organizaciones.

## 1. Niveles PAdES

| Nivel | Qué agrega | Dónde |
|---|---|---|
| B-B | Firma CAdES (`ETSI.CAdES.detached`) con `signingCertificateV2` | `packages/pdf/src/cms.ts` |
| B-T | Sello de tiempo RFC 3161 sobre el valor de la firma | `cms.ts` (atributo no firmado) |
| B-LT | `/DSS` con certificados, OCSP y CRL de **todas** las cadenas (firmantes y TSA) | `packages/pdf/src/ltv.ts` |
| B-LTA | Sello de tiempo de documento (`/SubFilter /ETSI.RFC3161`) que cubre todo, DSS incluido | `ltv.ts` |

Todo lo posterior a B-T se agrega como **revisión incremental** (`packages/pdf/src/incremental.ts`): se
escriben objetos nuevos y una xref con `/Prev` al final del archivo, sin tocar un byte de lo ya firmado. Así
también se agrega el **sello de empresa** (segunda firma CAdES con el certificado de la organización).

Orden al finalizar un sobre: sello de plataforma (B-T) → sello de empresa (si se pidió) → DSS → sello de
documento (B-LTA).

**Elección del nivel.** `SEAL_LEVEL` (entorno) y `tenants.seal_level` (cada organización, `PATCH
/v1/settings/evidence`). `auto` = B-LT si la cadena del sello publica OCSP/CRL; si no, B-T (no hay qué
incrustar). Sin TSA todo queda en B-B. Si la TSA o el OCSP fallan y `TSA_REQUIRED=false`, el sobre se entrega en
el nivel que se alcanzó y queda constancia en el evento `envelope.completed` (`seal.ltvError`). Si la
organización pide B-LT/B-LTA y el sobre quedó en B-T, el barrido de archivo lo marca "LTV pendiente" y después lo
completa a B-LTA (evento `envelope.archive_renewed` con `upgrade: true`; ver [`DATOS.md`](DATOS.md) §3).

**Compatibilidad verificada.** `pdfsig` (poppler/NSS) valida las firmas CAdES y la cadena; los certificados
de sello llevan EKU `emailProtection` además de `documentSigning` porque NSS lo exige. poppler todavía no
valida `ETSI.RFC3161` (lo muestra como "unknown"); el validador propio sí.

## 2. Renovación de sellos de archivo

Implementado (`apps/api/src/modules/data/archive.ts`, detalle en [`DATOS.md`](DATOS.md) §3). Un B-LTA vale
mientras el algoritmo y el certificado de la TSA del último sello de documento sigan siendo confiables. El
barrido calcula `archive_valid_until` (vencimiento del certificado de esa TSA) y, cuando faltan menos de
`ARCHIVE_RENEWAL_DAYS`, agrega DSS + un sello de documento nuevo (`applyLtv` nivel B-LTA, incremental), valida
el resultado, guarda la nueva versión (historial en `envelope_signed_versions`, la anterior se conserva) y
registra `envelope.archive_renewed`. Pendiente: renovar también ante el debilitamiento de algoritmos
(SHA-256/RSA-2048), no solo por vencimiento de la TSA.

El barrido consulta (con caché de 6 h) hasta cuándo vale el certificado que la TSA usa hoy y no renueva los
sobres cuyo último sello ya vence en esa fecha o después (no extendería nada); también respeta el tope de 50
renovaciones por sobre. La renovación manual (`POST /v1/envelopes/:id/archive/renew`) responde 409 si el PDF no
es de archivo (`archive_not_applicable`: sin DSS, salvo un «LTV pendiente» con la organización en B-LT/B-LTA) o
si todavía faltan más de `ARCHIVE_RENEWAL_DAYS` para el vencimiento o si, como en el barrido, el último sello ya es
del certificado vigente de la TSA (`archive_not_due`: un sello nuevo no extendería la validez). Si la inspección
previa del PDF falla (almacenamiento o BYOK caídos) se responde ese error, no un 409. Un PDF que ya es de
archivo se renueva con B-LTA aunque la organización haya pasado después a B-B/B-T: el pedido es justamente de
archivo y ese PDF ya lo era; un B-T no se completa a B-LTA si el nivel vigente no lo pide.

## 3. Validación

`packages/pdf/src/validate.ts` y `POST /v1/validate` (público, rate-limited; la página `/verify` lo muestra
junto a la búsqueda por hash). Por firma: integridad (CMS + messageDigest), cobertura (si cubre todo o hay
revisiones posteriores), sello de tiempo (messageImprint + firma del token), cadena hasta una raíz de
confianza (`TRUST_STORE_DIR` + la raíz del sello de plataforma), revocación (OCSP/CRL del DSS; online solo si
`VALIDATE_ONLINE_REVOCATION=true`, con protección SSRF: solo http(s) a IPs públicas) y nivel PAdES detectado.
La revocación también se mira para la cadena de la TSA de cada sello de tiempo: si estaba revocada al emitir el sello,
o revocada por compromiso de clave (keyCompromise, cACompromise, aACompromise) en cualquier fecha, el sello queda
`trusted: false` con un aviso, y la cadena del firmante ya no se valida a la fecha de ese sello sino a la de hoy.

### Rotación del sello de plataforma

Las raíces de confianza son las de `TRUST_STORE_DIR` (solo certificados autofirmados) más la raíz de la cadena
**actual** del sello (`SEAL_CHAIN_FILE`, o la CA de desarrollo en `var/keys`). Al rotar el sello a una cadena con otra
raíz, los PDF sellados antes dejan de figurar como confiables (`chain.trusted: false`) salvo que la raíz anterior esté
en el almacén: antes de cambiar `SEAL_CHAIN_FILE`, copiar la raíz de la cadena vieja (PEM o DER) a `TRUST_STORE_DIR` y
mantenerla ahí mientras haya PDF sellados con ella. Las raíces se leen una vez por proceso: reiniciar la API después
de agregarlas.

Al sellar se comprueba cada firma con la clave pública del primer certificado de la cadena (`buildPadesCms`): si la
clave (`SEAL_KEY_FILE` o `KMS_KEY_ID`) no corresponde a `SEAL_CHAIN_FILE` —por ejemplo, se rotó una y no la otra—, el
job de finalización falla con `SignatureKeyMismatchError` y se reintenta, en vez de entregar un PDF con una firma que
no verifica. Rotar clave y cadena juntas.

`chain.revocationUnknown` (por firma) y `summary.revocationUnknown` (en todo el PDF) indican que de algún
certificado que no es la raíz no se pudo saber si estaba revocado: sin OCSP/CRL en el DSS ni consulta online, o
solo con respuestas OCSP "unknown" (un "unknown" es provisional: se sigue buscando un OCSP "good"/"revoked" o una
CRL, y si no aparece nada concluyente cuenta como no verificado). Topes de recursos: hasta 50 firmas por PDF (más
es un error), 300 certificados, 300 OCSP y 300 CRL del DSS (las CRL de más de 5 MB se ignoran) y 300 certificados
en el conjunto con el que se arman las cadenas (sin contar las raíces de confianza). Lo que pasa de esos topes se
recorta, no se rechaza: un tope de recursos no es una firma rota.

`weakAlgorithm` (por firma, con `weakAlgorithmReasons`) y `summary.anyWeakAlgorithm` marcan algoritmos débiles:
resumen SHA-1 o MD5 en la firma, en el sello de tiempo o en un certificado de la cadena que no es la raíz, SubFilter
`adbe.pkcs7.sha1`/`adbe.x509.rsa_sha1`, o clave RSA de menos de 2048 bits. La firma puede verificar, pero no cuenta
para `summary.allValid` ni `summary.allTrusted`; la página `/verify` lo muestra como aviso.

Los PDF que se suben para firmar se sanean (ver «Saneamiento de los PDF subidos» en ARQUITECTURA.md): las firmas
digitales que traían se pierden en la copia guardada y en el PDF final (`hadSignatures` en la respuesta de la subida).
Para validar esas firmas hay que usar el archivo original con `/v1/validate`.

## 4. Firma XML (facturación electrónica)

`packages/xades`, `POST /v1/xml/sign` y `POST /v1/xml/verify`. Firma enveloped, RSA-SHA256, digests SHA-256
(configurable SHA-512); el perfil `sunat-cpe` usa RSA-SHA1 y SHA-1 por defecto (ver tabla). C14N 1.0 inclusiva y exclusiva de `xml-crypto`, con un ajuste: en la inclusiva se
emite el namespace por defecto heredado en el ápice (xml-crypto no lo hace). La salida se contrasta en los
tests con un verificador propio, con `xml-crypto` y con **libxml2** (lxml, `packages/xades/test/verify_xmldsig.py`).

| Perfil | Supuestos (a confirmar con la documentación técnica vigente de cada autoridad) |
|---|---|
| `dgii-ecf` | DGII e-CF (RD): XMLDSig enveloped **sin XAdES**, C14N inclusiva, `ds:Signature` al final del elemento raíz, `X509Certificate` del firmante en `KeyInfo`. |
| `dian-fe` | DIAN (CO): XAdES-EPES v1.3.2, política v2 (`https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf`, hash configurable — el valor por defecto debe verificarse contra el Anexo Técnico), rol `supplier`, C14N inclusiva, `SigningTime` con −05:00, referencias a documento + `KeyInfo` + `SignedProperties`, firma dentro del último `ext:ExtensionContent` vacío. |
| `sunat-cpe` | SUNAT (PE), comprobantes electrónicos UBL 2.1: XMLDSig enveloped **sin XAdES**, C14N inclusiva, **RSA-SHA1 con digest SHA-1 por defecto** (como la guía de elaboración de documentos XML UBL 2.1 de SUNAT; `signatureAlgorithm: "rsa-sha256"` si el OSE/SEE lo acepta), firma dentro del **primer** `ext:ExtensionContent` vacío, `Id` de `ds:Signature` tomado de `cac:Signature/cbc:ID` (o `SignatureSP`). RSA-SHA1 solo lo puede hacer un certificado en custodia propia (KMS no firma SHA-1). |
| `xades-bes` | Genérico: C14N exclusiva, `SigningCertificate` + `DataObjectFormat`. |
| `xades-epes` | Igual que BES + `SignaturePolicyIdentifier` (política obligatoria en el pedido). |

## 5. Certificados de la organización (custodia)

`POST /v1/certificates` recibe el `.p12/.pfx` (base64) y su contraseña; se abre con `node-forge` (modernos
AES/PBKDF2 y legados 3DES/SHA-1), se extrae la cadena y la clave RSA. **Cifrado de sobre**: clave de datos
aleatoria → AES-256-GCM sobre el PKCS#8; la clave de datos se envuelve con KMS (`CUSTODY_KMS_KEY_ID`,
`EncryptionContext purpose=calasign-tenant-certificate`) o, sin KMS, con `SECRET_KEY`. La API nunca devuelve
la clave; borrar el certificado elimina el material. Cada uso queda en la auditoría de cuenta
(`certificate.used`, con hashes de entrada y salida).

## 6. Conectores de firma (CSC v2)

`packages/pdf/src/csc.ts`: cliente de la Cloud Signature Consortium API v2 (`auth/login` o OAuth2
client_credentials, `credentials/list|info|authorize`, `signatures/signHash`) que implementa
`SignatureProvider`. Configuración por `CSC_CONNECTORS` (JSON). `calasign-ca` es un placeholder con la misma
interfaz (`CALASIGN_CA_CSC_URL`, `CALASIGN_CA_TOKEN_URL`, `CALASIGN_CA_CLIENT_ID`, `CALASIGN_CA_CLIENT_SECRET`),
sin cablear a la CA real. `GET /v1/signature-providers`, `POST /v1/signature-providers/:id/test`.

## 6b. Firma con el certificado del titular

Un firmante con `signatureType: "certificate"` agrega su propia firma PAdES B-T al PDF. La firma se hace con un
token, el almacén de Windows o un `.p12`, usando el Firmador CalaSign. Va como revisión incremental, después de la
firma electrónica y **antes** del sello de la plataforma, que se agrega al final con el LTV de siempre. El
certificado de finalización ya está dentro del PDF de trabajo, así que solo anota «firmará con certificado digital».
Los datos del certificado quedan en los eventos `recipient.certificate_signed` y `recipient.certificate_rejected`
y en los reportes de `/verify` y `/v1/validate`. Detalle en [`FIRMA-CON-CERTIFICADO.md`](FIRMA-CON-CERTIFICADO.md).

### Horas del certificado y fecha de firma

El certificado de finalización escribe todas las horas en el **huso de la organización** (`tenants.time_zone`,
Ajustes → Organización), con el desfase a la vista («2026-10-29 18:03:12 UTC−03:00») y una línea «Huso horario» que
dice cuál es. La fecha de los campos «fecha de firma» se calcula en ese mismo huso y se estampa con su desfase
(«29/10/2026 UTC−03:00»). Nunca se usa el huso del navegador del firmante: lo elige el cliente y no sirve como
evidencia. Sin configurar, UTC (como antes). Los eventos de la cadena se guardan siempre en UTC; el huso sólo cambia
cómo se imprimen.

## 7. Desarrollo y pruebas

```bash
tsx scripts/dev-pki.mts --port 4290           # PKI de laboratorio (OCSP, CRL, TSA) + CSC de prueba en 4291
# arrancar la API con las variables de var/dev-pki/api.env
node scripts/e2e-evidence.mjs http://localhost:4000 --pki-dir var/dev-pki
```

No usar los puertos 4190/6000/… para la PKI: `fetch` los bloquea ("bad port").

## 8. Variables de entorno nuevas

| Variable | Default | Uso |
|---|---|---|
| `SEAL_LEVEL` | `auto` | Nivel PAdES por defecto del entorno |
| `CUSTODY_KMS_KEY_ID` | — | Clave KMS simétrica para envolver las claves de los .p12 |
| `TRUST_STORE_DIR` | — | Raíces de confianza adicionales (PEM/DER) |
| `VALIDATE_ONLINE_REVOCATION` | `false` | OCSP/CRL online en `/v1/validate` |
| `CSC_CONNECTORS` | — | JSON con conectores CSC v2 |
| `CALASIGN_CA_*` | — | Conector `calasign-ca` |
| `FIRMADOR_DIST_DIR` | `packages/firmador/dist` | Binarios del Firmador CalaSign que se ofrecen en `/firmador` |

En AWS (dev/prod), el rol de la app necesita `kms:Encrypt` y `kms:Decrypt` sobre la clave de custodia (con la
condición `kms:EncryptionContext:purpose = calasign-tenant-certificate`), y salida HTTP a las URLs OCSP/CRL de
las cadenas que se usen.
