"""Non-destructive per-photo operations and output styling."""
from PIL import Image, ImageDraw, ImageOps

def prepare_photo(image, option, adjustments):
    from .collage import _apply_image_adjustments, _crop_rectangle
    # Crop coordinates always refer to the original photo, before rotation.
    render_option = dict(option)
    if option.get("crop_mode") == "crop" and option.get("crop_rect"):
        result = _crop_rectangle(image, option["crop_rect"])
        # Fill fixed cells using only the selected area, centered like the preview.
        render_option.update(crop_rect=None, crop_mode="fit", zoom=1, focal_x=0.5, focal_y=0.5)
    else:
        result = image.copy()
    rotation = option.get("rotation_degrees", 0)
    if rotation:
        transformed = result.rotate(-rotation, expand=True)
        result.close()
        result = transformed
    if option.get("flip_horizontal"):
        transformed = ImageOps.mirror(result)
        result.close()
        result = transformed
    if option.get("flip_vertical"):
        transformed = ImageOps.flip(result)
        result.close()
        result = transformed
    adjusted, _ = _apply_image_adjustments(result, adjustments)
    result.close()
    return adjusted, render_option

def caption_panel(panel, caption):
    from .collage import _font
    if not caption.strip():
        return panel
    result = panel.copy()
    font = _font(max(10, min(24, panel.width // 22)))
    draw = ImageDraw.Draw(result)
    text = caption.strip()
    while text and draw.textbbox((0, 0), text, font=font)[2] > panel.width - 12:
        text = text[:-1]
    draw.text((panel.width // 2, panel.height - max(12, panel.height // 40)), text,
              fill="white", font=font, anchor="ms", stroke_width=1, stroke_fill="#241a20")
    panel.close()
    return result
