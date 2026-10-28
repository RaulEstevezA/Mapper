"""The mapping lowered for the generators. Mirrors web/src/core/generate/plan.ts. Every value says its type and
whether it may be null, and every implicit step (a conversion, a fallback, a nested mapper) is explicit.
Generators only decide syntax (docs/generators.md).

A value is a dictionary with "k" (its kind), "type" and "nullable":
- path: {"root": "source" | "item", "steps": [{"field", "nullable", "owner"}]}
- self: {"root", "model"}; literal: {"value"}; convert: {"value"}
- concat: {"parts", "separator"}; split: {"value", "separator", "part"}; boolean: {"value", "trueValues"}
- enumMap: {"value", "target", "pairs", "fallback"?, "source"?}; epoch: {"value", "unit", "toDate"}
- arithmetic: {"value", "operator", "operand"}; mapper: {"value", "mapper"}
- list: {"value", "element", "isMap", "container"?}; coalesce: {"value", "fallback"}; expr: {"expr", "fields"}
A mapper plan is {"id", "source", "target", "assignments"}; an assignment {"field", "value", "missing",
"unsafeNull"}; a plan {"root", "mappers", "source", "target", "set", "enums": {"source", "target"}}.
"""

import json

from ..js import is_number
from ..mapping.paths import resolve_path
from ..mapping.types import find_mapping
from ..model.compatibility import compatibility
from ..model.schema import all_fields, find_enum, find_model, needs_value, primitive
from ..transform.expression import parse_expression


def make(node: dict, type_ref: dict, nullable: bool) -> dict:
    return {**node, "type": type_ref, "nullable": nullable}


def _literal_type(value, fallback: dict) -> dict:
    if isinstance(value, str):
        return fallback if fallback["kind"] == "enum" else primitive("string")
    if is_number(value):
        if fallback["kind"] == "primitive" and fallback["name"] in ("integer", "float", "decimal"):
            return fallback
        return primitive("integer" if float(value).is_integer() else "float")
    if isinstance(value, bool):
        return primitive("boolean")
    return fallback


def _numeric(type_ref: dict) -> bool:
    return type_ref["kind"] == "primitive" and type_ref["name"] in ("integer", "float")


def _same_scalar(a: dict, b: dict) -> bool:
    """Identical types need no conversion. Numbers of different (or unknown) size still get a conversion node:
    some languages need a cast (Math.toIntExact in Java), others write nothing."""
    # Compared as JSON, key order included, like the web version
    if json.dumps(a) == json.dumps(b):
        return True
    if _numeric(a) and _numeric(b):
        return False
    return compatibility(a, b)["level"] == "same"


def convert_to(value: dict, type_ref: dict) -> dict:
    """The value converted to the target type when they differ (int → string, enum → string)."""
    if _same_scalar(value["type"], type_ref):
        return value
    if (
        value["type"]["kind"] == "primitive"
        and type_ref["kind"] == "primitive"
        and value["type"]["name"] == type_ref["name"]
        and type_ref["name"] not in ("integer", "float")
    ):
        return value
    return make({"k": "convert", "value": value}, type_ref, value["nullable"])


class _Planner:
    def __init__(self, mapping_set: dict, source: dict, target: dict):
        self.set = mapping_set
        self.source = source
        self.target = target
        self.mappers: dict[str, dict] = {}
        self.order: list[dict] = []
        # Insertion-ordered sets of enum names
        self.source_enums: dict[str, None] = {}
        self.target_enums: dict[str, None] = {}

    def mapper(self, identifier: str) -> dict | None:
        existing = self.mappers.get(identifier)
        if existing:
            return existing
        mapping = find_mapping(self.set, identifier)
        source_model = find_model(self.source, mapping["source"]) if mapping else None
        target_model = find_model(self.target, mapping["target"]) if mapping else None
        if not mapping or not source_model or not target_model:
            return None
        plan = {"id": identifier, "source": source_model, "target": target_model, "assignments": []}
        # Registered before its assignments: recursive mappings call themselves
        self.mappers[identifier] = plan
        self.order.append(plan)
        for target_field in all_fields(self.target, target_model):
            field_mapping = next((item for item in mapping["fields"] if item["target"] == target_field["name"]), None)
            plan["assignments"].append(self._assignment(field_mapping, target_field, source_model))
        return plan

    def _path(self, root: str, model: dict, path: list) -> dict | None:
        if not path:
            return make({"k": "self", "root": root, "model": model}, {"kind": "model", "name": model["name"]}, False)
        resolved = resolve_path(self.source, model["name"], path)
        if not resolved:
            return None
        steps = []
        owner = model
        for field in resolved["steps"]:
            steps.append({"field": field, "nullable": field["nullable"] or field["optional"], "owner": owner})
            if field["type"]["kind"] == "model":
                owner = find_model(self.source, field["type"]["name"]) or owner
            if field["type"]["kind"] == "enum":
                self.source_enums[field["type"]["name"]] = None
        return make({"k": "path", "root": root, "steps": steps}, resolved["type"], resolved["nullable"])

    def _assignment(self, field_mapping: dict | None, target_field: dict, source_model: dict) -> dict:
        if target_field["type"]["kind"] == "enum":
            self.target_enums[target_field["type"]["name"]] = None
        required = needs_value(target_field)
        value = None
        if field_mapping and field_mapping["status"] == "active":
            value = self._value(field_mapping, target_field, source_model)
        fallback = field_mapping.get("fallback") if field_mapping else None
        if value and fallback is not None and value["nullable"]:
            literal = make({"k": "literal", "value": fallback}, _literal_type(fallback, target_field["type"]), False)
            value = make({"k": "coalesce", "value": value, "fallback": literal}, target_field["type"], False)
        if not value and fallback is not None:
            # No source, but a default value: the default is the value
            value = make({"k": "literal", "value": fallback}, _literal_type(fallback, target_field["type"]), False)
        missing = not value and required
        unsafe_null = (
            bool(value) and value["nullable"] and not target_field["nullable"] and not target_field["optional"]
        )
        return {"field": target_field, "value": value, "missing": missing, "unsafeNull": unsafe_null}

    def _value(self, field_mapping: dict, target_field: dict, source_model: dict, root: str = "source") -> dict | None:
        transform = field_mapping["transform"]
        kind = transform["kind"]
        target_type = target_field["type"]
        if kind == "constant":
            constant = transform["value"]
            return make({"k": "literal", "value": constant}, _literal_type(constant, target_type), constant is None)
        if kind == "expression":
            parsed = parse_expression(transform["expression"])
            if not parsed["ok"]:
                return None
            fields: dict[str, dict] = {}
            for path in parsed["fields"]:
                resolved = self._path(root, source_model, path)
                if not resolved:
                    return None
                fields[".".join(path)] = resolved
            # An expression handles missing values itself (a ?? b): its result is taken as present
            return make({"k": "expr", "expr": parsed["expr"], "fields": fields}, target_type, False)
        inputs = [self._path(root, source_model, path) for path in field_mapping["sources"]]
        if not inputs or any(item is None for item in inputs):
            return None
        first = inputs[0]
        text = primitive("string")
        if kind == "direct":
            return convert_to(first, target_type)
        if kind == "concat":
            # A missing part is joined as empty text, so the result is never null
            parts = []
            for part in inputs:
                as_text = convert_to(part, text)
                if as_text["nullable"]:
                    empty = make({"k": "literal", "value": ""}, text, False)
                    as_text = make({"k": "coalesce", "value": as_text, "fallback": empty}, text, False)
                parts.append(as_text)
            return make({"k": "concat", "parts": parts, "separator": transform["separator"]}, text, False)
        if kind == "split":
            node = {"k": "split", "value": first, "separator": transform["separator"], "part": transform["part"]}
            return make(node, text, first["nullable"])
        if kind == "boolean":
            node = {"k": "boolean", "value": first, "trueValues": transform["trueValues"]}
            return make(node, primitive("boolean"), first["nullable"])
        if kind == "enum":
            target_enum = find_enum(self.target, target_type["name"]) if target_type["kind"] == "enum" else None
            if not target_enum:
                return None
            source_enum = find_enum(self.source, first["type"]["name"]) if first["type"]["kind"] == "enum" else None
            if source_enum:
                self.source_enums[source_enum["name"]] = None
            self.target_enums[target_enum["name"]] = None
            node = {"k": "enumMap", "value": first, "target": target_enum, "pairs": transform["pairs"]}
            if "fallback" in transform:
                node["fallback"] = transform["fallback"]
            if source_enum:
                node["source"] = source_enum
            return make(node, target_type, first["nullable"])
        if kind == "epoch":
            to_date = target_type["kind"] == "primitive" and target_type["name"] in ("datetime", "date")
            node = {"k": "epoch", "value": first, "unit": transform["unit"], "toDate": to_date}
            return make(node, target_type, first["nullable"])
        if kind == "arithmetic":
            node = {
                "k": "arithmetic",
                "value": convert_to(first, target_type),
                "operator": transform["operator"],
                "operand": transform["operand"],
            }
            return make(node, target_type, first["nullable"])
        if kind == "object":
            mapper = self.mapper(transform["mapping"])
            if not mapper:
                return None
            return make({"k": "mapper", "value": first, "mapper": mapper}, target_type, first["nullable"])
        if kind == "collection":
            first_type = first["type"]
            source_items = (
                first_type["items"]
                if first_type["kind"] == "array"
                else first_type["value"]
                if first_type["kind"] == "map"
                else None
            )
            target_items = (
                target_type["items"]
                if target_type["kind"] == "array"
                else target_type["value"]
                if target_type["kind"] == "map"
                else None
            )
            if not source_items or not target_items:
                return None
            items_nullable = first_type["kind"] == "array" and first_type.get("itemsNullable") is True
            item = find_model(self.source, source_items["name"]) if source_items["kind"] == "model" else None
            if transform.get("mapping"):
                mapper = self.mapper(transform["mapping"])
                if not mapper or not item:
                    return None
                own = make({"k": "self", "root": "item", "model": item}, source_items, items_nullable)
                element = make({"k": "mapper", "value": own, "mapper": mapper}, target_items, items_nullable)
            else:
                if target_items["kind"] == "enum":
                    self.target_enums[target_items["name"]] = None
                model = item or {"name": "", "kind": "object", "fields": []}
                own = make({"k": "self", "root": "item", "model": model}, source_items, items_nullable)
                element = convert_to(own, target_items)
            node = {"k": "list", "value": first, "element": element, "isMap": first_type["kind"] == "map"}
            original = target_field.get("originalType")
            container = original.split("<")[0].strip() if original else ""
            if container:
                node["container"] = container
            return make(node, target_type, first["nullable"])
        return None


def build_plan(mapping_set: dict, source: dict, target: dict) -> dict | None:
    """Lowers the mapping (from its root) for the generators."""
    planner = _Planner(mapping_set, source, target)
    root = planner.mapper(mapping_set["root"])
    if not root:
        return None
    enums = {
        "source": [item for item in (find_enum(source, name) for name in planner.source_enums) if item],
        "target": [item for item in (find_enum(target, name) for name in planner.target_enums) if item],
    }
    return {
        "root": root,
        "mappers": planner.order,
        "source": source,
        "target": target,
        "set": mapping_set,
        "enums": enums,
    }


def walk_value(value: dict, visit) -> None:
    """Visits every value of a plan, nested ones included."""
    visit(value)
    kind = value["k"]
    if kind in ("convert", "split", "boolean", "enumMap", "epoch", "arithmetic", "mapper"):
        walk_value(value["value"], visit)
    elif kind == "list":
        walk_value(value["value"], visit)
        walk_value(value["element"], visit)
    elif kind == "coalesce":
        walk_value(value["value"], visit)
        walk_value(value["fallback"], visit)
    elif kind == "concat":
        for part in value["parts"]:
            walk_value(part, visit)
    elif kind == "expr":
        for field in value["fields"].values():
            walk_value(field, visit)


def all_values(plan: dict) -> list[dict]:
    """Every value of a plan, for generators that need to know what is used (imports, helpers)."""
    values: list[dict] = []
    for mapper in plan["mappers"]:
        for assignment in mapper["assignments"]:
            if assignment["value"]:
                walk_value(assignment["value"], values.append)
    return values


# Formats that describe documents: dates, times and ids in them are text
_DOCUMENT_FORMATS = {"json", "yaml", "xml", "csv", "jsonschema", "openapi", "modelschema"}
_TEXTUAL = {"date", "datetime", "time", "duration", "uuid"}


def _textual_type(type_ref: dict) -> dict:
    if type_ref["kind"] == "primitive" and type_ref["name"] in _TEXTUAL:
        return primitive("string")
    if type_ref["kind"] == "array":
        return {**type_ref, "items": _textual_type(type_ref["items"])}
    if type_ref["kind"] == "map":
        return {**type_ref, "value": _textual_type(type_ref["value"])}
    return type_ref


def is_document_schema(schema: dict) -> bool:
    """Whether the schema describes a document read as plain objects (JSON keys and text values)."""
    return (schema.get("origin") or {}).get("format", "") in _DOCUMENT_FORMATS


def as_document_values(schema: dict) -> dict:
    """The schema as a program sees a document read as plain objects: dates and ids are text."""
    if not is_document_schema(schema):
        return schema
    return {
        **schema,
        "models": [
            {**model, "fields": [{**field, "type": _textual_type(field["type"])} for field in model["fields"]]}
            for model in schema["models"]
        ],
    }


def plan_for_plain_objects(plan: dict, source: bool, target: bool) -> dict:
    """The plan for a language that reads and writes documents as plain objects (JavaScript, Python dicts)."""
    if not (source and is_document_schema(plan["source"])) and not (target and is_document_schema(plan["target"])):
        return plan
    rebuilt = build_plan(
        plan["set"],
        as_document_values(plan["source"]) if source else plan["source"],
        as_document_values(plan["target"]) if target else plan["target"],
    )
    return rebuilt or plan
