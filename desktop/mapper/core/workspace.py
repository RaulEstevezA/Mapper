"""Workspace logic the interface uses, kept out of the widgets so it can be tested. Mirrors
web/src/app/workspace.ts.

An input is {"text", "format" (None: detected from the text), "model" (None: the default model of the schema),
"fileName"?, "receivedFrom"?}.
"""

from .js import trim
from .mapping.paths import resolve_path
from .mapping.types import find_mapping, path_key
from .matching.engine import suggest_mapping
from .model.schema import all_fields, default_root, find_model
from .parsers.registry import detect_format, parse_input

EMPTY_INPUT = {"text": "", "format": None, "model": None}


def read_input(state: dict, role: str) -> dict:
    """Parses an input with its chosen or detected format: {"format", "outcome", "model"}; model is the chosen
    one when it exists, the default otherwise."""
    if trim(state["text"]) == "":
        return {"format": state.get("format"), "outcome": None, "model": None}
    format_id = state.get("format") or detect_format(state["text"], state.get("fileName"))
    if not format_id:
        return {"format": None, "outcome": None, "model": None}
    outcome = parse_input(state["text"], format_id, {"rootName": "Source" if role == "source" else "Target"})
    if not outcome["ok"]:
        return {"format": format_id, "outcome": outcome, "model": None}
    chosen = state.get("model") if state.get("model") and find_model(outcome["schema"], state["model"]) else None
    return {"format": format_id, "outcome": outcome, "model": chosen or default_root(outcome["schema"])}


def _still_valid(field: dict, mapping: dict, source: dict, target: dict) -> bool:
    """A manual decision still makes sense when its target field exists and its sources are still there."""
    target_model = find_model(target, mapping["target"])
    if not target_model or not any(item["name"] == field["target"] for item in all_fields(target, target_model)):
        return False
    return all(resolve_path(source, mapping["source"], path) is not None for path in field["sources"])


def _nested(field: dict) -> str | None:
    transform = field["transform"]
    return transform.get("mapping") if transform["kind"] in ("object", "collection") else None


def reconcile(previous: dict | None, source: dict, source_model: str, target: dict, target_model: str) -> dict:
    """New suggestions for the models, keeping what the user decided on the previous mapping (manual choices,
    ignored fields, accepted reviews) wherever it still applies."""
    fresh = suggest_mapping(source, source_model, target, target_model)
    if not previous:
        return fresh

    def keep(field: dict, old: dict, mapping: dict) -> dict:
        kept = next((item for item in old["fields"] if item["target"] == field["target"]), None)
        if not kept or not (kept.get("manual") or (kept["status"] == "active" and field["status"] == "pending")):
            return field
        if not _still_valid(kept, mapping, source, target):
            return field
        # Object and list mappings keep their nested mapping only if it is still part of the set
        nested = _nested(kept)
        known = any(item["id"] == nested for item in fresh["mappings"]) or any(
            item["id"] == nested for item in previous["mappings"]
        )
        if nested and not known:
            return field
        result = {**kept}
        if "candidates" in field:
            result["candidates"] = field["candidates"]
        else:
            result.pop("candidates", None)
        return result

    mappings = []
    for mapping in fresh["mappings"]:
        old = find_mapping(previous, mapping["id"])
        if not old:
            mappings.append(mapping)
            continue
        ignored = [
            path
            for path in old["ignoredSources"]
            if resolve_path(source, mapping["source"], path.split(".")) is not None
        ]
        mappings.append(
            {**mapping, "fields": [keep(field, old, mapping) for field in mapping["fields"]], "ignoredSources": ignored}
        )
    # Nested mappings the kept decisions use, carried over from the previous set
    ids = {mapping["id"] for mapping in mappings}
    index = 0
    while index < len(mappings):
        for field in mappings[index]["fields"]:
            nested = _nested(field)
            if nested and nested not in ids:
                carried = find_mapping(previous, nested)
                if carried:
                    mappings.append(carried)
                    ids.add(nested)
        index += 1
    return {"root": fresh["root"], "mappings": mappings}


def category_of(field: dict) -> str:
    """mapped, review, conflict, unmapped or ignored."""
    if field["status"] == "ignored":
        return "ignored"
    if field["status"] == "active":
        return "mapped"
    if field["status"] == "pending":
        return "conflict" if field["confidence"] == "conflict" else "review"
    return "unmapped"


def reachable(mapping_set: dict | None) -> list[dict]:
    """Model mappings in the order they are shown: the root, then the nested ones as they are used."""
    if not mapping_set:
        return []
    result: list[dict] = []
    queue = [mapping_set["root"]]
    seen: set[str] = set()
    while queue:
        identifier = queue.pop(0)
        if identifier in seen:
            continue
        seen.add(identifier)
        mapping = find_mapping(mapping_set, identifier)
        if not mapping:
            continue
        result.append(mapping)
        for field in mapping["fields"]:
            if field["status"] not in ("active", "pending"):
                continue
            nested = _nested(field)
            if nested:
                queue.append(nested)
    return result


def summarize(mapping_set: dict | None) -> dict:
    """Counts of the fields of every model mapping reachable from the root."""
    summary = {"total": 0, "mapped": 0, "review": 0, "conflict": 0, "unmapped": 0, "ignored": 0}
    for mapping in reachable(mapping_set):
        for field in mapping["fields"]:
            summary["total"] += 1
            summary[category_of(field)] += 1
    return summary


def matches_filter(field: dict, filter_id: str, search: str, diagnostics: list, mapping_id: str) -> bool:
    """Whether a field is shown with the current filter (all, mapped, review, unmapped, warnings) and search."""
    category = category_of(field)
    if filter_id == "mapped" and category != "mapped":
        return False
    if filter_id == "review" and category not in ("review", "conflict"):
        return False
    if filter_id == "unmapped" and category not in ("unmapped", "ignored"):
        return False
    if filter_id == "warnings" and not any(
        item["mapping"] == mapping_id and item.get("target") == field["target"] and item["severity"] != "info"
        for item in diagnostics
    ):
        return False
    text = trim(search).lower()
    if text == "":
        return True
    return text in field["target"].lower() or any(text in path_key(path).lower() for path in field["sources"])
