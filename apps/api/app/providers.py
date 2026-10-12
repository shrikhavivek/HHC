"""Shared pacing and durable cooldowns; upstream limits are respected, never rotated."""
import hashlib
import threading
import time
from email.utils import parsedate_to_datetime
from .database import SessionLocal
from .editorial import locked_state

class ProviderDeferred(RuntimeError):
    pass

def retry_seconds(headers, default=900):
    values = []
    for name in ("Retry-After", "X-Ratelimit-Reset"):
        value = headers.get(name)
        if value is None:
            continue
        try:
            values.append(max(1.0, float(value)))
        except (TypeError, ValueError):
            try:
                values.append(max(1.0, parsedate_to_datetime(value).timestamp() - time.time()))
            except (TypeError, ValueError, OverflowError):
                pass
    return max(values, default=default)

def before_request(provider, spacing=1.1):
    with SessionLocal() as db:
        state = locked_state(db, "provider:" + provider, {})
        remaining = state.value.get("next_at", 0) - time.time()
        if remaining > 2:
            raise ProviderDeferred(f"Provider cooling down; retry in {int(remaining) + 1} seconds")
        reserved = max(time.time(), state.value.get("next_at", 0))
        state.value = {**state.value, "next_at": reserved + spacing}
        db.commit()
    if remaining > 0:
        time.sleep(remaining)

def observe_response(provider, response):
    limited = response.status_code == 429
    try:
        exhausted = float(response.headers.get("X-Ratelimit-Remaining", "100")) < 1
    except ValueError:
        exhausted = False
    if limited or exhausted:
        delay = retry_seconds(response.headers)
        with SessionLocal() as db:
            state = locked_state(db, "provider:" + provider, {})
            state.value = {**state.value, "next_at": max(state.value.get("next_at", 0), time.time() + delay), "status": "cooldown"}
            db.commit()
        if limited:
            raise ProviderDeferred(f"Provider rate limit reached; retry in {int(delay)} seconds")

_cache = {}
_lock = threading.Lock()

def cache_key(client, path, parameters):
    import json
    return hashlib.sha256(json.dumps([client, path, parameters], sort_keys=True).encode()).hexdigest()

def cached_response(key):
    with _lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.monotonic():
            return entry[1]
        return None

def cache_response(key, response):
    if len(response.content) > 2_000_000:
        return
    with _lock:
        if len(_cache) >= 128:
            _cache.pop(next(iter(_cache)))
        _cache[key] = (time.monotonic() + 300, response)
