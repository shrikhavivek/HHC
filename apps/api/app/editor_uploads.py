from __future__ import annotations

import io
import re
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_OUTPUT_EDGE = 6000
MIN_IMAGE_EDGE = 320
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
