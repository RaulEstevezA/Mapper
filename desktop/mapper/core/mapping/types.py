"""The internal mapping: how every field of a target model gets its value from a source model. Mirrors
web/src/core/mapping/types.ts. Language-neutral, like the models; generators turn it into code
(docs/internal-model.md).

A mapping set is {"root", "mappings"}; a model mapping {"id", "source", "target", "fields", "ignoredSources"};
a field mapping {"target", "sources", "transform", "fallback"?, "status", "confidence", "manual"?, "reasons"?,
"candidates"?}. A source path is a list of field names: [] is the whole source object.
"""


def mapping_id(source: str, target: str) -> str:
    return f"{source}->{target}"


def find_mapping(mapping_set: dict, mapping: str) -> dict | None:
    return next((item for item in mapping_set["mappings"] if item["id"] == mapping), None)


def path_key(path: list[str]) -> str:
    return ".".join(path)


def source_count(transform: dict) -> dict:
    """Sources a transformation needs: none for a constant, two or more for a concatenation, one otherwise (an
    expression names its own)."""
    kind = transform["kind"]
    if kind == "constant":
        return {"min": 0, "max": 0}
    if kind == "concat":
        return {"min": 2, "max": 16}
    if kind == "expression":
        return {"min": 0, "max": 16}
    return {"min": 1, "max": 1}
