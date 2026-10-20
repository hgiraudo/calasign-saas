# Firma con certificado propio (token, almacén de Windows o .p12)

Un firmante puede firmar **con su propio certificado digital**: un token USB o tarjeta (PKCS#11), un certificado
instalado en Windows o un archivo `.p12/.pfx`. Así se cubren los casos que piden firma digital del titular
(ICP-Brasil A1/A3, DNIe de Perú, certificados de entidades acreditadas por ONAC, INDOTEL o el IP de Honduras).
La firma se hace en la computadora del titular con el **Firmador CalaSign** (`packages/firmador`). La clave
privada nunca sale del dispositivo: el servidor manda un hash y recibe una firma.

## 1. Configuración del destinatario

`RecipientInput` (y los roles de plantilla) tienen dos campos más:

```jsonc
{
  "role": "signer",
  "signatureType": "certificate",          // "electronic" (por defecto) | "certificate"
  "certificateRequirements": {
    "matchIdDocument": true,               // el certificado tiene que corresponder a idDocumentNumber (exige cadena de confianza)
    "allowedIssuers": ["ICP-Brasil"],      // partes del DN del emisor; vacío = cualquiera (exige cadena de confianza)
    "requireQualified": false              // exigir una CA del almacén de confianza (TRUST_STORE_DIR)
  }
}
```

- Solo un `signer` puede usar `certificate` (los `cc` y los aprobadores no). La API responde 400 en otro caso.
- Se hereda en plantillas (roles), envíos masivos y formularios web (salen de plantillas). La delegación y la
  reasignación pasan el tipo de firma y los requisitos al nuevo destinatario.
- Un firmante con certificado no necesita un campo de firma en el documento. Si tiene campos, los completa en la
  firma electrónica, como siempre.
- `matchIdDocument` solo se aplica si el destinatario tiene `idDocumentNumber`. Cuando se aplica, la cadena tiene que llegar a una raíz de confianza (`TRUST_STORE_DIR`): cualquiera puede emitirse un certificado con el documento de otra persona, así que la coincidencia sola no prueba la identidad.

## 2. Ciclo del sobre

1. **Firma electrónica.** Todos firman como siempre, incluidos los firmantes con certificado: completan sus
   campos y aceptan.
2. **PDF de trabajo.** Cuando no queda nadie, el worker arma el PDF final (estampado y certificado de
   finalización) **sin el sello de la plataforma**. Lo guarda (`envelope_certsign`) y el sobre pasa a
   `awaiting_certificates`. Se registra el evento `envelope.awaiting_certificates` y al primer firmante con
   certificado le llega la notificación `certificate_request`.
3. **Firmas con certificado.** Cada firmante firma **en orden de ruteo**, uno por vez. Cada firma es una revisión
   incremental **PAdES B-T** (CAdES detached, `ETSI.CAdES.detached`, con sello de tiempo RFC 3161) y no invalida
   las anteriores. Al terminar uno, se avisa al siguiente.
4. **Sello y LTV.** Con la última firma, `ready = true` y el sobre vuelve a `finalizing`. El job `finalize`
   agrega el sello de la plataforma como otra revisión incremental (campo `SelloIntegridad`) y después corre el
   proceso de evidencia de siempre (DSS/LTV según `SEAL_LEVEL`). El sobre queda `completed`.

Mientras el sobre está en `awaiting_certificates` se puede anular: los códigos del Firmador ya emitidos dejan de servir (410).

### Decisión: el certificado de finalización

El certificado de finalización es una página del PDF. Se genera **antes** de las firmas con certificado, porque
agregarle una página después rompería esas firmas. Por eso, para cada firmante con certificado, solo dice
*"Firmará con certificado digital"*. Los datos del certificado (titular, emisor, serie, vigencia, hora y
coincidencia de identidad) quedan en:

- la firma misma, dentro del PDF;
- los eventos de evidencia `recipient.certificate_signed` (y `recipient.certificate_rejected` para los intentos
  rechazados), en la cadena de hashes del sobre;
- el reporte de `/verify` y `POST /v1/validate`, que lista cada firma del PDF con su certificado y su validez;
- `GET /v1/envelopes/:id/certificate-signatures`, el progreso que ve el remitente.

## 3. Protocolo del Firmador (solo hash)

```
navegador del firmante                API CalaSign                           Firmador (127.0.0.1)
POST /v1/signing/:token/certsign/pairing ─▶ código XXXXX-XXXXX (10 min, un solo uso)
  calasign-firmador://sign?api=<base>&code=<código> ───────────────────────▶ abre la interfaz local
                                       ◀── GET  /v1/certsign/sessions/:code         (datos del sobre)
                                       ◀── GET  /v1/certsign/sessions/:code/document (PDF de trabajo)
                                       ◀── POST /v1/certsign/sessions/:code/certificate {chain}
                                            controles + reserva de la firma → {digestToSign, dataToSign, …}
                                       ◀── GET  /v1/certsign/sessions/:code/prepared (PDF preparado)
                                                                              vínculo documento–firma
                                                                              firma local (token/Windows/.p12)
                                       ◀── POST /v1/certsign/sessions/:code/signature {signature}
                                            CMS + sello de tiempo + validatePdf → evidencia → siguiente o sello
```

- **Código.** 10 caracteres sin ambigüedades (sin 0/O/1/I). Se guarda solo su SHA-256 (`certsign_sessions.code_hash`).
  Vence a los 10 minutos y sirve para una sola firma; un código usado devuelve `410`. Pedir un código nuevo invalida
  los anteriores del mismo firmante. Los endpoints tienen límite de pedidos.
- **Controles del certificado** (`checkSigningCertificate`, `packages/pdf/src/certcheck.ts`):
  - vigencia;
  - key usage `digitalSignature` o `nonRepudiation`;
  - EKU compatible con firma de documentos, si el certificado declara EKU;
  - que no sea un certificado de CA;
  - emisor dentro de `allowedIssuers` (si se usa, la cadena tiene que llegar a una raíz de confianza: el nombre del emisor se puede falsificar);
  - cadena hasta una raíz del almacén de confianza (obligatorio con `requireQualified`, con `allowedIssuers` y cuando hay que verificar el documento de identidad; si no, es una advertencia);
  - **identidad**: un número del certificado tiene que coincidir con el documento declarado. Se busca primero en el
    otherName de ICP-Brasil (CPF `2.16.76.1.3.1`, CNPJ `2.16.76.1.3.3`), después en el `serialNumber` del sujeto
    (incluidos los prefijos ETSI como `PNOPE-`, `IDCCO-`) y al final en el CN (`NOMBRE:CPF`). Se comparan dígitos, así
    que `001-1234567-8`, `123.456.789-09` y `1.020.304.050` coinciden con el mismo número sin puntos ni guiones.
  - Un certificado rechazado devuelve `422 certificate_rejected` con los motivos y queda en la evidencia.
- **Preparación.** `prepareExternalSignature` (`packages/pdf/src/external.ts`) agrega la revisión incremental con el
  campo de firma y el espacio reservado. Arma los atributos firmados (contentType, messageDigest del ByteRange,
  signingCertificateV2) y devuelve su DER (`dataToSign`) y su SHA-256 (`digestToSign`). La revisión preparada queda
  guardada en el servidor.
- **Algoritmos.** RSA PKCS#1 v1.5 con SHA-256 y ECDSA P-256 o P-384 con SHA-256. Para ECDSA se acepta la firma en DER
  o en `r||s` (como la devuelven PKCS#11 y Windows), y se normaliza a DER.
- **Cierre.** La firma se verifica con la clave pública del certificado antes de aceptarla. Después se arma el CMS
  con el sello de tiempo de `TSA_URL`: si `TSA_REQUIRED=false` y la TSA falla, se firma sin sello. Se valida el PDF
  completo (`validatePdf`: todas las firmas anteriores siguen intactas) y, en una transacción, se guarda el PDF, se
  marca la firma y se registra el evento.

## 4. Firmador CalaSign (`packages/firmador`)

| Fuente | Cómo firma |
|---|---|
| **Token/tarjeta (PKCS#11)** | `pkcs11js`: `CKM_RSA_PKCS` sobre el DigestInfo SHA-256, o `CKM_ECDSA` sobre el hash. Detecta los módulos más comunes (SafeNet eTokenPass, Feitian, Bit4id, Watchdata, OpenSC, SoftHSM) por sistema operativo; también acepta una ruta. Pide el PIN. |
| **Almacén de Windows** | PowerShell con `-EncodedCommand`: busca en `Cert:\CurrentUser\My` los certificados con clave y firma el hash (`RSA.SignHash` Pkcs1 o `ECDsa.SignHash`). Windows muestra su propio diálogo de PIN si el certificado es de un token. |
| **Archivo .p12/.pfx** | `node-forge` (cifrados modernos y legados). Firma con `crypto.sign` de Node. |

- **Interfaz local.** Un servidor en `127.0.0.1` con puerto al azar y una ruta con token secreto. Rechaza otro
  `Host` (protege contra DNS rebinding), acepta solo JSON y tiene CSP estricta. Se abre en el navegador. Muestra
  la organización, el sobre, el firmante y el SHA-256 del documento antes de firmar.
- **Seguridad del lado del Firmador.** Antes de firmar comprueba lo que manda el servidor: tiene que ser un
  conjunto de atributos firmados de CMS (contentType + messageDigest de 32 bytes, solo atributos conocidos) y el
  hash tiene que ser su SHA-256. Así no firma un hash arbitrario aunque el link apunte a un servidor falso. Exige
  https, salvo localhost.
- **Vínculo documento–firma** (`assertPreparedMatchesDocument`). Antes de firmar, el Firmador descarga el PDF de
  trabajo y el PDF preparado (`GET …/prepared`, disponible solo después de enviar el certificado) y comprueba con
  bytes, sin confiar en el servidor:
  1. el SHA-256 del PDF de trabajo es el `documentSha256` anunciado (el que ve el titular);
  2. el PDF preparado empieza exactamente con esos bytes: la firma nueva es una revisión agregada;
  3. el único `ByteRange` de la revisión nueva cubre todo el archivo salvo `/Contents`, que está en la revisión
     nueva y solo tiene dígitos hexadecimales;
  4. el SHA-256 de los bytes cubiertos es el `messageDigest` de los atributos a firmar.

  Si algo no coincide, responde `document_mismatch` y no firma. Así un servidor (o un link) no puede hacer firmar
  atributos de un documento distinto del que el titular tiene delante.
- **Esquema `calasign-firmador://`.** Se registra con `calasign-firmador register-protocol`: un `.desktop` +
  `xdg-mime` en Linux, o `HKCU\Software\Classes` en Windows, sin permisos de administrador.
- **Línea de comandos** (también para pruebas automáticas):

  ```bash
  calasign-firmador sign --api https://dev.calasign.com --code ABCDE-FGHJK --p12 firma.p12 --password-env CLAVE
  calasign-firmador sign --api … --code … --pkcs11 /usr/lib/libeTPkcs11.so [--slot 0]   # PIN en CALASIGN_TOKEN_PIN o --pin
  calasign-firmador sign --api … --code … --windows [--cert <thumbprint>]
  calasign-firmador list --p12 firma.p12 --password-env CLAVE
  ```

- **Binarios autocontenidos** (Node SEA):

  ```bash
  corepack pnpm --filter @calasign/firmador build:linux     # dist/calasign-firmador-linux-x64 (probado)
  corepack pnpm --filter @calasign/firmador build:windows   # dist/calasign-firmador-windows-x64.exe (script, sin probar)
  ```

  El build empaqueta con esbuild y descarga el `node` oficial de la misma versión. El de las distros suele ser un
  envoltorio de `libnode` sin el fusible de SEA. Después inyecta el blob con `postject`. `pkcs11js` es nativo y no
  entra en el blob: se copia a `dist/linux-x64-pkcs11/` y se instala junto al ejecutable.
- **Descargas.** La API publica los binarios que haya en `FIRMADOR_DIST_DIR` (por defecto `packages/firmador/dist`)
  en `GET /v1/firmador/downloads` y `GET /v1/firmador/download/:file`. La página pública `/firmador` los lista, con
  su tamaño y SHA-256, e instrucciones por sistema operativo. Sin binario, dice «Próximamente para tu sistema».

## 5. Datos (migración `0018_certificate_signing`)

| Tabla / columna | Contenido |
|---|---|
| `recipients.signature_type`, `recipients.certificate_requirements` | Tipo de firma y requisitos (también en `template_roles`) |
| `envelopes.status` | Nuevo valor `awaiting_certificates` |
| `envelope_certsign` | PDF de trabajo (clave en el blob store, SHA-256), hora de finalización y cabeza de la cadena de evidencia congeladas, `ready` |
| `certificate_signatures` | Una fila por firmante con certificado: posición, estado, datos del certificado, fuente de la coincidencia de identidad, SHA-256 del PDF resultante |
| `certsign_sessions` | Códigos (hash), estado, revisión preparada, atributos firmados, cadena, controles, IP y user agent |

## 6. Variables de entorno

| Variable | Uso |
|---|---|
| `TSA_URL`, `TSA_REQUIRED` | Sello de tiempo de cada firma con certificado (los mismos que el sello de la plataforma) |
| `TRUST_STORE_DIR` | Raíces de confianza para `requireQualified`, `allowedIssuers`, la verificación del documento de identidad y para marcar el certificado como confiable |
| `FIRMADOR_DIST_DIR` | Carpeta con los binarios del Firmador que se ofrecen para descargar |

## 7. Pruebas

```bash
corepack pnpm --filter @calasign/pdf exec vitest run test/certsign.test.ts   # identidad, controles, CMS RSA/EC
corepack pnpm --filter @calasign/firmador test                              # deep link, Windows, .p12, UI local
node scripts/e2e-certsign.mjs                                               # flujo completo (levanta PKI y API en 4118)
```

`e2e-certsign` usa la PKI de laboratorio (`scripts/e2e-certsign-lab.mts`). Cubre dos firmantes con certificado (Perú,
RSA con `PNOPE-…`; Brasil, ECDSA P-256 con CPF en el otherName de ICP-Brasil) y uno electrónico, a través del
Firmador por línea de comandos. Comprueba que se respete el orden (409), que se rechace el certificado de otra persona,
que no se pueda reusar un código (410) y que el PDF final tenga tres firmas válidas (dos titulares y el sello),
validadas también con `pdfsig`. La prueba con SoftHSM (PKCS#11) se salta con una advertencia si `softhsm2-util` no está
instalado.

## 8. Pendiente

- Probar con tokens reales (SafeNet, Feitian, Watchdata ICP-Brasil, DNIe) y con SoftHSM en CI.
- El almacén de Windows solo tiene pruebas unitarias (scripts generados): falta probarlo en Windows. El build
  `windows-x64` está escrito pero no se corrió.
- Firma de código: Authenticode para el `.exe` (sin firma, SmartScreen avisa) y codesign + notarización para macOS.
- macOS: falta el bundle `.app` con `Info.plist` para registrar el esquema, y el binario.
