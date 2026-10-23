"""Where media and collage renders live.

Local mode (Docker) keeps everything in MEDIA_DIR and OUTPUT_DIR. Supabase mode
treats those folders as a cache: a file is uploaded after it is written and
downloaded again the first time an instance without it reads it, so
serverless instances with no lasting disk can share the same files.
"""
from __future__ import annotations

import re
import shutil
import uuid
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

import requests

from .config import get_settings

INCOMING_PREFIX = "incoming"
INCOMING_KEY = re.compile(rf"{INCOMING_PREFIX}/[0-9a-f]{{32}}")
CONTENT_TYPES = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".zip": "application/zip"}


class LocalStorage:
    remote = False

    def __init__(self, media_dir: str, output_dir: str):
        self.roots = {"media": Path(media_dir).resolve(), "outputs": Path(output_dir).resolve()}

    def key(self, path: str | Path) -> str | None:
        """Bucket key for a file under MEDIA_DIR or OUTPUT_DIR, else None."""
        resolved = Path(path).resolve()
        for name, root in self.roots.items():
            if root in resolved.parents:
                return f"{name}/{resolved.relative_to(root).as_posix()}"
        return None

    def saved(self, path: str | Path) -> None:
        """Call after writing a file so other instances can read it."""

    def ensure(self, path: str | Path) -> bool:
        """True when the file is readable on this instance."""
        return Path(path).is_file()

    def exists(self, path: str | Path) -> bool:
        return Path(path).is_file()

    def delete(self, path: str | Path) -> None:
        Path(path).unlink(missing_ok=True)

    def delete_tree(self, directory: str | Path) -> None:
        shutil.rmtree(directory, ignore_errors=True)

    def signed_url(self, path: str | Path) -> str | None:
        return None

    def upload_targets(self, count: int) -> list[dict] | None:
        """Direct-to-storage upload links; None means send files inline."""
        return None

    def take_incoming(self, key: str) -> bytes:
        raise FileNotFoundError("Direct uploads need SUPABASE storage")

    def delete_stale_incoming(self, older_than_hours: int = 24) -> int:
        return 0

    def ensure_bucket(self) -> None:
        """Create the bucket on first deploy."""


class SupabaseStorage(LocalStorage):
    remote = True

    def __init__(self, media_dir: str, output_dir: str, url: str, service_key: str, bucket: str, signed_seconds: int):
        super().__init__(media_dir, output_dir)
        self.base = f"{url.rstrip('/')}/storage/v1"
        self.bucket = bucket
        self.signed_seconds = signed_seconds
        self.http = requests.Session()
        self.http.headers.update({"Authorization": f"Bearer {service_key}", "apikey": service_key})

    def ensure_bucket(self) -> None:
        if self._request("GET", f"{self.base}/bucket/{self.bucket}").status_code == 200:
            return
        # Private bucket; files are only reachable through signed links.
        response = self._request("POST", f"{self.base}/bucket", json={"id": self.bucket, "name": self.bucket, "public": False,
            "file_size_limit": 26214400})
        if response.status_code >= 300 and "already exists" not in response.text.lower():
            raise OSError(f"Could not create storage bucket ({response.status_code}): {response.text[:200]}")

    def _object(self, key: str) -> str:
        return f"{self.base}/object/{self.bucket}/{quote(key)}"

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        try:
            return self.http.request(method, url, timeout=kwargs.pop("timeout", 60), **kwargs)
        except requests.RequestException as exc:
            raise OSError(f"Storage request failed: {exc}") from exc

    def saved(self, path: str | Path) -> None:
        key = self.key(path)
        if key is None:
            return
        content_type = CONTENT_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")
        with Path(path).open("rb") as source:
            response = self._request("POST", self._object(key), data=source,
                headers={"Content-Type": content_type, "x-upsert": "true", "cache-control": "max-age=3600"})
        if response.status_code >= 300:
            raise OSError(f"Storage upload failed ({response.status_code}) for {key}")

    def ensure(self, path: str | Path) -> bool:
        path = Path(path)
        if path.is_file():
            return True
        key = self.key(path)
        if key is None:
            return False
        response = self._request("GET", self._object(key), stream=True)
        if response.status_code != 200:
            response.close()
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("wb") as target:
                for chunk in response.iter_content(1024 * 256):
                    target.write(chunk)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
            response.close()
        return True

    def exists(self, path: str | Path) -> bool:
        if Path(path).is_file():
            return True
        key = self.key(path)
        return key is not None and self._request("HEAD", self._object(key)).status_code == 200

    def _delete_keys(self, keys: list[str]) -> None:
        for start in range(0, len(keys), 1000):
            response = self._request("DELETE", f"{self.base}/object/{self.bucket}", json={"prefixes": keys[start:start + 1000]})
            if response.status_code >= 300:
                raise OSError(f"Storage delete failed ({response.status_code})")

    def delete(self, path: str | Path) -> None:
        super().delete(path)
        key = self.key(path)
        if key:
            self._delete_keys([key])

    def _list(self, prefix: str) -> list[dict]:
        """Every object under a folder; Supabase lists one level at a time."""
        found: list[dict] = []
        offset = 0
        while True:
            response = self._request("POST", f"{self.base}/object/list/{self.bucket}",
                json={"prefix": prefix, "limit": 1000, "offset": offset})
            if response.status_code >= 300:
                raise OSError(f"Storage list failed ({response.status_code})")
            page = response.json()
            for item in page:
                name = f"{prefix}/{item['name']}"
                if item.get("id") is None:
                    found.extend(self._list(name))
                else:
                    found.append({**item, "key": name})
            if len(page) < 1000:
                return found
            offset += 1000

    def delete_tree(self, directory: str | Path) -> None:
        super().delete_tree(directory)
        prefix = self.key(directory)
        if prefix:
            self._delete_keys([item["key"] for item in self._list(prefix)])

    def signed_url(self, path: str | Path) -> str | None:
        key = self.key(path)
        if key is None:
            return None
        response = self._request("POST", f"{self.base}/object/sign/{self.bucket}/{quote(key)}", json={"expiresIn": self.signed_seconds})
        if response.status_code >= 300:
            return None
        return f"{self.base}{response.json()['signedURL']}"

    def upload_targets(self, count: int) -> list[dict]:
        targets = []
        for _ in range(count):
            key = f"{INCOMING_PREFIX}/{uuid.uuid4().hex}"
            response = self._request("POST", f"{self.base}/object/upload/sign/{self.bucket}/{key}")
            if response.status_code >= 300:
                raise OSError(f"Storage upload link failed ({response.status_code})")
            targets.append({"key": key, "url": f"{self.base}{response.json()['url']}"})
        return targets

    def take_incoming(self, key: str) -> bytes:
        """Read a browser upload once, then remove it from the bucket."""
        if not INCOMING_KEY.fullmatch(key):
            raise FileNotFoundError("Unknown upload")
        response = self._request("GET", self._object(key))
        if response.status_code != 200:
            raise FileNotFoundError("The upload was not found; upload the image again")
        self._delete_keys([key])
        return response.content

    def delete_stale_incoming(self, older_than_hours: int = 24) -> int:
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
        stale = [item["key"] for item in self._list(INCOMING_PREFIX)
            if item.get("created_at") and datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")) < cutoff]
        if stale:
            self._delete_keys(stale)
        return len(stale)


@lru_cache
def get_storage() -> LocalStorage:
    settings = get_settings()
    if settings.storage_backend == "supabase":
        return SupabaseStorage(settings.media_dir, settings.output_dir, settings.supabase_url,
            settings.supabase_service_key, settings.supabase_bucket, settings.storage_signed_url_seconds)
    return LocalStorage(settings.media_dir, settings.output_dir)
