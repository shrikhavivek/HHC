import json
import math
import zipfile
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from .assets import build_render_assets


PALETTES = [
    ("#13131a", "#7357ff", "#ff796d"), ("#17120f", "#d99d64", "#f4dfc4"),
    ("#101818", "#1e847f", "#bbf0db"), ("#17131c", "#b6508a", "#f2b8da"),
    ("#111522", "#466bd7", "#c4d5ff"), ("#191612", "#a8864d", "#efe2bd"),
]

def _font(size: int, bold: bool = False):
    path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


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
    if not path.is_file():
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
        }
    return normalized


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
    """Keep the full image visible while filling the resized panel with itself."""
    background = ImageOps.fit(
        image,
        size,
        method=Image.Resampling.LANCZOS,
        centering=(option["focal_x"], option["focal_y"]),
    )
    background = ImageEnhance.Brightness(background).enhance(0.52)
    background = background.filter(ImageFilter.GaussianBlur(radius=max(8, min(size) // 35)))
    foreground = ImageOps.contain(image, size, method=Image.Resampling.LANCZOS)
    x = (size[0] - foreground.width) // 2
    y = (size[1] - foreground.height) // 2
    background.paste(foreground, (x, y))
    foreground.close()
    return background


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
):
    bundle_dir = Path(output_root) / f"case-{case.id}"
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

    canvas_width = 1200 if len(assets) == 1 else 1800 if len(assets) <= 12 else 2200
    opened: list[Image.Image] = []
    try:
        for asset in assets:
            source = _open_local_asset(static_dir, asset["image_path"], media_dir)
            opened.append(ImageOps.exif_transpose(source).convert("RGB"))
            source.close()
        width_scales = [normalized_options[str(asset["id"])]["width_scale"] for asset in assets]
        aspect_ratios = []
        for image, asset in zip(opened, assets):
            option = normalized_options[str(asset["id"])]
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
                option = normalized_options[str(assets[image_index]["id"])]
                if option["crop_mode"] == "crop" and option["crop_rect"]:
                    selection = _crop_rectangle(source, option["crop_rect"])
                    if option["width_scale"] != 1.0:
                        panel = _fit_panel(selection, (width, height), {**option, "focal_x": 0.5, "focal_y": 0.5})
                    else:
                        panel = selection.resize((width, height), Image.Resampling.LANCZOS)
                    selection.close()
                elif option["crop_mode"] == "crop":
                    panel = _crop_panel(source, (width, height), option)
                elif option["width_scale"] != 1.0:
                    panel = _fit_panel(source, (width, height), option)
                else:
                    panel = source.resize((width, height), Image.Resampling.LANCZOS)
                canvas.paste(panel, (x, y))
                panel.close()
                x += width
                image_index += 1
            y += row[0][1]
    finally:
        for image in opened:
            image.close()

    png_path, webp_path = bundle_dir / "collage.png", bundle_dir / "collage.webp"
    canvas.save(png_path, optimize=True)
    canvas.save(webp_path, quality=92, method=6)

    manifest = {
        "case_id": case.id,
        "decision_id": decision.id,
        "decision": decision.decision,
        "editorial_reason": decision.reason,
        "outfit": {"celebrity": case.celebrity, "designer": case.designer, "event": case.event_name, "date": case.event_date},
        "assets": assets,
        "panel_count": len(assets),
        "layout": "edge_to_edge_justified",
        "editor_customized": panel_ids is not None,
        "panel_options": normalized_options,
        "spacing_px": 0,
        "border_px": 0,
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    source_lines = ["# Source manifest", "", f"Outfit: {case.celebrity} in {case.designer}", ""]
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
    (bundle_dir / "sources.md").write_text("\n".join(source_lines), encoding="utf-8")

    zip_path = bundle_dir / "bundle.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ["collage.png", "collage.webp", "manifest.json", "sources.md"]:
            archive.write(bundle_dir / name, arcname=name)
    return str(webp_path), str(manifest_path), str(zip_path)
