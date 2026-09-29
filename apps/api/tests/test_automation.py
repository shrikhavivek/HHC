from types import SimpleNamespace

from PIL import Image

from app.automation import _outfit_match_assessment, _post_page_media, _usable_image_file, parse_outfit
from app.collage import render_bundle
from app import designer_search
from app.designer_search import find_official_designer_reference


def test_title_and_description_drive_outfit_extraction():
    parsed = parse_outfit(
        "Sara Ali Khan for Udta Teer trailer launch",
        "Stylist - Tanya Ghavri Wearing - Rohit Gandhi + Rahul Khanna Jewellery - Amrapali Jewels",
    )
    assert parsed == {
        "celebrity": "Sara Ali Khan",
        "designer": "Rohit Gandhi + Rahul Khanna",
        "event": "Udta Teer trailer launch",
    }


def test_multi_brand_and_handle_descriptions_are_extracted():
    campaign = parse_outfit(
        "Arjun Kapoor’s latest campaign for Heineken India",
        "Clothing designers: Acne Studios, Rick Owens & Perlo Studios Footwear: Louboutin",
    )
    assert campaign == {
        "celebrity": "Arjun Kapoor",
        "designer": "Acne Studios + Rick Owens + Perlo Studios",
        "event": "Heineken India",
    }
    runway = parse_outfit(
        "Komal Pandey and Siddharth Batra at Manish Malhotra's show",
        "Wearing Designer @manishmalhotra",
    )
    assert runway["designer"] == "Manish Malhotra"


def test_component_designers_are_preserved_for_a_mixed_outfit():
    parsed = parse_outfit(
        "Kareena Kapoor Khan wearing a crisp white shirt for What Women Want",
        "Shirt is from Italian luxury fashion brand Elisabetta Franchi Pant Designer Kanika Goyal Label. stylist Lakshmi Lehr",
    )
    assert parsed["designer"] == "Elisabetta Franchi + Kanika Goyal Label"


def test_post_page_media_extracts_complete_gallery_in_order():
    markup = """
    <html><body>
      <img src="https://styles.redditmedia.com/community-icon.jpg">
      <shreddit-post gallery id="t3_example">
        <img src="https://preview.redd.it/look-one.jpg?width=640&amp;crop=smart">
        <img src="https://i.redd.it/look-one.jpg">
        <img src="https://i.redd.it/look-two.jpg">
        <img src="https://i.redd.it/look-three.jpg">
        <img src="https://i.redd.it/cms/site-decoration.png">
      </shreddit-post>
    </body></html>
    """
    assert _post_page_media(markup) == [
        "https://i.redd.it/look-one.jpg",
        "https://i.redd.it/look-two.jpg",
        "https://i.redd.it/look-three.jpg",
    ]


def test_source_validation_rejects_reddit_badges_and_keeps_editorial_images(tmp_path):
    badge = tmp_path / "badge.png"
    editorial = tmp_path / "editorial.jpg"
    Image.new("RGB", (64, 64), "#36a9e1").save(badge)
    Image.new("RGB", (1080, 1350), "#7c1738").save(editorial)

    assert _usable_image_file(badge) is False
    assert _usable_image_file(editorial) is True


def test_exact_outfit_gate_rejects_same_designer_with_conflicting_landmarks():
    assessment = _outfit_match_assessment(
        "Actor One in Example Designer red embroidered gown",
        "A strapless red gown with crystal embroidery.",
        "Actor Two in Example Designer blue floral sari",
        "A printed blue sari with a floral border.",
        text_score=0.32,
        visual_score=0.91,
        same_person=False,
    )
    assert assessment["accepted"] is False
    assert "conflicting garment category" in assessment["contradictions"]
    assert "conflicting outfit colour" in assessment["contradictions"]


def test_exact_outfit_gate_requires_construction_evidence_for_other_celebrities():
    weak = _outfit_match_assessment(
        "Actor One in Example Designer blue gown",
        "At a film premiere.",
        "Actor Two in Example Designer blue gown",
        "At an awards event.",
        text_score=0.24,
        visual_score=0.88,
        same_person=False,
    )
    strong = _outfit_match_assessment(
        "Actor One in Example Designer blue embroidered gown",
        "A blue off-shoulder gown with floral embroidery.",
        "Actor Two in Example Designer blue embroidered gown",
        "The same blue off shoulder gown with floral embroidery.",
        text_score=0.42,
        visual_score=0.88,
        same_person=False,
    )
    assert weak["accepted"] is False
    assert strong["accepted"] is True
    assert "detail: embroidered" in strong["landmarks"]


def test_single_source_still_creates_an_automatic_draft(tmp_path):
    static_dir = tmp_path / "static"
    media_dir = tmp_path / "media"
    (media_dir / "reddit").mkdir(parents=True)
    static_dir.mkdir()
    Image.new("RGB", (900, 1200), "#7c1738").save(media_dir / "reddit" / "source.jpg")
    case = SimpleNamespace(
        id="automatic-case",
        celebrity="Rasika Dugal",
        designer="Shay by Shubham Tak",
        event_name="Unresolved",
        event_date="2026-09-27",
        base_image="/media-files/reddit/source.jpg",
        permalink="https://www.reddit.com/r/BollywoodFashion/comments/example",
        extraction={"collage_assets": []},
    )
    decision = SimpleNamespace(id="decision", decision="automation_draft", reason="Automated source-only draft")
    image_path, _, _ = render_bundle(
        str(tmp_path / "output"),
        str(static_dir),
        case,
        [],
        decision,
        media_dir=str(media_dir),
    )
    assert (tmp_path / "output" / "case-automatic-case" / "collage.webp").is_file()
    assert image_path.endswith("collage.webp")


def test_designer_search_never_inserts_a_placeholder_without_provider_credentials():
    result = find_official_designer_reference(
        designer="Example Designer",
        celebrity="Example Celebrity",
        title="Example Celebrity in Example Designer",
        description="An exact embroidered look.",
        api_key="",
        user_agent="test-agent",
    )
    assert result == {"status": "provider_not_configured", "provider": "serpapi", "selected": 0}


def test_verified_exact_product_is_available_without_provider_credentials():
    result = find_official_designer_reference(
        designer="House of CB",
        celebrity="Tara Sutaria",
        title="Tara Sutaria in House of CB",
        description="A blush strapless gown.",
        api_key="",
        user_agent="test-agent",
    )
    assert result["status"] == "found"
    assert result["provider"] == "verified_reference_catalog"
    assert result["exact_match"] is True
    assert result["verified_source"] is True


def test_verified_editorial_fallback_requires_celebrity_designer_and_context(monkeypatch):
    responses = iter([
        {"organic_results": []},
        {
            "images_results": [{
                "title": "Example Celebrity wears Example Designer embroidered blue gown at premiere",
                "source": "Fashion Journal",
                "link": "https://fashion.example/example-celebrity-example-designer-blue-gown-premiere",
                "original": "https://cdn.fashion.example/exact-look.jpg",
            }]
        },
    ])
    monkeypatch.setattr(designer_search, "_get", lambda *_args, **_kwargs: next(responses))

    result = find_official_designer_reference(
        designer="Example Designer",
        celebrity="Example Celebrity",
        title="Example Celebrity in Example Designer",
        description="An embroidered blue gown at the premiere.",
        api_key="configured",
        user_agent="test-agent",
    )

    assert result["status"] == "found"
    assert result["source_kind"] == "editorial_same_outfit"
    assert result["person"] == "Example Celebrity"
    assert result["official_source"] is False
