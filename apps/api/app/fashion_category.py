from __future__ import annotations

import re


VALID_FASHION_CATEGORIES = {"women", "men", "mixed", "unclassified"}

# Name hints are a fallback for concise Reddit titles that contain no pronouns.
# Editors can always override the resulting content-desk assignment.
KNOWN_WOMEN = {
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
    """Assign a reversible editorial section using explicit textual evidence."""
    text = _canonical(f"{celebrity} {title} {description}")
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
    inferred = classify_fashion_category(case.celebrity, case.source_title, case.source_body)
    # A post with supported women-and-men evidence belongs in Both even when
    # an older single-desk label was saved before group detection improved.
    if inferred == "mixed":
        return "mixed"
    if explicit in VALID_FASHION_CATEGORIES:
        return explicit
    return inferred
