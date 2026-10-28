"""Every change the user can make to a mapping, as pure functions. Mirrors web/src/core/mapping/edit.ts. They
return a new set and never modify the given one, so the interface can keep an undo history of plain values."""

from ..matching.engine import default_transform, resuggest_mapping
from ..transform.expression import parse_expression
from .types import find_mapping, path_key

UNSET = object()


def _update_field(mapping_set: dict, identifier: str, target: str, change) -> dict:
    return {
        "root": mapping_set["root"],
        "mappings": [
            mapping
            if mapping["id"] != identifier
            else {
                **mapping,
                "fields": [change(field) if field["target"] == target else field for field in mapping["fields"]],
            }
            for mapping in mapping_set["mappings"]
        ],
    }


def choose_sources(
    mapping_set: dict, source: dict, target: dict, identifier: str, target_field: str, sources: list
) -> dict:
    """Uses these sources for a target field, with the transformation their types need."""
    result = default_transform(mapping_set, source, target, identifier, target_field, sources)
    transform = result["transform"]
    return _update_field(
        result["set"],
        identifier,
        target_field,
        lambda field: {**field, "sources": sources, "transform": transform, "status": "active", "manual": True},
    )


def accept_candidate(mapping_set: dict, identifier: str, target_field: str, index: int = 0) -> dict:
    """Applies one of the engine's suggestions (the first one by default)."""

    def change(field: dict) -> dict:
        candidates = field.get("candidates") or []
        candidate = candidates[index] if 0 <= index < len(candidates) else None
        if candidate is None:
            if field["sources"] or field["transform"]["kind"] == "constant":
                return {**field, "status": "active"}
            return field
        return {
            **field,
            "sources": candidate["sources"],
            "transform": candidate["transform"],
            "reasons": candidate["reasons"],
            "status": "active",
            # The user decided: a confirmed conflict is no longer one
            "confidence": "review" if candidate["confidence"] == "conflict" else candidate["confidence"],
            "manual": index > 0 or field["confidence"] == "conflict" or field["status"] == "pending",
        }

    return _update_field(mapping_set, identifier, target_field, change)


def reject_suggestion(mapping_set: dict, identifier: str, target_field: str) -> dict:
    """Discards the suggestion: the field is left without value until the user chooses one."""
    return _update_field(
        mapping_set,
        identifier,
        target_field,
        lambda field: {**field, "sources": [], "transform": {"kind": "direct"}, "status": "unmapped", "manual": True},
    )


def ignore_target(mapping_set: dict, identifier: str, target_field: str) -> dict:
    """The target field intentionally gets no value."""
    return _update_field(
        mapping_set, identifier, target_field, lambda field: {**field, "status": "ignored", "manual": True}
    )


def set_transform(mapping_set: dict, identifier: str, target_field: str, transform: dict) -> dict:
    return _update_field(
        mapping_set,
        identifier,
        target_field,
        lambda field: {
            **field,
            "transform": transform,
            # A constant needs no source; an expression names its own
            "sources": [] if transform["kind"] == "constant" else field["sources"],
            "status": "active",
            "manual": True,
        },
    )


def set_fallback(mapping_set: dict, identifier: str, target_field: str, fallback=UNSET) -> dict:
    """Value used when the source is null or missing; UNSET (the web version's undefined) removes it."""

    def change(field: dict) -> dict:
        result = {**field, "manual": True}
        if fallback is UNSET:
            result.pop("fallback", None)
        else:
            result["fallback"] = fallback
        return result

    return _update_field(mapping_set, identifier, target_field, change)


def reset_field(mapping_set: dict, source: dict, target: dict, identifier: str, target_field: str) -> dict:
    """Back to what the engine suggests for this field, undoing the user's changes to it."""
    fresh = resuggest_mapping(mapping_set, identifier, source, target)
    mapping = find_mapping(fresh, identifier)
    suggested = (
        next((field for field in mapping["fields"] if field["target"] == target_field), None) if mapping else None
    )
    if not suggested:
        return mapping_set
    reset = _update_field(mapping_set, identifier, target_field, lambda _field: suggested)
    # Nested mappings the suggestion needs
    known = {item["id"] for item in reset["mappings"]}
    return {
        "root": reset["root"],
        "mappings": [*reset["mappings"], *(item for item in fresh["mappings"] if item["id"] not in known)],
    }


def restore_suggestions(mapping_set: dict, source: dict, target: dict, identifier: str) -> dict:
    """Every field of a model mapping back to the engine's suggestions."""
    return resuggest_mapping(mapping_set, identifier, source, target)


def toggle_ignored_source(mapping_set: dict, identifier: str, path: list) -> dict:
    """Marks a source field as intentionally unused, or not."""
    key = path_key(path)

    def change(mapping: dict) -> dict:
        ignored = mapping["ignoredSources"]
        return {
            **mapping,
            "ignoredSources": [item for item in ignored if item != key] if key in ignored else [*ignored, key],
        }

    return {
        "root": mapping_set["root"],
        "mappings": [
            change(mapping) if mapping["id"] == identifier else mapping for mapping in mapping_set["mappings"]
        ],
    }


def accept_all_reviews(mapping_set: dict, identifier: str) -> dict:
    """Accepts every suggestion of a mapping that is waiting for review, except conflicts (they need a choice)."""
    mapping = find_mapping(mapping_set, identifier)
    if not mapping:
        return mapping_set
    current = mapping_set
    for field in mapping["fields"]:
        if field["status"] == "pending" and field["confidence"] != "conflict":
            current = accept_candidate(current, identifier, field["target"])
    return current


def prune_mappings(mapping_set: dict) -> dict:
    """Mappings no field or suggestion leads to any more, removed (before saving)."""
    reachable: set[str] = set()
    queue = [mapping_set["root"]]
    while queue:
        identifier = queue.pop(0)
        if identifier in reachable:
            continue
        reachable.add(identifier)
        mapping = find_mapping(mapping_set, identifier)
        for field in mapping["fields"] if mapping else []:
            # Suggestions not accepted yet keep their nested mappings, so accepting them later still works
            transforms = [field["transform"], *(candidate["transform"] for candidate in field.get("candidates") or [])]
            for transform in transforms:
                if transform["kind"] in ("object", "collection") and transform.get("mapping"):
                    queue.append(transform["mapping"])
    return {
        "root": mapping_set["root"],
        "mappings": [item for item in mapping_set["mappings"] if item["id"] in reachable],
    }


def set_expression(mapping_set: dict, identifier: str, target_field: str, expression: str) -> dict:
    """A custom expression: the fields it reads become the sources of the relation, so unused source fields
    are still found. An expression that does not parse keeps the previous sources until it does."""
    parsed = parse_expression(expression)
    return _update_field(
        mapping_set,
        identifier,
        target_field,
        lambda field: {
            **field,
            "transform": {"kind": "expression", "expression": expression},
            "sources": parsed["fields"] if parsed["ok"] else field["sources"],
            "status": "active",
            "manual": True,
        },
    )
