# Sala de firma por video (Fase 6)

Videollamada para revisar y firmar un sobre con quien lo envía (tipo *Virtual Room*). Código: `apps/api/src/modules/video.ts`,
`apps/web/src/lib/video.ts`, `apps/web/src/components/Video.tsx`, `apps/web/src/pages/VideoRoom.tsx`; migración `0014_video.sql`.

## Cómo funciona

- **Sala por sobre** (`POST /v1/envelopes/:id/video-sessions`): la abre un usuario de la organización (anfitrión) con el sobre
  enviado; invita hasta 3 firmantes o aprobadores (por defecto, los pendientes). Una sola sala abierta por sobre. La invitación
  sale por los canales de cada destinatario con su link de firma (`/s/<token>?video=1`).
- **WebRTC en malla** para hasta 4 participantes. El audio y el video van directo entre navegadores; la API solo hace de
  señalización por WebSocket:
  - anfitrión: `GET /v1/envelopes/:id/video-sessions/:sid/ws` (cookie de sesión; exige poder gestionar el sobre y ser el anfitrión);
  - firmante: `GET /v1/signing/:token/video/ws` (pasan los mismos controles que el resto del link: OTP y verificación de identidad).
  Quien entra llama a los que ya estaban (nunca hay ofertas cruzadas).
- **Co-navegación**: quien tiene el control (por defecto el anfitrión) emite página, desplazamiento, zoom y campo resaltado; el resto
  lo sigue. El anfitrión cede el control a cualquiera y quien lo tiene puede devolvérselo. Cada firmante firma sus propios campos
  con el flujo de firma de siempre (el panel de video flota sobre la página de firma y no corta la llamada al avanzar).
- **Consentimiento y grabación**: cada participante consiente explícitamente (evento `video.recording_consented`). El navegador
  del anfitrión compone los videos en un canvas, mezcla los audios y graba con `MediaRecorder`; sube fragmentos en orden
  (`PUT …/recording/chunks/:seq`), que la API guarda cifrados (AES-256-GCM) con su SHA-256. Si se conecta alguien sin
  consentimiento, la API rechaza fragmentos (409) y el anfitrión pausa hasta que consienta. Al detener, el SHA-256 de la
  grabación completa queda en la evidencia (`video.recording_stored`) y en el certificado de finalización.
- **Identidad en cámara**: el anfitrión confirma el documento de cada firmante (casilla, nota y número leído, que se compara con el
  declarado). Con `requireIdentityConfirmation`, el firmante no puede finalizar (`403 identity_confirmation_required`) hasta esa
  confirmación.
- **Evidencia**: `video.session_scheduled`, `video.session_started`, `video.participant_joined/left`, `video.recording_consented`,
  `video.recording_started`, `video.recording_stored`, `recipient.identity_confirmed` (`method: "video"`), `video.session_ended`.
  El certificado de finalización suma la sección «Sesiones por video» (anfitrión, inicio, fin, participantes con consentimiento e
  identidad, y SHA-256 de cada grabación).
- **Retención**: las grabaciones se borran con la política de retención de la organización, igual que los originales.

## Variables de entorno

| Variable | Uso |
|---|---|
| `VIDEO_ICE_SERVERS` | Lista JSON de servidores ICE (`[{"urls":"stun:…"}]`). Por defecto, el STUN público de Google. |
| `VIDEO_TURN_SECRET` | Secreto compartido con coturn (`use-auth-secret` / `static-auth-secret`). |
| `VIDEO_TURN_URLS` | URLs TURN separadas por coma, p. ej. `turn:turn.calasign.com:3478?transport=udp,turns:turn.calasign.com:5349`. |
| `VIDEO_TURN_TTL` | Vida de la credencial TURN en segundos (por defecto 3600). |

Con secreto y URLs, cada participante recibe credenciales TURN temporales: `username = "<expira-unix>:<id>"`,
`credential = base64(HMAC-SHA1(secreto, username))` (REST API for TURN de coturn).

## Producción

- **TURN es obligatorio**: con STUN solo, las llamadas entre redes con NAT simétrico o firewalls corporativos no conectan. Un
  coturn (o un servicio gestionado) con `use-auth-secret`, TLS en 5349 y puertos UDP de relay abiertos.
- **Varias instancias de la API**: el estado de cada sala (conexiones, control, co-navegación) vive en la memoria del proceso. El
  balanceador tiene que mandar todos los WebSocket de una sala a la misma instancia (afinidad por id de sesión) o agregarse un bus
  pub/sub (Redis) entre instancias.
- El proxy (Caddy) ya reenvía WebSocket; la CSP `connect-src 'self'` cubre `wss:` del mismo origen.
- La grabación ocupa ~1–2 MB por minuto con 2 participantes (VP8 a 1,2 Mbps compuesto a 1280×720, 15 fps).
