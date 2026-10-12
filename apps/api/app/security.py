"""The API is private: browser traffic enters through the authenticated web proxy."""
import hmac
from urllib.parse import unquote
from contextvars import ContextVar
from starlette.responses import JSONResponse

actor_context: ContextVar[str] = ContextVar("editor_actor", default="service")


def current_actor() -> str:
    return actor_context.get()


class PrivateAPIMiddleware:
    def __init__(self, app, key: str):
        self.app, self.key = app, key

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        if scope["path"] != "/health" and not hmac.compare_digest(headers.get(b"x-editor-key", b""), self.key.encode()):
            return await JSONResponse({"detail": "Authentication required"}, status_code=401)(scope, receive, send)
        actor = unquote(headers.get(b"x-editor-id", b"service").decode("utf-8", errors="replace"))[:120]
        token = actor_context.set(actor)
        async def secure_send(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).extend([
                    (b"cache-control", b"private, no-store"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                ])
            await send(message)
        try:
            await self.app(scope, receive, secure_send)
        finally:
            actor_context.reset(token)
