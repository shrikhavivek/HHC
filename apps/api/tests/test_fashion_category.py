from types import SimpleNamespace

from app.fashion_category import case_fashion_category, classify_fashion_category


def test_known_people_are_routed_to_editorial_fashion_sections():
    assert classify_fashion_category("Alia Bhatt", "Alia Bhatt in Gucci") == "women"
    assert classify_fashion_category("Arjun Kapoor", "Arjun Kapoor in Acne Studios") == "men"


def test_joint_posts_are_available_to_both_content_desks():
    assert classify_fashion_category(
        "Komal Pandey and Siddharth Batra",
        "Komal Pandey and Siddharth Batra at a fashion show",
    ) == "mixed"


def test_group_description_with_women_and_men_is_routed_to_both_desks():
    assert classify_fashion_category(
        "Celebrities attend a designer preview",
        "Celebrities attend a private flagship preview",
        "Anshula Kapoor, Sushmita Sen, Babil Khan and Manushi Chhillar attended together.",
    ) == "mixed"


def test_compact_social_handle_and_plural_titles_are_understood():
    assert classify_fashion_category(
        'Eka on Instagram: "Arriving in style"',
        "@ranveersingh for BMW India",
    ) == "men"
    assert classify_fashion_category(
        "Koffee With Karan favourites",
        "Top looks of actresses from the season",
    ) == "women"
    assert classify_fashion_category("Sreeleela", "Sreeleela in Saaksha & Kinni") == "women"


def test_editor_override_wins_over_automatic_classification():
    case = SimpleNamespace(
        celebrity="Unresolved Person",
        source_title="A red carpet look",
        source_body="",
        extraction={"fashion_category": "men"},
    )
    assert case_fashion_category(case) == "men"


def test_mixed_evidence_repairs_an_older_single_desk_label():
    case = SimpleNamespace(
        celebrity="Komal Pandey and Siddharth Batra",
        source_title="Komal Pandey and Siddharth Batra at a fashion show",
        source_body="",
        extraction={"fashion_category": "men"},
    )
    assert case_fashion_category(case) == "mixed"
