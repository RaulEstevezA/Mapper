"""A saved Mapper project. Mirrors web/src/core/project/project.ts: both inputs as written, their models, the
mapping and the output settings, so work can continue later, on another computer or in the other version
(docs/interoperability.md). The file is the same in the web and desktop versions."""

import json
import re
from datetime import UTC, datetime

from ..js import is_number, js_string, parse_json_value
from ..mapping.edit import prune_mappings
from ..parsers.schema.model_schema import validate_model_schema

PROJECT_FORMAT = "mapper-project"
PROJECT_VERSION = 1


def _iso(moment: datetime) -> str:
    """Date.toISOString(): UTC with milliseconds and a Z."""
    utc = moment.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def create_project(source: dict, target: dict, mapping: dict, output: dict, now=None) -> dict:
    """source and target are {"format", "text", "model", "schema"}; output is {"generator", "mode", "naming",
    "options"}. now is a datetime or an ISO text (the web version's Date)."""
    if now is None:
        saved_at = _iso(datetime.now(UTC))
    elif isinstance(now, str):
        saved_at = _iso(datetime.fromisoformat(now.replace("Z", "+00:00")))
    else:
        saved_at = _iso(now)
    return {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "savedAt": saved_at,
        "source": source,
        "target": target,
        "mapping": prune_mappings(mapping),
        "output": output,
    }


def _is_string_array(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


_TRANSFORMS = {
    "direct",
    "concat",
    "split",
    "constant",
    "boolean",
    "enum",
    "epoch",
    "arithmetic",
    "object",
    "collection",
    "expression",
}
_STATUSES = {"active", "pending", "ignored", "unmapped"}


def _kind_text(value) -> str:
    """String(value) of a value that may be missing."""
    return value if isinstance(value, str) else ("undefined" if value is _ABSENT else js_string(value))


_ABSENT = object()


def _validate_mapping_set(value, path: str) -> str | None:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("root"), str)
        or not isinstance(value.get("mappings"), list)
    ):
        return path
    ids: set[str] = set()
    for index, mapping in enumerate(value["mappings"]):
        at = f"{path}.mappings[{index}]"
        if (
            not isinstance(mapping, dict)
            or not isinstance(mapping.get("id"), str)
            or not isinstance(mapping.get("source"), str)
            or not isinstance(mapping.get("target"), str)
            or not isinstance(mapping.get("fields"), list)
        ):
            return at
        ignored = mapping.get("ignoredSources")
        if not _is_string_array([] if ignored is None else ignored):
            return f"{at}.ignoredSources"
        ids.add(mapping["id"])
        for field_index, field in enumerate(mapping["fields"]):
            field_path = f"{at}.fields[{field_index}]"
            if not isinstance(field, dict) or not isinstance(field.get("target"), str):
                return field_path
            sources = field.get("sources")
            if not isinstance(sources, list) or not all(_is_string_array(item) for item in sources):
                return f"{field_path}.sources"
            transform = field.get("transform")
            if not isinstance(transform, dict) or _kind_text(transform.get("kind", _ABSENT)) not in _TRANSFORMS:
                return f"{field_path}.transform"
            if _kind_text(field.get("status", _ABSENT)) not in _STATUSES:
                return f"{field_path}.status"
            if transform["kind"] == "expression" and not isinstance(transform.get("expression"), str):
                return f"{field_path}.transform"
    if value["root"] not in ids:
        return f"{path}.root"
    return None


def _validate_side(value, path: str) -> str | None:
    if not isinstance(value, dict) or not all(isinstance(value.get(key), str) for key in ("format", "text", "model")):
        return path
    schema = validate_model_schema(value.get("schema"))
    if not schema["ok"]:
        return f"{path}.schema{schema['path'][1:]}"
    return None


def read_project(text: str) -> dict:
    """Reads a project file: {"ok": True, "project"} or {"ok": False, "error", "path"?}, where error is notJson,
    notProject, newerVersion or invalid. Everything is checked: a damaged or edited file is rejected with the
    path of the first problem instead of breaking the window later."""
    try:
        value = parse_json_value(text)
    except (ValueError, RecursionError):
        return {"ok": False, "error": "notJson"}
    if not isinstance(value, dict) or value.get("format") != PROJECT_FORMAT:
        return {"ok": False, "error": "notProject"}
    if not is_number(value.get("version")) or value["version"] > PROJECT_VERSION:
        return {"ok": False, "error": "newerVersion"}
    for key, check in (("source", _validate_side), ("target", _validate_side), ("mapping", _validate_mapping_set)):
        problem = check(value.get(key), f"$.{key}")
        if problem:
            return {"ok": False, "error": "invalid", "path": problem}
    output = value.get("output")
    if (
        not isinstance(output, dict)
        or not isinstance(output.get("generator"), str)
        or not isinstance(output.get("mode"), str)
    ):
        return {"ok": False, "error": "invalid", "path": "$.output"}
    naming = output.get("naming") if output.get("naming") in ("auto", "keep", "convention") else "auto"
    options = output.get("options") if isinstance(output.get("options"), dict) else {}
    return {"ok": True, "project": {**value, "output": {**output, "naming": naming, "options": options}}}


_UNSAFE = re.compile(r"[^\w.-]+", re.ASCII)


def project_file_name(project: dict) -> str:
    base = _UNSAFE.sub("-", f"{project['source']['model']}-to-{project['target']['model']}").lower()
    return f"{base}.mapper.json"


def project_text(project: dict) -> str:
    """The project as the file the web version writes."""
    return json.dumps(project, ensure_ascii=False, indent=2)
