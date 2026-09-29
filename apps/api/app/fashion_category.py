from __future__ import annotations

import re


VALID_FASHION_CATEGORIES = {"women", "men", "mixed", "unclassified"}

# Name hints are a fallback for concise Reddit titles that contain no pronouns.
# Editors can always override the resulting content-desk assignment.
KNOWN_WOMEN = {
    "aishwarya rai", "alaya f", "alia bhatt", "ananya panday", "bhagyashree borse",
    "deepika padukone", "diana penty", "janhvi kapoor", "kajol", "kalyani priyadarshan",
    "kareena kapoor", "karishma kapoor", "kiara advani", "komal pandey", "kriti sanon",
    "malaika arora", "malavika mohanan", "parvathy thiruvothu", "priyanka chopra",
    "rasika dugal", "sai pallavi", "samantha ruth prabhu", "sandeepa dhar", "sara ali khan",
    "shilpa shetty", "shreya goshal", "simone ashley", "sonal chauhan", "sonam kapoor",
    "tara sutaria", "triptii dimri", "vidya balan",
}
KNOWN_MEN = {
    "aditya roy kapur", "akshay kumar", "amitabh bachchan", "arjun kapoor", "ayushmann khurrana",
    "diljit dosanjh", "hrithik roshan", "ishaan khatter", "kartik aaryan", "ranbir kapoor",
    "ranveer singh", "saif ali khan", "shahid kapoor", "shah rukh khan", "siddharth batra",
    "sidharth malhotra", "varun dhawan", "vicky kaushal",
}

WOMEN_SIGNALS = {"she", "her", "hers", "woman", "women", "actress", "bride", "female"}
MEN_SIGNALS = {"he", "him", "his", "man", "men", "groom", "male"}


def _canonical(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _contains_name(text: str, names: set[str]) -> bool:
    padded = f" {text} "
    return any(f" {name} " in padded for name in names)


def _signal_count(text: str, signals: set[str]) -> int:
    tokens = set(text.split())
    return len(tokens & signals)


def classify_fashion_category(celebrity: str, title: str = "", description: str = "") -> str:
    """Assign a reversible editorial section using explicit textual evidence."""
    person = _canonical(celebrity)
    text = _canonical(f"{title} {description}")
    known_woman = _contains_name(person, KNOWN_WOMEN)
    known_man = _contains_name(person, KNOWN_MEN)
    if known_woman and known_man:
        return "mixed"
    if known_woman:
        return "women"
    if known_man:
        return "men"

    women_score = _signal_count(text, WOMEN_SIGNALS)
    men_score = _signal_count(text, MEN_SIGNALS)
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
    if explicit in VALID_FASHION_CATEGORIES:
        return explicit
    return classify_fashion_category(case.celebrity, case.source_title, case.source_body)
