from __future__ import annotations

import re


VALID_FASHION_CATEGORIES = {"women", "men", "mixed", "unclassified"}

# Name hints are a fallback for concise Reddit titles that contain no pronouns.
# Editors can always override the resulting content-desk assignment.
KNOWN_WOMEN = {
    "gauri khan", "bhavana pandey", "nita ambani", "khushi kapoor", "jacqueline fernandez",
    "isha ambani", "genelia d souza", "kusha kapila", "radhika ambani", "shanaya kapoor",
    "rashmika mandanna", "shweta tripathi",
    "rakul preet singh", "kritika kamra", "ankita chawla", "ritu varma", "yami gautam",
    "bhavitha mandava", "shloka ambani", "rysa panday",
    "katrina kaif", "kangana ranaut",
    "aditi rao hydari", "aishwarya rai", "alaya f", "alia bhatt", "ananya panday",
    "anjini dhawan", "anshula kapoor", "asha parekh", "bhagyashree borse", "deepika padukone",
    "diana penty", "esha gupta", "janhvi kapoor", "jonita gandhi", "kajol",
    "kalyani priyadarshan", "kareena kapoor", "karishma kapoor", "keerthy suresh",
    "kiara advani", "komal pandey", "kriti sanon", "lisa haydon", "madhoo shah",
    "malaika arora", "malavika mohanan", "manushi chhillar", "medha rana", "mrunal thakur",
    "natasha poonawalla", "neha dhupia", "parineeti chopra", "parvathy thiruvothu",
    "priyanka chopra", "rasika dugal", "sai pallavi", "samantha ruth prabhu",
    "sandeepa dhar", "sara ali khan", "shilpa shetty", "shreya goshal", "simone ashley",
    "sonal chauhan", "sonali bendre", "sonam kapoor", "sreeleela", "sushmita sen",
    "tamannaah bhatia", "tara sutaria", "triptii dimri", "vidya balan",
}
KNOWN_MEN = {
    "abhay verma", "abhay deol", "vijay varma", "rajkummar rao", "sidhant gupta",
    "ibrahim ali khan", "vedang raina", "agastya nanda", "ishaan khattar", "karan johar",
    "aditya roy kapur", "akshay kumar", "amitabh bachchan", "arjun kapoor", "ayushmann khurrana",
    "babil khan", "diljit dosanjh", "hrithik roshan", "ishaan khatter", "kartik aaryan",
    "ranbir kapoor", "ranveer singh", "saif ali khan", "shahid kapoor", "shah rukh khan",
    "siddhant chaturvedi", "siddharth batra", "sidharth malhotra", "varun dhawan", "vicky kaushal",
}

WOMEN_SIGNALS = {
    "she", "her", "hers", "woman", "women", "womenswear", "actress", "actresses", "bride",
    "brides", "female", "girl", "girls", "lady", "ladies", "daughter", "daughters", "mother",
    "mothers", "wife", "wives", "sister", "sisters", "niece", "nieces",
}
MEN_SIGNALS = {
    "he", "him", "his", "man", "men", "menswear", "groom", "grooms", "male", "boy", "boys",
    "gentleman", "gentlemen", "son", "sons", "father", "fathers", "husband", "husbands",
    "brother", "brothers", "nephew", "nephews",
}
GROUP_SIGNALS = {"with", "alongside", "couple", "duo", "pair", "group", "celebrities", "together"}


def _canonical(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _contains_name(text: str, names: set[str]) -> bool:
    padded = f" {text} "
    tokens = set(text.split())
    return any(
        f" {name} " in padded or name.replace(" ", "") in tokens
        for name in names
    )


def _signal_count(text: str, signals: set[str]) -> int:
    tokens = set(text.split())
    return len(tokens & signals)


def classify_fashion_category(celebrity: str, title: str = "", description: str = "") -> str:
    """The title's main subjects take precedence over other people in a gallery."""
    title_category = _classify_subjects("", title)
    if title_category != "unclassified":
        return title_category
    celebrity_category = _classify_subjects(celebrity)
    if celebrity_category != "unclassified":
        return celebrity_category
    # A generic group title can use explicit joint-appearance context.
    if _signal_count(_canonical(title), GROUP_SIGNALS):
        return _classify_subjects(celebrity, title, description)
    return "unclassified"


def _classify_subjects(celebrity: str, title: str = "", description: str = "") -> str:
    """Assign a reversible editorial section using explicit textual evidence."""
    # Credits and historical comparisons do not identify people in this photo.
    subjects = " ".join(re.split(r"\b(?:in|wearing|styled by|outfit by|photographed by)\b", value, maxsplit=1, flags=re.I)[0] for value in (celebrity, title))
    group_description = description if re.search(r"\b(?:attended together|pictured together|posing together|photographed together)\b", description, re.I) else ""
    text = _canonical(f"{subjects} {group_description}")
    known_woman = _contains_name(text, KNOWN_WOMEN)
    known_man = _contains_name(text, KNOWN_MEN)
    if known_woman and known_man:
        return "mixed"

    women_score = _signal_count(text, WOMEN_SIGNALS)
    men_score = _signal_count(text, MEN_SIGNALS)
    group_context = bool(_signal_count(_canonical(f"{celebrity} {title}"), GROUP_SIGNALS))
    if known_woman and men_score and group_context:
        return "mixed"
    if known_man and women_score and group_context:
        return "mixed"
    if known_woman:
        return "women"
    if known_man:
        return "men"
    if women_score and men_score:
        return "mixed"
    if women_score:
        return "women"
    if men_score:
        return "men"
    return "unclassified"


def case_fashion_category(case) -> str:
    extraction = case.extraction if isinstance(case.extraction, dict) else {}
    explicit = str(extraction.get("fashion_category") or "").casefold()
    if extraction.get("fashion_category_source") == "editor_confirmed" and explicit in VALID_FASHION_CATEGORIES:
        return explicit
    inferred = classify_fashion_category(case.celebrity, case.source_title, case.source_body)
    # Recompute automatic labels with the title-first rule; retain human edits.
    if inferred != "unclassified":
        return inferred
    if explicit in VALID_FASHION_CATEGORIES and explicit != "unclassified":
        return explicit
    return inferred
