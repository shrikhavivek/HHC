from PIL import Image
from app.collage import _fit_panel
from app.photo_controls import caption_panel


def test_panel_fills_every_pixel_without_blur_or_letterboxing():
    image = Image.new("RGB", (200, 100), "red")
    image.paste("blue", (100, 0, 200, 100))
    result = _fit_panel(image, (100, 200), {"focal_x": 0.5, "focal_y": 0.5})
    assert result.size == (100, 200)
    assert result.getpixel((0, 0)) == (255, 0, 0)
    assert result.getpixel((99, 199)) == (0, 0, 255)
    assert result.getpixel((20, 0)) == result.getpixel((20, 199))


def test_caption_does_not_add_a_strip_or_resize_photo():
    image = Image.new("RGB", (400, 600), "red")
    result = caption_panel(image, "Designer credit")
    assert result.size == (400, 600)
    for point in [(0, 0), (399, 0), (0, 599), (399, 599), (200, 300)]:
        assert result.getpixel(point) == (255, 0, 0)
