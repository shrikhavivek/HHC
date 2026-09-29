import json
from datetime import datetime, timezone
from types import SimpleNamespace

from app.assets import build_panel_catalog, build_render_assets, default_panel_ids, normalize_case_assets
from app.collage import render_bundle
from PIL import Image


def _case(assets):
    return SimpleNamespace(
        id="case-1",
        celebrity="Current Celebrity",
        designer="Example Designer",
        event_name="Today Event",
        event_date="2026-09-27",
        base_image="/static/look-1.png",
        permalink="https://www.reddit.com/r/BollywoodFashion/comments/example",
        extraction={"collage_assets": assets},
    )


def _asset(role, *, rights="editorial_review_required", fallback=False, official=None, verified=None, suffix="", image_path="/static/look-3.png"):
    is_official = role == "designer_reference" if official is None else official
    return {
        "id": f"asset-{role}-{rights}-{suffix}",
        "role": role,
        "image_path": image_path,
        "source_url": "https://example.com/source",
        "publisher": "Official source",
        "official_source": is_official,
        "verified_source": is_official if verified is None else verified,
        "exact_match": True,
        "include_in_collage": True,
        "fallback_only": fallback,
        "rights_status": rights,
    }


def _candidate(person="Archive Celebrity"):
    decision = SimpleNamespace(decision="approved", decided_at=datetime.now(timezone.utc))
    return SimpleNamespace(
        id=f"candidate-{person}",
        person=person,
        designer="Example Designer",
        event_name="Archive Event",
        event_date="2022-04-03",
        image_path="/static/look-2.png",
        evidence=[{"url": "https://example.com/archive", "publisher": "Archive", "credit": "Archive credit"}],
        rights_status="editorial_review_required",
        source_grade="A",
        decisions=[decision],
    )


def test_normalization_rejects_unknown_or_incomplete_assets():
    case = _case([
        _asset("designer_reference"),
        {"role": "unknown", "image_path": "/static/look.png", "source_url": "https://example.com"},
        {"role": "current_angle", "image_path": ""},
    ])
    assert [item["role"] for item in normalize_case_assets(case)] == ["designer_reference"]


def test_historical_collage_keeps_all_current_angles_and_skips_original():
    case = _case([
        _asset("current_angle", fallback=True),
        _asset("designer_reference"),
        _asset("designer_reference", rights="do_not_use"),
        _asset("designer_reference", official=False),
    ])
    panels = build_render_assets(case, [_candidate("Current Celebrity"), _candidate("Other Celebrity")])
    assert [item["role"] for item in panels] == [
        "current_primary",
        "current_angle",
        "historical_same_person",
        "historical_other_person",
    ]


def test_no_historical_match_keeps_current_angles_then_adds_verified_original():
    case = _case([_asset("current_angle", fallback=True), _asset("designer_reference")])
    panels = build_render_assets(case, [])
    assert [item["role"] for item in panels] == ["current_primary", "current_angle", "designer_reference"]


def test_verified_retailer_product_is_allowed_as_exact_original():
    case = _case([_asset("designer_reference", official=False, verified=True)])
    panels = build_render_assets(case, [])
    assert [item["role"] for item in panels] == ["current_primary", "designer_reference"]


def test_current_angles_are_last_fallback_when_no_match_or_original_exists():
    case = _case([_asset("current_angle", fallback=True)])
    panels = build_render_assets(case, [])
    assert [item["role"] for item in panels] == ["current_primary", "current_angle"]


def test_editor_can_replace_and_reorder_panels_from_the_source_catalog():
    case = _case([
        _asset("current_angle", suffix="alternate"),
        _asset("designer_reference", suffix="original"),
    ])
    candidate = _candidate("Other Celebrity")
    catalog = build_panel_catalog(case, [candidate])
    assert default_panel_ids(catalog) == ["current-primary", "asset-current_angle-editorial_review_required-alternate", candidate.id]

    panels = build_render_assets(
        case,
        [candidate],
        panel_ids=[candidate.id, "asset-current_angle-editorial_review_required-alternate"],
    )
    assert [item["id"] for item in panels] == [candidate.id, "asset-current_angle-editorial_review_required-alternate"]
    assert [item["role"] for item in panels] == ["historical_other_person", "current_angle"]


def test_legacy_automation_match_is_not_available_to_the_renderer():
    legacy = _candidate("Legacy Candidate")
    legacy.decisions = []
    legacy.status = "automation_selected"
    legacy.checks = {"automation": {"combined": 0.81}}
    current = _candidate("Current Matcher Candidate")
    current.decisions = []
    current.status = "automation_selected"
    current.checks = {"automation": {"matcher_version": 2}}

    panels = build_panel_catalog(_case([]), [legacy, current], include_automation_matches=True)
    assert [item["id"] for item in panels] == ["current-primary", current.id]


def test_editor_upload_is_available_but_never_auto_selected():
    uploaded = _asset("editor_upload", suffix="manual", official=False, verified=False)
    uploaded["exact_match"] = False
    case = _case([uploaded])
    catalog = build_panel_catalog(case, [])
    assert [item["role"] for item in catalog] == ["current_primary", "editor_upload"]
    assert default_panel_ids(catalog) == ["current-primary"]
    selected = build_render_assets(case, [], panel_ids=["current-primary", uploaded["id"]])
    assert [item["role"] for item in selected] == ["current_primary", "editor_upload"]


def test_complete_reddit_gallery_is_not_truncated():
    assets = [
        _asset("current_angle", suffix=str(index), image_path=f"/static/look-{index + 2}.png")
        for index in range(12)
    ]
    panels = build_render_assets(_case(assets), [])
    assert len(panels) == 13
    assert panels[0]["role"] == "current_primary"
    assert all(item["role"] == "current_angle" for item in panels[1:])


def test_rendered_bundle_contains_today_and_verified_original_panels(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    for index, color in enumerate(["#7c1738", "#1d6c62", "#c09042"], start=1):
        Image.new("RGB", (500 + index * 10, 800), color).save(static_dir / f"look-{index}.png")

    case = _case([_asset("designer_reference")])
    decision = SimpleNamespace(id="decision-1", decision="approved", reason="Exact construction is supported by official source evidence.")
    _, manifest_path, bundle_path = render_bundle(str(tmp_path / "output"), str(static_dir), case, [], decision)

    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    assert manifest["panel_count"] == 2
    assert manifest["layout"] == "edge_to_edge_justified"
    assert manifest["spacing_px"] == 0
    assert manifest["border_px"] == 0
    assert [item["role"] for item in manifest["assets"]] == ["current_primary", "designer_reference"]
    assert (tmp_path / "output" / "case-case-1" / "collage.webp").is_file()
    assert open(bundle_path, "rb").read(2) == b"PK"


def test_multiple_post_photos_render_into_one_collage_file(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    for index in range(1, 6):
        Image.new("RGB", (420 + index * 15, 760), f"#{index * 28:02x}435e").save(static_dir / f"look-{index}.png")

    case = _case([
        _asset("current_angle", suffix="2", image_path="/static/look-2.png"),
        _asset("current_angle", suffix="3", image_path="/static/look-3.png"),
        _asset("current_angle", suffix="4", image_path="/static/look-4.png"),
        _asset("designer_reference", suffix="og", image_path="/static/look-5.png"),
    ])
    decision = SimpleNamespace(id="decision-gallery", decision="automation_draft", reason="Complete post gallery")
    image_path, manifest_path, _ = render_bundle(str(tmp_path / "output"), str(static_dir), case, [], decision)

    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    assert manifest["panel_count"] == 5
    assert manifest["layout"] == "edge_to_edge_justified"
    assert manifest["spacing_px"] == 0
    assert manifest["border_px"] == 0
    assert len(list((tmp_path / "output" / "case-case-1").glob("collage.webp"))) == 1
    with Image.open(image_path) as collage:
        assert collage.width == 1800
        assert collage.height > 1000
    with Image.open(tmp_path / "output" / "case-case-1" / "collage.png") as collage:
        # Every outer pixel belongs to a source image: no frame, gutter or
        # caption canvas is introduced by the renderer.
        assert collage.getpixel((0, 0)) != (242, 238, 231)
        assert collage.getpixel((collage.width - 1, 0)) != (242, 238, 231)
        assert collage.getpixel((0, collage.height - 1)) != (242, 238, 231)
        assert collage.getpixel((collage.width - 1, collage.height - 1)) != (242, 238, 231)


def test_panel_width_and_focal_crop_are_applied_and_recorded(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    current = Image.new("RGB", (1000, 500), "#ff0000")
    current.paste(Image.new("RGB", (250, 500), "#0000ff"), (750, 0))
    current.save(static_dir / "look-1.png")
    Image.new("RGB", (1000, 500), "#00ff00").save(static_dir / "look-2.png")

    angle = _asset("current_angle", suffix="custom", image_path="/static/look-2.png")
    case = _case([angle])
    decision = SimpleNamespace(id="decision-layout", decision="editor_draft", reason="Custom panel layout")
    panel_ids = ["current-primary", angle["id"]]
    panel_options = {
        "current-primary": {"width_scale": 0.65, "crop_mode": "crop", "focal_x": 1, "focal_y": 0.5, "zoom": 2},
        angle["id"]: {"width_scale": 1.75, "crop_mode": "fit", "focal_x": 0.5, "focal_y": 0.5, "zoom": 1},
    }

    _, manifest_path, _ = render_bundle(
        str(tmp_path / "output"),
        str(static_dir),
        case,
        [],
        decision,
        panel_ids=panel_ids,
        panel_options=panel_options,
    )

    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    assert manifest["editor_customized"] is True
    assert manifest["panel_options"]["current-primary"] == {
        "width_scale": 0.65,
        "crop_mode": "crop",
        "focal_x": 1.0,
        "focal_y": 0.5,
        "zoom": 2.0,
        "crop_rect": None,
    }
    with Image.open(tmp_path / "output" / "case-case-1" / "collage.png") as collage:
        # The narrowed first panel ends well before the midpoint, and its
        # right-focused crop displays the blue edge of the source image.
        assert collage.getpixel((300, collage.height // 2)) == (0, 0, 255)
        second_panel_pixel = collage.getpixel((700, collage.height // 2))
        assert second_panel_pixel[0] == 0
        assert second_panel_pixel[1] > 100
        assert second_panel_pixel[2] == 0


def test_manual_crop_rectangle_keeps_only_the_selected_source_area(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    sales_page = Image.new("RGB", (1000, 500), "#ff0000")
    sales_page.paste(Image.new("RGB", (300, 500), "#0000ff"), (700, 0))
    sales_page.save(static_dir / "look-1.png")

    case = _case([])
    decision = SimpleNamespace(id="decision-manual-crop", decision="editor_draft", reason="Keep only the model area")
    crop_rect = {"x": 0.7, "y": 0, "width": 0.3, "height": 1}
    _, manifest_path, _ = render_bundle(
        str(tmp_path / "output"),
        str(static_dir),
        case,
        [],
        decision,
        panel_ids=["current-primary"],
        panel_options={
            "current-primary": {
                "width_scale": 1,
                "crop_mode": "crop",
                "crop_rect": crop_rect,
            },
        },
    )

    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    assert manifest["panel_options"]["current-primary"]["crop_rect"] == crop_rect
    with Image.open(tmp_path / "output" / "case-case-1" / "collage.png") as collage:
        assert collage.size == (1200, 2000)
        assert collage.getpixel((collage.width // 2, collage.height // 2)) == (0, 0, 255)
        assert collage.getpixel((20, collage.height // 2)) == (0, 0, 255)
