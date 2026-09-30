from __future__ import annotations

import io
import re
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_WATERMARK_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_OUTPUT_EDGE = 6000
MIN_IMAGE_EDGE = 320
MAX_WATERMARK_PIXELS = 16_000_000
MAX_WATERMARK_EDGE = 4096
MIN_WATERMARK_EDGE = 16
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}


class UploadValidationError(ValueError):
    pass


def store_editor_image(content: bytes, media_dir: str, file_key: str) -> tuple[str, dict]:
    """Validate and atomically store an editor-provided image as high-quality WebP."""
    if not content:
        raise UploadValidationError("Choose an image to upload")
    if len(content) > MAX_UPLOAD_BYTES:
        raise UploadValidationError("Image must be 20 MB or smaller")
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", file_key):
        raise UploadValidationError("Invalid upload identifier")

    destination_dir = Path(media_dir) / "editor"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{file_key}.webp"
    temporary = destination_dir / f".{file_key}.tmp.webp"
    try:
        with Image.open(io.BytesIO(content)) as source:
            image_format = (source.format or "").upper()
            if image_format not in ALLOWED_FORMATS:
                raise UploadValidationError("Upload a JPEG, PNG, or WebP image")
            if getattr(source, "n_frames", 1) != 1:
                raise UploadValidationError("Animated images are not supported")
            source.load()
            image = ImageOps.exif_transpose(source)
            width, height = image.size
            if width < MIN_IMAGE_EDGE or height < MIN_IMAGE_EDGE:
                raise UploadValidationError("Image must be at least 320 px on both sides")
            if width * height > MAX_IMAGE_PIXELS:
                raise UploadValidationError("Image dimensions are too large")
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            if max(image.size) > MAX_OUTPUT_EDGE:
                image.thumbnail((MAX_OUTPUT_EDGE, MAX_OUTPUT_EDGE), Image.Resampling.LANCZOS)
            output_width, output_height = image.size
            image.save(temporary, "WEBP", quality=95, method=6, lossless=image.mode == "RGBA")
            image.close()
        temporary.replace(destination)
    except UploadValidationError:
        temporary.unlink(missing_ok=True)
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        temporary.unlink(missing_ok=True)
        raise UploadValidationError("The uploaded file is not a valid, readable image") from exc

    return (
        f"/media-files/editor/{destination.name}",
        {
            "input_format": image_format,
            "input_bytes": len(content),
            "input_width": width,
            "input_height": height,
            "output_width": output_width,
            "output_height": output_height,
        },
    )


def store_watermark_image(content: bytes, media_dir: str, file_key: str) -> tuple[str, dict]:
    """Validate and store a brand mark while preserving its alpha channel."""
    if not content:
        raise UploadValidationError("Choose a watermark image to upload")
    if len(content) > MAX_WATERMARK_UPLOAD_BYTES:
        raise UploadValidationError("Watermark image must be 8 MB or smaller")
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", file_key):
        raise UploadValidationError("Invalid watermark upload identifier")

    destination_dir = Path(media_dir) / "watermarks"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{file_key}.webp"
    temporary = destination_dir / f".{file_key}.tmp.webp"
    try:
        with Image.open(io.BytesIO(content)) as source:
            image_format = (source.format or "").upper()
            if image_format not in ALLOWED_FORMATS:
                raise UploadValidationError("Upload a PNG, WebP, or JPEG watermark")
            if getattr(source, "n_frames", 1) != 1:
                raise UploadValidationError("Animated watermark images are not supported")
            width, height = source.size
            if width < MIN_WATERMARK_EDGE or height < MIN_WATERMARK_EDGE:
                raise UploadValidationError("Watermark must be at least 16 px on both sides")
            if width * height > MAX_WATERMARK_PIXELS:
                raise UploadValidationError("Watermark dimensions are too large")
            # Reject decompression bombs from header dimensions before Pillow
            # allocates the full decoded bitmap.
            source.load()
            transposed = ImageOps.exif_transpose(source)
            width, height = transposed.size
            has_transparency = "A" in transposed.getbands() or "transparency" in source.info
            image = transposed.convert("RGBA")
            if max(image.size) > MAX_WATERMARK_EDGE:
                image.thumbnail((MAX_WATERMARK_EDGE, MAX_WATERMARK_EDGE), Image.Resampling.LANCZOS)
            output_width, output_height = image.size
            image.save(temporary, "WEBP", lossless=True, method=6)
            image.close()
        temporary.replace(destination)
    except UploadValidationError:
        temporary.unlink(missing_ok=True)
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        temporary.unlink(missing_ok=True)
        raise UploadValidationError("The uploaded watermark is not a valid, readable image") from exc

    return (
        f"/media-files/watermarks/{destination.name}",
        {
            "input_format": image_format,
            "input_bytes": len(content),
            "input_width": width,
            "input_height": height,
            "output_width": output_width,
            "output_height": output_height,
            "has_transparency": has_transparency,
        },
    )
