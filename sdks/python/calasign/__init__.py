"""SDK de CalaSign para Python (≥ 3.8, sin dependencias)."""
from .client import VERSION, CalaSign, CalaSignError, ClientCredentials, CreateEnvelopeResponse
from .webhooks import WebhookSignatureError, construct_event, verify_signature

__version__ = VERSION
__all__ = ["CalaSign", "CalaSignError", "ClientCredentials", "CreateEnvelopeResponse", "WebhookSignatureError", "construct_event", "verify_signature", "__version__"]
