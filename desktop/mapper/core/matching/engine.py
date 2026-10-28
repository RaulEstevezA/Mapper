"""The automatic matching engine: proposes, for every target field, the source that most likely gives its
value, with a confidence. Mirrors web/src/core/matching/engine.ts. It never resolves an ambiguity: close
alternatives become a conflict that the user decides (docs/mapping-engine.md).

A candidate is {"sources", "transform", "score", "confidence", "reasons"}; a source option {"path", "field",
"words", "nullablePath"}.
"""

import re

from ..js import coalesce, js_string
from ..mapping.types import mapping_id, path_key
from ..model.compatibility import compatibility
from ..model.naming import name_words
from ..model.schema import all_fields, find_enum, find_model, needs_value
from .names import compare_names, expanded_words, meaning_words, model_words

# Thresholds of the confidence scale. Only identical names (or the same name on the wire) are exact: a
# convention change is "high"
EXACT = 0.99
HIGH = 0.85
PROBABLE = 0.7
REVIEW = 0.5
# Two candidates closer than this are ambiguous
MARGIN = 0.06
# Nested fields are offered as sources down to this depth (customer.address.city)
MAX_DEPTH = 3
# A path through a nested object is slightly less likely than a field of the model itself
FLATTEN_FACTOR = 0.96


def confidence_of(score: float) -> str:
    if score >= EXACT:
        return "exact"
    if score >= HIGH:
        return "high"
    if score >= PROBABLE:
        return "probable"
    if score >= REVIEW:
        return "review"
    return "none"


def source_options(
    schema: dict,
    model: dict,
    depth: int = 1,
    prefix: list | None = None,
    nullable_prefix: bool = False,
    seen: set | None = None,
) -> list[dict]:
    """Fields of the source model and of its nested objects, as paths. Lists are not entered: their elements
    are mapped by a collection."""
    prefix = prefix or []
    seen = seen or set()
    options: list[dict] = []
    if model["name"] in seen:
        return options
    next_seen = seen | {model["name"]}
    for field in all_fields(schema, model):
        path = [*prefix, field["name"]]
        words = [word for part in path for word in name_words(part)]
        options.append({"path": path, "field": field, "words": words, "nullablePath": nullable_prefix})
        if field["type"]["kind"] == "model" and depth < MAX_DEPTH:
            nested = find_model(schema, field["type"]["name"])
            if nested:
                nullable = nullable_prefix or field["nullable"] or field["optional"]
                options.extend(source_options(schema, nested, depth + 1, path, nullable, next_seen))
    return options


class _Context:
    def __init__(self, source: dict, target: dict, mappings: dict | None = None):
        self.source = source
        self.target = target
        self.mappings: dict[str, dict] = mappings if mappings is not None else {}


def _inner_collection(type_ref: dict) -> dict:
    if type_ref["kind"] == "array":
        return type_ref["items"]
    if type_ref["kind"] == "map":
        return type_ref["value"]
    return type_ref


def _type_factor(result: dict, source_type: dict, target_type: dict, context: _Context) -> float:
    """How likely a value of source type can fill a field of target type, from 0 to 1."""
    level = result["level"]
    if level == "same":
        return 1
    if level == "widening":
        return 0.98
    if level == "conversion":
        return 0.88 if result.get("fallible") else 0.85 if result.get("lossy") else 0.9
    if level == "transform":
        return 0.6
    if level == "nested":
        return 0.6 + 0.4 * _structural_similarity(source_type, target_type, context)
    if level == "collection":
        if "items" not in result:
            return 0.9
        return _type_factor(result["items"], _inner_collection(source_type), _inner_collection(target_type), context)
    return 0


def _structural_similarity(source_type: dict, target_type: dict, context: _Context) -> float:
    """Share of the target model's fields that some source field matches by name."""
    if source_type["kind"] != "model" or target_type["kind"] != "model":
        return 0
    source_model = find_model(context.source, source_type["name"])
    target_model = find_model(context.target, target_type["name"])
    if not source_model or not target_model:
        return 0
    target_fields = all_fields(context.target, target_model)
    if not target_fields:
        return 0
    source_fields = all_fields(context.source, source_model)
    names = {"sourceModel": model_words(source_model["name"]), "targetModel": model_words(target_model["name"])}
    matched = 0
    for target_field in target_fields:
        for source_field in source_fields:
            match = compare_names(source_field["name"], name_words(source_field["name"]), target_field["name"], names)
            if (match["score"] if match else 0) >= PROBABLE:
                matched += 1
                break
    return matched / len(target_fields)


def _compatibility_reasons(result: dict, source_nullable: bool, target: dict) -> list[dict]:
    reasons: list[dict] = []
    items = result.get("items")
    level = (items["level"] if items else "same") if result["level"] == "collection" else result["level"]
    if level == "conversion":
        if result.get("fallible") or (items and items.get("fallible")):
            reasons.append({"code": "typeFallible"})
        elif result.get("lossy"):
            reasons.append({"code": "typeLossy"})
        else:
            reasons.append({"code": "typeConversion"})
    if level == "transform":
        reasons.append({"code": "typeTransform"})
    if level == "nested":
        reasons.append({"code": "nestedModel"})
    if result["level"] == "collection":
        reasons.append({"code": "collection"})
    if source_nullable and not target["nullable"] and "defaultValue" not in target:
        reasons.append({"code": "nullToRequired"})
    return reasons


def _type_words(type_ref: dict) -> list[str]:
    return model_words(type_ref["name"]) if type_ref["kind"] in ("model", "enum") else []


def _strip_type(words: list[str], type_ref: dict) -> list[str]:
    extra = _type_words(type_ref)
    if extra and len(words) > len(extra) and words[len(words) - len(extra) :] == extra:
        return words[: -len(extra)]
    return words


def _score_option(option: dict, target: dict, names: dict, context: _Context) -> dict | None:
    """Score of using one source option for a target field, or None when it makes no sense."""
    field = option["field"]
    path = option["path"]
    path_match = compare_names(
        field["name"] if len(path) == 1 else path_key(path), option["words"], target["name"], names
    )
    # A nested field may match by its own name (shipping.city → city), less surely than by the whole path
    leaf = compare_names(field["name"], name_words(field["name"]), target["name"], names) if len(path) > 1 else None
    leaf_match = {**leaf, "score": leaf["score"] * 0.82} if leaf else None
    if path_match and leaf_match:
        best = path_match if path_match["score"] >= leaf_match["score"] else leaf_match
    else:
        best = path_match or leaf_match
    match = best
    if match is None:
        # The name on the wire or an alias may be the one that matches (@JsonProperty("user_id"))
        wire_target = coalesce(target.get("serializedName"), target["name"])
        for name in [field.get("serializedName"), *(field.get("aliases") or [])]:
            if name is None:
                continue
            found = compare_names(name, name_words(name), wire_target, names)
            if found is not None and found["score"] >= HIGH:
                match = found
                break
    serialized = False
    # The name of the field's type completes the name: shipping: AddressApi and shippingAddress: Address
    if not match or match["score"] < HIGH:
        source_words = _strip_type(option["words"], field["type"])
        target_name_words = name_words(target["name"])
        target_words = _strip_type(target_name_words, target["type"])
        changed = source_words is not option["words"] or len(target_words) != len(target_name_words)
        if changed and " ".join(source_words) == " ".join(target_words):
            match = {"score": 0.86, "reason": "modelContext"}
    if (
        field.get("serializedName")
        and target.get("serializedName")
        and field["serializedName"] == target["serializedName"]
    ):
        if not match or match["score"] < 0.95:
            match = {"score": 0.95, "reason": "serializedName"}
            serialized = True
    if not match:
        return None
    result = compatibility(field["type"], target["type"])
    factor = _type_factor(result, field["type"], target["type"], context)
    # Two enums are as compatible as the share of values that pair up by name
    if (
        field["type"]["kind"] == "enum"
        and target["type"]["kind"] == "enum"
        and field["type"]["name"] != target["type"]["name"]
    ):
        found_enum = find_enum(context.source, field["type"]["name"])
        total = len(found_enum["values"]) if found_enum else 0
        paired = len(suggest_enum_pairs(context.source, field["type"]["name"], context.target, target["type"]["name"]))
        factor = 0.6 + 0.4 * (paired / total) if total > 0 else 0.6
    if factor == 0:
        return None
    nullable = field["nullable"] or field["optional"] or option["nullablePath"]
    null_factor = (
        0.97 if nullable and not target["nullable"] and not target["optional"] and "defaultValue" not in target else 1
    )
    depth_factor = FLATTEN_FACTOR ** (len(path) - 1) if len(path) > 1 else 1
    score = match["score"] * factor * null_factor * depth_factor
    if score < REVIEW:
        return None
    first = {"code": "serializedName" if serialized else match["reason"]}
    if match.get("similarity") is not None:
        first["params"] = {"similarity": match["similarity"]}
    reasons = [first]
    if len(path) > 1:
        reasons.append({"code": "flattened", "params": {"path": path_key(path)}})
    reasons.extend(_compatibility_reasons(result, nullable, target))
    return {
        "sources": [path],
        "transform": _transform_for(result, field["type"], target["type"]),
        "score": score,
        "confidence": confidence_of(score),
        "reasons": reasons,
    }


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float")


def _is_date(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("datetime", "date")


def _transform_for(result: dict, source: dict, target: dict) -> dict:
    """The transformation a single source needs, from the compatibility of the two types. Nested models and
    collections get their mapping id later."""
    if result["level"] == "nested":
        return {"kind": "object", "mapping": ""}
    if result["level"] == "collection":
        return {"kind": "collection"}
    if result["level"] == "transform":
        if source["kind"] == "enum" and target["kind"] == "enum":
            return {"kind": "enum", "pairs": []}
        if (_is_number(source) and _is_date(target)) or (_is_date(source) and _is_number(target)):
            return {"kind": "epoch", "unit": "seconds"}
        if target["kind"] == "primitive" and target["name"] == "boolean":
            return {"kind": "boolean", "trueValues": []}
    return {"kind": "direct"}


_TRUE_STATUS = re.compile(r"(active|enabled|on|yes)", re.IGNORECASE)


def _combined_candidates(options: list[dict], target: dict, context: _Context) -> list[dict]:
    """Suggestions that combine or split values: first + last → full name, full name → first / last, cents →
    amount, status → active, epoch → date."""
    results: list[dict] = []
    target_words = meaning_words(expanded_words(target["name"]))

    def is_text(type_ref: dict) -> bool:
        return type_ref["kind"] == "primitive" and type_ref["name"] == "string"

    top_level = [option for option in options if len(option["path"]) == 1]

    def meaning_of(option: dict) -> list[str]:
        return meaning_words(expanded_words(option["field"]["name"]))

    def find(predicate):
        return next(
            (option for option in top_level if is_text(option["field"]["type"]) and predicate(meaning_of(option))), None
        )

    def has(words: list[str], *wanted: str) -> bool:
        return all(word in words for word in wanted)

    if is_text(target["type"]) and (
        has(target_words, "full", "name") or has(target_words, "display", "name") or target_words == ["name"]
    ):
        first = find(lambda words: has(words, "given", "name") or words == ["given"])
        last = find(lambda words: has(words, "family", "name") or words == ["family"])
        if first and last:
            score = 0.86 if "full" in target_words else 0.72
            results.append(
                {
                    "sources": [first["path"], last["path"]],
                    "transform": {"kind": "concat", "separator": " "},
                    "score": score,
                    "confidence": confidence_of(score),
                    "reasons": [{"code": "combined"}],
                }
            )

    # Synonyms are compared by their canonical word: "first" is read as "given" and "last" as "family"
    if is_text(target["type"]) and (has(target_words, "given", "name") or has(target_words, "family", "name")):
        full = find(lambda words: has(words, "full", "name") or words == ["name"])
        if full:
            results.append(
                {
                    "sources": [full["path"]],
                    "transform": {
                        "kind": "split",
                        "separator": " ",
                        "part": 0 if has(target_words, "given") else "rest",
                    },
                    "score": 0.6,
                    "confidence": "review",
                    "reasons": [{"code": "split"}],
                }
            )

    def is_number(type_ref: dict) -> bool:
        return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal")

    if is_number(target["type"]):
        for option in top_level:
            words = meaning_of(option)
            # cents is singularized to cent
            if not is_number(option["field"]["type"]) or "cent" not in words:
                continue
            rest = [word for word in words if word != "cent"]
            if rest and " ".join(rest) == " ".join(target_words):
                results.append(
                    {
                        "sources": [option["path"]],
                        "transform": {"kind": "arithmetic", "operator": "/", "operand": 100},
                        "score": 0.8,
                        "confidence": "probable",
                        "reasons": [{"code": "cents"}],
                    }
                )

    if (
        target["type"]["kind"] == "primitive"
        and target["type"]["name"] == "boolean"
        and ("active" in target_words or "enabled" in target_words)
    ):
        status = next((option for option in top_level if " ".join(meaning_of(option)) in ("status", "state")), None)
        if status and (is_text(status["field"]["type"]) or status["field"]["type"]["kind"] == "enum"):
            values = []
            if status["field"]["type"]["kind"] == "enum":
                found = find_enum(context.source, status["field"]["type"]["name"])
                values = [value["name"] for value in found["values"]] if found else []
            true_values = [value for value in values if _TRUE_STATUS.fullmatch(value)]
            results.append(
                {
                    "sources": [status["path"]],
                    "transform": {"kind": "boolean", "trueValues": true_values or ["ACTIVE"]},
                    "score": 0.62,
                    "confidence": "review",
                    "reasons": [{"code": "typeTransform"}],
                }
            )
    return results


_NOT_KEY = re.compile(r"[^a-z0-9]")


def _enum_key(text: str) -> str:
    return _NOT_KEY.sub("", text.lower())


def suggest_enum_pairs(source: dict, source_enum: str, target: dict, target_enum: str) -> list[dict]:
    """Value pairs between two enums, matched by name or wire value, ignoring case and separators."""
    found_from = find_enum(source, source_enum)
    found_to = find_enum(target, target_enum)
    origin = found_from["values"] if found_from else []
    to = found_to["values"] if found_to else []
    pairs: list[dict] = []
    for value in origin:
        keys = [_enum_key(value["name"]), _enum_key(js_string(value["value"])) if "value" in value else ""]
        match = next(
            (
                candidate
                for candidate in to
                if _enum_key(candidate["name"]) in keys
                or ("value" in candidate and _enum_key(js_string(candidate["value"])) in keys)
            ),
            None,
        )
        if match:
            pairs.append({"from": value["name"], "to": match["name"]})
    return pairs


def _candidate_key(candidate: dict) -> str:
    return "+".join(path_key(path) for path in candidate["sources"])


def _shares(candidate: dict) -> bool:
    return candidate["transform"]["kind"] in ("split", "boolean")


def _assign(candidates_by_target: dict[str, list[dict]], targets: list[dict]) -> dict[str, tuple]:
    """Ranks candidates per target, then assigns sources greedily (each source used once by the automatic
    suggestions), turning close alternatives into conflicts. Returns target → (chosen, conflict)."""
    result: dict[str, tuple] = {}
    used_sources: set[str] = set()
    pairs = [
        (target["name"], candidate) for target in targets for candidate in candidates_by_target.get(target["name"], [])
    ]
    pairs.sort(key=lambda pair: -pair[1]["score"])
    decided: set[str] = set()
    # Pairs by source, to find the other targets that want a source without going through every pair
    pairs_by_source: dict[str, list] = {}
    for pair in pairs:
        for path in pair[1]["sources"]:
            pairs_by_source.setdefault(path_key(path), []).append(pair)

    for target, candidate in pairs:
        if target in decided:
            continue
        source_keys = [path_key(path) for path in candidate["sources"]]
        # Derived values (a part of a text, a flag computed from a status) do not use their source up: other
        # targets can still take it (first name and last name; status and active)
        shares = _shares(candidate)
        if not shares and any(key in used_sources for key in source_keys):
            continue
        if candidate["confidence"] != "exact" and not shares:
            # Another source almost as good for this target
            rivals_for_target = [
                other
                for other in candidates_by_target.get(target, [])
                if other is not candidate
                and _candidate_key(other) != _candidate_key(candidate)
                and other["score"] >= REVIEW
                and candidate["score"] - other["score"] < MARGIN
                and not any(path_key(path) in used_sources for path in other["sources"])
            ]
            # Another undecided target that wants this source almost as much
            wanting: dict[int, tuple] = {}
            for key in source_keys:
                for pair in pairs_by_source.get(key, []):
                    wanting.setdefault(id(pair), pair)
            rival_targets = [
                other
                for other in wanting.values()
                if other[0] != target
                and not _shares(other[1])
                and other[0] not in decided
                and any(path_key(path) in source_keys for path in other[1]["sources"])
                and candidate["score"] - other[1]["score"] < MARGIN
                and other[1]["score"] >= REVIEW
            ]
            if rivals_for_target or rival_targets:
                result[target] = (candidate, True)
                decided.add(target)
                for rival_target, rival in rival_targets:
                    if rival_target not in decided:
                        result[rival_target] = (rival, True)
                        decided.add(rival_target)
                continue
        result[target] = (candidate, False)
        decided.add(target)
        if not shares:
            used_sources.update(source_keys)
    for target in targets:
        result.setdefault(target["name"], (None, False))
    return result


def _status_for(confidence: str) -> str:
    if confidence in ("exact", "high", "probable"):
        return "active"
    return "unmapped" if confidence == "none" else "pending"


def _root_candidate(source_model: dict, target: dict, context: _Context) -> dict | None:
    """A target model field filled from the source model itself (flat source → nested target), when enough of
    its fields have a match among the source's top-level fields."""
    if target["type"]["kind"] != "model":
        return None
    if not find_model(context.target, target["type"]["name"]):
        return None
    similarity = _structural_similarity({"kind": "model", "name": source_model["name"]}, target["type"], context)
    if similarity < 0.5:
        return None
    score = min(0.78, 0.4 + similarity * 0.4)
    return {
        "sources": [[]],
        "transform": {"kind": "object", "mapping": ""},
        "score": score,
        "confidence": confidence_of(score),
        "reasons": [{"code": "builtFromRoot"}],
    }


def _inner(type_ref: dict | None) -> dict | None:
    if type_ref is None:
        return None
    if type_ref["kind"] == "array":
        return _inner(type_ref["items"])
    if type_ref["kind"] == "map":
        return _inner(type_ref["value"])
    return type_ref


def _complete_transform(candidate: dict, source_model: dict, target: dict, context: _Context) -> dict:
    """Fills in the mapping ids of nested objects and collections, suggesting those mappings too, and the value
    pairs of enum transformations."""
    transform = candidate["transform"]

    def source_type() -> dict | None:
        if not candidate["sources"]:
            return None
        path = candidate["sources"][0]
        if not path:
            return {"kind": "model", "name": source_model["name"]}
        model = source_model
        type_ref = None
        for part in path:
            field = (
                next((item for item in all_fields(context.source, model) if item["name"] == part), None)
                if model
                else None
            )
            if not field:
                return None
            type_ref = field["type"]
            model = find_model(context.source, field["type"]["name"]) if field["type"]["kind"] == "model" else None
        return type_ref

    kind = transform["kind"]
    if kind == "object":
        origin = source_type()
        if origin and origin["kind"] == "model" and target["type"]["kind"] == "model":
            mapping = ensure_mapping(origin["name"], target["type"]["name"], context)
            return {**candidate, "transform": {"kind": "object", "mapping": mapping}}
    if kind == "collection":
        origin = _inner(source_type())
        to = _inner(target["type"])
        if origin and origin["kind"] == "model" and to and to["kind"] == "model":
            mapping = ensure_mapping(origin["name"], to["name"], context)
            return {**candidate, "transform": {"kind": "collection", "mapping": mapping}}
    if kind == "enum":
        origin = source_type()
        if origin and origin["kind"] == "enum" and target["type"]["kind"] == "enum":
            pairs = suggest_enum_pairs(context.source, origin["name"], context.target, target["type"]["name"])
            return {**candidate, "transform": {"kind": "enum", "pairs": pairs}}
    return candidate


def _suggest_fields(source_model: dict, target_model: dict, context: _Context) -> list[dict]:
    options = source_options(context.source, source_model)
    targets = all_fields(context.target, target_model)
    names = {"sourceModel": model_words(source_model["name"]), "targetModel": model_words(target_model["name"])}
    candidates_by_target: dict[str, list[dict]] = {}
    for target in targets:
        candidates = [
            candidate
            for candidate in (_score_option(option, target, names, context) for option in options)
            if candidate is not None
        ]
        candidates.extend(_combined_candidates(options, target, context))
        root = _root_candidate(source_model, target, context)
        if root and not any(candidate["score"] >= root["score"] for candidate in candidates):
            candidates.append(root)
        # The same source may appear through two rules: keep its best
        best: dict[str, dict] = {}
        for candidate in candidates:
            key = f"{_candidate_key(candidate)}:{candidate['transform']['kind']}"
            if (best[key]["score"] if key in best else -1) < candidate["score"]:
                best[key] = candidate
        candidates_by_target[target["name"]] = sorted(best.values(), key=lambda candidate: -candidate["score"])

    assignment = _assign(candidates_by_target, targets)
    fields = []
    for target in targets:
        chosen, conflict = assignment[target["name"]]
        candidates = candidates_by_target.get(target["name"], [])[:5]
        if chosen is None:
            # Generated fields (ids, timestamps) need nothing; the rest is left for the user
            field = {
                "target": target["name"],
                "sources": [],
                "transform": {"kind": "direct"},
                "status": "unmapped",
                "confidence": "none",
            }
            if candidates:
                field["candidates"] = candidates
            fields.append(field)
            continue
        completed = _complete_transform(chosen, source_model, target, context)
        confidence = "conflict" if conflict else completed["confidence"]
        ordered = [completed] + [
            _complete_transform(candidate, source_model, target, context)
            for candidate in candidates
            if candidate is not chosen
        ]
        # A transformation without enough information (which texts are true) always needs a review
        incomplete = completed["transform"]["kind"] == "boolean" and not completed["transform"]["trueValues"]
        status = "pending" if conflict or incomplete else _status_for(confidence)
        fields.append(
            {
                "target": target["name"],
                "sources": completed["sources"],
                "transform": completed["transform"],
                "status": status,
                "confidence": "review" if incomplete and confidence != "conflict" else confidence,
                "reasons": completed["reasons"],
                "candidates": ordered,
            }
        )
    return fields


def ensure_mapping(source: str, target: str, context: _Context) -> str:
    """Creates (once) the mapping between two models and returns its id."""
    identifier = mapping_id(source, target)
    if identifier in context.mappings:
        return identifier
    source_model = find_model(context.source, source)
    target_model = find_model(context.target, target)
    mapping = {"id": identifier, "source": source, "target": target, "fields": [], "ignoredSources": []}
    # Registered before its fields, so recursive models (a Category with child categories) end
    context.mappings[identifier] = mapping
    if source_model and target_model:
        mapping["fields"] = _suggest_fields(source_model, target_model, context)
    return identifier


def suggest_mapping(source: dict, source_model: str, target: dict, target_model: str) -> dict:
    """Suggests the whole mapping from one source model to one target model, nested models included."""
    context = _Context(source, target)
    root = ensure_mapping(source_model, target_model, context)
    return {"root": root, "mappings": list(context.mappings.values())}


def resuggest_mapping(mapping_set: dict, identifier: str, source: dict, target: dict) -> dict:
    """Recomputes the suggestions of one model mapping (after "restore suggestions"), keeping the others."""
    current = next((mapping for mapping in mapping_set["mappings"] if mapping["id"] == identifier), None)
    if not current:
        return mapping_set
    context = _Context(
        source, target, {mapping["id"]: mapping for mapping in mapping_set["mappings"] if mapping["id"] != identifier}
    )
    fresh = {**current, "fields": []}
    context.mappings[identifier] = fresh
    source_model = find_model(source, current["source"])
    target_model = find_model(target, current["target"])
    if source_model and target_model:
        fresh["fields"] = _suggest_fields(source_model, target_model, context)
    mappings = [fresh if mapping["id"] == identifier else mapping for mapping in mapping_set["mappings"]]
    for key, mapping in context.mappings.items():
        if not any(item["id"] == key for item in mappings):
            mappings.append(mapping)
    return {"root": mapping_set["root"], "mappings": mappings}


def coverage(mapping: dict, source: dict, target: dict) -> dict:
    """Fields the target needs that receive nothing, and source fields nobody uses."""
    source_model = find_model(source, mapping["source"])
    target_model = find_model(target, mapping["target"])
    used: set[str] = set()
    for field in mapping["fields"]:
        if field["status"] not in ("active", "pending"):
            continue
        for path in field["sources"]:
            # Using address.city also uses address; using the whole object uses every field below it
            for length in range(1, len(path) + 1):
                used.add(path_key(path[:length]))
        if any(not path for path in field["sources"]):
            for option in source_options(source, source_model, 1) if source_model else []:
                if len(option["path"]) == 1:
                    used.add(path_key(option["path"]))
    unused_sources = (
        [field["name"] for field in all_fields(source, source_model) if field["name"] not in used]
        if source_model
        else []
    )
    missing_required = []
    if target_model:
        for field in all_fields(target, target_model):
            if not needs_value(field):
                continue
            field_mapping = next((item for item in mapping["fields"] if item["target"] == field["name"]), None)
            if not field_mapping or field_mapping["status"] != "active":
                missing_required.append(field["name"])
    return {"unusedSources": unused_sources, "missingRequired": missing_required}


def default_transform(
    mapping_set: dict, source: dict, target: dict, identifier: str, target_field: str, sources: list
) -> dict:
    """The transformation used when the user picks sources for a target field by hand: the one the types call
    for, with the nested mapping suggested when the value is an object or a list of objects. Returns
    {"set", "transform"}."""
    current = next((mapping for mapping in mapping_set["mappings"] if mapping["id"] == identifier), None)
    source_model = find_model(source, current["source"]) if current else None
    target_model = find_model(target, current["target"]) if current else None
    field = (
        next((item for item in all_fields(target, target_model) if item["name"] == target_field), None)
        if target_model
        else None
    )
    if not current or not source_model or not field:
        return {"set": mapping_set, "transform": {"kind": "direct"}}
    if not sources:
        return {"set": mapping_set, "transform": {"kind": "constant", "value": None}}
    if len(sources) > 1:
        return {"set": mapping_set, "transform": {"kind": "concat", "separator": " "}}
    context = _Context(source, target, {mapping["id"]: mapping for mapping in mapping_set["mappings"]})
    type_ref = {"kind": "model", "name": source_model["name"]}
    model = source_model
    for part in sources[0]:
        step = next((item for item in all_fields(source, model) if item["name"] == part), None) if model else None
        if not step:
            type_ref = None
            break
        type_ref = step["type"]
        model = find_model(source, step["type"]["name"]) if step["type"]["kind"] == "model" else None
    if not type_ref:
        return {"set": mapping_set, "transform": {"kind": "direct"}}
    result = compatibility(type_ref, field["type"])
    candidate = _complete_transform(
        {
            "sources": sources,
            "transform": _transform_for(result, type_ref, field["type"]),
            "score": 1,
            "confidence": "exact",
            "reasons": [],
        },
        source_model,
        field,
        context,
    )
    return {
        "set": {"root": mapping_set["root"], "mappings": list(context.mappings.values())},
        "transform": candidate["transform"],
    }
