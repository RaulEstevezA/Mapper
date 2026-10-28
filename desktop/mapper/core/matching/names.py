"""Name comparison for the matching engine. Mirrors web/src/core/matching/names.ts. Every rule gives a score
from 0 to 1 and the reason, so the interface can explain each suggestion (docs/mapping-engine.md)."""

import math

from ..model.naming import name_words, singularize

# Abbreviations expanded before comparing (qty → quantity)
ABBREVIATIONS = {
    "qty": ["quantity"],
    "amt": ["amount"],
    "addr": ["address"],
    "desc": ["description"],
    "descr": ["description"],
    "img": ["image"],
    "pic": ["picture"],
    "num": ["number"],
    "nr": ["number"],
    "no": ["number"],
    "tel": ["phone"],
    "msg": ["message"],
    "cnt": ["count"],
    "dt": ["date"],
    "ts": ["timestamp"],
    "dept": ["department"],
    "mgr": ["manager"],
    "emp": ["employee"],
    "cust": ["customer"],
    "prod": ["product"],
    "acct": ["account"],
    "pwd": ["password"],
    "pw": ["password"],
    "passwd": ["password"],
    "info": ["information"],
    "ref": ["reference"],
    "src": ["source"],
    "dst": ["destination"],
    "dest": ["destination"],
    "lang": ["language"],
    "cfg": ["configuration"],
    "config": ["configuration"],
    "org": ["organization"],
    "qtty": ["quantity"],
    "fname": ["first", "name"],
    "lname": ["last", "name"],
    "dob": ["birth", "date"],
    "pk": ["id"],
    "uid": ["user", "id"],
}

# Single words that stand for several (surname is "last name")
COMPOUNDS = {
    "surname": ["last", "name"],
    "forename": ["first", "name"],
    "firstname": ["first", "name"],
    "lastname": ["last", "name"],
    "fullname": ["full", "name"],
    "birthday": ["birth", "date"],
    "birthdate": ["birth", "date"],
    "zipcode": ["postal", "code"],
    "zip": ["postal", "code"],
    "postcode": ["postal", "code"],
    "postalcode": ["postal", "code"],
    "phonenumber": ["phone"],
    "emailaddress": ["email"],
    "mail": ["email"],
    "telephone": ["phone"],
    "mobile": ["phone"],
    "cellphone": ["phone"],
    "cell": ["phone"],
    "identifier": ["id"],
    "createdat": ["created"],
    "updatedat": ["updated"],
    "timestamp": ["time"],
}

# Words with the same meaning; the first is the canonical one. Strong groups are near certain; weak groups
# are only likely and stay "probable" at most.
STRONG_SYNONYMS = [
    ["created", "creation", "create", "inserted", "added"],
    ["updated", "modified", "changed", "update", "modification", "edited"],
    ["deleted", "removed", "deletion"],
    ["given", "first"],
    ["family", "last"],
    ["description", "details"],
    ["url", "uri", "link", "href"],
    ["image", "picture", "photo"],
    ["quantity", "units"],
    ["active", "enabled"],
    ["comment", "note", "notes", "remarks", "comments"],
    ["company", "organization", "organisation"],
    ["category", "categories"],
    ["gender", "sex"],
    ["postal", "zip"],
]

WEAK_SYNONYMS = [
    ["price", "cost"],
    ["amount", "total", "sum"],
    ["name", "title", "label"],
    ["city", "town", "locality"],
    ["state", "province", "region"],
    ["country", "nation"],
    ["street", "line"],
    ["count", "number", "total"],
    ["username", "login", "handle"],
    ["avatar", "image"],
    ["customer", "client"],
    ["product", "item", "article"],
    ["item", "line", "entry"],
    ["order", "purchase"],
]

# Words that add no meaning when comparing (createdAt and creation_date are the same moment)
_STOP_WORDS = {"at", "on", "of", "the", "a", "an", "by", "in", "is", "has", "was"}
_TEMPORAL = {"date", "time", "datetime", "timestamp", "when"}
# Keys whose meaning does not change when the model name is added or removed (userId in User is id)
_KEY_WORDS = {"id", "key", "code", "number", "uuid", "guid", "ref"}

_STRONG_INDEX = {word: group[0] for group in STRONG_SYNONYMS for word in group}
_WEAK_INDEX: dict[str, set[int]] = {}
for _index, _group in enumerate(WEAK_SYNONYMS):
    for _word in _group:
        _WEAK_INDEX.setdefault(_word, set()).add(_index)

# Phrases that say the same as a shorter one (emailAddress is the email, phoneNumber the phone)
_PHRASES = [
    (["email", "address"], ["email"]),
    (["e", "mail"], ["email"]),
    (["phone", "number"], ["phone"]),
    (["zip", "code"], ["postal", "code"]),
    (["post", "code"], ["postal", "code"]),
    (["user", "name"], ["username"]),
    (["date", "birth"], ["birth", "date"]),
]


def _collapse_phrases(words: list[str]) -> list[str]:
    result: list[str] = []
    index = 0
    while index < len(words):
        phrase = next(
            (
                (source, replacement)
                for source, replacement in _PHRASES
                if all(
                    index + offset < len(words) and words[index + offset] == word for offset, word in enumerate(source)
                )
            ),
            None,
        )
        if phrase:
            result.extend(phrase[1])
            index += len(phrase[0])
        else:
            result.append(words[index])
            index += 1
    return result


def expanded_words(name: str) -> list[str]:
    """Words of a name, expanded: abbreviations, compound words, plurals, phrases."""
    return expand_word_list(name_words(name))


def expand_word_list(words: list[str]) -> list[str]:
    """The same for words already split (the words of a path, address.zipCode)."""
    expanded: list[str] = []
    for word in words:
        if word in ABBREVIATIONS:
            expanded.extend(ABBREVIATIONS[word])
        elif word in COMPOUNDS:
            expanded.extend(COMPOUNDS[word])
        else:
            singular = singularize(word)
            expanded.extend(COMPOUNDS[singular] if singular in COMPOUNDS else [singular])
    return _collapse_phrases(expanded)


# Suffixes of model names that say what the model is for, not what it holds (UserDto holds a user)
_MODEL_SUFFIXES = {
    "dto",
    "entity",
    "model",
    "request",
    "response",
    "api",
    "data",
    "record",
    "schema",
    "payload",
    "view",
    "vm",
    "dao",
    "bean",
    "pojo",
    "input",
    "output",
    "resource",
    "details",
    "info",
    "type",
    "object",
    "row",
    "table",
}


def model_words(name: str) -> list[str]:
    """Words of a model name for context matching, without the role suffixes: UserDto → user."""
    words = name_words(name)
    while len(words) > 1 and words[-1] in _MODEL_SUFFIXES:
        words.pop()
    return words


def meaning_words(words: list[str]) -> list[str]:
    """Words reduced to their meaning: stop words out, synonyms canonical, a trailing "date" or "time" dropped
    when something else remains (created_at, creation_date and createdOn are all "created")."""
    result = [_STRONG_INDEX.get(word, word) for word in words if word not in _STOP_WORDS]
    while len(result) > 1 and result[-1] in _TEMPORAL:
        result = result[:-1]
    return result


def _same_set(a: list[str], b: list[str]) -> bool:
    return len(a) == len(b) and sorted(a) == sorted(b)


def _weak_same(a: list[str], b: list[str]) -> bool:
    if len(a) != len(b) or not a:
        return False
    used: set[int] = set()
    for word in a:
        groups = _WEAK_INDEX.get(word)
        found = -1
        for position, other in enumerate(b):
            if position in used:
                continue
            if other == word or (groups is not None and any(group in groups for group in _WEAK_INDEX.get(other, ()))):
                found = position
                break
        if found == -1:
            return False
        used.add(found)
    return True


def jaro_winkler(a: str, b: str) -> float:
    """Jaro-Winkler similarity of two strings, from 0 to 1."""
    if a == b:
        return 1
    if not a or not b:
        return 0
    window = max(0, max(len(a), len(b)) // 2 - 1)
    a_matches = [False] * len(a)
    b_matches = [False] * len(b)
    matches = 0
    for i in range(len(a)):
        for j in range(max(0, i - window), min(len(b), i + window + 1)):
            if b_matches[j] or a[i] != b[j]:
                continue
            a_matches[i] = b_matches[j] = True
            matches += 1
            break
    if matches == 0:
        return 0
    transpositions = 0
    k = 0
    for i in range(len(a)):
        if not a_matches[i]:
            continue
        while not b_matches[k]:
            k += 1
        if a[i] != b[k]:
            transpositions += 1
        k += 1
    jaro = (matches / len(a) + matches / len(b) + (matches - transpositions / 2) / matches) / 3
    prefix = 0
    while prefix < min(4, len(a), len(b)) and a[prefix] == b[prefix]:
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def _dice(a: list[str], b: list[str]) -> float:
    """Share of words in common (Dice coefficient)."""
    if not a and not b:
        return 1
    remaining = list(b)
    common = 0
    for word in a:
        if word in remaining:
            common += 1
            remaining.remove(word)
    return (2 * common) / (len(a) + len(b))


def _containment(a: list[str], b: list[str]) -> float:
    """How much of the words of one name appear inside the other's (username contains name)."""
    joined_a = "".join(a)
    joined_b = "".join(b)

    def covered(words: list[str], text: str) -> int:
        return sum(len(word) for word in words if len(word) >= 3 and word in text)

    cover_a = covered(b, joined_a) / len(joined_a) if joined_a else 0
    cover_b = covered(a, joined_b) / len(joined_b) if joined_b else 0
    return min(1, (cover_a + cover_b) / 2)


def _strip_model(words: list[str], model: list[str]) -> list[str]:
    if not model or len(words) <= len(model):
        return words
    return words[len(model) :] if all(words[index] == word for index, word in enumerate(model)) else words


class _Analysis:
    __slots__ = ("raw", "expanded", "meaning")

    def __init__(self, words: list[str]):
        self.raw = " ".join(words)
        self.expanded = expand_word_list(words)
        self.meaning = meaning_words(self.expanded)


# Every name is compared with many others: its words are worked out once
_ANALYSES: dict[str, _Analysis] = {}


def _analyze(words: list[str]) -> _Analysis:
    raw = " ".join(words)
    analysis = _ANALYSES.get(raw)
    if analysis is None:
        analysis = _Analysis(words)
        # A bound so a long session with many inputs does not keep every name forever
        if len(_ANALYSES) > 20000:
            _ANALYSES.clear()
        _ANALYSES[raw] = analysis
    return analysis


def compare_names(source_name: str, source_words: list[str], target_name: str, context: dict) -> dict | None:
    """Scores how well a source name matches a target name: {"score", "reason", "similarity"?}. source_words
    may come from a path (address.city → address city); context holds the words of both models
    ("sourceModel", "targetModel"). Returns None when they have nothing in common."""
    if source_name == target_name:
        return {"score": 1, "reason": "sameName"}
    source_analysis = _analyze(source_words)
    target_analysis = _analyze(name_words(target_name))
    if source_analysis.raw == target_analysis.raw:
        return {"score": 0.97, "reason": "sameWords"}

    if _same_set(source_analysis.expanded, target_analysis.expanded):
        return {"score": 0.93, "reason": "abbreviation"}

    source_meaning = source_analysis.meaning
    target_meaning = target_analysis.meaning
    if _same_set(source_meaning, target_meaning):
        return {"score": 0.88, "reason": "synonym"}

    # The model name added to a key: id in User and user_id. Either model's name counts on either side: a
    # JSON document has no model name of its own, but its invoice_id is the id of the target model Invoice
    for model in (context["sourceModel"], context["targetModel"]):
        stripped_source = _strip_model(source_meaning, model)
        stripped_target = _strip_model(target_meaning, model)
        changed = stripped_source is not source_meaning or stripped_target is not target_meaning
        if changed and _same_set(stripped_source, stripped_target):
            is_key = len(stripped_source) == 1 and stripped_source[0] in _KEY_WORDS
            return {"score": 0.9 if is_key else 0.75, "reason": "modelContext"}

    if _weak_same(source_meaning, target_meaning):
        return {"score": 0.74, "reason": "synonym"}

    # fuzzy ≥ 0.75 needs a Dice of at least 0.5: Jaro-Winkler, the costly part, is computed only then
    words = _dice(source_meaning, target_meaning)
    fuzzy = 0.5 * words + 0.5 * jaro_winkler("".join(source_meaning), "".join(target_meaning)) if words >= 0.5 else 0
    contained = _containment(source_meaning, target_meaning)
    # Fuzzy similarity alone never reaches "high": a similar name is not the same name
    fuzzy_score = fuzzy * 0.85 if fuzzy >= 0.75 else 0
    contained_score = contained * 0.75 if contained >= 0.5 else 0
    if fuzzy_score == 0 and contained_score == 0:
        return None
    if fuzzy_score >= contained_score:
        return {"score": fuzzy_score, "reason": "similarName", "similarity": math.floor(fuzzy * 100)}
    return {"score": contained_score, "reason": "containsName", "similarity": math.floor(contained * 100)}
