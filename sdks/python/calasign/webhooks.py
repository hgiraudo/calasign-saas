"""Verificación de webhooks de CalaSign: `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional, Union

__all__ = ["WebhookSignatureError", "construct_event", "verify_signature"]


class WebhookSignatureError(Exception):
    pass


def construct_event(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> Dict[str, Any]:
    """Verifica la firma (y su antigüedad) y devuelve el evento. Usar el cuerpo CRUDO del POST."""
    if not header:
        raise WebhookSignatureError("Falta el header CalaSign-Signature")
    parts: Dict[str, str] = {}
    for kv in header.split(","):
        k, _, v = kv.partition("=")
        parts[k.strip()] = v.strip()
    try:
        t = int(parts["t"])
        v1 = parts["v1"]
    except (KeyError, ValueError):
        raise WebhookSignatureError("Header de firma mal formado") from None
    if abs(int(now if now is not None else time.time()) - t) > tolerance:
        raise WebhookSignatureError("Firma fuera de la tolerancia de tiempo")
    # HMAC sobre los bytes crudos: un cuerpo que no es UTF-8 no rompe la verificación (simplemente no coincide).
    raw = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + raw, hashlib.sha256).hexdigest()
    # En bytes: compare_digest con un str no ASCII (un header manipulado) lanza TypeError en vez de no coincidir.
    if not hmac.compare_digest(expected.encode(), v1.encode("utf-8", "surrogateescape")):
        raise WebhookSignatureError("Firma inválida")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise WebhookSignatureError("El cuerpo del webhook no es JSON válido") from None


def verify_signature(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> bool:
    try:
        construct_event(payload, header, secret, tolerance=tolerance, now=now)
        return True
    except WebhookSignatureError:
        return False
