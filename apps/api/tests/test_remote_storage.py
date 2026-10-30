import asyncio
import io
import json
import shutil
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import pytest
from PIL import Image

from app import automation, storage
from app.collage import bundle_archive, bundle_download_url, render_bundle
from app.config import get_settings
from app.editor_uploads import store_editor_image
from app.uploads import StagedUpload, staged_uploads

BASE = "https://project.supabase.co/storage/v1"


class FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b""):
        self.status_code, self._payload, self.content = status_code, payload, content

    def json(self):
        return self._payload

    def iter_content(self, size):
        for start in range(0, len(self.content), size):
            yield self.content[start:start + size]

    def close(self):
        pass


class FakeBucket:
    """Just enough of the Supabase Storage REST API for the storage layer."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, datetime]] = {}

    def __call__(self, method, url, **kwargs):
        path = unquote(urlsplit(url).path).removeprefix("/storage/v1/object/")
        if method == "POST" and path.startswith("list/hhc"):
            prefix = kwargs["json"]["prefix"].rstrip("/") + "/"
            names, folders = [], set()
            for key, (_, created) in self.objects.items():
                if key.startswith(prefix):
                    rest = key.removeprefix(prefix)
                    if "/" in rest:
                        folders.add(rest.split("/", 1)[0])
                    else:
                        names.append({"name": rest, "id": key, "created_at": created.isoformat()})
            return FakeResponse(payload=[{"name": name, "id": None} for name in sorted(folders)] + names)
        if method == "POST" and path.startswith("sign/hhc/"):
            key = path.removeprefix("sign/hhc/")
            return FakeResponse(payload={"signedURL": f"/object/sign/hhc/{key}?token=t"}) if key in self.objects else FakeResponse(400)
        if method == "POST" and path.startswith("upload/sign/hhc/"):
            return FakeResponse(payload={"url": f"/object/upload/sign/hhc/{path.removeprefix('upload/sign/hhc/')}?token=t"})
        if method == "DELETE" and path == "hhc":
            for key in kwargs["json"]["prefixes"]:
                self.objects.pop(key, None)
            return FakeResponse(payload=[])
        key = path.removeprefix("hhc/")
        if method == "POST":
            self.objects[key] = (kwargs["data"].read(), datetime.now(timezone.utc))
            return FakeResponse(payload={"Key": key})
        if method in {"GET", "HEAD"}:
            return FakeResponse(content=self.objects[key][0]) if key in self.objects else FakeResponse(400)
        raise AssertionError(f"Unexpected storage call {method} {url}")

    def put(self, key: str, content: bytes, created: datetime | None = None):
        """What a browser does with a signed upload link."""
        self.objects[key] = (content, created or datetime.now(timezone.utc))


@pytest.fixture()
def remote(tmp_path, monkeypatch):
    settings = get_settings()
    media, outputs = tmp_path / "media", tmp_path / "outputs"
    for name, value in {"storage_backend": "supabase", "supabase_url": "https://project.supabase.co", "supabase_service_key": "service",
            "media_dir": str(media), "output_dir": str(outputs)}.items():
        monkeypatch.setattr(settings, name, value)
    storage.get_storage.cache_clear()
    bucket = FakeBucket()
    store = storage.get_storage()
    monkeypatch.setattr(store, "_request", bucket)
    yield SimpleNamespace(bucket=bucket, store=store, media=media, outputs=outputs, tmp=tmp_path)
    storage.get_storage.cache_clear()


def jpeg(color: str, size=(640, 900)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "JPEG")
    return output.getvalue()


def fresh_instance(remote):
    """A new serverless instance starts with an empty cache."""
    shutil.rmtree(remote.media, ignore_errors=True)
    shutil.rmtree(remote.outputs, ignore_errors=True)


def test_files_written_on_one_instance_are_readable_on_another(remote):
    path, _ = store_editor_image(jpeg("#804060"), str(remote.media), "upload-abcdef12")
    assert "media/editor/upload-abcdef12.webp" in remote.bucket.objects
    static = remote.tmp / "static"
    static.mkdir()
    case = SimpleNamespace(id="remote", celebrity="C", designer="D", event_name="E", event_date="2026-10-22", base_image=path,
        permalink="https://example.com/p", extraction={"collage_assets": []})
    image_path, manifest_path, bundle_path = render_bundle(str(remote.outputs), str(static), case, [],
        SimpleNamespace(id="d", decision="approved", reason="r"), media_dir=str(remote.media), panel_ids=["current-primary"])
    keys = {key for key in remote.bucket.objects if key.startswith("outputs/case-remote/")}
    assert {key.rsplit("/", 1)[1] for key in keys} == {"collage.webp", "collage-base.webp", "collage-source.webp", "manifest.json", "sources.md"}

    fresh_instance(remote)
    assert remote.store.exists(image_path)
    assert automation._local_media_path(path, str(remote.media)) is not None
    assert bundle_archive(bundle_path)[:2] == b"PK"
    assert bundle_download_url(bundle_path).startswith(f"{BASE}/object/sign/hhc/outputs/case-remote/")
    assert any(key.endswith("/bundle.zip") for key in remote.bucket.objects)
    fresh_instance(remote)
    assert remote.store.ensure(manifest_path)
    assert json.loads(open(manifest_path, encoding="utf-8").read())["case_id"] == "remote"

    remote.store.delete_tree(remote.outputs / "case-remote")
    assert not any(key.startswith("outputs/case-remote/") for key in remote.bucket.objects)
    assert not remote.store.exists(image_path)


def test_signed_urls_only_cover_the_media_and_output_folders(remote):
    store_editor_image(jpeg("#406080"), str(remote.media), "upload-12345678")
    assert remote.store.signed_url(remote.media / "editor" / "upload-12345678.webp") == f"{BASE}/object/sign/hhc/media/editor/upload-12345678.webp?token=t"
    assert remote.store.signed_url(remote.tmp / "elsewhere.webp") is None
    assert remote.store.key(remote.media / ".." / "secret.txt") is None


def test_staged_upload_is_read_once_and_stale_uploads_are_cleaned(remote):
    (target,) = remote.store.upload_targets(1)
    assert target["url"].startswith(f"{BASE}/object/upload/sign/hhc/incoming/")
    remote.bucket.put(target["key"], jpeg("#608040"))
    (upload,) = staged_uploads(json.dumps([target["key"]]), json.dumps(["look.jpg"]))
    assert upload.filename == "look.jpg"
    content = asyncio.run(upload.read(20 * 1024 * 1024 + 1))
    assert content[:2] == b"\xff\xd8" and target["key"] not in remote.bucket.objects
    with pytest.raises(Exception):
        asyncio.run(StagedUpload("media/editor/not-an-upload.webp").read())

    remote.bucket.put("incoming/" + "a" * 32, b"old", datetime.now(timezone.utc) - timedelta(days=2))
    remote.bucket.put("incoming/" + "b" * 32, b"new")
    assert remote.store.delete_stale_incoming() == 1
    assert set(remote.bucket.objects) == {"incoming/" + "b" * 32}


def test_downloaded_photo_already_in_the_bucket_is_not_fetched_again(remote, monkeypatch):
    from app import public_sources
    url = "https://i.redd.it/look.jpg"
    monkeypatch.setattr(public_sources, "_fetch_limited", lambda *args, **kwargs: (url, jpeg("#902030"), "image/jpeg"))
    first = automation._download_image(url, str(remote.media), "agent")
    assert first.endswith(".webp") and f"media{first.removeprefix('/media-files')}" in remote.bucket.objects
    fresh_instance(remote)
    monkeypatch.setattr(public_sources, "_fetch_limited", lambda *args, **kwargs: pytest.fail("photo should come from the bucket"))
    assert automation._download_image(url, str(remote.media), "agent") == first
