import json
import math
import zipfile
import uuid
import io
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

from .assets import build_render_assets
from .storage import get_storage
from .photo_controls import prepare_photo, caption_panel


PALETTES = [
    ("#13131a", "#7357ff", "#ff796d"), ("#17120f", "#d99d64", "#f4dfc4"),
    ("#101818", "#1e847f", "#bbf0db"), ("#17131c", "#b6508a", "#f2b8da"),
    ("#111522", "#466bd7", "#c4d5ff"), ("#191612", "#a8864d", "#efe2bd"),
]
INSTAGRAM_CANVAS_FORMATS = {
    "instagram_portrait": {"width": 1080, "height": 1350, "label": "Instagram portrait", "ratio": "4:5"},
    "instagram_landscape": {"width": 1080, "height": 566, "label": "Instagram landscape", "ratio": "1.91:1"},
}
COLLAGE_LAYOUT_TEMPLATES = {"balanced_grid", "hero_focus", "editorial_split", "side_by_side"}

def _font(size: int, bold: bool = False):
    path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


BUNDLE_NAME = "bundle.zip"
# A lossless copy is several times the WebP size; pixel-exact tests turn it on.
WRITE_LOSSLESS_PNG = False
BUNDLE_FILES = ["collage.webp", "collage.png", "collage-source.webp", "manifest.json", "sources.md"]


def bundle_archive(bundle_path: str) -> bytes | None:
    """Zip a render's files for download; older renders may still have a stored ZIP."""
    storage = get_storage()
    path = Path(bundle_path)
    if storage.ensure(path):
        return path.read_bytes()
    version_dir = path.parent
    if not storage.ensure(version_dir / "manifest.json"):
        return None
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in BUNDLE_FILES:
            if (name == "collage.png" and not (version_dir / name).is_file()) or not storage.ensure(version_dir / name):
                continue
            archive.write(version_dir / name, arcname=name)
    return output.getvalue()


def bundle_download_url(bundle_path: str) -> str | None:
    """Remote storage: keep the ZIP beside its render and hand out a signed link.

    Serverless responses are capped at 4.5 MB, so large ZIPs cannot be streamed.
    """
    storage = get_storage()
    path = Path(bundle_path)
    if not storage.exists(path):
        content = bundle_archive(bundle_path)
        if content is None:
            return None
        path.write_bytes(content)
        storage.saved(path)
    return storage.signed_url(path)


def render_urls(image_path: str, output_dir: str, case_id: str) -> dict:
    """Preview links for one render, served from its own version folder."""
    version_dir = Path(image_path).resolve().parent
    relative_dir = version_dir.relative_to(Path(output_dir).resolve()).as_posix()
    preview_url = f"/outputs/{relative_dir}/collage.webp"
    # Every render writes both previews; only old local renders may lack them.
    present = (lambda name: True) if get_storage().remote else (lambda name: (version_dir / name).is_file())
    base_preview_url = f"/outputs/{relative_dir}/collage-base.webp" if present("collage-base.webp") else preview_url
    source_preview_url = f"/outputs/{relative_dir}/collage-source.webp" if present("collage-source.webp") else base_preview_url
    return {"preview_url": preview_url, "base_preview_url": base_preview_url, "source_preview_url": source_preview_url, "bundle_url": f"/api/cases/{case_id}/bundle"}


def ensure_demo_images(static_dir: str):
    Path(static_dir).mkdir(parents=True, exist_ok=True)
    for index, palette in enumerate(PALETTES, start=1):
        path = Path(static_dir) / f"look-{index}.png"
        if path.exists():
            continue
        bg, accent, light = palette
        image = Image.new("RGB", (900, 1200), bg)
        draw = ImageDraw.Draw(image)
        for y in range(1200):
            ratio = y / 1200
            base = tuple(int(bg.lstrip("#")[i:i+2], 16) for i in (0, 2, 4))
            hi = tuple(int(accent.lstrip("#")[i:i+2], 16) for i in (0, 2, 4))
            color = tuple(int(base[c] * (1-ratio*.45) + hi[c] * ratio*.45) for c in range(3))
            draw.line((0, y, 900, y), fill=color)
        draw.ellipse((280, 105, 620, 445), fill=light)
        draw.rounded_rectangle((220, 390, 680, 1060), radius=190, fill=accent)
        draw.polygon([(450, 420), (185, 1080), (715, 1080)], fill=light)
        draw.text((42, 45), f"EDITORIAL STUDY  0{index}", fill="#ffffff", font=_font(22, True))
        draw.text((42, 1135), "DEMO ASSET - NOT SOURCE EVIDENCE", fill="#ffffff", font=_font(18))
        image.save(path, quality=94)


def _open_local_asset(static_dir: str, image_path: str, media_dir: str | None = None) -> Image.Image:
    """Open only media imported into an explicitly configured local root."""
    normalized = image_path.replace("\\", "/")
    if normalized.startswith("/media-files/") and media_dir:
        root = Path(media_dir).resolve()
        relative = normalized.removeprefix("/media-files/")
    elif normalized.startswith("/static/"):
        root = Path(static_dir).resolve()
        relative = normalized.removeprefix("/static/")
    else:
        root = Path(static_dir).resolve()
        relative = Path(normalized).name
    path = (root / relative).resolve()
    if root not in path.parents and path != root:
        raise FileNotFoundError(f"Collage asset path is not allowed: {image_path}")
    if not (path.is_file() if root == Path(static_dir).resolve() else get_storage().ensure(path)):
        raise FileNotFoundError(f"Collage asset has not been imported: {image_path}")
    return Image.open(path)


def _row_sizes(count: int) -> list[int]:
    """Split panels into balanced rows for a full-bleed justified mosaic."""
    if count <= 3:
        return [count]
    if count == 4:
        columns = 2
    elif count <= 6:
        columns = 3
    elif count <= 8:
        columns = 4
    elif count == 9:
        columns = 3
    elif count <= 16:
        columns = 4
    else:
        columns = 5
    row_count = (count + columns - 1) // columns
    base, remainder = divmod(count, row_count)
    return [base + (1 if index < remainder else 0) for index in range(row_count)]


def _justified_geometry(
    images: list[Image.Image],
    canvas_width: int,
    width_scales: list[float] | None = None,
    aspect_ratios: list[float] | None = None,
) -> list[list[tuple[int, int]]]:
    """Return exact edge-to-edge panel sizes without cropping any image."""
    geometry: list[list[tuple[int, int]]] = []
    cursor = 0
    scales = width_scales or [1.0] * len(images)
    source_ratios = aspect_ratios or [image.width / max(1, image.height) for image in images]
    for row_size in _row_sizes(len(images)):
        row_scales = scales[cursor:cursor + row_size]
        row_ratios = source_ratios[cursor:cursor + row_size]
        ratios = [
            ratio * max(0.65, min(1.75, scale))
            for ratio, scale in zip(row_ratios, row_scales)
        ]
        row_height = max(1, round(canvas_width / sum(ratios)))
        widths = [max(1, round(row_height * ratio)) for ratio in ratios]
        widths[-1] += canvas_width - sum(widths)
        geometry.append([(width, row_height) for width in widths])
        cursor += row_size
    return geometry


def _weighted_sizes(total: int, weights: list[float]) -> list[int]:
    """Divide one axis exactly, using editor panel-size weights."""
    if not weights:
        return []
    safe = [max(0.2, float(weight)) for weight in weights]
    scale = total / sum(safe)
    sizes = [max(1, round(weight * scale)) for weight in safe]
    sizes[-1] += total - sum(sizes)
    return sizes


def _grid_geometry_in_box(
    count: int,
    box: tuple[int, int, int, int],
    weights: list[float],
    columns: int,
) -> list[tuple[int, int, int, int]]:
    if count <= 0:
        return []
    x0, y0, box_width, box_height = box
    columns = max(1, min(columns, count))
    row_counts: list[int] = []
    remaining = count
    while remaining:
        row_count = min(columns, remaining)
        row_counts.append(row_count)
        remaining -= row_count
    row_heights = _weighted_sizes(box_height, [1.0] * len(row_counts))
    geometry: list[tuple[int, int, int, int]] = []
    cursor = 0
    y = y0
    for row_count, row_height in zip(row_counts, row_heights):
        row_weights = weights[cursor:cursor + row_count]
        widths = _weighted_sizes(box_width, row_weights)
        x = x0
        for width in widths:
            geometry.append((x, y, width, row_height))
            x += width
        cursor += row_count
        y += row_height
    return geometry


def _balanced_grid_geometry(
    count: int,
    width: int,
    height: int,
    weights: list[float],
    canvas_format: str,
) -> list[tuple[int, int, int, int]]:
    if count <= 1:
        return [(0, 0, width, height)]
    if canvas_format == "instagram_portrait":
        columns = 2 if count <= 6 else 3 if count <= 12 else 4
    else:
        columns = min(count, 3 if count <= 6 else 4 if count <= 12 else 6)
    return _grid_geometry_in_box(count, (0, 0, width, height), weights, columns)


def _hero_focus_geometry(
    count: int,
    width: int,
    height: int,
    weights: list[float],
    canvas_format: str,
) -> list[tuple[int, int, int, int]]:
    if count <= 1:
        return [(0, 0, width, height)]
    hero_fraction = max(0.45, min(0.72, 0.58 * weights[0]))
    if canvas_format == "instagram_portrait":
        hero_height = round(height * hero_fraction)
        supporting = _grid_geometry_in_box(
            count - 1,
            (0, hero_height, width, height - hero_height),
            weights[1:],
            min(3, count - 1),
        )
        return [(0, 0, width, hero_height), *supporting]
    hero_width = round(width * hero_fraction)
    supporting_columns = 1 if count <= 4 else 2
    supporting = _grid_geometry_in_box(
        count - 1,
        (hero_width, 0, width - hero_width, height),
        weights[1:],
        supporting_columns,
    )
    return [(0, 0, hero_width, height), *supporting]


def _editorial_split_geometry(
    count: int,
    width: int,
    height: int,
    weights: list[float],
    canvas_format: str,
) -> list[tuple[int, int, int, int]]:
    """Build an asymmetric magazine-style split with no gutters."""
    result: list[tuple[int, int, int, int] | None] = [None] * count

    def place(indices: list[int], box: tuple[int, int, int, int], vertical: bool, depth: int) -> None:
        if len(indices) == 1:
            result[indices[0]] = box
            return
        split_at = (len(indices) + 1) // 2
        first, second = indices[:split_at], indices[split_at:]
        first_weight = sum(weights[index] for index in first)
        total_weight = first_weight + sum(weights[index] for index in second)
        fraction = first_weight / max(0.01, total_weight)
        fraction += 0.07 if depth % 2 == 0 else -0.04
        fraction = max(0.34, min(0.66, fraction))
        x, y, box_width, box_height = box
        if vertical:
            first_width = max(1, min(box_width - 1, round(box_width * fraction)))
            place(first, (x, y, first_width, box_height), False, depth + 1)
            place(second, (x + first_width, y, box_width - first_width, box_height), False, depth + 1)
        else:
            first_height = max(1, min(box_height - 1, round(box_height * fraction)))
            place(first, (x, y, box_width, first_height), True, depth + 1)
            place(second, (x, y + first_height, box_width, box_height - first_height), True, depth + 1)

    place(
        list(range(count)),
        (0, 0, width, height),
        canvas_format == "instagram_portrait",
        0,
    )
    return [item for item in result if item is not None]


def _instagram_geometry(
    count: int,
    width: int,
    height: int,
    weights: list[float],
    canvas_format: str,
    layout_template: str,
) -> list[tuple[int, int, int, int]]:
    if layout_template == "hero_focus":
        return _hero_focus_geometry(count, width, height, weights, canvas_format)
    if layout_template == "editorial_split":
        return _editorial_split_geometry(count, width, height, weights, canvas_format)
    return _balanced_grid_geometry(count, width, height, weights, canvas_format)


def side_by_side_geometry(sizes, export_scale=1):
    scale = export_scale if export_scale in {1, 2, 3} else 1
    ratios = [width / height for width, height in sizes]
    total_ratio = sum(ratios)
    height = max(1, min(4320 * scale, round(1080 * scale / total_ratio)))
    width = max(len(sizes), round(height * total_ratio))
    cells = []
    cumulative = 0.0
    left = 0
    for index, ratio in enumerate(ratios):
        cumulative += ratio
        right = max(left + 1, min(width - len(sizes) + index + 1, round(width * cumulative / total_ratio)))
        cells.append((left, 0, right - left, height))
        left = right
    return width, height, cells


def _bounded_float(value, default: float, lower: float, upper: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if not math.isfinite(number):
        number = default
    return max(lower, min(upper, number))


def _normalized_crop_rect(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    x = _bounded_float(raw.get("x"), 0.0, 0.0, 0.95)
    y = _bounded_float(raw.get("y"), 0.0, 0.0, 0.95)
    width = _bounded_float(raw.get("width"), 1.0 - x, 0.05, 1.0 - x)
    height = _bounded_float(raw.get("height"), 1.0 - y, 0.05, 1.0 - y)
    return {
        "x": round(x, 4),
        "y": round(y, 4),
        "width": round(width, 4),
        "height": round(height, 4),
    }


def _normalized_panel_options(assets: list[dict], raw_options: dict | None) -> dict[str, dict]:
    options = raw_options if isinstance(raw_options, dict) else {}
    normalized: dict[str, dict] = {}
    for asset in assets:
        panel_id = str(asset["id"])
        raw = options.get(panel_id, {}) if isinstance(options.get(panel_id, {}), dict) else {}
        normalized[panel_id] = {
            "width_scale": round(_bounded_float(raw.get("width_scale"), 1.0, 0.65, 1.75), 2),
            "crop_mode": "crop" if raw.get("crop_mode") == "crop" else "fit",
            "focal_x": round(_bounded_float(raw.get("focal_x"), 0.5, 0.0, 1.0), 3),
            "focal_y": round(_bounded_float(raw.get("focal_y"), 0.5, 0.0, 1.0), 3),
            "zoom": round(_bounded_float(raw.get("zoom"), 1.0, 1.0, 2.5), 2),
            "crop_rect": _normalized_crop_rect(raw.get("crop_rect")),
            "rotation_degrees": raw.get("rotation_degrees", 0) if raw.get("rotation_degrees", 0) in {0, 90, 180, 270} else 0,
            "flip_horizontal": bool(raw.get("flip_horizontal", False)),
            "flip_vertical": bool(raw.get("flip_vertical", False)),
            "caption": str(raw.get("caption") or "")[:160],
            "adjustments": _normalized_image_adjustments(raw.get("adjustments")),
        }
    return normalized


def _normalized_image_adjustments(raw_options: dict | None) -> dict:
    options = raw_options if isinstance(raw_options, dict) else {}
    return {
        "brightness": round(_bounded_float(options.get("brightness"), 1.0, 0.25, 2.0), 3),
        "contrast": round(_bounded_float(options.get("contrast"), 1.0, 0.25, 2.0), 3),
        "saturation": round(_bounded_float(options.get("saturation"), 1.0, 0.0, 2.0), 3),
        "grayscale": round(_bounded_float(options.get("grayscale"), 0.0, 0.0, 1.0), 3),
    }


def _apply_image_adjustments(image: Image.Image, raw_options: dict | None) -> tuple[Image.Image, dict]:
    """Return an adjusted copy while preserving an RGBA image's original alpha."""
    option = _normalized_image_adjustments(raw_options)
    alpha = image.getchannel("A") if "A" in image.getbands() else None
    working = image.convert("RGB")
    try:
        for enhancer, value in (
            (ImageEnhance.Brightness, option["brightness"]),
            (ImageEnhance.Contrast, option["contrast"]),
            (ImageEnhance.Color, option["saturation"]),
        ):
            if value == 1.0:
                continue
            adjusted = enhancer(working).enhance(value)
            working.close()
            working = adjusted
        if option["grayscale"] > 0:
            gray = ImageOps.grayscale(working).convert("RGB")
            blended = Image.blend(working, gray, option["grayscale"])
            working.close()
            gray.close()
            working = blended
        if alpha is None:
            result = working
            working = None
            return result, option
        result = working.convert("RGBA")
        result.putalpha(alpha)
        return result, option
    finally:
        if working is not None:
            working.close()
        if alpha is not None:
            alpha.close()


def _normalized_watermark_options(raw_options: dict | None) -> dict | None:
    if not isinstance(raw_options, dict):
        return None
    image_path = raw_options.get("image_path")
    if not isinstance(image_path, str) or not image_path.strip():
        return None
    asset_id = raw_options.get("asset_id")
    raw_height = raw_options.get("height")
    height = None if raw_height is None else round(_bounded_float(raw_height, 0.08, 0.02, 1.0), 4)
    return {
        "enabled": bool(raw_options.get("enabled", True)),
        "asset_id": str(asset_id) if asset_id else None,
        "image_path": image_path.strip(),
        "center_x": round(_bounded_float(raw_options.get("center_x"), 0.82, 0.0, 1.0), 4),
        "center_y": round(_bounded_float(raw_options.get("center_y"), 0.9, 0.0, 1.0), 4),
        "width": round(_bounded_float(raw_options.get("width"), 0.2, 0.05, 1.0), 4),
        "height": height,
        "rotation_degrees": round(_bounded_float(raw_options.get("rotation_degrees"), 0.0, -180.0, 180.0), 2),
        "opacity": round(_bounded_float(raw_options.get("opacity"), 0.72, 0.05, 1.0), 3),
        "adjustments": _normalized_image_adjustments(raw_options.get("adjustments")),
    }


def _apply_watermark(
    canvas: Image.Image,
    static_dir: str,
    media_dir: str | None,
    raw_options: dict | None,
) -> tuple[Image.Image, dict | None]:
    option = _normalized_watermark_options(raw_options)
    if not option:
        return canvas, None
    manifest = {**option, "applied": False}
    if not option["enabled"]:
        return canvas, manifest

    source = _open_local_asset(static_dir, option["image_path"], media_dir)
    try:
        logo = ImageOps.exif_transpose(source).convert("RGBA")
    finally:
        source.close()
    try:
        adjusted_logo, adjustments = _apply_image_adjustments(logo, option["adjustments"])
    finally:
        logo.close()
    option["adjustments"] = adjustments
    manifest["adjustments"] = adjustments
    try:
        target_width = max(1, round(canvas.width * option["width"]))
        target_height = (
            max(1, round(canvas.height * option["height"]))
            if option["height"] is not None
            else max(1, round(adjusted_logo.height * target_width / max(1, adjusted_logo.width)))
        )
        resized = adjusted_logo.resize((target_width, target_height), Image.Resampling.LANCZOS)
    finally:
        adjusted_logo.close()
    try:
        alpha = resized.getchannel("A").point(lambda value: round(value * option["opacity"]))
        resized.putalpha(alpha)
        alpha.close()
        # CSS rotates positive angles clockwise; Pillow uses positive angles
        # counter-clockwise, so invert the sign for preview/render parity.
        rotated = resized.rotate(
            -option["rotation_degrees"],
            resample=Image.Resampling.BICUBIC,
            expand=True,
            fillcolor=(0, 0, 0, 0),
        )
    finally:
        resized.close()

    try:
        left = round(option["center_x"] * canvas.width - rotated.width / 2)
        top = round(option["center_y"] * canvas.height - rotated.height / 2)
        layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        # Copy RGBA directly onto the transparent layer. Passing the logo as
        # both source and mask would multiply its alpha a second time and make
        # the rendered opacity weaker than the editor preview.
        layer.paste(rotated, (left, top))
        base = canvas.convert("RGBA")
        try:
            rendered = Image.alpha_composite(base, layer).convert("RGB")
        finally:
            base.close()
            layer.close()
        manifest.update({
            "applied": True,
            "rendered_width_px": target_width,
            "rendered_height_px": target_height,
            "rotated_width_px": rotated.width,
            "rotated_height_px": rotated.height,
            "left_px": left,
            "top_px": top,
        })
        return rendered, manifest
    finally:
        rotated.close()


def _crop_rectangle(image: Image.Image, rect: dict) -> Image.Image:
    left = max(0, min(image.width - 1, round(rect["x"] * image.width)))
    top = max(0, min(image.height - 1, round(rect["y"] * image.height)))
    right = max(left + 1, min(image.width, round((rect["x"] + rect["width"]) * image.width)))
    bottom = max(top + 1, min(image.height, round((rect["y"] + rect["height"]) * image.height)))
    return image.crop((left, top, right, bottom))


def _crop_panel(image: Image.Image, size: tuple[int, int], option: dict) -> Image.Image:
    target_width, target_height = size
    target_ratio = target_width / max(1, target_height)
    source_ratio = image.width / max(1, image.height)
    if source_ratio > target_ratio:
        crop_height = float(image.height)
        crop_width = crop_height * target_ratio
    else:
        crop_width = float(image.width)
        crop_height = crop_width / target_ratio
    zoom = option["zoom"]
    crop_width = max(1.0, crop_width / zoom)
    crop_height = max(1.0, crop_height / zoom)
    center_x = option["focal_x"] * image.width
    center_y = option["focal_y"] * image.height
    left = max(0.0, min(image.width - crop_width, center_x - crop_width / 2))
    top = max(0.0, min(image.height - crop_height, center_y - crop_height / 2))
    box = (round(left), round(top), round(left + crop_width), round(top + crop_height))
    return image.crop(box).resize(size, Image.Resampling.LANCZOS)


def _fit_panel(image: Image.Image, size: tuple[int, int], option: dict) -> Image.Image:
    """Fill the cell edge to edge, without letterboxing or synthetic backgrounds."""
    return ImageOps.fit(
        image,
        size,
        method=Image.Resampling.LANCZOS,
        centering=(option["focal_x"], option["focal_y"]),
    )


def _instagram_panel(image: Image.Image, size: tuple[int, int], option: dict) -> Image.Image:
    """Render one fixed-canvas cell without reintroducing manually removed content."""
    if option["crop_mode"] == "crop" and option["crop_rect"]:
        selection = _crop_rectangle(image, option["crop_rect"])
        try:
            return _fit_panel(selection, size, {**option, "focal_x": 0.5, "focal_y": 0.5})
        finally:
            selection.close()
    if option["crop_mode"] == "crop":
        return _crop_panel(image, size, option)
    return _fit_panel(image, size, option)


def render_bundle(
    output_root: str,
    static_dir: str,
    case,
    candidates,
    decision,
    *,
    media_dir: str | None = None,
    include_automation_matches: bool = False,
    panel_ids: Sequence[str] | None = None,
    panel_options: dict[str, dict] | None = None,
    collage_adjustments: dict | None = None,
    watermark_options: dict | None = None,
    canvas_format: str | None = None,
    layout_template: str | None = None,
    export_scale: int = 1,
):
    case_dir = Path(output_root) / f"case-{case.id}"
    bundle_dir = case_dir / "versions" / uuid.uuid4().hex
    bundle_dir.mkdir(parents=True, exist_ok=True)

    assets = build_render_assets(
        case,
        candidates,
        include_automation_matches=include_automation_matches,
        panel_ids=panel_ids,
    )
    if not assets:
        raise ValueError("At least one source-backed image is required")
    normalized_options = _normalized_panel_options(assets, panel_options)
    render_options = {}

    normalized_format = canvas_format if canvas_format in INSTAGRAM_CANVAS_FORMATS else None
    normalized_template = layout_template if layout_template in COLLAGE_LAYOUT_TEMPLATES else "balanced_grid"
    opened: list[Image.Image] = []
    try:
        for asset in assets:
            source = _open_local_asset(static_dir, asset["image_path"], media_dir)
            original = ImageOps.exif_transpose(source).convert("RGB")
            photo, render_option = prepare_photo(original, normalized_options[str(asset["id"])], normalized_options[str(asset["id"])]["adjustments"])
            original.close()
            opened.append(photo)
            render_options[str(asset["id"])] = render_option
            source.close()
        width_scales = [normalized_options[str(asset["id"])]["width_scale"] for asset in assets]
        if normalized_template == "side_by_side":
            # A shared height preserves each edited photo's proportions. The
            # canvas follows the photos instead of cropping them into fixed cells.
            canvas_width, canvas_height, cells = side_by_side_geometry([image.size for image in opened], export_scale)
            canvas = Image.new("RGB", (canvas_width, canvas_height))
            for index, image in enumerate(opened):
                x, y, width, height = cells[index]
                panel = image.resize((width, canvas_height), Image.Resampling.LANCZOS)
                panel = caption_panel(panel, normalized_options[str(assets[index]["id"])]["caption"])
                canvas.paste(panel, (x, y))
                panel.close()
        elif normalized_format:
            format_spec = INSTAGRAM_CANVAS_FORMATS[normalized_format]
            scale = export_scale if export_scale in {1, 2, 3} else 1
            canvas_width = int(format_spec["width"]) * scale
            canvas_height = int(format_spec["height"]) * scale
            cells = _instagram_geometry(
                len(assets),
                canvas_width,
                canvas_height,
                width_scales,
                normalized_format,
                normalized_template,
            )
            canvas = Image.new("RGB", (canvas_width, canvas_height))
            for image_index, (x, y, width, height) in enumerate(cells):
                option = render_options[str(assets[image_index]["id"])]
                panel = _instagram_panel(opened[image_index], (width, height), option)
                panel = caption_panel(panel, normalized_options[str(assets[image_index]["id"])]["caption"])
                canvas.paste(panel, (x, y))
                panel.close()
        else:
            canvas_width = 1200 if len(assets) == 1 else 1800 if len(assets) <= 12 else 2200
            aspect_ratios = []
            for image, asset in zip(opened, assets):
                option = render_options[str(asset["id"])]
                rect = option["crop_rect"] if option["crop_mode"] == "crop" else None
                if rect:
                    aspect_ratios.append((image.width * rect["width"]) / max(1, image.height * rect["height"]))
                else:
                    aspect_ratios.append(image.width / max(1, image.height))
            geometry = _justified_geometry(opened, canvas_width, width_scales, aspect_ratios)
            canvas_height = sum(row[0][1] for row in geometry)
            canvas = Image.new("RGB", (canvas_width, canvas_height))
            image_index = 0
            y = 0
            for row in geometry:
                x = 0
                for width, height in row:
                    source = opened[image_index]
                    option = render_options[str(assets[image_index]["id"])]
                    if option["crop_mode"] == "crop" and option["crop_rect"]:
                        selection = _crop_rectangle(source, option["crop_rect"])
                        panel = _fit_panel(selection, (width, height), {**option, "focal_x": 0.5, "focal_y": 0.5})
                        selection.close()
                    elif option["crop_mode"] == "crop":
                        panel = _crop_panel(source, (width, height), option)
                    elif option["width_scale"] != 1.0:
                        panel = _fit_panel(source, (width, height), option)
                    else:
                        panel = source.resize((width, height), Image.Resampling.LANCZOS)
                    panel = caption_panel(panel, normalized_options[str(assets[image_index]["id"])]["caption"])
                    canvas.paste(panel, (x, y))
                    panel.close()
                    x += width
                    image_index += 1
                y += row[0][1]
    finally:
        for image in opened:
            image.close()

    source_webp_path = bundle_dir / "collage-source.webp"
    canvas.save(source_webp_path, quality=90, method=6)
    adjusted_canvas, normalized_collage_adjustments = _apply_image_adjustments(canvas, collage_adjustments)
    canvas.close()
    canvas = adjusted_canvas
    base_webp_path = bundle_dir / "collage-base.webp"
    canvas.save(base_webp_path, quality=90, method=6)
    rendered_canvas, watermark_manifest = _apply_watermark(canvas, static_dir, media_dir, watermark_options)

    webp_path = bundle_dir / "collage.webp"
    rendered_canvas.save(webp_path, quality=92, method=6)
    if WRITE_LOSSLESS_PNG:
        rendered_canvas.save(bundle_dir / "collage.png", optimize=True)

    manifest = {
        "case_id": case.id,
        "decision_id": decision.id,
        "decision": decision.decision,
        "editorial_reason": decision.reason,
        "outfit": {"celebrity": case.celebrity, "designer": case.designer, "event": case.event_name, "date": case.event_date},
        "assets": assets,
        "panel_count": len(assets),
        "layout": normalized_template if normalized_format or normalized_template == "side_by_side" else "edge_to_edge_justified",
        "canvas_format": normalized_format or "source_ratio",
        "canvas_width": canvas.width,
        "export_scale": export_scale,
        "canvas_height": canvas.height,
        "canvas_ratio": f"{canvas.width}:{canvas.height}" if normalized_template == "side_by_side" else INSTAGRAM_CANVAS_FORMATS[normalized_format]["ratio"] if normalized_format else "source-driven",
        "editor_customized": panel_ids is not None,
        "panel_options": normalized_options,
        "collage_adjustments": normalized_collage_adjustments,
        "watermark_applied": bool(watermark_manifest and watermark_manifest.get("applied")),
        "watermark": watermark_manifest,
        "source_preview_file": source_webp_path.name,
        "base_preview_file": base_webp_path.name,
        "spacing_px": 0,
        "border_px": 0,
        "renderer_style": "edge_to_edge_v2",
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    source_lines = [
        "# Source manifest",
        "",
        f"Outfit: {case.celebrity} in {case.designer}",
        "",
        "## Collage layout",
        f"- Format: {INSTAGRAM_CANVAS_FORMATS[normalized_format]['label'] if normalized_format else 'Source-driven'}",
        f"- Template: {normalized_template.replace('_', ' ').title() if normalized_format else 'Edge-to-edge justified'}",
        f"- Dimensions: {canvas.width} × {canvas.height} px",
        "",
    ]
    for index, asset in enumerate(assets, start=1):
        source_lines.extend(
            [
                f"## Panel {index}: {asset.get('label') or asset.get('role')}",
                f"- Person/model: {asset.get('person') or 'Not applicable'}",
                f"- Publisher: {asset.get('publisher') or 'Unknown'}",
                f"- Source: {asset.get('source_url') or 'Missing'}",
                f"- Credit: {asset.get('credit') or 'Credit pending'}",
                f"- Retrieved: {asset.get('retrieved_at') or 'Not recorded'}",
                f"- Rights: {asset.get('rights_status')}",
                f"- Source grade: {asset.get('source_grade')}",
                "",
            ]
        )
    if watermark_manifest:
        watermark_height = watermark_manifest.get("height")
        watermark_adjustments = watermark_manifest.get("adjustments", {})
        watermark_height_label = (
            "Natural aspect ratio"
            if watermark_height is None
            else f"{round(float(watermark_height) * 100)}% of canvas"
        )
        source_lines.extend(
            [
                "## HHC watermark",
                f"- Applied: {'Yes' if watermark_manifest.get('applied') else 'No'}",
                f"- Brand asset: {watermark_manifest.get('asset_id') or 'Not recorded'}",
                f"- Opacity: {round(float(watermark_manifest.get('opacity', 0)) * 100)}%",
                f"- Rotation: {watermark_manifest.get('rotation_degrees', 0)} degrees",
                f"- Width: {round(float(watermark_manifest.get('width', 0)) * 100)}% of canvas",
                f"- Height: {watermark_height_label}",
                f"- Brightness: {round(float(watermark_adjustments.get('brightness', 1)) * 100)}%",
                f"- Contrast: {round(float(watermark_adjustments.get('contrast', 1)) * 100)}%",
                f"- Saturation: {round(float(watermark_adjustments.get('saturation', 1)) * 100)}%",
                f"- Grayscale: {round(float(watermark_adjustments.get('grayscale', 0)) * 100)}%",
                "",
            ]
        )
    source_lines.extend(
        [
            "## Collage image adjustments",
            f"- Brightness: {round(normalized_collage_adjustments['brightness'] * 100)}%",
            f"- Contrast: {round(normalized_collage_adjustments['contrast'] * 100)}%",
            f"- Saturation: {round(normalized_collage_adjustments['saturation'] * 100)}%",
            f"- Grayscale: {round(normalized_collage_adjustments['grayscale'] * 100)}%",
            "",
        ]
    )
    (bundle_dir / "sources.md").write_text("\n".join(source_lines), encoding="utf-8")

    if rendered_canvas is not canvas:
        rendered_canvas.close()
    canvas.close()
    # Each version lives only in its own folder; the evidence ZIP is built on
    # download (bundle_archive) instead of being stored with every render.
    for written in bundle_dir.iterdir():
        get_storage().saved(written)
    zip_path = bundle_dir / BUNDLE_NAME
    return str(webp_path), str(manifest_path), str(zip_path)
