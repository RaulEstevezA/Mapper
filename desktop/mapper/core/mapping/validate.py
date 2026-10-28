"""Checks a mapping before generating code. Mirrors web/src/core/mapping/validate.ts. Errors make the generated
code wrong or incomplete; warnings may fail at run time or lose information; information needs no action
(docs/mapping-engine.md).

A diagnostic is {"severity", "code", "mapping", "target"?, "params"?, "expressionError"?}.
"""

import math

from ..js import is_number
from ..model.compatibility import compatibility
from ..model.schema import all_fields, find_enum, find_model, needs_value
from ..transform.expression import check_expression, parse_expression
from .paths import element_type, resolve_path
from .types import find_mapping, path_key

SEVERITY = {
    "requiredMissing": "error",
    "unknownSource": "error",
    "incompatibleType": "error",
    "needsTransform": "error",
    "sourceCount": "error",
    "transformType": "error",
    "booleanValues": "error",
    "invalidExpression": "error",
    "unresolvedObject": "error",
    "constantType": "error",
    "nullToRequired": "warning",
    "fallibleConversion": "warning",
    "lossyConversion": "warning",
    "enumIncomplete": "warning",
    "pendingSuggestion": "warning",
    "conflictPending": "warning",
    "unusedSource": "info",
    "optionalUnmapped": "info",
    "conversion": "info",
    "sharedSource": "info",
}


def _add(diagnostics: list, code: str, mapping: str, target=None, params=None, expression_error=None) -> None:
    diagnostic = {"severity": SEVERITY[code], "code": code, "mapping": mapping}
    if target is not None:
        diagnostic["target"] = target
    if params:
        diagnostic["params"] = params
    if expression_error:
        diagnostic["expressionError"] = expression_error
    diagnostics.append(diagnostic)


def _is_text(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("string", "any")


def _is_number(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float", "decimal", "any")


def _is_temporal(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("datetime", "date")


def value_kind(type_ref: dict) -> str:
    """Kind of a value in the expression language. Dates, ids and objects are opaque ("any")."""
    if type_ref["kind"] == "enum":
        return "string"
    if type_ref["kind"] != "primitive":
        return "any"
    name = type_ref["name"]
    if name == "string":
        return "string"
    if name in ("integer", "float", "decimal"):
        return "number"
    if name == "boolean":
        return "boolean"
    return "any"


def _literal_fits(value, type_ref: dict, target: dict) -> bool:
    if value is None:
        return True
    if type_ref["kind"] == "enum":
        found = find_enum(target, type_ref["name"])
        return (
            isinstance(value, str)
            and bool(found)
            and any(item["name"] == value or item.get("value") == value for item in found["values"])
        )
    if type_ref["kind"] != "primitive":
        return False
    name = type_ref["name"]
    if name == "any":
        return True
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return is_number(value) and float(value).is_integer()
    if name in ("float", "decimal"):
        return is_number(value)
    return isinstance(value, str)


def _conversion_code(result: dict) -> str:
    return (
        "fallibleConversion" if result.get("fallible") else "lossyConversion" if result.get("lossy") else "conversion"
    )


def _check_field(context: dict, mapping: dict, field: dict, target_field: dict) -> None:
    diagnostics = context["diagnostics"]
    source, target = context["source"], context["target"]
    identifier = mapping["id"]
    name = field["target"]
    status = field["status"]

    if status in ("ignored", "unmapped", "pending"):
        if status == "pending":
            _add(
                diagnostics,
                "conflictPending" if field["confidence"] == "conflict" else "pendingSuggestion",
                identifier,
                name,
            )
        if needs_value(target_field):
            if field.get("fallback") is None:
                _add(diagnostics, "requiredMissing", identifier, name)
        elif status == "unmapped":
            _add(diagnostics, "optionalUnmapped", identifier, name)
        return

    resolved = [(path, resolve_path(source, mapping["source"], path)) for path in field["sources"]]
    for path, value in resolved:
        if not value:
            _add(diagnostics, "unknownSource", identifier, name, {"path": path_key(path) or "(root)"})
    if any(value is None for _, value in resolved):
        return
    values = [value for _, value in resolved]
    transform = field["transform"]
    kind = transform["kind"]
    if kind == "constant":
        minimum, maximum = 0, 0
    elif kind == "concat":
        minimum, maximum = 2, math.inf
    elif kind == "expression":
        minimum, maximum = 0, math.inf
    else:
        minimum, maximum = 1, 1
    if len(values) < minimum or len(values) > maximum:
        _add(diagnostics, "sourceCount", identifier, name, {"transform": kind, "count": len(values)})
        return
    first = values[0] if values else None
    nullable = any(value["nullable"] for value in values)
    target_type = target_field["type"]
    fallback = field.get("fallback") is not None

    if kind == "direct":
        result = compatibility(first["type"], target_type)
        items = result.get("items")
        level = (items["level"] if items else "same") if result["level"] == "collection" else result["level"]
        if result["level"] == "incompatible":
            _add(diagnostics, "incompatibleType", identifier, name)
        elif level == "transform":
            _add(diagnostics, "needsTransform", identifier, name)
        elif level == "nested":
            _add(diagnostics, "unresolvedObject", identifier, name)
        elif level == "conversion":
            inner = items if result["level"] == "collection" else result
            _add(diagnostics, _conversion_code(inner), identifier, name)
    elif kind == "concat":
        if not _is_text(target_type):
            _add(diagnostics, "transformType", identifier, name, {"transform": "concat"})
    elif kind == "split":
        if not _is_text(first["type"]) or not _is_text(target_type):
            _add(diagnostics, "transformType", identifier, name, {"transform": "split"})
    elif kind == "constant":
        if not _literal_fits(transform["value"], target_type, target):
            _add(diagnostics, "constantType", identifier, name)
    elif kind == "boolean":
        is_boolean = target_type["kind"] == "primitive" and target_type["name"] == "boolean"
        if not is_boolean or not (_is_text(first["type"]) or first["type"]["kind"] == "enum"):
            _add(diagnostics, "transformType", identifier, name, {"transform": "boolean"})
        elif not transform["trueValues"]:
            _add(diagnostics, "booleanValues", identifier, name)
    elif kind == "enum":
        source_values = None
        if first["type"]["kind"] == "enum":
            found = find_enum(source, first["type"]["name"])
            source_values = [value["name"] for value in found["values"]] if found else []
        if target_type["kind"] != "enum" or not (first["type"]["kind"] == "enum" or _is_text(first["type"])):
            _add(diagnostics, "transformType", identifier, name, {"transform": "enum"})
        else:
            found_target = find_enum(target, target_type["name"])
            target_values = {value["name"] for value in found_target["values"]} if found_target else set()
            bad_pair = next((pair for pair in transform["pairs"] if pair["to"] not in target_values), None)
            if bad_pair:
                _add(diagnostics, "transformType", identifier, name, {"transform": "enum", "value": bad_pair["to"]})
            elif source_values is not None and "fallback" not in transform:
                missing = [
                    value for value in source_values if not any(pair["from"] == value for pair in transform["pairs"])
                ]
                if missing:
                    _add(
                        diagnostics,
                        "enumIncomplete",
                        identifier,
                        name,
                        {"values": ", ".join(missing), "count": len(missing)},
                    )
    elif kind == "epoch":
        number_to_date = _is_number(first["type"]) and _is_temporal(target_type)
        date_to_number = _is_temporal(first["type"]) and _is_number(target_type)
        if not (number_to_date or date_to_number):
            _add(diagnostics, "transformType", identifier, name, {"transform": "epoch"})
    elif kind == "arithmetic":
        if not _is_number(first["type"]) or not _is_number(target_type):
            _add(diagnostics, "transformType", identifier, name, {"transform": "arithmetic"})
        elif transform["operator"] == "/" and transform["operand"] == 0:
            _add(diagnostics, "transformType", identifier, name, {"transform": "arithmetic", "operand": 0})
    elif kind == "object":
        nested = find_mapping(context["set"], transform["mapping"])
        expected_target = target_type["name"] if target_type["kind"] == "model" else None
        if (
            not nested
            or first["type"]["kind"] != "model"
            or nested["source"] != first["type"]["name"]
            or nested["target"] != expected_target
        ):
            _add(diagnostics, "unresolvedObject", identifier, name)
    elif kind == "collection":
        if first["type"]["kind"] != target_type["kind"] or first["type"]["kind"] not in ("array", "map"):
            _add(diagnostics, "incompatibleType", identifier, name)
        else:
            origin = element_type(first["type"])
            to = element_type(target_type)
            if origin["kind"] == "model" or to["kind"] == "model":
                nested = find_mapping(context["set"], transform["mapping"]) if transform.get("mapping") else None
                if (
                    not nested
                    or origin["kind"] != "model"
                    or to["kind"] != "model"
                    or nested["source"] != origin["name"]
                    or nested["target"] != to["name"]
                ):
                    _add(diagnostics, "unresolvedObject", identifier, name)
            else:
                result = compatibility(origin, to)
                if result["level"] in ("incompatible", "transform"):
                    _add(diagnostics, "incompatibleType", identifier, name)
                elif result["level"] == "conversion":
                    _add(diagnostics, _conversion_code(result), identifier, name)
    elif kind == "expression":
        parsed = parse_expression(transform["expression"])
        if not parsed["ok"]:
            _add(diagnostics, "invalidExpression", identifier, name, None, parsed["error"])
        else:

            def field_kind(path: list) -> str | None:
                value = resolve_path(source, mapping["source"], path)
                return value_kind(value["type"]) if value else None

            checked = check_expression(parsed["expr"], field_kind)
            if "error" in checked:
                _add(diagnostics, "invalidExpression", identifier, name, None, checked["error"])
            else:
                wanted = value_kind(target_type)
                found = checked["kind"]
                if wanted != "any" and found not in ("any", "null") and found != wanted:
                    _add(
                        diagnostics,
                        "transformType",
                        identifier,
                        name,
                        {"transform": "expression", "expected": wanted, "found": found},
                    )

    # A value that may be null going into a field that cannot hold null
    produces_null = kind not in ("constant", "concat", "boolean") and nullable
    if produces_null and not target_field["nullable"] and not fallback:
        _add(diagnostics, "nullToRequired", identifier, name)


def _used_paths(field: dict) -> list:
    if field["transform"]["kind"] == "expression":
        parsed = parse_expression(field["transform"]["expression"])
        return parsed["fields"] if parsed["ok"] else []
    return field["sources"]


def validate_mapping(mapping_set: dict, source: dict, target: dict) -> list[dict]:
    """Diagnostics of the root mapping and of every mapping it uses, errors first."""
    diagnostics: list[dict] = []
    context = {"set": mapping_set, "source": source, "target": target, "diagnostics": diagnostics}
    visited: set[str] = set()
    queue = [mapping_set["root"]]
    while queue:
        identifier = queue.pop(0)
        if identifier in visited:
            continue
        visited.add(identifier)
        mapping = find_mapping(mapping_set, identifier)
        if not mapping:
            continue
        target_model = find_model(target, mapping["target"])
        source_model = find_model(source, mapping["source"])
        if not target_model or not source_model:
            continue
        for target_field in all_fields(target, target_model):
            field = next((item for item in mapping["fields"] if item["target"] == target_field["name"]), None)
            if not field:
                if needs_value(target_field):
                    _add(diagnostics, "requiredMissing", identifier, target_field["name"])
                continue
            _check_field(context, mapping, field, target_field)
            transform = field["transform"]
            if (
                field["status"] == "active"
                and transform["kind"] in ("object", "collection")
                and transform.get("mapping")
            ):
                queue.append(transform["mapping"])

        # Source fields nobody uses, and the same source used by several targets
        uses: dict[str, list[str]] = {}
        for field in mapping["fields"]:
            if field["status"] != "active":
                continue
            for path in _used_paths(field):
                uses.setdefault(path[0] if path else "", []).append(field["target"])
        uses_root = "" in uses
        for source_field in all_fields(source, source_model):
            if (
                source_field["name"] not in uses
                and not uses_root
                and source_field["name"] not in mapping["ignoredSources"]
            ):
                _add(diagnostics, "unusedSource", identifier, None, {"field": source_field["name"]})
        for field in mapping["fields"]:
            if (
                field["status"] != "active"
                or field["transform"]["kind"] == "split"
                or len(field["sources"]) != 1
                or not field["sources"][0]
            ):
                continue
            key = path_key(field["sources"][0])
            sharing = [
                other
                for other in mapping["fields"]
                if other is not field
                and other["status"] == "active"
                and other["transform"]["kind"] != "split"
                and any(path_key(path) == key for path in other["sources"])
            ]
            if sharing and all(other["target"] > field["target"] for other in sharing):
                _add(diagnostics, "sharedSource", identifier, field["target"], {"path": key, "count": len(sharing) + 1})
    order = {"error": 0, "warning": 1, "info": 2}
    return sorted(diagnostics, key=lambda diagnostic: order[diagnostic["severity"]])


def summarize_diagnostics(diagnostics: list[dict]) -> dict:
    summary = {"error": 0, "warning": 0, "info": 0}
    for diagnostic in diagnostics:
        summary[diagnostic["severity"]] += 1
    return summary
