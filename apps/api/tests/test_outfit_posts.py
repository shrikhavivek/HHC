from datetime import datetime, timezone
from random import Random
from types import SimpleNamespace

from PIL import Image, ImageDraw

from app.outfit_posts import group_outfit_posts


def post(identifier, **overrides):
    values = dict(
        id=identifier, celebrity="Kangana Ranaut", designer="Gaurang Shah",
        source_title="Kangana Ranaut in Gaurang Shah", source_body="Designer: Gaurang Shah",
        base_image=f"/media-files/{identifier}.jpg", extraction={}, demo_data=False,
        created_at=datetime(2026, 10, 12, tzinfo=timezone.utc),
    )
    return SimpleNamespace(**{**values, **overrides})


def photograph(path, seed=12, size=(320, 480), quality=95):
    random = Random(seed)
    with Image.new("RGB", (320, 480), "#725944") as image:
        draw = ImageDraw.Draw(image)
        for _ in range(40):
            left, top = random.randrange(280), random.randrange(420)
            draw.rectangle((left, top, left + 35, top + 55), fill=tuple(random.randrange(256) for _ in range(3)))
        with image.resize(size) as resized:
            resized.save(path, quality=quality)


def test_reencoded_shared_photo_groups_different_posts(tmp_path):
    photograph(tmp_path / "first.jpg")
    photograph(tmp_path / "second.jpg", size=(640, 960), quality=88)
    groups = group_outfit_posts([post("first"), post("second", celebrity="kangana RANAUT")], str(tmp_path))
    assert len(groups) == 1
    assert {item.id for item in groups[0]} == {"first", "second"}


def test_same_person_and_designer_in_different_photos_stay_separate(tmp_path):
    photograph(tmp_path / "first.jpg")
    photograph(tmp_path / "second.jpg", seed=47)
    assert len(group_outfit_posts([post("first"), post("second")], str(tmp_path))) == 2


def test_shared_gallery_image_prefers_complete_post(tmp_path):
    shorter = post("short", base_image="/media-files/shared.jpg")
    complete = post("complete", extraction={"collage_assets": [{"role": "current_angle", "image_path": shorter.base_image}]})
    groups = group_outfit_posts([shorter, complete], str(tmp_path))
    assert [[item.id for item in group] for group in groups] == [["complete", "short"]]


def test_editor_customized_post_is_kept_as_representative(tmp_path):
    edited = post("edited", base_image="/media-files/shared.jpg", extraction={"collage_edit": {"revision": 1}})
    complete = post("complete", extraction={"collage_assets": [{"role": "current_angle", "image_path": edited.base_image}]})
    groups = group_outfit_posts([complete, edited], str(tmp_path))
    assert groups[0][0] is edited
    assert len(groups[0]) == 2


def test_shared_designer_reference_does_not_merge_outfits(tmp_path):
    reference = {"role": "designer_reference", "image_path": "/media-files/reference.jpg"}
    rows = [post(identifier, extraction={"collage_assets": [reference]}) for identifier in ["first", "second"]]
    assert len(group_outfit_posts(rows, str(tmp_path))) == 2


def test_other_people_unknown_names_and_demo_posts_are_not_grouped(tmp_path):
    rows = [post("first", base_image="/media-files/shared.jpg")]
    rows.extend(post(str(index), celebrity=person, base_image=rows[0].base_image) for index, person in enumerate(["Alia Bhatt", "Unknown", "Unknown", "Unresolved", "Unresolved"]))
    rows.append(post("demo", base_image=rows[0].base_image, demo_data=True))
    assert len(group_outfit_posts(rows, str(tmp_path))) == len(rows)


def test_missing_and_blank_images_do_not_create_visual_matches(tmp_path):
    for identifier in ["first", "second"]:
        with Image.new("RGB", (320, 480), "white") as image:
            image.save(tmp_path / f"{identifier}.jpg")
    rows = [post(identifier) for identifier in ["first", "second", "missing"]]
    assert len(group_outfit_posts(rows, str(tmp_path))) == 3


def test_legacy_event_in_person_is_normalized_before_grouping(tmp_path):
    title = "Kangana Ranaut for the inauguration of PNG Jewellers in Ayodhya."
    malformed = post("legacy", celebrity="Kangana Ranaut for the inauguration of PNG Jewellers", source_title=title)
    correct = post("correct", base_image=malformed.base_image)
    assert len(group_outfit_posts([malformed, correct], str(tmp_path))) == 1


def test_representative_does_not_depend_on_input_order(tmp_path):
    rows = [post(identifier, base_image="/media-files/shared.jpg") for identifier in ["first", "second"]]
    assert group_outfit_posts(rows, str(tmp_path))[0][0].id == group_outfit_posts(rows[::-1], str(tmp_path))[0][0].id
