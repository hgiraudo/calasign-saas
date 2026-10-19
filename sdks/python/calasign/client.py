"""Cliente HTTP de CalaSign (solo biblioteca estándar: urllib, json, hmac)."""
from __future__ import annotations

import base64
import json
import random
import socket
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
    sentAt: Optional[str]
    completedAt: Optional[str]
    metadata: Dict[str, Any]
    signedSha256: Optional[str]


class EnvelopeDetail(TypedDict, total=False):
    envelope: Envelope
    documents: List[Document]
    recipients: List[Recipient]
    fields: List[Dict[str, Any]]


class EnvelopeSummary(TypedDict, total=False):
    id: str
    subject: str
    status: str
    createdAt: str


# ───────────────────────────── Errores y opciones ─────────────────────────────


class CalaSignError(Exception):
    """Error de la API: status HTTP, código (`envelope_incomplete`, `insufficient_scope`, …) y detalles."""

    def __init__(self, message: str, status: int, code: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details

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
    ):
        if not (api_key or access_token or oauth):
            raise ValueError("CalaSign: falta api_key, access_token u oauth")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._access_token = access_token
        self._oauth = oauth
        self._token: Optional[_Token] = None
        self.max_retries = max_retries
        self.timeout = timeout
        self.user_agent = user_agent or f"calasign-python/{VERSION}"
        self.envelopes = _Envelopes(self)
        self.templates = _Templates(self)
        self.webhooks = _Webhooks(self)

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
            body = _json_or_empty(e.read())
            raise CalaSignError(body.get("error_description", "No se pudo obtener el token OAuth"), e.code, body.get("error", "oauth_error")) from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as e:
            # Igual que en `request`: quien captura CalaSignError para los errores de red no recibe un URLError suelto
            # cuando el que falla es el pedido del token (el primero de cada cliente, o el refresh tras un 401).
            raise CalaSignError(f"Error de red al pedir el token OAuth: {e}", 0, "network_error") from None
        self._token = _Token(body["access_token"], time.time() + float(body.get("expires_in", 3600)))
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
    ) -> Any:
        """Pedido a la API v1 con autenticación, reintentos e idempotencia."""
        url = self.base_url + path
        if query:
            q = {k: v for k, v in query.items() if v not in (None, "")}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        if retryable is None:
            retryable = method in ("GET", "PUT", "DELETE") or idempotency_key is not None
        refreshed = False
        attempt = 0
        while True:
            headers = {"Authorization": f"Bearer {self._bearer()}", "Accept": "application/json", "User-Agent": self.user_agent}
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key
            data: Optional[bytes] = None
            if multipart is not None:
                data, ctype = _encode_multipart(multipart)
                headers["Content-Type"] = ctype
            elif json_body is not None:
                data = json.dumps(json_body).encode()
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    payload = res.read()
                    if raw:
                        return payload
                    return json.loads(payload) if payload else None
            except urllib.error.HTTPError as e:
                status = e.code
                body = _json_or_empty(e.read())
                if status == 401 and self._oauth and not refreshed:
                    refreshed = True
                    self._bearer(force=True)
                    continue
                if status in _RETRY_STATUS and attempt < self.max_retries and (retryable or status in (429, 503)):
                    retry_after = e.headers.get("Retry-After")
                    time.sleep(_retry_delay(attempt, retry_after))
                    attempt += 1
                    continue
                err = body.get("error") if isinstance(body.get("error"), dict) else {}
                raise CalaSignError(err.get("message", f"HTTP {status}"), status, err.get("code", f"http_{status}"), err.get("details")) from None
            except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as e:
                if retryable and attempt < self.max_retries:
                    time.sleep(_retry_delay(attempt, None))
                    attempt += 1
                    continue
                raise CalaSignError(f"Error de red: {e}", 0, "network_error") from None

    def me(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/me")


# ───────────────────────────── Recursos ─────────────────────────────


class _Envelopes:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(self, *, status: Union[str, Sequence[str], None] = None, q: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        st = ",".join(status) if isinstance(status, (list, tuple)) else status
        return self._c.request("GET", "/v1/envelopes", query={"status": st, "q": q, "limit": limit, "cursor": cursor})

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
        return self._c.request("POST", "/v1/envelopes", json_body=data, idempotency_key=idempotency_key or str(uuid.uuid4()))

    def update(self, envelope_id: str, data: Dict[str, Any]) -> EnvelopeDetail:
        return self._c.request("PATCH", f"/v1/envelopes/{_seg(envelope_id)}", json_body=data, retryable=True)

    def delete(self, envelope_id: str) -> None:
        self._c.request("DELETE", f"/v1/envelopes/{_seg(envelope_id)}")

    def upload_document(self, envelope_id: str, content: bytes, filename: str = "documento.pdf") -> Document:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/documents", multipart={"file": (filename, content, "application/pdf")})

    def set_recipients(self, envelope_id: str, recipients: List[Dict[str, Any]]) -> EnvelopeDetail:
        return self._c.request("PUT", f"/v1/envelopes/{_seg(envelope_id)}/recipients", json_body={"recipients": recipients})

    def set_fields(self, envelope_id: str, fields: List[Dict[str, Any]]) -> EnvelopeDetail:
        return self._c.request("PUT", f"/v1/envelopes/{_seg(envelope_id)}/fields", json_body={"fields": fields})

    def send(self, envelope_id: str, *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/send", idempotency_key=idempotency_key or f"send-{_seg(envelope_id)}")

    def void(self, envelope_id: str, reason: str) -> EnvelopeDetail:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/void", json_body={"reason": reason}, retryable=True)

    def remind(self, envelope_id: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/remind")

    def events(self, envelope_id: str) -> List[Dict[str, Any]]:
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/events")["items"]

    def download_signed(self, envelope_id: str) -> bytes:
        return self._c.request("GET", f"/v1/envelopes/{_seg(envelope_id)}/signed.pdf", raw=True)

    def signing_url(self, envelope_id: str, recipient_id: str, *, return_url: Optional[str] = None) -> Dict[str, Any]:
        body = {"returnUrl": return_url} if return_url else {}
        return self._c.request("POST", f"/v1/envelopes/{_seg(envelope_id)}/recipients/{_seg(recipient_id)}/signing-url", json_body=body)

    def from_template(self, data: Dict[str, Any], *, idempotency_key: Optional[str] = None) -> EnvelopeDetail:
        return self._c.request("POST", "/v1/envelopes/from-template", json_body=data, idempotency_key=idempotency_key or str(uuid.uuid4()))


class _Templates:
    def __init__(self, c: CalaSign):
        self._c = c

    def list(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._c.request("GET", "/v1/templates", query={"q": q})["items"]

    def get(self, template_id: str) -> Dict[str, Any]:
        return self._c.request("GET", f"/v1/templates/{_seg(template_id)}")


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

    def delete(self, webhook_id: str) -> None:
        self._c.request("DELETE", f"/v1/webhooks/{_seg(webhook_id)}")

    def test(self, webhook_id: str) -> Dict[str, Any]:
        return self._c.request("POST", f"/v1/webhooks/{_seg(webhook_id)}/test")


# ───────────────────────────── Utilidades ─────────────────────────────


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


def _retry_delay(attempt: int, retry_after: Optional[str]) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 30.0)
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
