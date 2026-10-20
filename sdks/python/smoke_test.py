#!/usr/bin/env python3
"""Prueba de humo del SDK de Python.

    python3 -I sdks/python/smoke_test.py                         # solo pruebas sin red
    python3 -I sdks/python/smoke_test.py http://localhost:4000   # + contra una API local
"""
import datetime
import hashlib
import hmac
import http.server
import json
import os
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from calasign import CalaSign, CalaSignError, ClientCredentials, WebhookSignatureError, construct_event, verify_signature  # noqa: E402


def ok(msg):
    print(f"✓ {msg}")


# ───────── Webhooks (sin red) ─────────
secret = "whsec_py"
body = json.dumps({"id": "evt_1", "type": "envelope.completed", "data": {}})
t = 1_800_000_000
sig = f"t={t},v1={hmac.new(secret.encode(), f'{t}.{body}'.encode(), hashlib.sha256).hexdigest()}"
assert construct_event(body, sig, secret, now=t)["type"] == "envelope.completed"
assert verify_signature(body.encode(), sig, secret, now=t)
assert not verify_signature(body.replace("completed", "voided"), sig, secret, now=t)
assert not verify_signature(body, sig, "otro", now=t)
assert not verify_signature(body, sig, secret, now=t + 1000)
assert not verify_signature(body, f"t={t},v1=é", secret, now=t)  # header no ASCII: no coincide, no lanza TypeError
try:
    construct_event(body, None, secret)
    raise AssertionError("debió fallar")
except WebhookSignatureError:
    pass
ok("verificación de webhooks: válida, alterada, secreto incorrecto, vieja y sin header")

# Rotación del secreto: el header trae dos v1 (nuevo y anterior); vale con cualquiera de los dos.
_mac = lambda k: hmac.new(k.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()  # noqa: E731
dual = f"t={t},v1={_mac('nuevo')},v1={_mac('viejo')}"
assert verify_signature(body, dual, "nuevo", now=t) and verify_signature(body, dual, "viejo", now=t)
assert not verify_signature(body, dual, "otro", now=t)
ok("verificación con dos firmas v1 (rotación del secreto)")

# Un error de red al pedir el token OAuth también llega como CalaSignError (no como URLError suelto).
try:
    CalaSign(oauth=ClientCredentials("cli", "sec"), base_url="http://127.0.0.1:9", timeout=2, max_retries=0).me()
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.code == "network_error", e.code
ok("error de red al pedir el token OAuth: CalaSignError network_error")

# Un id que llega de afuera no cambia la ruta del pedido ("../webhooks" no llega a /v1/webhooks).
_paths = []


class _Rec(http.server.BaseHTTPRequestHandler):
    def _any(self):
        _paths.append((self.command, self.path))
        self.send_response(404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"code":"not_found","message":"x"}}')

    do_GET = do_DELETE = _any

    def log_message(self, *a):
        pass


_srv = http.server.HTTPServer(("127.0.0.1", 0), _Rec)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
_cs = CalaSign(api_key="k", base_url=f"http://127.0.0.1:{_srv.server_address[1]}", max_retries=0)
for call in (lambda: _cs.envelopes.get("../webhooks"), lambda: _cs.webhooks.delete("../envelopes/e1?x=1")):
    try:
        call()
        raise AssertionError("debió fallar")
    except CalaSignError:
        pass
_srv.shutdown()
assert _paths == [("GET", "/v1/envelopes/..%2Fwebhooks"), ("DELETE", "/v1/webhooks/..%2Fenvelopes%2Fe1%3Fx%3D1")], _paths
ok("ids en la ruta: se codifican como un segmento")

# Respuestas en cola: idempotency_in_progress, request_id/idempotency_key en el error, str sueltos y adjuntos con tipo.
_queue = []
_seen = []


class _Script(http.server.BaseHTTPRequestHandler):
    def _any(self):
        n = int(self.headers.get("content-length") or 0)
        _seen.append((self.command, self.path, json.loads(self.rfile.read(n)) if n else None))
        status, body, ctype = _queue.pop(0)
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("x-request-id", "req-1")
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = _any

    def log_message(self, *a):
        pass


_srv = http.server.HTTPServer(("127.0.0.1", 0), _Script)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
_base = f"http://127.0.0.1:{_srv.server_address[1]}"
_busy = (409, b'{"error":{"code":"idempotency_in_progress","message":"en curso"}}', "application/json")
_queue[:] = [_busy, _busy, (201, b'{"envelope":{"id":"e1"}}', "application/json")]
_cs = CalaSign(api_key="k", base_url=_base, max_retries=0, idempotency_wait=10)
assert _cs.envelopes.create({"subject": "x"}, idempotency_key="idem-1")["envelope"]["id"] == "e1"
assert len(_seen) == 3, _seen
_queue[:] = [_busy]
try:
    CalaSign(api_key="k", base_url=_base, max_retries=3, idempotency_wait=0).envelopes.create({"subject": "x"}, idempotency_key="idem-2")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.status, e.code, e.request_id, e.idempotency_key) == (409, "idempotency_in_progress", "req-1", "idem-2"), vars(e)
ok("idempotency_in_progress: espera aparte de max_retries; el error trae request_id e idempotency_key")

_seen.clear()
_queue[:] = [
    (200, b'{"items":[],"nextCursor":null,"hasMore":false}', "application/json"),
    (200, b'{"results":[]}', "application/json"),
    (200, b"\x89PNG", "image/png"),
    (200, b'{"url":"u"}', "application/json"),
]
_cs.events.list(types="envelope.completed")
_cs.envelopes.batch("get", "e1")
att = _cs.envelopes.download_attachment_with_type("e1", "f1")
_cs.envelopes.signing_url("e1", "r1", frame_ancestors=["https://app.example.com"])
assert _seen[0][1] == "/v1/events?types=envelope.completed", _seen[0]
assert _seen[1][2] == {"action": "get", "ids": ["e1"]}, _seen[1]
assert att == {"bytes": b"\x89PNG", "content_type": "image/png"}, att
assert _seen[3][2] == {"frameAncestors": ["https://app.example.com"]}, _seen[3]
_srv.shutdown()
ok("types/ids como str, adjunto con tipo y frame_ancestors")

# Celdas (421 wrong_cell), 503 no reintentable, expected_updated_at en void/remind/send y paridad con el SDK de Node.
_cell_log = []


def _cell_handler(name, queue):
    class _H(http.server.BaseHTTPRequestHandler):
        def _any(self):
            n = int(self.headers.get("content-length") or 0)
            if n:
                self.rfile.read(n)
            _cell_log.append((name, self.command, self.path, self.headers.get("X-Expected-Updated-At")))
            item = queue.pop(0)
            status, payload = item() if callable(item) else item
            self.send_response(status)
            self.send_header("content-type", "application/json")
            if status == 421 and isinstance(payload, dict) and payload.get("error", {}).get("details", {}).get("baseUrl"):
                self.send_header("location", payload["error"]["details"]["baseUrl"] + self.path)
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        do_GET = do_POST = do_DELETE = _any

        def log_message(self, *a):
            pass

    return _H


_qa, _qb = [], []
_sa = http.server.HTTPServer(("127.0.0.1", 0), _cell_handler("a", _qa))
_sb = http.server.HTTPServer(("127.0.0.1", 0), _cell_handler("b", _qb))
for _s in (_sa, _sb):
    threading.Thread(target=_s.serve_forever, daemon=True).start()
_base_a = f"http://127.0.0.1:{_sa.server_address[1]}"
_base_b = f"http://127.0.0.1:{_sb.server_address[1]}"


def _wrong(base):
    return (421, {"error": {"code": "wrong_cell", "message": "otra región", "details": {"cell": "eu", "baseUrl": base}}})


# Un POST sin idempotencia (remind) se repite una vez contra la otra celda y la URL queda para los siguientes.
_qa[:] = [_wrong(_base_b + "/")]
_qb[:] = [(200, {"notified": 1}), (200, {"items": [], "nextCursor": None})]
_cs = CalaSign(api_key="k", base_url=_base_a, max_retries=0)
assert _cs.envelopes.remind("e1") == {"notified": 1}
assert _cs.base_url == _base_b, _cs.base_url
_cs.envelopes.list(limit=5)
assert [x[:3] for x in _cell_log] == [("a", "POST", "/v1/envelopes/e1/remind"), ("b", "POST", "/v1/envelopes/e1/remind"), ("b", "GET", "/v1/envelopes?limit=5")], _cell_log
# Si la otra celda también responde 421 (o no hay baseUrl), se lanza wrong_cell con cell_base_url.
_cell_log.clear()
_qa[:] = [_wrong(_base_b)]
_qb[:] = [_wrong(_base_a)]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=0).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.status, e.code, e.cell_base_url) == (421, "wrong_cell", _base_a), vars(e)
assert len(_cell_log) == 2, _cell_log
_qa[:] = [_wrong(None)]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=0).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.code, e.cell_base_url) == ("wrong_cell", None)
ok("421 wrong_cell: un reintento contra details.baseUrl, que queda para los siguientes; si no, cell_base_url en el error")

# Carrera: mientras un pedido espera su 421, otro (otro hilo) ya cambió la base a la celda nueva. El 421 se compara contra
# la base con la que salió el pedido, así que igual reintenta contra la nueva (antes fallaba con wrong_cell).
_cell_log.clear()
_cs = CalaSign(api_key="k", base_url=_base_a, max_retries=0)


def _switched_meanwhile():
    _cs.base_url = _base_b
    return _wrong(_base_b)


_qa[:] = [_switched_meanwhile]
_qb[:] = [(200, {"envelope": {"id": "e1"}})]
assert _cs.envelopes.get("e1")["envelope"]["id"] == "e1"
assert [x[0] for x in _cell_log] == ["a", "b"] and _cs.base_url == _base_b, (_cell_log, _cs.base_url)
# Lo mismo con dos hilos de verdad que reciben 421.
_cell_log.clear()
_cs = CalaSign(api_key="k", base_url=_base_a, max_retries=0)
_qa[:] = [_wrong(_base_b), _wrong(_base_b)]
_qb[:] = [(200, {"envelope": {"id": "e1"}}), (200, {"envelope": {"id": "e1"}})]
_res = []
_ths = [threading.Thread(target=lambda: _res.append(_cs.envelopes.get("e1"))) for _ in range(2)]
for _t in _ths:
    _t.start()
for _t in _ths:
    _t.join(10)
assert len(_res) == 2 and _cs.base_url == _base_b, (_res, _cell_log)
ok("421 concurrentes: se comparan contra la base del intento; el cambio de base va con lock")

# Dominio registrable: tres etiquetas solo con ccTLD de 2 letras + segundo nivel genérico; hosting compartido, host entero.
from calasign.client import _registrable_domain as _rd

for _h, _want in [
    ("api.ibm.com", "ibm.com"),
    ("eu.api.calasign.com.ar", "calasign.com.ar"),
    ("api.calasign.co.uk", "calasign.co.uk"),
    ("api.calasign.gob.ar.", "calasign.gob.ar"),
    ("x.foo.de", "foo.de"),
    ("api.abc.xyz", "abc.xyz"),
    ("a.herokuapp.com", "a.herokuapp.com"),
    ("b.x.vercel.app", "b.x.vercel.app"),
    ("herokuapp.com", "herokuapp.com"),
    ("API.Calasign.COM", "calasign.com"),
    ("api.calasign.com.\u00e1r", "com.\u00e1r"),  # ccTLD no ASCII: no cuenta como ccTLD (igual que /^[a-z]{2}$/ en Node)
    ("127.0.0.1", "127.0.0.1"),
    ("localhost", "localhost"),
]:
    assert _rd(_h) == _want, (_h, _rd(_h), _want)
assert _rd("a.github.io") != _rd("b.github.io")
ok("dominio registrable: ccTLD + segundo nivel genérico, hosting compartido por host completo")

# Solo se sigue el 421 hacia el mismo dominio registrable (o allowed_cell_hosts); follow_cell_redirects=False no lo sigue.
_base_b_lh = _base_b.replace("127.0.0.1", "localhost")
_cell_log.clear()
_qa[:] = [_wrong(_base_b_lh)]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=0).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.status, e.code, e.cell_base_url) == (421, "wrong_cell", _base_b_lh), vars(e)
assert len(_cell_log) == 1, _cell_log
_cell_log.clear()
_qa[:] = [_wrong(_base_b_lh)]
_qb[:] = [(200, {"envelope": {"id": "e1"}})]
_cs = CalaSign(api_key="k", base_url=_base_a, max_retries=0, allowed_cell_hosts=["localhost"])
assert _cs.envelopes.get("e1")["envelope"]["id"] == "e1"
assert _cs.base_url == _base_b_lh and [x[0] for x in _cell_log] == ["a", "b"], _cell_log
_cell_log.clear()
_qa[:] = [_wrong(_base_b)]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=0, follow_cell_redirects=False).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.cell_base_url == _base_b
assert len(_cell_log) == 1, _cell_log
from calasign.client import _registrable_domain

assert _registrable_domain("eu.calasign.com") == _registrable_domain("dev.calasign.com") == "calasign.com"
assert _registrable_domain("api.calasign.com.ar") == "calasign.com.ar" != _registrable_domain("otro.com.ar")
assert _registrable_domain("x.calasign.co.uk") == "calasign.co.uk"
ok("421 solo hacia el mismo dominio registrable o allowed_cell_hosts; follow_cell_redirects=False")

# 503 byok_key_unavailable no se reintenta (requiere acción de un admin); storage_unavailable sí.
_cell_log.clear()
_qa[:] = [(503, {"error": {"code": "byok_key_unavailable", "message": "clave", "details": {"keyArn": "arn"}}})]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=3).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.status, e.code) == (503, "byok_key_unavailable")
assert len(_cell_log) == 1, _cell_log
_qa[:] = [(503, {"error": {"code": "storage_unavailable", "message": "x"}}), (200, {"envelope": {"id": "e1"}})]
assert CalaSign(api_key="k", base_url=_base_a, max_retries=3).envelopes.get("e1")["envelope"]["id"] == "e1"
assert len(_cell_log) == 3, _cell_log
_cell_log.clear()
_qa[:] = [(503, {"error": {"code": "ai_unavailable", "message": "sin IA"}})]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=3).envelopes.get("e1")
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert (e.status, e.code) == (503, "ai_unavailable")
assert len(_cell_log) == 1, _cell_log
ok("503 byok_key_unavailable y ai_unavailable no se reintentan; storage_unavailable sí")

# expected_updated_at en void (sin reintento ante 5xx), remind y send; remove_document y webhooks.deliveries.
_cell_log.clear()
_at = "2026-01-01T00:00:00.000Z"
_qa[:] = [(500, {"error": {"code": "internal_error", "message": "x"}})]
try:
    CalaSign(api_key="k", base_url=_base_a, max_retries=2).envelopes.void("e1", "r", expected_updated_at=_at)
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.status == 500
assert len(_cell_log) == 1 and _cell_log[0][3] == _at, _cell_log
_qa[:] = [(200, {"notified": 1}), (200, {"envelope": {"id": "e1"}}), (204, {}), (200, {"items": [{"id": "d1"}]})]
_cs = CalaSign(api_key="k", base_url=_base_a, max_retries=0)
_cs.envelopes.remind("e1", expected_updated_at=_at)
_cs.envelopes.send("e1", expected_updated_at=_at)
_cs.envelopes.remove_document("e1", "doc1")
assert _cs.webhooks.deliveries("w1") == [{"id": "d1"}]
assert [x[1:] for x in _cell_log[1:]] == [
    ("POST", "/v1/envelopes/e1/remind", _at),
    ("POST", "/v1/envelopes/e1/send", _at),
    ("DELETE", "/v1/envelopes/e1/documents/doc1", None),
    ("GET", "/v1/webhooks/w1/deliveries", None),
], _cell_log
_sa.shutdown()
_sb.shutdown()
ok("expected_updated_at en void/remind/send; remove_document y webhooks.deliveries")

if len(sys.argv) < 2:
    print("\n(sin URL de API: se omiten las pruebas en línea)")
    sys.exit(0)

BASE = sys.argv[1].rstrip("/")
stamp = int(time.time() * 1000)


def raw(method, path, data=None, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers=headers)
    with urllib.request.urlopen(req) as res:
        return res.headers.get("Set-Cookie"), json.loads(res.read() or b"{}")


set_cookie, _ = raw("POST", "/v1/auth/signup", {"name": "Py", "email": f"py+{stamp}@example.com", "password": "una-clave-segura-123", "organization": f"Py {stamp}"})
cookie = set_cookie.split(";")[0]
_, key = raw("POST", "/v1/api-keys", {"name": "python"}, cookie)
cs = CalaSign(key["secret"], base_url=BASE)
ok("cuenta y API key")

PDF = (
    b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n"
    b"0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n180\n%%EOF\n"
)
idem = str(uuid.uuid4())
a = cs.envelopes.create({"subject": f"Python {stamp}"}, idempotency_key=idem)
b = cs.envelopes.create({"subject": f"Python {stamp}"}, idempotency_key=idem)
assert a["envelope"]["id"] == b["envelope"]["id"]
eid = a["envelope"]["id"]
doc = cs.envelopes.upload_document(eid, PDF, "contrato.pdf")
signer = str(uuid.uuid4())
cs.envelopes.set_recipients(eid, [{"id": signer, "name": "Ana Py", "email": f"ana-py+{stamp}@example.com"}])
cs.envelopes.set_fields(eid, [{"documentId": doc["id"], "recipientId": signer, "type": "signature", "page": 0, "x": 0.1, "y": 0.7, "width": 0.3, "height": 0.08}])
assert cs.envelopes.send(eid)["envelope"]["status"] == "sent"
assert eid in [e["id"] for e in cs.envelopes.iterate(q=f"Python {stamp}")]
assert "envelope.sent" in [e["type"] for e in cs.envelopes.events(eid)]
try:
    cs.envelopes.get(str(uuid.uuid4()))
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.status == 404
ok("sobre: crear (idempotente), subir, destinatarios, campos, enviar, iterar, eventos y 404 tipado")

# Sobre completo en una llamada: PDF en bytes (multipart), firmante y campo, y envío; idempotente.
idem2 = str(uuid.uuid4())
one = {
    "subject": f"Python oneshot {stamp}",
    "documents": [{"content": PDF, "name": "contrato.pdf"}],
    "recipients": [{"name": "Ana Oneshot", "email": f"ana-oneshot+{stamp}@example.com"}],
    "fields": [{"type": "signature", "page": 0, "x": 0.1, "y": 0.7, "width": 0.3, "height": 0.08}],
}
o1 = cs.envelopes.create_and_send(one, idempotency_key=idem2)
o2 = cs.envelopes.create_and_send(one, idempotency_key=idem2)
assert o1["envelope"]["status"] == "sent" and o1["envelope"]["id"] == o2["envelope"]["id"], o1["envelope"]
assert o1["documents"][0]["name"] == "contrato.pdf" and o1["fields"][0]["recipientId"] == o1["recipients"][0]["id"]
import base64 as _b64  # noqa: E402

o3 = cs.envelopes.create({**one, "subject": f"Python oneshot b64 {stamp}", "documents": [{"base64": _b64.b64encode(PDF).decode()}]})
assert o3["envelope"]["status"] == "draft" and len(o3["fields"]) == 1
ok("sobre completo en una llamada: create_and_send (multipart, idempotente) y create con base64")
# Ampliaciones: búsqueda por metadata y fechas, form-data, clonado, lote y API de eventos.
_ago = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)
m = cs.envelopes.create({"subject": f"Python meta {stamp}", "metadata": {"pedido": f"P-{stamp}"}})
found = cs.envelopes.list(metadata={"pedido": f"P-{stamp}"}, created_from=_ago)
assert [e["id"] for e in found["items"]] == [m["envelope"]["id"]], found
fd = cs.envelopes.form_data(eid)
assert fd["envelopeId"] == eid and fd["recipients"][0]["fields"][0]["type"] == "signature"
cl = cs.envelopes.clone(eid, {"subject": f"Python clon {stamp}"})
assert cl["envelope"]["status"] == "draft" and cl["envelope"]["metadata"]["clonedFrom"] == eid and len(cl["fields"]) == 1
res = cs.envelopes.batch("delete", [cl["envelope"]["id"], m["envelope"]["id"], eid])
assert res["succeeded"] == 2 and res["results"][2]["error"]["code"] == "not_draft", res
for _ in range(20):
    evs = cs.events.list(envelope_id=eid, since=_ago)
    if evs["items"]:
        break
    time.sleep(0.5)
assert evs["items"][0]["type"] == "envelope.sent" and evs["nextCursor"], evs
ok("búsqueda por metadata y fecha, form_data, clone, batch y events.list")

# Fecha con zona horaria (lo que da datetime.isoformat() con tzinfo) y nombre de archivo con comillas.
import datetime as _dt  # noqa: E402

exp = (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(days=7)).isoformat()
c2 = cs.envelopes.create({"subject": f"Python tz {stamp}", "expiresAt": exp})
d2 = cs.envelopes.upload_document(c2["envelope"]["id"], PDF, 'Contrato "ACME".pdf')
assert d2["name"].startswith("Contrato %22ACME%22") or d2["name"].startswith('Contrato "ACME"'), d2["name"]
ok("expiresAt con zona horaria y nombre de archivo con comillas")

received = []


class Hook(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        received.append((self.rfile.read(n), self.headers.get("CalaSign-Signature")))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Hook)
threading.Thread(target=srv.serve_forever, daemon=True).start()
created = cs.webhooks.create(f"http://127.0.0.1:{srv.server_address[1]}/hook", events=["envelope.completed"])
cs.webhooks.test(created["webhook"]["id"])
for _ in range(50):
    if received:
        break
    time.sleep(0.2)
payload, header = received[0]
assert construct_event(payload, header, created["secret"])["type"] == "webhook.test"
ok("webhook real recibido y verificado")
rot = cs.webhooks.rotate_secret(created["webhook"]["id"], grace_hours=1)
received.clear()
cs.webhooks.test(created["webhook"]["id"])
for _ in range(50):
    if received:
        break
    time.sleep(0.2)
srv.shutdown()
payload, header = received[0]
assert header.count("v1=") == 2, header
assert verify_signature(payload, header, rot["secret"]) and verify_signature(payload, header, created["secret"])
cs.webhooks.delete(created["webhook"]["id"])
ok("rotación del secreto: el webhook verifica con el secreto nuevo y con el anterior")

_, app = raw("POST", "/v1/oauth/apps", {"name": "Py app", "grantTypes": ["client_credentials"], "scopes": ["envelopes:read"], "role": "member"}, cookie)
oc = CalaSign(oauth=ClientCredentials(app["app"]["clientId"], app["clientSecret"]), base_url=BASE)
assert oc.me()["tenant"]["name"] == f"Py {stamp}"
try:
    oc.envelopes.create({"subject": "no"})
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.code == "insufficient_scope"
ok("OAuth client credentials con scope de solo lectura")

print("\nSMOKE PYTHON OK")
