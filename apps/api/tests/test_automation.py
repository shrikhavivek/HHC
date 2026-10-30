import os
from datetime import date, datetime, timezone
from types import SimpleNamespace

from PIL import Image

from app import automation
from app.automation import (
    _fetch_reddit_daily_json,
    _outfit_match_assessment,
    _post_page_media,
    _refresh_case_metadata,
    _usable_image_file,
    editorial_subject_eligibility,
    parse_outfit,
)
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


def test_event_location_is_not_parsed_as_a_designer():
    title = "Kangana Ranaut for the inauguration of PNG Jewellers and a visit to the Shri Ram Janmabhoomi Mandir in Ayodhya."
    parsed = parse_outfit(title, "Designer: Gaurang Shah")
    assert parsed["celebrity"] == "Kangana Ranaut"
    assert parsed["designer"] == "Gaurang Shah"
    assert parsed["event"].endswith("in Ayodhya.")
    case = SimpleNamespace(
        source_title=title, source_body="Designer: Gaurang Shah", celebrity=title.rsplit(" in ", 1)[0],
        designer="Ayodhya.", event_name="Unresolved", status="review_ready", extraction={},
    )
    assert set(_refresh_case_metadata(case)) == {"celebrity", "designer", "event"}
    assert case.celebrity == "Kangana Ranaut"
    assert case.designer == "Gaurang Shah"
    assert _refresh_case_metadata(case) == {}


def test_verified_context_is_not_replaced_by_the_parser():
    case = SimpleNamespace(extraction={"context_verified": True})
    assert _refresh_case_metadata(case) == {}


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


def test_campaign_policy_keeps_named_people_and_rejects_anonymous_creative():
    arjun_title = "Arjun Kapoor’s latest campaign for Heineken India"
    arjun = parse_outfit(arjun_title, "Clothing designers: Acne Studios")
    assert editorial_subject_eligibility(arjun_title, "", arjun["celebrity"]) == (
        True,
        "identified_person",
    )

    tanishq_title = 'Rivaah Wedding Signatures by Tanishq launches new campaign “One Wedding. Many Stories.”'
    tanishq = parse_outfit(tanishq_title, "")
    assert editorial_subject_eligibility(tanishq_title, "", tanishq["celebrity"]) == (
        False,
        "individual_subject_not_identified",
    )

    # An editor can retain a campaign when a real subject is explicitly known.
    assert editorial_subject_eligibility(tanishq_title, "", "Katrina Kaif")[0] is True


def test_social_caption_extracts_the_subject_event_and_designer_handles():
    parsed = parse_outfit(
        'Eka on Instagram: "Arriving in style! @ranveersingh for BMW India Wearing @ysl Sunglasses"',
        "@ranveersingh for BMW India Wearing @ysl Sunglasses @peterandmay",
    )
    assert parsed == {
        "celebrity": "Ranveer Singh",
        "designer": "Saint Laurent",
        "event": "BMW India",
    }


def test_improved_social_parser_repairs_existing_malformed_metadata():
    case = SimpleNamespace(
        source_title='Eka on Instagram: "Arriving in style! @ranveersingh for BMW India Wearing @ysl Sunglasses"',
        source_body="@ranveersingh for BMW India Wearing @ysl Sunglasses @peterandmay",
        celebrity='Eka on Instagram: "Arriving',
        designer="style! @ranveersingh",
        event_name="BMW India Wearing @ysl Sunglasses followed by a very long list of styling and production credits that is not an event name at all",
        extraction={},
        status="context_review",
        confidence=0.56,
    )

    changes = _refresh_case_metadata(case)

    assert set(changes) == {"celebrity", "designer", "event"}
    assert case.celebrity == "Ranveer Singh"
    assert case.designer == "Saint Laurent"
    assert case.event_name == "BMW India"
    assert case.status == "review_ready"


def test_daily_listing_follows_pages_until_the_local_day_is_complete(monkeypatch):
    def child(post_id: str, published: datetime) -> dict:
        return {
            "kind": "t3",
            "data": {
                "name": f"t3_{post_id}",
                "id": post_id,
                "title": f"Look {post_id}",
                "author": "fashion_source",
                "created_utc": published.timestamp(),
                "permalink": f"/r/BollywoodFashion/comments/{post_id}/look/",
                "url_overridden_by_dest": f"https://i.redd.it/{post_id}.jpg",
                "selftext": f"Description {post_id}",
            },
        }

    pages = [
        {
            "data": {
                "after": "t3_page_two",
                "children": [child("late", datetime(2026, 10, 1, 18, 0, tzinfo=timezone.utc))],
            }
        },
        {
            "data": {
                "after": "t3_older",
                "children": [
                    child("early", datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc)),
                    child("previous", datetime(2026, 9, 30, 18, 0, tzinfo=timezone.utc)),
                ],
            }
        },
    ]

    class Response:
        def __init__(self, payload: dict):
            self.payload = payload

        def json(self) -> dict:
            return self.payload

    monkeypatch.setattr(automation, "_request", lambda *_args, **_kwargs: Response(pages.pop(0)))
    posts, scanned = _fetch_reddit_daily_json(
        "BollywoodFashion",
        date(2026, 10, 1),
        "Asia/Kolkata",
        100,
        50,
        "test-agent",
    )

    assert scanned == 2
    assert [post["post_id"] for post in posts] == ["t3_late", "t3_early"]


def test_outfit_search_uses_the_full_reddit_history(monkeypatch):
    requested: dict[str, str] = {}

    class Response:
        content = b"<rss><channel></channel></rss>"

    def fake_request(url: str, *_args, **_kwargs):
        requested["url"] = url
        return Response()

    monkeypatch.setattr(automation, "_request", fake_request)
    automation.search_reddit_feed("BollywoodFashion", '"Example Designer" gown', 100, "test-agent")

    assert "t=all" in requested["url"]
    assert "limit=100" in requested["url"]


def test_outfit_search_uses_oauth_json_when_credentials_are_configured(monkeypatch):
    requested: dict[str, object] = {}
    payload = {
        "data": {
            "after": None,
            "children": [{
                "kind": "t3",
                "data": {
                    "name": "t3_match",
                    "id": "match",
                    "title": "Actor Two in Example Designer embroidered gown",
                    "author": "fashion_source",
                    "created_utc": datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp(),
                    "permalink": "/r/BollywoodFashion/comments/match/look/",
                    "url_overridden_by_dest": "https://i.redd.it/match.jpg",
                    "selftext": "The same blue embroidered gown.",
                },
            }],
        },
    }

    class Response:
        def json(self) -> dict:
            return payload

    def fake_oauth_request(path, user_agent, client_id, client_secret, *, parameters=None):
        requested.update({
            "path": path,
            "user_agent": user_agent,
            "client_id": client_id,
            "client_secret": client_secret,
            "parameters": parameters,
        })
        return Response()

    monkeypatch.setattr(automation, "_reddit_oauth_request", fake_oauth_request)
    posts = automation.search_reddit_feed(
        "BollywoodFashion",
        '"Example Designer" gown',
        100,
        "test-agent",
        oauth_client_id="client-id",
        oauth_client_secret="client-secret",
    )

    assert requested["path"] == "/r/BollywoodFashion/search"
    assert requested["parameters"]["t"] == "all"
    assert requested["parameters"]["limit"] == 100
    assert [post["post_id"] for post in posts] == ["t3_match"]


def test_reddit_oauth_token_is_cached_and_sent_as_bearer(monkeypatch):
    automation._clear_reddit_oauth_token_cache()
    calls = {"token": 0, "api": 0}
    headers_seen: list[dict] = []

    class TokenResponse:
        status_code = 200
        headers: dict = {}

        def raise_for_status(self):
            return None

        def json(self) -> dict:
            return {"access_token": "test-access-token", "expires_in": 3600}

    class ApiResponse:
        status_code = 200
        headers = {"X-Ratelimit-Remaining": "99", "X-Ratelimit-Reset": "60"}

        def raise_for_status(self):
            return None

    def fake_post(*_args, **kwargs):
        calls["token"] += 1
        assert kwargs["auth"] == ("client-id", "client-secret")
        return TokenResponse()

    def fake_get(*_args, **kwargs):
        calls["api"] += 1
        headers_seen.append(kwargs["headers"])
        return ApiResponse()

    monkeypatch.setattr(automation.requests, "post", fake_post)
    monkeypatch.setattr(automation.requests, "get", fake_get)
    automation._reddit_oauth_request("/r/BollywoodFashion/new", "test-agent", "client-id", "client-secret")
    automation._reddit_oauth_request("/r/BollywoodFashion/new", "test-agent", "client-id", "client-secret")
    automation._clear_reddit_oauth_token_cache()

    assert calls == {"token": 1, "api": 2}
    assert headers_seen[0]["Authorization"] == "Bearer test-access-token"


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
    assert os.path.isfile(image_path)
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
