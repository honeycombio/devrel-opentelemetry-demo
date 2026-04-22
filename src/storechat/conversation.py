import json
import logging
import os

import httpx
import redis

VALKEY_ADDR = os.environ.get("VALKEY_ADDR", "valkey-cart:6379")
SESSION_TTL = 3600  # 1 hour

_KEY_PREFIX = "storechat:session:"

# Feature flag evaluation via flagd OFREP HTTP API
_FLAGD_HOST = os.environ.get("FLAGD_HOST", "flagd")
_FLAGD_PORT = os.environ.get("FLAGD_PORT", "8013")
_FLAGD_OFREP_PORT = os.environ.get("FLAGD_OFREP_PORT", "8016")
_FLAGD_OFREP_URL = f"http://{_FLAGD_HOST}:{_FLAGD_OFREP_PORT}/ofrep/v1/evaluate/flags"

logger = logging.getLogger(__name__)


def evaluate_flag(flag_key: str, default: bool = False) -> bool:
    try:
        resp = httpx.post(f"{_FLAGD_OFREP_URL}/{flag_key}", json={}, timeout=2)
        if resp.status_code == 200:
            return resp.json().get("value", default)
    except Exception:
        logger.debug("Failed to evaluate flag %s, using default", flag_key)
    return default


def _get_client() -> redis.Redis:
    host, _, port = VALKEY_ADDR.partition(":")
    return redis.Redis(host=host, port=int(port or 6379), decode_responses=True)


def get_history(session_id: str) -> list[dict]:
    """Load conversation history from Valkey."""
    client = _get_client()
    raw = client.get(f"{_KEY_PREFIX}{session_id}")
    if raw is None:
        return []
    return json.loads(raw)


def append(session_id: str, role: str, content: str) -> None:
    """Append a message to the conversation history and refresh TTL."""
    client = _get_client()
    key = f"{_KEY_PREFIX}{session_id}"
    history = get_history(session_id)
    history.append({"role": role, "content": content})
    client.setex(key, SESSION_TTL, json.dumps(history))
