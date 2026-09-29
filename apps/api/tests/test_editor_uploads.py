import io

import pytest
from PIL import Image

from app.editor_uploads import UploadValidationError, store_editor_image


def _jpeg(width=1200, height=1800):
    stream = io.BytesIO()
    Image.new("RGB", (width, height), "#7c1738").save(stream, "JPEG", quality=96)
    return stream.getvalue()


def test_editor_upload_preserves_normal_full_resolution_image(tmp_path):
    image_path, metadata = store_editor_image(_jpeg(), str(tmp_path), "upload-12345678")
    assert image_path == "/media-files/editor/upload-12345678.webp"
    assert metadata["output_width"] == 1200
    assert metadata["output_height"] == 1800
    with Image.open(tmp_path / "editor" / "upload-12345678.webp") as stored:
        assert stored.size == (1200, 1800)


def test_editor_upload_rejects_invalid_or_tiny_files(tmp_path):
    with pytest.raises(UploadValidationError):
        store_editor_image(b"not an image", str(tmp_path), "upload-12345678")
    with pytest.raises(UploadValidationError, match="at least 320"):
        store_editor_image(_jpeg(200, 400), str(tmp_path), "upload-87654321")
