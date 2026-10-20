"""Cliente HTTP de CalaSign (solo biblioteca estándar: urllib, json, hmac)."""
from __future__ import annotations

import base64
import datetime
import http.client
import json
import math
import random
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, TypedDict, Union

__all__ = ["CalaSign", "CalaSignError", "ClientCredentials"]

VERSION = "0.1.0"
_RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
# Estados reintentables tras los que el pedido pudo haberse procesado igual (408/425/429/503 se rechazan sin procesar).
_MAYBE_PROCESSED_STATUS = {500, 502, 504}
# Errores de red: URLError, timeouts (socket.timeout en 3.8/3.9), ConnectionError y SSLError son OSError; un corte a mitad
# del cuerpo (IncompleteRead) o una respuesta mal formada (BadStatusLine) son HTTPException. HTTPError (respuesta con
# status) también es OSError, pero se atrapa antes.
_NETWORK_ERRORS = (OSError, http.client.HTTPException)


# ───────────────────────────── Tipos (subconjunto del contrato de la API) ─────────────────────────────


class Document(TypedDict, total=False):
    id: str
    name: str
    position: int
    pageCount: int
    sha256: str
    sizeBytes: int


class Recipient(TypedDict, total=False):
    id: str
    role: str
    routingOrder: int
    name: str
    email: Optional[str]
    phone: Optional[str]
    channels: List[str]
    status: str


class Envelope(TypedDict, total=False):
    id: str
    subject: str
    status: str
    createdAt: str
    updatedAt: str
    sentAt: Optional[str]
    completedAt: Optional[str]
    metadata: Dict[str, Any]
    signedSha256: Optional[str]


class EnvelopeDetail(TypedDict, total=False):
    envelope: Envelope
    documents: List[Document]
    recipients: List[Recipient]
    fields: List[Dict[str, Any]]
    canManage: bool


class EnvelopeSummary(TypedDict, total=False):
    id: str
    subject: str
    status: str
    createdAt: str


# ───────────────────────────── Errores y opciones ─────────────────────────────


class CalaSignError(Exception):
    """Error de la API: status HTTP, código (`envelope_incomplete`, `insufficient_scope`, …) y detalles.

    `request_id`: header X-Request-Id de la respuesta (para soporte). `idempotency_key`: la Idempotency-Key del pedido,
    si tenía; reintentar con la misma clave es seguro (no duplica el sobre ni el envío)."""

    def __init__(
        self,
        message: str,
        status: int,
        code: str,
        details: Any = None,
        request_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details
        self.request_id = request_id
        self.idempotency_key = idempotency_key

    def __repr__(self) -> str:  # pragma: no cover
        return f"CalaSignError(status={self.status}, code={self.code!r}, message={str(self)!r})"


@dataclass
class ClientCredentials:
    """OAuth 2.0 client credentials: el cliente pide y renueva el token solo."""

    client_id: str
    client_secret: str
    scope: Optional[str] = None


@dataclass
class _Token:
    value: str
    expires_at: float


# ───────────────────────────── Cliente ─────────────────────────────


class CalaSign:
    """
    cs = CalaSign(api_key=os.environ["CALASIGN_KEY"], base_url="https://dev.calasign.com")
    detail = cs.envelopes.create({"subject": "Contrato"})
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        access_token: Optional[str] = None,
        oauth: Optional[ClientCredentials] = None,
        base_url: str = "https://dev.calasign.com",
        max_retries: int = 3,
        timeout: float = 30.0,
        user_agent: Optional[str] = None,
        idempotency_wait: float = 60.0,
    ):
        """`timeout`: segundos por operación de socket (conectar, cada lectura), no del pedido entero.
        `idempotency_wait`: espera total ante un 409 idempotency_in_progress, aparte de `max_retries`."""
        if not (api_key or access_token or oauth):
            raise ValueError("CalaSign: falta api_key, access_token u oauth")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._access_token = access_token
        self._oauth = oauth
        self._token: Optional[_Token] = None
        self.max_retries = max_retries
        self.timeout = timeout
        self.idempotency_wait = idempotency_wait
        self.user_agent = user_agent or f"calasign-python/{VERSION}"
        self.envelopes = _Envelopes(self)
        self.templates = _Templates(self)
        self.webhooks = _Webhooks(self)
        #: Marca blanca: marcas ("default" y sub-marcas), archivos, dominios y vista previa.
        self.brands = _Brands(self)
        self.events = _Events(self)

    # ── autenticación ──

    def _bearer(self, force: bool = False) -> str:
        if self._api_key:
            return self._api_key
        if self._access_token:
            return self._access_token
        assert self._oauth is not None
        if not force and self._token and self._token.expires_at - 60 > time.time():
            return self._token.value
        data = {"grant_type": "client_credentials"}
        if self._oauth.scope:
            data["scope"] = self._oauth.scope
        basic = base64.b64encode(
            f"{urllib.parse.quote(self._oauth.client_id, safe='')}:{urllib.parse.quote(self._oauth.client_secret, safe='')}".encode()
        ).decode()
        req = urllib.request.Request(
            f"{self.base_url}/oauth/token",
            data=urllib.parse.urlencode(data).encode(),
            method="POST",
            headers={"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": self.user_agent},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                body = json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            body = _error_body(e)
            raise CalaSignError(body.get("error_description", "No se pudo obtener el token OAuth"), e.code, body.get("error", "oauth_error")) from None
        except _NETWORK_ERRORS as e:
            # Igual que en `request`: quien captura CalaSignError para los errores de red no recibe un URLError suelto
            # cuando el que falla es el pedido del token (el primero de cada cliente, o el refresh tras un 401).
            raise CalaSignError(f"Error de red al pedir el token OAuth: {e}", 0, "network_error") from None
        except ValueError:
            raise CalaSignError("La respuesta del token OAuth no es JSON válido", 0, "oauth_error") from None
        if not isinstance(body, dict) or not body.get("access_token"):
            raise CalaSignError("La respuesta del token OAuth no trae access_token", 0, "oauth_error")
        try:
            ttl = float(body.get("expires_in") or 3600)
        except (TypeError, ValueError):
            # Como el SDK de Node: un expires_in null o no numérico no escapa como TypeError/ValueError suelto.
            ttl = 3600.0
        # "nan", "inf" o un valor negativo: el token no se reutilizaba (nan/negativo) o no vencía nunca (inf).
        if not math.isfinite(ttl) or ttl <= 0:
            ttl = 3600.0
        self._token = _Token(body["access_token"], time.time() + ttl)
        return self._token.value

    # ── pedido genérico ──

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        multipart: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        retryable: Optional[bool] = None,
        raw: bool = False,
        with_headers: bool = False,
        headers: Optional[Mapping[str, str]] = None,
        _on_retry: Optional[Any] = None,
    ) -> Any:
        """Pedido a la API v1 con autenticación, reintentos e idempotencia. `raw=True` devuelve los bytes del cuerpo;
        con `with_headers=True` además, la tupla (bytes, headers). `headers`: headers extra (p. ej.
        X-Expected-Updated-At); no reemplazan Authorization ni Idempotency-Key."""
        url = self.base_url + path
        if query:
            q = {k: v for k, v in query.items() if v not in (None, "")}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        if retryable is None:
            retryable = method in ("GET", "PUT", "DELETE") or idempotency_key is not None
        refreshed = False
        attempt = 0
        # Las esperas por un 409 idempotency_in_progress tienen su propio tope (en segundos), aparte de max_retries.
        idem_waited = 0.0
        idem_waits = 0
        extra = {k.title(): str(v) for k, v in (headers or {}).items()}
        while True:
            req_headers = dict(extra)
            req_headers.update({"Authorization": f"Bearer {self._bearer()}", "Accept": "application/json", "User-Agent": self.user_agent})
            if idempotency_key:
                req_headers["Idempotency-Key"] = idempotency_key
            data: Optional[bytes] = None
            if multipart is not None:
                data, ctype = _encode_multipart(multipart)
                req_headers["Content-Type"] = ctype
            elif json_body is not None:
                data = json.dumps(json_body).encode()
                req_headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=data, method=method, headers=req_headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    payload = res.read()
                    if raw:
                        return (payload, res.headers) if with_headers else payload
                    status = res.status
                    request_id = res.headers.get("X-Request-Id")
                try:
                    return json.loads(payload) if payload else None
                except ValueError:
                    # Respuesta 2xx que no es JSON (un proxy, una página de error): CalaSignError, no un JSONDecodeError suelto.
                    raise CalaSignError("La respuesta de la API no es JSON válido", status, "invalid_response", None, request_id, idempotency_key) from None
            except urllib.error.HTTPError as e:
                status = e.code
                body = _error_body(e)
                if status == 401 and self._oauth and not refreshed:
                    refreshed = True
                    self._bearer(force=True)
                    continue
                retry_after = e.headers.get("Retry-After")
                # Un 429 sin Retry-After y con código propio (reminded_recently, form_rate_limited, ai_signer_limit…) es un
                # tope de negocio que no se libera en segundos: no se reintenta. Solo el límite por IP (con Retry-After) sí.
                business_429 = status == 429 and not retry_after and _is_business_429(body)
                if status in _RETRY_STATUS and attempt < self.max_retries and (retryable or status in (429, 503)) and not business_429:
                    time.sleep(_retry_delay(attempt, retry_after))
                    attempt += 1
                    # _on_retry avisa solo de reintentos cuyo intento previo pudo haberse procesado (red o 500/502/504).
                    if _on_retry and status in _MAYBE_PROCESSED_STATUS:
                        _on_retry()
                    continue
                err = body.get("error") if isinstance(body.get("error"), dict) else {}
                # El pedido original con esta Idempotency-Key sigue ejecutándose (típico del reintento después de un
                # timeout): se espera y se repite hasta recibir la respuesta guardada, en vez de fallar con el sobre creado.
                if status == 409 and idempotency_key and err.get("code") == "idempotency_in_progress":
                    idem_waits += 1
                    wait = _retry_delay(idem_waits, None)
                    if idem_waited + wait <= self.idempotency_wait:
                        idem_waited += wait
                        time.sleep(wait)
                        continue
                raise CalaSignError(
                    err.get("message", f"HTTP {status}"),
                    status,
                    err.get("code", f"http_{status}"),
                    err.get("details"),
                    e.headers.get("X-Request-Id") if e.headers else None,
                    idempotency_key,
                ) from None
            except _NETWORK_ERRORS as e:
                if retryable and attempt < self.max_retries:
                    time.sleep(_retry_delay(attempt, None))
                    attempt += 1
                    if _on_retry:
                        _on_retry()
                    continue
                raise CalaSignError(f"Error de red: {e}", 0, "network_error", None, None, idempotency_key) from None

    def me(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/me")


# ───────────────────────────── Recursos ─────────────────────────────


class _Envelopes:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(
        self,
        *,
        status: Union[str, Sequence[str], None] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        created_from: Any = None,
        created_to: Any = None,
        updated_from: Any = None,
        updated_to: Any = None,
        sent_from: Any = None,
        sent_to: Any = None,
        completed_from: Any = None,
        completed_to: Any = None,
        metadata: Optional[Mapping[str, str]] = None,
        recipient: Optional[str] = None,
        template_id: Optional[str] = None,
        created_via: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fechas como str ISO 8601 o datetime (*_from inclusive, *_to exclusivo). `metadata`: pares que tienen que coincidir."""
        st = ",".join(status) if isinstance(status, (list, tuple)) else status
        query: Dict[str, Any] = {
            "status": st,
            "q": q,
            "limit": limit,
            "cursor": cursor,
            "created_from": _iso(created_from),
            "created_to": _iso(created_to),
            "updated_from": _iso(updated_from),
            "updated_to": _iso(updated_to),
            "sent_from": _iso(sent_from),
            "sent_to": _iso(sent_to),
            "completed_from": _iso(completed_from),
            "completed_to": _iso(completed_to),
            "recipient": recipient,
            "template_id": template_id,
            "created_via": created_via,
        }
        for k, v in (metadata or {}).items():
            query[f"metadata[{k}]"] = v
        return self._c.request("GET", "/v1/envelopes", query=query)

    def iterate(self, **params: Any) -> Iterator[EnvelopeSummary]:
        """Recorre todas las páginas: `for e in cs.envelopes.iterate(status="completed"): …`"""
        cursor = None
        while True:
            page = self.list(cursor=cursor, **params)
            yield from page["items"]
            cursor = page.get("nextCursor")
            if not cursor:
                return

    def get(self, envelope_id: str) -> EnvelopeDetail:
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}")

    def create(self, data: Dict[str, Any], *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        """Crea un sobre en UNA llamada: solo el borrador ({"subject": …}) o completo, con "documents", "recipients",
        "fields" y, con "send": True, también enviado. Cada documento va con "content" (bytes del PDF: se sube como
        multipart, sin base64), "base64" o "url". Atómico e idempotente (Idempotency-Key automática). Con firmantes
        "embedded", la respuesta trae "signingUrls"."""
        key = idempotency_key or str(uuid.uuid4())
        docs = data.get("documents") or []
        if not any(isinstance(d, dict) and d.get("content") is not None for d in docs):
            return self._c.request("POST", "/v1/envelopes", json_body=data, idempotency_key=key)
        # Con bytes: multipart/form-data, el JSON en la parte "payload" y cada PDF en su parte ("file").
        parts: Dict[str, Any] = {}
        documents = []
        for i, d in enumerate(docs):
            if d.get("content") is None:
                documents.append(d)
                continue
            part = f"document{i}"
            rest = {k: v for k, v in d.items() if k != "content"}
            parts[part] = (d.get("name") or f"documento-{i + 1}.pdf", bytes(d["content"]), "application/pdf")
            documents.append({**rest, "file": part})
        payload = json.dumps({**data, "documents": documents})
        return self._c.request("POST", "/v1/envelopes", multipart={"payload": payload, **parts}, idempotency_key=key)

    def create_and_send(self, data: Dict[str, Any], *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        """Como create con "send": True: crea el sobre completo y lo envía en una sola llamada."""
        return self.create({**data, "send": True}, idempotency_key=idempotency_key)

    def update(self, envelope_id: str, data: Dict[str, Any], *, expected_updated_at: Any = None) -> EnvelopeDetail:
        """Edita el borrador. Con `expected_updated_at` (el `updatedAt` del sobre que cargaste), 409 `version_changed`
        (con `details["updatedAt"]`, el actual) si alguien lo modificó mientras tanto: recargá, reaplicá y reintentá.
        Con `expected_updated_at` no se reintenta ante errores de red/5xx (sí ante 429/503): ver `_draft_retryable`."""
        return self._c.request(
            "PATCH", f"/v1/envelopes/{_seg(envelope_id)}", json_body=data, retryable=_draft_retryable(expected_updated_at, True), headers=_expected(expected_updated_at)
        )

    def delete(self, envelope_id: str) -> None:
        self._c.request("DELETE", f"/v1/envelopes/{_seg(envelope_id)}")

    def upload_document(self, envelope_id: str, content: bytes, filename: str = "documento.pdf") -> Document:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/documents", multipart={"file": (filename, content, "application/pdf")})

    def set_recipients(self, envelope_id: str, recipients: List[Dict[str, Any]], *, expected_updated_at: Any = None) -> EnvelopeDetail:
        """Reemplaza los destinatarios del borrador. Con `expected_updated_at`, 409 `version_changed` si cambió."""
        return self._c.request(
            "PUT",
            f"/v1/envelopes/{_seg(envelope_id)}/recipients",
            json_body={"recipients": recipients},
            retryable=_draft_retryable(expected_updated_at, None),
            headers=_expected(expected_updated_at),
        )

    def set_fields(self, envelope_id: str, fields: List[Dict[str, Any]], *, expected_updated_at: Any = None) -> EnvelopeDetail:
        """Reemplaza los campos del borrador. Con `expected_updated_at`, 409 `version_changed` si cambió."""
        return self._c.request(
            "PUT", f"/v1/envelopes/{_seg(envelope_id)}/fields", json_body={"fields": fields}, retryable=_draft_retryable(expected_updated_at, None), headers=_expected(expected_updated_at)
        )

    def send(self, envelope_id: str, *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/send", idempotency_key=idempotency_key or f"send-{_seg(envelope_id)}")

    def void(self, envelope_id: str, reason: str) -> EnvelopeDetail:
        """Anula el sobre. Se reintenta ante errores de red/5xx; si el primer intento sí llegó a anularlo, el reintento
        recibe 409 `not_voidable`: en ese caso (solo tras un reintento cuyo intento previo pudo haberse procesado: red o
        500/502/504, no 429/503) se confirma con un GET y, si quedó `voided`, se
        devuelve el detalle. Anular un sobre ya anulado sin reintentos sigue lanzando 409 `not_voidable`."""
        retried = []
        try:
            return self._c.request(
                "POST", f"/v1/envelopes/{_seg(envelope_id)}/void", json_body={"reason": reason}, retryable=True, _on_retry=lambda: retried.append(1)
            )
        except CalaSignError as e:
            if retried and e.code == "not_voidable":
                detail = self.get(envelope_id)
                if (detail.get("envelope") or {}).get("status") == "voided":
                    return detail
            raise

    def remind(self, envelope_id: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/remind")

    def events(self, envelope_id: str) -> List[Dict[str, Any]]:
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/events")["items"]

    def download_signed(self, envelope_id: str) -> bytes:
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/signed.pdf", raw=True)

    def signing_url(
        self, envelope_id: str, recipient_id: str, *, return_url: Optional[str] = None, frame_ancestors: Optional[Sequence[str]] = None
    ) -> Dict[str, Any]:
        """URL de firma (5 min, un solo uso) de un destinatario, embebido (iframe) o no (abrirla en una pestaña o
        redirigir). Devuelve {"url", "expiresAt", "tabOnly"?}: `tabOnly` True (destinatarios con OTP) significa que no
        se puede embeber; pedir `frame_ancestors` para ellos da 409 `otp_not_embeddable`. `frame_ancestors`:
        subconjunto de los orígenes autorizados de la organización que pueden embeber la firma (por defecto, todos).
        En un iframe, la página de firma avisa por postMessage `viewed`, `signing_complete`, `declined`, `error` y
        `closed` (con `status`)."""
        body: Dict[str, Any] = {"returnUrl": return_url} if return_url else {}
        if frame_ancestors is not None:
            body["frameAncestors"] = [frame_ancestors] if isinstance(frame_ancestors, str) else list(frame_ancestors)
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/recipients/{_seg(recipient_id)}/signing-url", json_body=body)

    def form_data(self, envelope_id: str) -> Dict[str, Any]:
        """Valores completados por destinatario y vista plana etiqueta → valor (`values`)."""
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/form-data")

    def download_attachment(self, envelope_id: str, field_id: str) -> bytes:
        """Archivo que subió un firmante en un campo de adjunto (solo los bytes; con el tipo: download_attachment_with_type)."""
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/attachments/{_seg(field_id)}", raw=True)

    def download_attachment_with_type(self, envelope_id: str, field_id: str) -> Dict[str, Any]:
        """Como download_attachment, con el tipo del archivo (un adjunto puede ser PDF o imagen):
        {"bytes": …, "content_type": "image/png"}."""
        payload, headers = self._c.request(
            "GET", f"/v1/envelopes/{_seg(envelope_id)}/attachments/{_seg(field_id)}", raw=True, with_headers=True
        )
        return {"bytes": payload, "content_type": headers.get("Content-Type") or "application/octet-stream"}

    def clone(self, envelope_id: str, data: Optional[Dict[str, Any]] = None) -> EnvelopeDetail:
        """Clona el sobre como borrador nuevo (subject, metadata, includeRecipients, includeFields, includeValues…)."""
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/clone", json_body=data or {})

    def batch(self, action: str, ids: Sequence[str], *, reason: Optional[str] = None) -> Dict[str, Any]:
        """get | void | remind | delete sobre hasta 100 sobres. Devuelve un resultado por id (`results`)."""
        # Un id suelto como str: list("uuid") lo partía en caracteres.
        body: Dict[str, Any] = {"action": action, "ids": [ids] if isinstance(ids, str) else list(ids)}
        if reason:
            body["reason"] = reason
        return self._c.request("POST", "/v1/envelopes/batch", json_body=body, retryable=action == "get")

    def from_template(self, data: Dict[str, Any], *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        return self._c.request("POST", "/v1/envelopes/from-template", json_body=data, idempotency_key=idempotency_key or str(uuid.uuid4()))


class _Templates:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/v1/templates", query={"q": q})["items"]

    def get(self, template_id: str) -> Dict[str, Any]:
        return self._c.request("GET", f"/v1/templates/{_seg(template_id)}")


class _Brands:
    """Marca blanca. `brand_id`: "default" (marca de la organización) o el id de una sub-marca."""

    def __init__(self, c: CalaSign):
        self._c = c

    def list(self) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/v1/settings/brands")["items"]

    def get(self, brand_id: str = "default") -> Dict[str, Any]:
        return self._c.request("GET", f"/v1/settings/brands/{_seg(brand_id)}")

    def create(self, name: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._c.request("POST", "/v1/settings/brands", json_body={"name": name, **({"config": config} if config else {})})

    def update(self, brand_id: str, config: Dict[str, Any], name: Optional[str] = None) -> Dict[str, Any]:
        """Reemplaza la configuración entera (get, modificar, update)."""
        body: Dict[str, Any] = {"config": config}
        if name:
            body["name"] = name
        return self._c.request("PUT", f"/v1/settings/brands/{_seg(brand_id)}", json_body=body, retryable=True)

    def delete(self, brand_id: str) -> None:
        self._c.request("DELETE", f"/v1/settings/brands/{_seg(brand_id)}")

    def preview(self, brand_id: str = "default", **params: Any) -> Dict[str, Any]:
        """kind="email"|"theme", event="invite"…, locale="es", config={…} (sin guardar)."""
        return self._c.request("POST", f"/v1/settings/brands/{_seg(brand_id)}/preview", json_body=params)

    def upload_asset(self, brand_id: str, kind: str, content: bytes, filename: str = "archivo", content_type: str = "application/octet-stream") -> Dict[str, Any]:
        """kind: logo, logoDark, favicon o font."""
        return self._c.request("POST", f"/v1/settings/brands/{_seg(brand_id)}/assets/{_seg(kind)}", multipart={"file": (filename, content, content_type)})

    def delete_asset(self, brand_id: str, kind: str) -> Dict[str, Any]:
        return self._c.request("DELETE", f"/v1/settings/brands/{_seg(brand_id)}/assets/{_seg(kind)}")

    def set_domain(self, brand_id: str, domain: str) -> Dict[str, Any]:
        return self._c.request("PUT", f"/v1/settings/brands/{_seg(brand_id)}/domain", json_body={"domain": domain})

    def verify_domain(self, brand_id: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/settings/brands/{_seg(brand_id)}/domain/verify")

    def list_email_domains(self) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/v1/settings/email-domains")["items"]

    def add_email_domain(self, domain: str) -> Dict[str, Any]:
        return self._c.request("POST", "/v1/settings/email-domains", json_body={"domain": domain})

    def verify_email_domain(self, domain: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/settings/email-domains/{_seg(domain)}/verify")


class _Webhooks:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(self) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/v1/webhooks")["items"]

    def create(self, url: str, events: Optional[List[str]] = None, description: Optional[str] = None) -> Dict[str, Any]:
        """Devuelve {"webhook": …, "secret": …}. El secreto se muestra una sola vez."""
        body: Dict[str, Any] = {"url": url}
        if events:
            body["events"] = events
        if description:
            body["description"] = description
        return self._c.request("POST", "/v1/webhooks", json_body=body)

    def get(self, webhook_id: str) -> Dict[str, Any]:
        return self._c.request("GET", f"/v1/webhooks/{_seg(webhook_id)}")

    def update(self, webhook_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH parcial: url, events, description, active. Una suscripción creada con una API key o token OAuth se
        desactiva (active False) al revocar esa credencial; `update(id, active=True)` la reactiva y la ata a la
        credencial actual (conserva id y secreto)."""
        return self._c.request("PATCH", f"/v1/webhooks/{_seg(webhook_id)}", json_body=fields, retryable=True)

    def delete(self, webhook_id: str) -> None:
        self._c.request("DELETE", f"/v1/webhooks/{_seg(webhook_id)}")

    def test(self, webhook_id: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/webhooks/{_seg(webhook_id)}/test")

    def rotate_secret(self, webhook_id: str, *, grace_hours: Optional[int] = None) -> Dict[str, Any]:
        """Devuelve {"webhook", "secret"}. Durante grace_hours (24 por defecto) se firma también con el secreto anterior."""
        body = {} if grace_hours is None else {"graceHours": grace_hours}
        return self._c.request("POST", f"/v1/webhooks/{_seg(webhook_id)}/rotate-secret", json_body=body)


class _Events:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(
        self,
        *,
        after: Optional[str] = None,
        since: Any = None,
        types: Optional[Sequence[str]] = None,
        envelope_id: Optional[str] = None,
        scope: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Una página de eventos (del más viejo al más nuevo): {"items", "nextCursor", "hasMore"}."""
        if isinstance(types, str):
            # Un tipo suelto: ",".join("envelope.completed") lo partía en caracteres.
            types = [types]
        query = {
            "after": after,
            "since": _iso(since),
            "types": ",".join(types) if types else None,
            "envelope_id": envelope_id,
            "scope": scope,
            "limit": limit,
        }
        return self._c.request("GET", "/v1/events", query=query)

    def poll(self, *, after: Optional[str] = None, interval: float = 5.0, **params: Any) -> Iterator[Dict[str, Any]]:
        """Polling continuo: `for ev in cs.events.poll(after=cursor_guardado): …` (guardar ev["cursor"] al procesar)."""
        while True:
            page = self.list(after=after, **params)
            yield from page["items"]
            after = page.get("nextCursor") or after
            if not page.get("hasMore"):
                time.sleep(interval)


# ───────────────────────────── Utilidades ─────────────────────────────


def _iso(value: Any) -> Optional[str]:
    """datetime → ISO 8601 (sin zona se asume UTC); str se pasa tal cual."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.timezone.utc)
        return value.isoformat()
    return str(value)


def _expected(value: Any) -> Optional[Dict[str, str]]:
    """Header X-Expected-Updated-At (control de edición concurrente de borradores) o None."""
    iso = _iso(value)
    return {"X-Expected-Updated-At": iso} if iso else None


def _draft_retryable(expected_updated_at: Any, default: Optional[bool]) -> Optional[bool]:
    """Con `expected_updated_at` el pedido NO se reintenta ante errores de red/5xx: si el primer intento se guardó y se
    perdió la respuesta, el reintento compararía contra el `updatedAt` que ese mismo intento cambió y daría un 409
    `version_changed` falso. Solo se reintentan 429 (límite por IP) y 503, que la API responde sin procesar el pedido.
    Ante un `network_error` o un 5xx, recargá el sobre y comprobá si el cambio quedó aplicado."""
    return False if _expected(expected_updated_at) else default


def _seg(value: str) -> str:
    """Un id como segmento de la ruta: sin codificar, un id que llega de afuera ("../webhooks", "x?y") cambiaba el
    pedido (otra ruta de la API con la credencial del integrador)."""
    return urllib.parse.quote(str(value), safe="")


def _json_or_empty(raw: bytes) -> Dict[str, Any]:
    try:
        v = json.loads(raw or b"{}")
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


def _error_body(e: urllib.error.HTTPError) -> Dict[str, Any]:
    """Cuerpo JSON de una respuesta de error. Un corte o timeout al leerlo no escapa como OSError/IncompleteRead suelto:
    se lanza dentro del `except HTTPError`, así que los `except` hermanos de los errores de red no lo atrapaban."""
    try:
        return _json_or_empty(e.read())
    except _NETWORK_ERRORS:
        return {}


# Códigos del 429 del límite por IP (genérico): cualquier otro código en un 429 es un tope de negocio.
_GENERIC_429_CODES = {"bad_request", "rate_limited"}


def _is_business_429(body: Dict[str, Any]) -> bool:
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    code = err.get("code")
    return isinstance(code, str) and code not in _GENERIC_429_CODES


def _retry_delay(attempt: int, retry_after: Optional[str]) -> float:
    if retry_after:
        try:
            d = float(retry_after)
            # Negativo o NaN: time.sleep lanzaba ValueError (como el SDK de Node, solo cuenta si es positivo).
            if d > 0:
                return min(d, 30.0)
        except ValueError:
            pass
    return min(8.0, 0.5 * 2**attempt) * (0.75 + random.random() * 0.5)


def _encode_multipart(fields: Dict[str, Any]) -> "tuple[bytes, str]":
    boundary = f"calasign{uuid.uuid4().hex}"
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            filename, content, ctype = value
            # Como los navegadores (y FormData de Node): comillas y saltos de línea escapados, para que un nombre como
            # 'Contrato "ACME".pdf' no corte el encabezado ni agregue otros.
            safe_name = str(filename).replace("\r", "%0D").replace("\n", "%0A").replace('"', "%22")
            out += f'Content-Disposition: form-data; name="{name}"; filename="{safe_name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
            out += content
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}'.encode()
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"
