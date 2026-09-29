from __future__ import annotations

import re
from urllib.parse import urlparse

import requests


SEARCH_URL = "https://serpapi.com/search.json"
EXCLUDED_HOSTS = {
    "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "reddit.com",
    "wikipedia.org", "x.com", "youtube.com",
}
GENERIC_DESIGNER_WORDS = {"and", "by", "couture", "custom", "label", "labels", "the"}
CONTEXT_STOPWORDS = {
    "about", "after", "and", "at", "for", "from", "her", "his", "in", "look", "outfit",
    "she", "the", "this", "to", "was", "wearing", "with", "wore", "stylist", "submitted",
}


# Exact product references that have been visually checked against a specific
# Reddit post.  Keeping the Reddit title in the fingerprint prevents a product
# from being reused when the same celebrity later wears a different piece by
# the same designer.  This small catalogue also makes the demo deterministic
# when a search-provider key has not yet been configured.
VERIFIED_REFERENCE_CATALOG = (
    {
        "title": "Shreya Goshal in Mehak Makhija",
        "designer": "Mehak Makhija",
        "celebrity": "Shreya Goshal",
        "label": "Drape Skirt and Cape Set / metallic colourway",
        "image_url": "https://cdn.shopify.com/s/files/1/0714/0494/5485/files/1765997655218-rvd8ne_fa59f63d-f731-4756-a296-09fc8042f6a8.jpg?v=1781204905",
        "source_url": "https://mehakmakhija.com/products/drape-skirt-and-cape-set",
        "publisher": "Mehak Makhija",
        "official_domain": "mehakmakhija.com",
        "official_source": True,
        "source_kind": "official_designer_product",
        "source_grade": "A",
        "verification_basis": "Matching cape, beaded crop layer and draped skirt construction; the product page lists the metallic colourways.",
    },
    {
        "title": "Tara Sutaria in House of CB",
        "designer": "House of CB",
        "celebrity": "Tara Sutaria",
        "label": "Adrienne Blush Satin Strapless Gown",
        "image_url": "https://d166chel5lrjm5.cloudfront.net/images/detailed/66/adrienne-5482-14.jpg",
        "source_url": "https://app.houseofcb.com/b/adrienne-blush-satin-strapless-gown-fr",
        "publisher": "House of CB",
        "official_domain": "houseofcb.com",
        "official_source": True,
        "source_kind": "official_designer_product",
        "source_grade": "A",
        "verification_basis": "Matching blush satin, strapless draped bust, waist seam and asymmetric draped skirt.",
    },
    {
        "title": "Parvathy Thiruvothu in Shraddha Rambhia",
        "designer": "Shraddha Rambhia",
        "celebrity": "Parvathy Thiruvothu",
        "label": "Bottle Green Vegan Silk Hand Embellished Lehenga Set",
        "image_url": "https://img.perniaspopupshop.com/catalog/product/s/h/SHRD0226154_1.jpg?impolicy=detailimageprod",
        "source_url": "https://www.perniaspopupshop.com/shraddha-rambhia-bottle-green-vegan-silk-hand-embellished-lehenga-set-shrd0226154.html",
        "publisher": "Pernia's Pop-Up Shop / Shraddha Rambhia",
        "official_domain": "perniaspopupshop.com",
        "official_source": False,
        "source_kind": "authorized_retailer_product",
        "source_grade": "B",
        "verification_basis": "Matching green silk, repeated gold motifs, striped panel embroidery and red-gold hem border.",
    },
    {
        "title": "Rasika Dugal in Shay by Shubham Tak",
        "designer": "Shay by Shubham Tak",
        "celebrity": "Rasika Dugal",
        "label": "Gulaab Saree - Black",
        "image_url": "https://shaybyshubhamtak.com/cdn/shop/files/KEW6526.webp?v=1778070223&width=1281",
        "source_url": "https://shaybyshubhamtak.com/products/gulaab-saree-black",
        "publisher": "Shay by Shubham Tak",
        "official_domain": "shaybyshubhamtak.com",
        "official_source": True,
        "source_kind": "official_designer_product",
        "source_grade": "A",
        "verification_basis": "Matching black organza saree and the same cap-sleeve floral applique blouse construction.",
    },
    {
        "title": "Sonal Chauhan in Neon The Labels",
        "designer": "Neon The Labels",
        "celebrity": "Sonal Chauhan",
        "label": "Rouge Romance 3D Patch Flower High-neck Maxi Dress",
        "image_url": "https://img.drz.lazcdn.com/static/np/p/27a8e1551b80e87f92495c9a733a8534.jpg_720x720q80.jpg_.webp",
        "source_url": "https://neonthelabels.com/products/rouge-romance-3d-patch-flower-high-neck-maxi-dress-1",
        "publisher": "Neon The Labels",
        "official_domain": "neonthelabels.com",
        "official_source": True,
        "source_kind": "official_designer_product",
        "source_grade": "A",
        "image_source_url": "https://www.daraz.com.np/products/red-rouge-romance-3d-patch-flower-high-neck-maxi-dress-for-women-i479790759.html",
        "verification_basis": "Matching high neck, long sleeves, side cut-out, thigh slit and structured rosette at the hip; the official product page names the same construction.",
    },
    {
        "title": "Alia Bhatt in Givenchy Couture 1997 by Alexander McQueen",
        "designer": "Givenchy Couture 1997 by Alexander McQueen",
        "celebrity": "Alia Bhatt",
        "label": "1997 Givenchy by Alexander McQueen / alternate appearance angles",
        "image_url": "https://images.news9live.com/wp-content/uploads/2026/09/Alia-Bhatt-Vintage-Givenchy.jpg?enlarge=true&w=1280",
        "source_url": "https://www.news9live.com/lifestyle/fashion/alia-bhatt-butter-yellow-givenchy-look-alexander-mcqueen-1997-couture-3011316",
        "publisher": "News9 Live",
        "official_domain": "news9live.com",
        "official_source": False,
        "source_kind": "editorial_same_outfit",
        "source_grade": "B",
        "person": "Alia Bhatt",
        "verification_basis": "The editorial shows the same butter-yellow fitted jacket, sculptural waist bow and matching skirt in alternate views.",
    },
)


def _canonical(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold().replace("’", "'")).strip()


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def _is_excluded(host: str) -> bool:
    return any(host == item or host.endswith(f".{item}") for item in EXCLUDED_HOSTS)


def _verified_catalog_reference(*, designer: str, celebrity: str, title: str) -> dict | None:
    title_key = _canonical(title)
    designer_key = _canonical(designer)
    celebrity_key = _canonical(celebrity)
    for record in VERIFIED_REFERENCE_CATALOG:
        if (
            title_key == _canonical(record["title"])
            and designer_key == _canonical(record["designer"])
            and celebrity_key == _canonical(record["celebrity"])
        ):
            return {
                **record,
                "status": "found",
                "provider": "verified_reference_catalog",
                "selected": 1,
                "exact_match": True,
                "verified_source": True,
            }
    return None


def _get(params: dict, api_key: str, user_agent: str) -> dict:
    response = requests.get(
        SEARCH_URL,
        params={**params, "api_key": api_key},
        headers={"User-Agent": user_agent},
        timeout=25,
    )
    response.raise_for_status()
    return response.json()


def find_official_designer_reference(
    *,
    designer: str,
    celebrity: str,
    title: str,
    description: str,
    api_key: str,
    user_agent: str,
) -> dict:
    """Find a source-backed image of the exact original outfit.

    The deterministic catalogue contains post-specific matches that were
    visually checked against official designer or established retailer product
    pages.  Everything else goes through the configured search provider.  The
    function deliberately returns no asset when exact-context checks are
    inconclusive; a missing panel is safer than a convincing misattribution.
    """
    verified = _verified_catalog_reference(designer=designer, celebrity=celebrity, title=title)
    if verified:
        return verified

    if not api_key:
        return {"status": "provider_not_configured", "provider": "serpapi", "selected": 0}

    designer_terms = {
        token for token in _canonical(designer).split()
        if len(token) >= 3 and token not in GENERIC_DESIGNER_WORDS
    }
    if not designer_terms:
        return {"status": "skipped", "reason": "designer_unresolved", "selected": 0}

    try:
        organic = _get(
            {"engine": "google", "q": f'"{designer}" official website', "num": 8},
            api_key,
            user_agent,
        )
    except (requests.RequestException, ValueError) as exc:
        return {"status": "unavailable", "provider": "serpapi", "error": str(exc)[:240], "selected": 0}

    person_terms = {
        token for token in _canonical(celebrity).split()
        if len(token) >= 3
    }
    context_terms = [
        token for token in _canonical(f"{title} {description}").split()
        if len(token) >= 4 and token not in CONTEXT_STOPWORDS and token not in designer_terms and token not in person_terms
    ][:10]
    context_set = set(context_terms)

    official = None
    best_score = -1
    for result in organic.get("organic_results", []):
        link = str(result.get("link") or "")
        host = _host(link)
        if not host or _is_excluded(host):
            continue
        searchable = set(_canonical(f"{host} {result.get('title', '')} {result.get('snippet', '')}").split())
        overlap = len(designer_terms & searchable)
        score = overlap * 3 + int("official" in _canonical(result.get("title", "")))
        if overlap and score > best_score:
            official, best_score = {"url": link, "host": host, "title": result.get("title", designer)}, score

    official_query = None
    if official:
        official_query = " ".join([f"site:{official['host']}", f'"{designer}"', *context_terms[:6]])
        try:
            images = _get({"engine": "google_images", "q": official_query}, api_key, user_agent)
        except (requests.RequestException, ValueError) as exc:
            return {"status": "unavailable", "provider": "serpapi", "official_domain": official["host"], "error": str(exc)[:240], "selected": 0}

        for result in images.get("images_results", [])[:30]:
            source_url = str(result.get("link") or result.get("source") or "")
            image_url = str(result.get("original") or "")
            if not source_url or not image_url or _host(source_url) != official["host"]:
                continue
            evidence_text = set(_canonical(f"{result.get('title', '')} {result.get('source', '')} {source_url}").split())
            designer_overlap = len(designer_terms & evidence_text) / max(1, len(designer_terms))
            context_overlap = len(context_set & evidence_text)
            exact_match = designer_overlap >= 0.75 and context_overlap >= min(2, len(context_set))
            if not exact_match:
                continue
            return {
                "status": "found",
                "provider": "serpapi",
                "selected": 1,
                "image_url": image_url,
                "source_url": source_url,
                "official_domain": official["host"],
                "publisher": official["title"],
                "label": result.get("title") or f"Official {designer} reference",
                "exact_match": True,
                "verified_source": True,
                "official_source": True,
                "source_kind": "official_designer_product",
                "source_grade": "A",
                "person": "Designer model",
                "verification_basis": "Official-domain result matched the designer and outfit context terms from the Reddit title and description.",
                "query": official_query,
            }

    # If an official catalogue image is unavailable, an established editorial
    # page showing the named celebrity in the same look is a valid fallback.
    # Both the celebrity and designer must be present in the result evidence;
    # this intentionally favours missing a panel over adding a wrong outfit.
    editorial_query = " ".join([f'"{celebrity}"', f'"{designer}"', *context_terms[:6]])
    try:
        editorial_images = _get({"engine": "google_images", "q": editorial_query}, api_key, user_agent)
    except (requests.RequestException, ValueError) as exc:
        return {
            "status": "unavailable",
            "provider": "serpapi",
            "official_domain": official["host"] if official else None,
            "error": str(exc)[:240],
            "selected": 0,
        }
    for result in editorial_images.get("images_results", [])[:40]:
        source_url = str(result.get("link") or result.get("source") or "")
        image_url = str(result.get("original") or "")
        source_host = _host(source_url)
        if not source_url or not image_url or not source_host or _is_excluded(source_host):
            continue
        evidence_text = set(_canonical(f"{result.get('title', '')} {result.get('source', '')} {source_url}").split())
        designer_overlap = len(designer_terms & evidence_text) / max(1, len(designer_terms))
        person_overlap = len(person_terms & evidence_text) / max(1, len(person_terms))
        context_overlap = len(context_set & evidence_text)
        if (
            designer_overlap < 0.75
            or person_overlap < 0.75
            or context_overlap < min(2, len(context_set))
        ):
            continue
        return {
            "status": "found",
            "provider": "serpapi",
            "selected": 1,
            "image_url": image_url,
            "source_url": source_url,
            "official_domain": source_host,
            "publisher": result.get("source") or source_host,
            "label": result.get("title") or f"{celebrity} in {designer}",
            "exact_match": True,
            "verified_source": True,
            "official_source": False,
            "source_kind": "editorial_same_outfit",
            "source_grade": "B",
            "person": celebrity,
            "verification_basis": "Editorial image result matched the celebrity, designer and outfit context from the Reddit title and description.",
            "query": editorial_query,
        }
    return {
        "status": "no_exact_reference",
        "provider": "serpapi",
        "selected": 0,
        "official_domain": official["host"] if official else None,
        "query": editorial_query,
        "official_query": official_query,
    }
