from __future__ import annotations

import hashlib
import html
import io
import ipaddress
import json
import re
import socket
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup
from PIL import Image, UnidentifiedImageError


MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_SOURCE_PIXELS = 40_000_000
MIN_SOURCE_EDGE = 320
MAX_SOURCE_IMAGES = 20
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
IMAGE_FORMAT_EXTENSIONS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}
DEFAULT_ALLOWED_DOMAINS = {
    "instagram.com",
    "threads.net",
    "facebook.com",
    "fb.watch",
    "x.com",
    "twitter.com",
    "t.co",
    "pinterest.com",
    "pin.it",
    "tiktok.com",
    "youtube.com",
    "youtu.be",
    "reddit.com",
}


class PublicSourceError(ValueError):
    pass


class DuplicatePublicSourceError(PublicSourceError):
    pass


def allowed_domain_set(value: str | None) -> set[str]:
    configured = {
        item.strip().casefold().lstrip(".")
        for item in (value or "").split(",")
        if item.strip()
    }
    return configured or set(DEFAULT_ALLOWED_DOMAINS)


def _domain_allowed(host: str, allowed_domains: set[str]) -> bool:
    normalized = host.casefold().rstrip(".")
    return any(normalized == domain or normalized.endswith(f".{domain}") for domain in allowed_domains)


def _public_addresses(host: str, port: int) -> list[str]:
    try:
        records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise PublicSourceError("The source hostname could not be resolved") from exc
    addresses = sorted({record[4][0] for record in records})
    if not addresses:
        raise PublicSourceError("The source hostname did not resolve to an address")
    for value in addresses:
        try:
            address = ipaddress.ip_address(value.split("%", 1)[0])
        except ValueError as exc:
            raise PublicSourceError("The source resolved to an invalid address") from exc
        if not address.is_global:
            raise PublicSourceError("Private or local network URLs cannot be imported")
    return addresses


def _validated_url(raw_url: str, *, allowed_domains: set[str] | None, source_document: bool) -> str:
    parsed = urlsplit(raw_url.strip())
    if parsed.scheme not in ({"https"} if source_document else {"http", "https"}):
        raise PublicSourceError("Use a public HTTPS post URL" if source_document else "The source image URL is not public HTTP(S)")
    if parsed.username or parsed.password:
        raise PublicSourceError("URLs containing credentials cannot be imported")
    host = (parsed.hostname or "").casefold().rstrip(".")
    if not host:
        raise PublicSourceError("The source URL is missing a hostname")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise PublicSourceError("The source URL contains an invalid port") from exc
    if port not in {80, 443}:
        raise PublicSourceError("Only standard public web ports are supported")
    if allowed_domains is not None and not _domain_allowed(host, allowed_domains):
        supported = ", ".join(sorted(allowed_domains))
        raise PublicSourceError(f"This source is not enabled. Supported domains: {supported}")
    _public_addresses(host, port)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


def _fetch_limited(
    raw_url: str,
    *,
    user_agent: str,
    allowed_domains: set[str] | None,
    source_document: bool,
    maximum_bytes: int,
    accept: str,
    referer: str | None = None,
) -> tuple[str, bytes, str]:
    url = raw_url
    for _ in range(5):
        url = _validated_url(url, allowed_domains=allowed_domains, source_document=source_document)
        headers = {"User-Agent": user_agent, "Accept": accept}
        if referer:
            headers["Referer"] = referer
        try:
            with requests.get(url, headers=headers, timeout=25, stream=True, allow_redirects=False) as response:
                if response.status_code in REDIRECT_STATUSES:
                    location = response.headers.get("Location")
                    if not location:
                        raise PublicSourceError("The source returned an invalid redirect")
                    url = urljoin(url, location)
                    continue
                if response.status_code in {401, 403}:
                    raise PublicSourceError("This post requires sign-in or does not expose public media")
                if response.status_code == 404:
                    raise PublicSourceError("The public post could not be found")
                if response.status_code == 429:
                    raise PublicSourceError("The source is temporarily rate-limiting imports; try again later")
                response.raise_for_status()
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > maximum_bytes:
                    raise PublicSourceError("The source response is too large to import safely")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_content(64 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > maximum_bytes:
                        raise PublicSourceError("The source response is too large to import safely")
                    chunks.append(chunk)
                return url, b"".join(chunks), response.headers.get("Content-Type", "").split(";", 1)[0].casefold()
        except PublicSourceError:
            raise
        except requests.RequestException as exc:
            raise PublicSourceError("The public source could not be reached") from exc
    raise PublicSourceError("The source redirected too many times")


def _platform_for_host(host: str) -> str:
    host = host.casefold()
    if host.endswith("instagram.com"):
        return "Instagram"
    if host.endswith("threads.net"):
        return "Threads"
    if host.endswith("facebook.com") or host == "fb.watch":
        return "Facebook"
    if host.endswith("x.com") or host.endswith("twitter.com") or host == "t.co":
        return "X / Twitter"
    if host.endswith("pinterest.com") or host == "pin.it":
        return "Pinterest"
    if host.endswith("tiktok.com"):
        return "TikTok"
    if host.endswith("youtube.com") or host == "youtu.be":
        return "YouTube"
    if host.endswith("reddit.com"):
        return "Reddit"
    return host


def _clean_text(value: str | None, maximum: int) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()[:maximum]


def _largest_srcset(value: str) -> str | None:
    choices: list[tuple[int, str]] = []
    for item in value.split(","):
        bits = item.strip().split()
        if not bits:
            continue
        try:
            width = int(bits[1].rstrip("w")) if len(bits) > 1 else 0
        except ValueError:
            width = 0
        choices.append((width, bits[0]))
    return max(choices)[1] if choices else None


def _image_url(value: object, base_url: str) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = html.unescape(value).replace("\\u0026", "&").replace("\\/", "/").strip()
    candidate = urljoin(base_url, cleaned)
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    lowered = candidate.casefold()
    if any(marker in lowered for marker in ("favicon", "sprite", "emoji", "profile_pic", "avatar", "logo")):
        return None
    return candidate


def _structured_images(value: object, found: list[str]) -> None:
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            _structured_images(item, found)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key.casefold() in {"url", "contenturl", "thumbnailurl"} and isinstance(item, str):
                found.append(item)
            elif isinstance(item, (dict, list)):
                _structured_images(item, found)


def _structured_authors(value: object, found: list[str]) -> None:
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            _structured_authors(item, found)
    elif isinstance(value, dict):
        name = value.get("name")
        if isinstance(name, str):
            found.append(name)


def _json_ld_values(value: object, found: dict[str, list[str]]) -> None:
    if isinstance(value, list):
        for item in value:
            _json_ld_values(item, found)
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        normalized = key.casefold()
        if normalized in {"image", "thumbnailurl", "contenturl"}:
            _structured_images(item, found["images"])
        elif normalized in {"headline", "name"} and isinstance(item, str):
            found["titles"].append(item)
        elif normalized in {"description", "caption", "articlebody"} and isinstance(item, str):
            found["descriptions"].append(item)
        elif normalized in {"datepublished", "uploaddate"} and isinstance(item, str):
            found["dates"].append(item)
        elif normalized == "author":
            _structured_authors(item, found["authors"])
        elif isinstance(item, (dict, list)):
            _json_ld_values(item, found)


def extract_public_metadata(markup: str, base_url: str) -> dict:
    """Extract only media and descriptive metadata publicly exposed by a post page."""
    soup = BeautifulSoup(markup, "html.parser")
    parsed_base = urlsplit(base_url)
    base_host = (parsed_base.hostname or "").casefold()
    is_instagram = base_host == "instagram.com" or base_host.endswith(".instagram.com")
    is_instagram_embed = is_instagram and "/embed" in parsed_base.path.casefold()
    meta: dict[str, list[str]] = {}
    for tag in soup.find_all("meta"):
        key = str(tag.get("property") or tag.get("name") or tag.get("itemprop") or "").casefold().strip()
        content = str(tag.get("content") or "").strip()
        if key and content:
            meta.setdefault(key, []).append(content)

    structured = {"images": [], "titles": [], "descriptions": [], "dates": [], "authors": []}
    for script in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        try:
            _json_ld_values(json.loads(script.get_text("", strip=True)), structured)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue

    title_candidates = [
        *meta.get("og:title", []),
        *meta.get("twitter:title", []),
        *structured["titles"],
        soup.title.get_text(" ", strip=True) if soup.title else "",
    ]
    description_candidates = [
        *meta.get("og:description", []),
        *meta.get("twitter:description", []),
        *meta.get("description", []),
        *structured["descriptions"],
    ]
    author_candidates = [
        *meta.get("author", []),
        *meta.get("twitter:creator", []),
        *structured["authors"],
    ]
    publisher_candidates = [*meta.get("og:site_name", []), *meta.get("application-name", [])]
    date_candidates = [
        *meta.get("article:published_time", []),
        *meta.get("datepublished", []),
        *structured["dates"],
    ]

    embedded_media: list[str] = []
    if is_instagram_embed:
        for image in soup.select("img.EmbeddedMediaImage"):
            candidate = _largest_srcset(str(image.get("srcset") or "")) or image.get("data-src") or image.get("src")
            if candidate:
                embedded_media.append(str(candidate))

    if embedded_media:
        # Instagram's embed marks the actual post media with this class. Other
        # images on the document can be profile photos, recommendations, or UI.
        raw_images = embedded_media
    else:
        raw_images = [
            *meta.get("og:image:secure_url", []),
            *meta.get("og:image", []),
            *meta.get("twitter:image", []),
            *meta.get("twitter:image:src", []),
            *([] if is_instagram else structured["images"]),
        ]

    if not is_instagram:
        for link in soup.find_all("link", href=True):
            relation = " ".join(link.get("rel", [])).casefold()
            if relation in {"image_src", "preload"} and (relation == "image_src" or link.get("as") == "image"):
                raw_images.append(link["href"])

    if not raw_images and not is_instagram:
        for image in soup.find_all("img"):
            candidate = _largest_srcset(str(image.get("srcset") or "")) or image.get("data-src") or image.get("src")
            width = str(image.get("width") or "")
            height = str(image.get("height") or "")
            editorial_size = width.isdigit() and height.isdigit() and int(width) >= MIN_SOURCE_EDGE and int(height) >= MIN_SOURCE_EDGE
            if candidate and (editorial_size or image.get("srcset")):
                raw_images.append(str(candidate))

    images: list[str] = []
    seen: set[str] = set()
    for raw in raw_images:
        candidate = _image_url(raw, base_url)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        images.append(candidate)
        if len(images) >= MAX_SOURCE_IMAGES:
            break

    return {
        "title": next((_clean_text(item, 500) for item in title_candidates if _clean_text(item, 500)), ""),
        "description": next((_clean_text(item, 5000) for item in description_candidates if _clean_text(item, 5000)), ""),
        "author": next((_clean_text(item, 180).lstrip("@") for item in author_candidates if _clean_text(item, 180)), ""),
        "publisher": next((_clean_text(item, 180) for item in publisher_candidates if _clean_text(item, 180)), ""),
        "published": next((_clean_text(item, 80) for item in date_candidates if _clean_text(item, 80)), ""),
        "image_urls": images,
    }


def _instagram_embed_url(url: str) -> str | None:
    parsed = urlsplit(url)
    match = re.match(r"^/(?:p|reel|tv)/([^/]+)/?", parsed.path, re.I)
    if not match:
        return None
    return f"https://www.instagram.com/{parsed.path.strip('/')}/embed/captioned/"


def _merge_metadata(items: list[dict]) -> dict:
    merged = {"title": "", "description": "", "author": "", "publisher": "", "published": "", "image_urls": []}
    seen: set[str] = set()
    for item in items:
        for key in ("title", "description", "author", "publisher", "published"):
            if not merged[key] and item.get(key):
                merged[key] = item[key]
        for image_url in item.get("image_urls", []):
            if image_url not in seen:
                seen.add(image_url)
                merged["image_urls"].append(image_url)
    merged["image_urls"] = merged["image_urls"][:MAX_SOURCE_IMAGES]
    return merged


def inspect_public_post(raw_url: str, *, user_agent: str, allowed_domains: str | None = None) -> dict:
    domains = allowed_domain_set(allowed_domains)
    original_url = _validated_url(raw_url, allowed_domains=domains, source_document=True)
    platform = _platform_for_host(urlsplit(original_url).hostname or "")
    documents: list[dict] = []
    instagram_embed_metadata: dict | None = None
    errors: list[PublicSourceError] = []

    try:
        final_url, content, content_type = _fetch_limited(
            original_url,
            user_agent=user_agent,
            allowed_domains=domains,
            source_document=True,
            maximum_bytes=MAX_DOCUMENT_BYTES,
            accept="text/html,application/xhtml+xml,image/*;q=0.7",
        )
        if content_type.startswith("image/"):
            documents.append({"title": "", "description": "", "author": "", "publisher": platform, "published": "", "image_urls": [final_url]})
        else:
            documents.append(extract_public_metadata(content.decode("utf-8", "replace"), final_url))
    except PublicSourceError as exc:
        errors.append(exc)

    embed_url = _instagram_embed_url(original_url) if platform == "Instagram" else None
    if embed_url:
        try:
            final_embed_url, embed_content, _ = _fetch_limited(
                embed_url,
                user_agent=user_agent,
                allowed_domains=domains,
                source_document=True,
                maximum_bytes=MAX_DOCUMENT_BYTES,
                accept="text/html,application/xhtml+xml",
                referer=original_url,
            )
            instagram_embed_metadata = extract_public_metadata(embed_content.decode("utf-8", "replace"), final_embed_url)
            documents.append(instagram_embed_metadata)
        except PublicSourceError as exc:
            errors.append(exc)

    if not documents:
        raise errors[0] if errors else PublicSourceError("The public post could not be inspected")
    metadata = _merge_metadata(documents)
    if instagram_embed_metadata and instagram_embed_metadata.get("image_urls"):
        # Prefer the post-specific embed media over the main page's Open Graph
        # cover so signed URL variants do not become duplicate collage panels.
        metadata["image_urls"] = instagram_embed_metadata["image_urls"][:MAX_SOURCE_IMAGES]
    if not metadata["image_urls"]:
        raise PublicSourceError("No public post image was exposed. Private, login-gated, or video-only posts cannot be imported automatically")
    publisher = metadata["publisher"] or platform
    if metadata["author"]:
        publisher = f"{publisher} (@{metadata['author']})"
    return {
        **metadata,
        "title": metadata["title"] or f"{platform} fashion post",
        "publisher": publisher,
        "platform": platform,
        "permalink": original_url,
        "post_id": hashlib.sha256(original_url.encode("utf-8")).hexdigest()[:32],
    }


def _existing_image(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
        return width >= MIN_SOURCE_EDGE and height >= MIN_SOURCE_EDGE
    except (OSError, ValueError, UnidentifiedImageError):
        return False


def download_public_images(
    image_urls: list[str],
    *,
    media_dir: str,
    user_agent: str,
    referer: str,
) -> tuple[list[str], list[str], list[Path]]:
    destination_dir = Path(media_dir) / "imports"
    destination_dir.mkdir(parents=True, exist_ok=True)
    valid_urls: list[str] = []
    local_paths: list[str] = []
    created_files: list[Path] = []
    for image_url in image_urls[:MAX_SOURCE_IMAGES]:
        temporary: Path | None = None
        digest = hashlib.sha256(image_url.encode("utf-8")).hexdigest()[:24]
        existing = next((path for path in destination_dir.glob(f"{digest}.*") if _existing_image(path)), None)
        if existing:
            valid_urls.append(image_url)
            local_paths.append(f"/media-files/imports/{existing.name}")
            continue
        try:
            _, content, _ = _fetch_limited(
                image_url,
                user_agent=user_agent,
                allowed_domains=None,
                source_document=False,
                maximum_bytes=MAX_IMAGE_BYTES,
                accept="image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2",
                referer=referer,
            )
            with Image.open(io.BytesIO(content)) as probe:
                width, height = probe.size
                image_format = (probe.format or "").upper()
                if width < MIN_SOURCE_EDGE or height < MIN_SOURCE_EDGE:
                    continue
                if width * height > MAX_SOURCE_PIXELS:
                    continue
                if image_format not in IMAGE_FORMAT_EXTENSIONS or getattr(probe, "n_frames", 1) != 1:
                    continue
                probe.verify()
            destination = destination_dir / f"{digest}{IMAGE_FORMAT_EXTENSIONS[image_format]}"
            temporary = destination_dir / f".{digest}.tmp"
            temporary.write_bytes(content)
            temporary.replace(destination)
            valid_urls.append(image_url)
            local_paths.append(f"/media-files/imports/{destination.name}")
            created_files.append(destination)
        except (PublicSourceError, OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
            if temporary:
                temporary.unlink(missing_ok=True)
            continue
    return valid_urls, local_paths, created_files


def normalized_published_date(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip()
    try:
        parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        return parsed.date().isoformat()
    except ValueError:
        match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", cleaned)
        return match.group(1) if match else None
