# CalaSign — Análisis de mercado y roadmap de features

> Motor de firma electrónica en la nube (SaaS + API). Documento de trabajo, octubre 2026.
> **Mercados objetivo: República Dominicana, Honduras, Colombia, Brasil y Perú** (Perú agregado el 2026-10-17).

---

## 1. Resumen ejecutivo

- El núcleo de todos los proveedores es el mismo: **sobre/transacción → documentos → destinatarios con roles → campos → flujo de firma → documento sellado + evidencia (audit trail)**. Ese núcleo es lo primero que hay que construir bien, porque todo lo demás se apoya en él.
- La diferencia entre un producto "de juguete" y uno serio no está en la UI, sino en **la evidencia legal**: sellado criptográfico del PDF (PAdES), sello de tiempo (TSA), audit trail inmutable, autenticación del firmante y certificado de finalización.
- **La API es un producto en sí mismo.** DocuSign, Dropbox Sign y OneSpan ganan contratos grandes por la API (firma embebida, webhooks, sandbox, SDKs), no por la web.
- El mercado se está moviendo de "firmar" a **gestionar el acuerdo completo** (DocuSign IAM / Navigator / Maestro / Iris, PandaDoc con generación de documentos) y a **IA y agentes** (análisis de contratos, MCP para que agentes de IA disparen firmas).
- Oportunidades para un jugador nuevo: precio por uso amigable para desarrolladores, firma embebida sin fricción y white-label real, **cumplimiento regulatorio local en los cuatro países objetivo** (firma digital con certificados de entidades acreditadas por INDOTEL, Instituto de la Propiedad, ONAC e ICP-Brasil), y ser "AI-native" desde el día uno.
- **Los cuatro países comparten la misma estructura legal de dos niveles**: firma electrónica simple (vale como prueba, sirve para la mayoría de los contratos privados) y firma digital/cualificada con certificado de una entidad acreditada (presunción legal fuerte, obligatoria para ciertos trámites). Eso permite **un solo motor con "conectores de certificación" por país**.
- **WhatsApp es el canal de firma en la región**, no el email. Tiene que estar en el MVP.
- Gancho comercial: la **facturación electrónica** obliga a las empresas a tener certificado digital (DGII e-CF en RD, con plazo para pequeñas empresas hasta el 15/11/2026; DIAN en Colombia). Un servicio de firma XML (XAdES) por API es una puerta de entrada.

---

## 2. Panorama de proveedores

| Proveedor | Posicionamiento | Fuertes | Notas para nosotros |
|---|---|---|---|
| **DocuSign** | Líder, enterprise | eSignature REST API v2.1, Connect (webhooks), PowerForms/Web Forms, Bulk Send, ID Verification, firma basada en estándares (QES/AES con certificados), Notary, Payments, CLM. Plataforma **IAM**: Navigator (repositorio con IA), Maestro (orquestación de workflows), Iris (motor de IA), App Center, Agent Studio. | Referencia de modelo de datos (envelopes, recipients, tabs). La firma embebida queda en planes caros: es un hueco de precio. |
| **Adobe Acrobat Sign** | Enterprise, ecosistema Adobe/Microsoft | Agreements, Library templates, Web Forms, Mega Sign (envío masivo), Workflow Designer, webhooks con scope (cuenta/grupo/usuario/recurso), integración profunda con Acrobat, Microsoft 365 y Teams. Fundó el **Cloud Signature Consortium** (firmas con certificado en la nube, QES). | Su modelo de webhooks por recurso y verificación de URL es un buen patrón para copiar. |
| **OneSpan Sign** | Banca, seguros, gobierno, sectores regulados | Autenticación fuerte (SMS, KBA, verificación de identidad biométrica), **Virtual Room** (firma en videollamada con co-browsing y grabación), audit trail embebido en el documento, white-label completo, opción on-premise/nube privada. Dirección nueva: detección de manipulación de adjuntos, credenciales digitales/wallets, soporte MCP para agentes. | Referencia para el segmento regulado y para "evidencia fuerte". |
| **Dropbox Sign** (ex HelloSign) | SMB y desarrolladores | API simple y bien documentada, firma/envío/templates embebidos, test mode gratis, branding. | Referencia de **experiencia de desarrollador**: así tiene que sentirse nuestra API. |
| **PandaDoc** | Ventas / propuestas | Generación de documentos, editor, librería de contenido, cotizaciones/CPQ, cobro, analítica de visualización. | La "generación de documentos" es un diferenciador de upsell. |
| **SignNow / airSlate** | Precio | Precio por invitación, automatización de workflows sin código. | Presión sobre precio: el plan base tiene que ser competitivo. |
| **Yousign, Signaturit, Zoho Sign** | Europa / SMB | Cumplimiento eIDAS (AES/QES vía prestadores cualificados), APIs simples, precio bajo. | Modelo de cómo ofrecer niveles de firma (simple/avanzada/cualificada) como opción por documento. |
| **Clicksign, D4Sign, ZapSign, Autentique** | Brasil | Precio bajo, firma por **WhatsApp** (ZapSign), APIs simples, integración con ICP-Brasil, validación de identidad con selfie/documento, pago por Pix. | Competencia directa en Brasil: precio y WhatsApp son el estándar mínimo. |
| **Certicámara, GSE, Andes SCD** | Colombia (entidades de certificación acreditadas por ONAC) | Certificados digitales, firma electrónica/digital, estampado de tiempo, pagaré electrónico, firma para facturación DIAN. | Socios más que competidores: son la fuente de certificados para firma digital en Colombia. |
| **Digifirma (Cámara de Comercio de Santo Domingo), Avansi, Viafirma** | República Dominicana | Certificados digitales autorizados por INDOTEL, firma para e-CF de la DGII. | Socios de certificación en RD; el mercado SaaS de firma está poco desarrollado: oportunidad. |
| **Banco Central de Honduras (PSC)** | Honduras | Primera entidad autorizada por el Instituto de la Propiedad como prestadora de servicios de certificación. | Mercado chico y temprano; entrar con firma simple + socio de certificación. |
| **Documenso, OpenSign** | Open source | Implementaciones abiertas del núcleo (firma de PDF, campos, audit log). | Útiles para estudiar implementación, no para copiar código sin revisar licencias (AGPL). |

---

## 3. Catálogo de features del mercado

### 3.1 Usuario web — Remitente

| Área | Features |
|---|---|
| Documentos | Subir PDF/Word/imagen (conversión a PDF), múltiples documentos por sobre, reordenar/rotar/borrar páginas, combinar. |
| Destinatarios | Roles: firmante, aprobador, copia (CC), editor, testigo, firmante en persona; orden secuencial, paralelo o mixto; mensaje y asunto por destinatario; idioma por destinatario. |
| Campos | Firma, iniciales, fecha de firma, nombre, email, empresa, cargo, texto, número, checkbox, radio, desplegable, adjunto, fórmula/cálculo, sello, nota. Validaciones (regex, obligatorio, máscara). **Lógica condicional** (mostrar campo si…). Campos compartidos entre firmantes. |
| Colocación | Drag & drop, **auto-detección de campos con IA**, anchor tags (colocar campo donde aparece un texto). |
| Templates | Templates reutilizables con roles, campos prellenados, carpetas compartidas, versión. |
| Envío | Recordatorios automáticos, vencimiento, corrección de sobre en vuelo, anular (void), reasignar, reenviar. |
| Envío masivo | Bulk send desde CSV (un mismo documento a N personas). |
| Formularios públicos | Web Forms / PowerForms: link público o embebido donde el firmante se autoregistra y firma. |
| Seguimiento | Dashboard por estado (borrador, enviado, visto, firmado, rechazado, vencido), historial, búsqueda, filtros, carpetas, etiquetas. |
| Pagos | Cobrar dentro del flujo de firma (Stripe, MercadoPago). |

### 3.2 Usuario web — Firmante

- Firma sin cuenta, desde email o SMS/WhatsApp.
- Tipos de firma: dibujar, tipear (fuente), subir imagen, firma con certificado digital.
- Mobile-first, responsive, accesible (WCAG 2.1 AA).
- Navegación guiada ("siguiente campo"), adopción de firma reutilizable.
- Rechazar con motivo, delegar/reasignar, descargar copia, comentarios.
- **Consentimiento de registros electrónicos** (requisito ESIGN/UETA en EE. UU.).
- Autenticación: link por email, código de acceso, OTP por SMS/email, KBA, verificación de identidad (foto de DNI + selfie con prueba de vida), SSO, certificado.
- Firma en persona (host con tablet). *(La firma por videollamada tipo Virtual Room se descartó del producto el 2026-10-18.)*

### 3.3 Administración y empresa

- Organizaciones, equipos/grupos, usuarios, roles y permisos (RBAC).
- Branding: logo, colores, dominio propio para emails y para la página de firma (white-label).
- SSO (SAML 2.0, OIDC), aprovisionamiento SCIM, 2FA obligatorio.
- Políticas: retención y borrado de documentos, métodos de autenticación permitidos, plantillas de email.
- Logs de auditoría de la cuenta (quién hizo qué), exportación.
- Residencia de datos (región de almacenamiento), claves de cifrado del cliente (BYOK).
- Facturación por plan / por uso, límites, reportes de consumo.

### 3.4 API y desarrolladores

| Área | Lo que ofrecen los líderes |
|---|---|
| Autenticación | OAuth 2.0 (authorization code, JWT grant / client credentials para servidor-a-servidor), API keys, scopes. |
| Recursos | Envelopes/agreements, documents, recipients, tabs/fields, templates, bulk send, web forms, users, groups, accounts, brands. |
| Firma embebida | Generar URL de firma para iframe/redirect (*recipient view*), envío embebido (*sender view*), edición de template embebida, eventos por `postMessage`. |
| Eventos | Webhooks (DocuSign Connect, Adobe webhooks) con firma HMAC, reintentos con backoff, filtros por evento, scope por cuenta o por sobre, verificación de URL, log de entregas y re-envío manual. |
| Calidad de API | Idempotency keys, paginación, rate limits documentados, versionado, errores consistentes, OpenAPI. |
| Entorno | Sandbox/test mode gratis, SDKs (Node, Python, Java, .NET, PHP, Go), Postman, ejemplos, CLI. |
| Descargas | PDF firmado, documentos combinados, certificado de finalización, audit trail en JSON/PDF. |
| Integraciones | Salesforce, Microsoft 365/Teams, Google Workspace, Slack, HubSpot, Zapier/Make, SharePoint/Drive/Dropbox. |
| IA / agentes | Servidor **MCP** para que agentes de IA creen y consulten sobres (SignWell, OneSpan, DocuSign van en esa dirección). |

### 3.5 Capa legal y criptográfica (lo que no se ve pero define el producto)

- **Niveles de firma**:
  - *Simple (SES)*: email + click + evidencia. Suficiente para la mayoría de contratos comerciales (ESIGN/UETA en EE. UU.; firma electrónica simple en RD, Honduras, Colombia, Brasil y Perú).
  - *Avanzada (AES)*: vinculada únicamente al firmante, con control exclusivo y detección de cambios (eIDAS).
  - *Cualificada (QES) / Firma digital*: certificado emitido por un prestador acreditado y dispositivo seguro (HSM). Ver sección 3.6 para los cuatro países objetivo. Referencia internacional: en la UE, QES remota vía prestadores cualificados (eIDAS 2).
- **Sellado del PDF**: firma PAdES (B-B → B-T con sello de tiempo → B-LT con datos de validación → B-LTA para archivo a largo plazo), certificado de la plataforma en HSM/KMS.
- **Sello de tiempo** RFC 3161 de una TSA confiable.
- **Audit trail** inmutable: IP, user agent, geolocalización aproximada, hash de cada documento, timestamps de cada evento, método de autenticación usado. Encadenado por hash.
- **Certificado de finalización** en PDF anexado o separado.
- Validación de firmas de terceros (subir un PDF y verificar).
- Integración con **CSC API** (Cloud Signature Consortium) para firmar con certificados de prestadores externos.

### 3.6 Marco legal y mercado por país

| | República Dominicana | Honduras | Colombia | Brasil |
|---|---|---|---|---|
| **Ley base** | Ley 126-02 de Comercio Electrónico, Documentos y Firmas Digitales; Resolución INDOTEL 017-19 (nueva terminología: Firma Electrónica Simple, etc.) | Ley sobre Firmas Electrónicas, Decreto 149-2013; Reglamento Acuerdo Ejecutivo 41-2014; reforma Decreto 33-2020 | Ley 527 de 1999; Decreto 2364 de 2012 (firma electrónica); Decreto 1747 de 2000 (firma digital); compilados en Decreto 1074 de 2015 | MP 2.200-2/2001 (ICP-Brasil); Lei 14.063/2020 (niveles simple / avanzada / cualificada) |
| **Regulador / acreditador** | INDOTEL | Instituto de la Propiedad (Dirección General de Propiedad Intelectual) | ONAC (acredita entidades de certificación digital); SIC | ITI (Instituto Nacional de Tecnologia da Informação) — ICP-Brasil |
| **Niveles** | Firma electrónica simple / firma digital segura (certificado de entidad autorizada) | Firma electrónica / firma electrónica avanzada con certificado de PSC acreditado | Firma electrónica (confiable y apropiada) / firma digital (certificado de ECD acreditada por ONAC) | Simple / avanzada (incluida la de gov.br para trámites con el gobierno) / cualificada (ICP-Brasil) |
| **Proveedores de certificados** | Digifirma (CCSD), Avansi, Viafirma, otros autorizados por INDOTEL | Banco Central de Honduras (primer PSC) | Certicámara, GSE, Andes SCD, otras acreditadas por ONAC | Decenas de AC de ICP-Brasil (Serasa, Certisign, Valid, Soluti, etc.) |
| **Casos que exigen firma digital** | e-CF (factura electrónica DGII, Ley 32-23), trámites con el Estado | Trámites con el Estado y sector financiero | Factura electrónica DIAN (XAdES-EPES), algunos trámites públicos | Transferencia y registro de inmuebles (art. 5 Lei 14.063), varios actos con el gobierno |
| **Protección de datos** | Ley 172-13 | Sin ley integral de datos personales (verificar estado de proyectos) | Ley 1581 de 2012 (SIC) | LGPD (Lei 13.709/2018), ANPD; reglas de transferencia internacional |
| **Idioma / canales** | ES · WhatsApp | ES · WhatsApp | ES · WhatsApp, email | **PT-BR** · WhatsApp domina |
| **Pagos** | Tarjeta, transferencia | Tarjeta, transferencia | PSE, tarjeta, Nequi | **Pix**, boleto, tarjeta |
| **Oportunidades** | Mercado SaaS poco atendido; ola de facturación electrónica 2026 | Mercado temprano; primer jugador SaaS serio puede definir la categoría | Fintech y crédito: **pagaré electrónico**, onboarding bancario, contratos laborales | Mercado más grande y competido; diferenciarse por API, white-label y precio |

#### Perú

| | Perú |
|---|---|
| **Ley base** | Ley 27269, Ley de Firmas y Certificados Digitales; Reglamento aprobado por D.S. 052-2008-PCM y modificatorias |
| **Regulador / acreditador** | INDECOPI, Autoridad Administrativa Competente de la IOFE (Infraestructura Oficial de Firma Electrónica) |
| **Niveles** | Firma electrónica / firma digital (certificado de una entidad acreditada en la IOFE, con presunción de validez equivalente a la manuscrita) |
| **Proveedores de certificados** | RENIEC (entidad de certificación del Estado y DNI electrónico) y entidades privadas acreditadas por INDECOPI |
| **Casos que exigen firma digital** | Comprobantes de pago electrónicos de la SUNAT (UBL 2.1 con XMLDSig, emitidos vía SEE u OSE), trámites con el Estado |
| **Protección de datos** | Ley 29733 de Protección de Datos Personales y su reglamento (Autoridad Nacional de Protección de Datos Personales) |
| **Idioma / canales** | ES · WhatsApp |
| **Pagos** | Tarjeta, Yape/Plin, transferencia; Mercado Pago opera en Perú; procesadores locales (Niubiz, Izipay, Culqi) como adaptadores futuros |
| **Oportunidades** | Facturación electrónica masiva (SUNAT) como puerta de entrada; banca, seguros y crédito con DNI electrónico |

> Hay que confirmar con un abogado local el encuadre de cada caso de uso y, con el OSE/SEE elegido, los algoritmos de firma aceptados para los CPE.

**Conclusiones para el producto:**

1. Un **solo motor** con niveles de firma configurables y **conectores de certificación por país** (interfaz común: obtener certificado, firmar hash, validar). Se empieza con firma simple robusta, que es legal en los cinco países para contratos privados.
2. El **formato de firma** debe soportar PAdES (PDF) y **XAdES** (XML, para facturación electrónica de DGII, DIAN y SUNAT).
3. **Internacionalización** desde el día uno: ES y PT-BR, zonas horarias, formatos de fecha/moneda, documentos de identidad locales (cédula RD, DNI Honduras, cédula Colombia, CPF/CNPJ Brasil, DNI y carné de extranjería Perú).
4. **Residencia de datos**: Brasil es el más exigente (LGPD); tener región en São Paulo facilita ventas a bancos y gobierno.
5. Validación de identidad con fuentes locales: Registraduría (Colombia), JCE (RD), RNP (Honduras), base de CPF / gov.br (Brasil), RENIEC (Perú), vía proveedores de KYC con cobertura regional.

---

## Estado de implementación (dev.calasign.com)

| Fase | Estado |
|---|---|
| 0 — Fundaciones | ✅ Hecha |
| Perú | ✅ Mercado agregado: perfil XML `sunat-cpe`, precios en PEN, carné de extranjería, montos en soles en la IA, página pública. Certificación por país «Próximamente» en el sitio para los cinco países |
| 1 — MVP | ✅ Hecha (incluye WhatsApp y Telegram, ES/PT-BR/EN) |
| 2 — Productividad | ✅ Plantillas, campos nuevos (número, desplegable, empresa, cargo, adjunto), OTP por email/SMS/WhatsApp, aprobador, delegación y reasignación, recordatorios automáticos, branding básico, planes y facturación (Stripe / Mercado Pago) |
| 3 — API y firma embebida | ✅ API v1 + OpenAPI + página /developers, firma embebida (iframe + postMessage), webhooks HMAC con reintentos, anclas de texto, idempotencia. ✅ OAuth 2.0 (client credentials y authorization code + PKCE), SDKs Node y Python |
| 4 — Escala y equipos | ✅ Miembros e invitaciones, roles y permisos (RBAC), grupos, auditoría de cuenta, retención, 2FA; envío masivo (CSV/API), formularios web públicos, campos condicionales y calculados; firma en persona, corrección en vuelo, reportes, PWA, reenvío de copias, accesibilidad. ✅ Slack/Teams, guía Zapier/Make, exportación a Google Drive/Dropbox/OneDrive/S3, dominio propio |
| 5 — Evidencia fuerte y cumplimiento | ✅ Verificación pública y validador de firmas, PAdES B-LT/B-LTA, firma XML para DGII/DIAN/SUNAT (Perú), custodia de certificados por organización, sello de empresa, nivel de firma, conectores CSC, verificación de identidad (mock/Truora/Veriff), SSO OIDC/SAML, SCIM. ✅ BYOK (clave KMS del cliente), residencia de datos por celdas (enrutamiento listo), renovación automática de sellos de archivo B-LTA, dominios SSO verificados por DNS. ⏳ Conectores reales por país (ICP-Brasil, ONAC, INDOTEL, Honduras, INDECOPI/RENIEC), celda São Paulo desplegada (requiere cambiar la SCP de regiones), certificaciones SOC 2/ISO 27001 |
| 6 — Plataforma e IA | ✅ IA (detección de campos, resumen y preguntas del firmante, metadatos y alertas de renovación, revisión contra playbook), repositorio de acuerdos con búsqueda, generación de documentos, workflows sin código, negociación con versiones, servidor MCP para agentes, cobro dentro de la firma. ✅ CRM/ERP: HubSpot, Salesforce, Siigo, Alegra. ⏳ TOTVS y RD Station. Firma por videollamada: descartada |

## 4. Roadmap de features (de menor a mayor)

Cada fase entrega algo usable por sí solo. Las estimaciones suponen un equipo chico (2–4 devs) y son orientativas.

### Fase 0 — Fundaciones (3–4 semanas)
*Objetivo: la base técnica sobre la que se construye todo; nada visible para el cliente todavía.*

- Multi-tenant: organizaciones, usuarios, membresías. Registro/login (email + contraseña, Google), 2FA opcional.
- Almacenamiento de objetos cifrado (S3 o compatible), con hash SHA-256 de cada archivo al subir.
- Pipeline de PDF: normalización, conversión de Word/imagen a PDF, render de páginas a imagen para el editor.
- Cola de trabajos asíncronos (conversión, sellado, emails, webhooks).
- Servicio de email transaccional con tracking de entrega/rebote.
- **Event store / audit log** append-only con encadenado por hash desde el día uno (agregarlo después es muy caro).
- Gestión de claves: certificado de la plataforma en KMS/HSM.
- Observabilidad, CI/CD, entornos separados (dev / sandbox / prod).

### Fase 1 — MVP: firma simple de punta a punta (6–8 semanas)
*Objetivo: un usuario sube un PDF, lo manda a firmar y recibe el documento firmado con evidencia válida.*

- Crear sobre: 1+ documentos, 1+ firmantes, asunto y mensaje.
- Editor drag & drop con campos básicos: firma, iniciales, fecha de firma, nombre, texto, checkbox.
- Orden de firma secuencial y paralelo.
- Experiencia del firmante sin cuenta: link único por **email y WhatsApp** (WhatsApp Business API), consentimiento de uso de medios electrónicos, firma dibujada / tipeada / imagen, mobile-first.
- Interfaz en **español y portugués (Brasil)**; captura de documento de identidad local del firmante (cédula, CPF) en el audit trail.
- Rechazar con motivo.
- Al completar: aplanar campos, **sellar con PAdES B-T** (certificado de plataforma + sello de tiempo RFC 3161), generar **certificado de finalización** con audit trail.
- Envío de copia final a todas las partes.
- Dashboard con estados y descarga.
- Recordatorios y vencimiento básicos; anular sobre.

### Fase 2 — Productividad del remitente (4–6 semanas)
*Objetivo: que se pueda usar todos los días en una empresa chica.*

- **Templates** con roles y campos prellenados.
- Más campos: número, email, desplegable, radio, adjunto del firmante, cargo, empresa; validaciones y obligatorios.
- Roles extra: aprobador, copia (CC), editor; orden mixto (grupos paralelos dentro de una secuencia).
- Autenticación del firmante nivel 1: código de acceso y **OTP por email/SMS/WhatsApp**.
- Corrección de sobre en vuelo, reasignar, delegar.
- Recordatorios configurables, plantillas de email y WhatsApp, idioma por destinatario (ES / PT-BR / EN).
- Branding básico (logo y colores).
- Carpetas, búsqueda y filtros.
- Planes y cobro con medios locales (tarjeta internacional + **Pix** en Brasil, **PSE** en Colombia; evaluar dLocal / EBANX / Mercado Pago para cubrir los cuatro países con un solo proveedor), precios en moneda local, límites por plan.

### Fase 3 — API v1 y firma embebida (6–8 semanas)
*Objetivo: el producto para desarrolladores. Es la fuente principal de ingresos recurrentes B2B.*

- API REST pública con OpenAPI: sobres, documentos, destinatarios, campos, templates, descargas.
- Auth: API keys + OAuth 2.0 (authorization code y client credentials), scopes.
- **Firma embebida**: URL de firma para iframe/redirect con expiración corta; eventos al padre vía `postMessage`.
- **Envío embebido**: el cliente arma el sobre dentro de su app con nuestro editor.
- **Anchor tags** (colocar campos por texto en el documento) y creación desde template con datos (merge fields).
- **Webhooks**: firma HMAC, reintentos con backoff exponencial, log de entregas, re-envío manual, filtros por evento, webhook por sobre.
- Idempotency keys, rate limits, paginación, errores consistentes.
- **Sandbox gratis** con marca de agua, portal de desarrolladores, docs en ES y PT-BR, SDKs (Node, Python, PHP y Java primero: son los más usados por fintechs y ERPs de la región).

### Fase 4 — Escala y equipos (6–8 semanas)
*Objetivo: vender a empresas medianas.*

- Equipos/grupos, RBAC con roles personalizados, templates compartidos.
- **Envío masivo** (bulk send desde CSV / API).
- **Formularios web públicos** (tipo PowerForms / Web Forms): link o embed donde el firmante se autoregistra.
- Lógica condicional de campos, campos calculados.
- Firma en persona (modo host en tablet).
- Logs de auditoría de cuenta, reportes de uso.
- Políticas de retención y borrado automático.
- Integraciones: Google Drive, Dropbox, OneDrive; Zapier/Make; Slack.
- Dominio propio para emails (DKIM/SPF) y para la página de firma: **white-label completo** (clave para revendedores).
- App móvil o PWA para remitentes.

### Fase 5 — Evidencia fuerte y cumplimiento (8–12 semanas)
*Objetivo: entrar en sectores regulados (banca, seguros, salud, gobierno, inmobiliario).*

- **Verificación de identidad**: foto de cédula/CPF + selfie con prueba de vida, contrastada con fuentes oficiales (Registraduría en Colombia, JCE en RD, RNP en Honduras, CPF/gov.br en Brasil, RENIEC en Perú) vía proveedor KYC con cobertura regional (ej. Truora, MetaMap, Unico, idwall). Resultado incorporado al audit trail.
- **Niveles de firma configurables por sobre**: simple / avanzada / digital-cualificada, con reglas por país.
- **Firma digital con certificado — conectores por país** (orden sugerido por tamaño de mercado y madurez):
  1. **Brasil**: ICP-Brasil — certificados A1 (archivo) y A3 (token/nube); firma en la nube con AC que ofrecen certificado remoto (tipo BirdID, VIDaaS, SafeID). Firma avanzada vía gov.br para trámites con el gobierno.
  2. **Colombia**: entidades acreditadas por ONAC (Certicámara, GSE, Andes SCD) — certificados en la nube, estampado de tiempo; **pagaré electrónico** y registro en depósito (Deceval) como caso de uso fintech.
  3. **República Dominicana**: entidades autorizadas por INDOTEL (Digifirma, Avansi, Viafirma).
  4. **Honduras**: PSC acreditados por el Instituto de la Propiedad (BCH y los que se sumen).
  5. **Perú**: entidades acreditadas por INDECOPI en la IOFE (RENIEC y privadas), incluido el DNI electrónico.
  - Firma con token/certificado local (componente de escritorio o WebAuthn/PKCS#11 donde sea posible).
- **Firma de XML (XAdES)** por API para facturación electrónica: e-CF de la DGII (RD), factura electrónica DIAN (Colombia, XAdES-EPES) y comprobantes electrónicos SUNAT (Perú, XMLDSig sobre UBL 2.1). Producto de entrada, independiente del flujo de sobres.
- PAdES **B-LT / B-LTA** para archivo a largo plazo; validador público de firmas.
- **Sello electrónico de empresa** (firma automática de la organización).
- SSO SAML/OIDC, SCIM, 2FA obligatorio por política.
- Residencia de datos por región (primero **São Paulo** para LGPD; luego región en Colombia o EE. UU. Este para el Caribe y Centroamérica), BYOK.
- Certificaciones: SOC 2 Type II, ISO 27001; pruebas de penetración; cumplimiento de LGPD, Ley 1581 (Colombia), Ley 172-13 (RD) y Ley 29733 (Perú): DPA, registro de tratamiento, borrado a pedido.

### Fase 6 — Plataforma de acuerdos e IA (continuo)
*Objetivo: dejar de ser "solo firma" y competir con DocuSign IAM / PandaDoc.*

- **IA para el remitente**: auto-detección y colocación de campos, sugerencia de firmantes y roles.
- **IA para el firmante**: resumen del documento en lenguaje simple antes de firmar, preguntas sobre el contrato.
- **Repositorio inteligente** (tipo Navigator): extracción de metadatos (partes, fechas, montos, renovaciones), búsqueda semántica, alertas de vencimiento y renovación.
- Análisis de cláusulas contra un playbook de la empresa (riesgo, desvíos de estándar).
- **Generación de documentos**: editor con variables, librería de cláusulas, cotizaciones, generación desde datos de CRM.
- **Orquestador de workflows sin código** (tipo Maestro): pasos de recolección de datos, verificación, firma, aprobaciones, envío a sistemas externos.
- Pagos dentro del flujo de firma.
- **Servidor MCP** y herramientas para agentes de IA (crear sobres, consultar estado, extraer datos) con permisos y aprobación humana.
- Integraciones enterprise: Salesforce, HubSpot, Microsoft 365/Teams, SAP; regionales: TOTVS y RD Station (Brasil), Siigo y Alegra (Colombia), core bancarios.
- Verticales con plantillas listas: crédito y pagarés, onboarding bancario, contratos laborales, inmobiliario, seguros.
- ~~Firma en videollamada (tipo Virtual Room)~~ — descartada el 2026-10-18.
- Negociación/redlining colaborativo antes de firmar.

---

## 5. Prioridades y razonamiento

| Decisión | Motivo |
|---|---|
| Audit log encadenado y sellado PAdES desde la Fase 0–1 | Es lo que da validez legal. Rehacerlo después invalida la evidencia de documentos ya firmados. |
| API antes que equipos grandes (Fase 3 antes que 4) | Los desarrolladores compran rápido, integran una vez y generan uso recurrente. Dropbox Sign creció así. |
| WhatsApp y PT-BR en el MVP | En los cuatro países el firmante vive en WhatsApp; sin portugués no se puede vender en Brasil. |
| Firma digital por país en Fase 5 (con Brasil primero) | Diferenciador fuerte frente a proveedores globales, que suelen cubrirlo mal o caro. Brasil es el mercado más grande; Colombia el más atractivo para fintech. Si el primer cliente es regulado, adelantar solo ese conector. |
| Firma XAdES para facturación electrónica como producto aparte | En RD la obligatoriedad de e-CF para pequeñas empresas llega en noviembre 2026: es demanda inmediata para captar clientes y luego venderles firma de contratos. |
| Orden de entrada sugerido | **Colombia y RD primero** (mismo idioma, menos competencia SaaS local, demanda por facturación y fintech), **Brasil** después con producto maduro y en PT-BR, **Honduras** como extensión de bajo costo. **Perú** junto con Colombia: mismo idioma, facturación electrónica SUNAT como producto de entrada. |
| IA en Fase 6 pero diseñada desde antes | Guardar texto extraído y metadatos desde el principio deja la base lista para el repositorio inteligente. |

---

## 6. Arquitectura sugerida (alto nivel)

- **API Gateway** → servicios: Identity/Tenancy, Envelopes (núcleo y máquina de estados), Documents (PDF), Signing (sellado criptográfico, aislado), Notifications (email/SMS/WhatsApp), Webhooks, Billing.
- **Máquina de estados del sobre** explícita: `draft → sent → delivered → (viewed) → signed/declined/voided/expired → completed`. Todos los cambios pasan por eventos que alimentan el audit log y los webhooks.
- **Servicio de firma aislado** con acceso exclusivo al KMS/HSM; nunca expuesto públicamente.
- Base relacional (PostgreSQL) para el modelo, almacenamiento de objetos para archivos, cola (SQS/RabbitMQ/Redis streams) para trabajos.
- Librerías de PDF/PAdES a evaluar: iText (licencia comercial/AGPL), Apache PDFBox + DSS de la UE (Digital Signature Service, LGPL, cubre PAdES/XAdES/CAdES y validación), pdf-lib (JS, para manipulación, no para PAdES completo).
- El modelo de datos sigue el patrón de la industria: `Envelope 1—N Document`, `Envelope 1—N Recipient`, `Recipient 1—N Field (anclado a Document + página + coordenadas)`, `Envelope 1—N Event`.

---

## 7. Fuentes consultadas

- DocuSign IAM, Navigator, Iris y agentes: [National CIO Review](https://nationalcioreview.com/articles-insights/cio-field-notes/docusigns-2026-points-to-the-next-clause-in-ai-strategy/), [resumen de earnings Q1 2026](https://www.marketbeat.com/earnings/reports/2025-6-5-docusign-inc-stock)
- Adobe Acrobat Sign webhooks: [Adobe Developer](https://developer.adobe.com/acrobat-sign/docs/overview/acrobat_sign_events/), [Adobe HelpX](https://helpx.adobe.com/sign/web/developers/webhooks/overview.html)
- OneSpan Sign: [Virtual Room](https://onespan.com/resources/onespan-sign-virtual-room), [Pulse 2 — IA, verificación de identidad y agentes](https://pulse2.com/onespan-expands-onespan-sign-beyond-esignature-with-ai-identity-verification-and-agentic-workflow-capabilities/)
- Alternativas y APIs embebidas: [Anvil](https://www.useanvil.com/blog/digital-transformation/best-docusign-api-alternatives-2026/), [Eversign](https://eversign.com/blog/best-docusign-api-alternatives-for-embedded-signing), [SignWell MCP](https://www.signwell.com/resources/?p=2968)
- República Dominicana: [Exposición de motivos Ley 126-02 (CCSD/Digifirma)](https://www.camarasantodomingo.do/digifirma/Media/assets/documents/base-legal/exposicion-de-motivos-ley-no-126-02.pdf), [Acento — firma digital en RD](https://acento.com.do/opinion/firma-digital-herramienta-clave-en-la-transformacion-digital-8982789.html), [Viafirma — Resolución 166-06](https://www.viafirma.do/download/doc/resolucion-166-06.pdf), [Edicom — e-CF DGII](https://edicomgroup.com/es/blog/como-facturar-de-forma-electronica-en-republica-dominicana)
- Honduras: [La Prensa — BCH primer PSC](https://www.laprensa.hn/economia/certifican-al-bch-para-prestar-servicios-de-firma-electronica-EALP1055188), [UNITEC — identificación digital y firma electrónica en Honduras](https://www.unitec.edu/conacieti/wp-content/uploads/2023/09/e-28-identificacion-digital-y-firma-electronica-honduras.pdf)
- Colombia: [Decreto 2364 de 2012 (DIAN)](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_2364_2012.htm), [Portafolio — firma digital de factura electrónica](https://www.portafolio.co/tendencias/como-firmar-digitalmente-la-factura-electronica-543281)
- Brasil: [Lei 14.063/2020 — Câmara dos Deputados](https://www2.camara.leg.br/legin/fed/lei/2020/lei-14063-23-setembro-2020-790659-publicacaooriginal-161547-pl.html), [STJ — assinatura eletrônica qualificada](https://bdjur.stj.jus.br/jspui/bitstream/2011/150333/assinatura_eletronica_qualificada_chini.pdf)
- eIDAS 2 y QES remota: [A&L Goodbody](https://techreg.algoodbody.com/techreg/eidas), [Certyneo — guía eIDAS 2](https://certyneo.com/en/guide/eidas-2-0)

> Nota: varias fuentes de comparación son blogs de competidores. Antes de decisiones comerciales conviene validar precios y disponibilidad de features en la documentación oficial de cada proveedor. Las listas de entidades de certificación vigentes deben confirmarse en INDOTEL, Instituto de la Propiedad, ONAC e ITI, y el encuadre legal de cada caso de uso con un abogado local de cada país.
