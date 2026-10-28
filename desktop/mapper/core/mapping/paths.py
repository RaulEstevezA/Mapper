"""Values at a path of a model. Mirrors web/src/core/mapping/paths.ts."""

from ..model.schema import all_fields, find_model


def resolve_path(schema: dict, model_name: str, path: list) -> dict | None:
    """Type of the value at a path of a model: {"type", "nullable", "steps"}, or None when some step does not
    exist. [] is the model itself. nullable says whether the field itself or any object on the way to it may
    be null or missing; steps are the fields from the model to the value."""
    if not path:
        if find_model(schema, model_name):
            return {"type": {"kind": "model", "name": model_name}, "nullable": False, "steps": []}
        return None
    model = find_model(schema, model_name)
    steps: list[dict] = []
    nullable = False
    for part in path:
        if not model:
            return None
        field = next((item for item in all_fields(schema, model) if item["name"] == part), None)
        if not field:
            return None
        steps.append(field)
        nullable = nullable or field["nullable"] or field["optional"]
        model = find_model(schema, field["type"]["name"]) if field["type"]["kind"] == "model" else None
    return {"type": steps[-1]["type"], "nullable": nullable, "steps": steps}


def element_type(type_ref: dict) -> dict:
    """The type at the bottom of arrays and maps (Order[] → Order)."""
    if type_ref["kind"] == "array":
        return element_type(type_ref["items"])
    if type_ref["kind"] == "map":
        return element_type(type_ref["value"])
    return type_ref
