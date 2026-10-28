"""Annotations, decorators and attributes, and what the well-known ones say about a field. Mirrors
web/src/core/parsers/code/annotations.ts."""

import re

from ...js import coalesce, trim
from .lexer import Cursor
from .raw import RawType


def read_at_annotation(cursor: Cursor, source: str) -> dict | None:
    """Reads @Name, @pkg.Name(args) at the cursor (Java, Kotlin, Dart, TypeScript and Python decorators)."""
    if not cursor.is_("@") or not cursor.is_ident(1):
        return None
    cursor.next()
    name = cursor.next().value
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        name += f".{cursor.next().value}"
    # Kotlin use-site targets: @field:Json(...), @get:JsonProperty
    if cursor.is_(":") and cursor.is_ident(1) and name in ("field", "get", "set", "param", "property"):
        cursor.next()
        return _read_named_annotation(cursor, source, cursor.next().value)
    return _read_named_annotation(cursor, source, name)


def _read_named_annotation(cursor: Cursor, source: str, name: str) -> dict:
    if not cursor.is_("("):
        return {"name": name}
    start = cursor.index
    cursor.skip_group()
    text = cursor.text_between(source, start, cursor.index)
    return {"name": name, "args": trim(text[1:-1])}


def read_bracket_attributes(cursor: Cursor, source: str) -> list[dict]:
    """Reads a bracketed attribute list: C# [Required, Column("x")], Rust and PHP #[serde(rename = "x")].
    The cursor must be on [ or #[. Returns one annotation per comma-separated entry."""
    start = cursor.index
    cursor.skip_group()
    end = cursor.index
    tokens = cursor.tokens
    annotations: list[dict] = []

    def at(position: int):
        return tokens[position] if position < len(tokens) else None

    # Inner tokens, without the brackets
    index = start + 1
    while index < end - 1:
        token = tokens[index]
        if token.kind != "ident":
            index += 1
            continue
        name = token.value
        index += 1
        while (
            index < end - 1
            and tokens[index].value in (".", "::", "\\")
            and at(index + 1) is not None
            and at(index + 1).kind == "ident"
        ):
            name += f"{tokens[index].value}{tokens[index + 1].value}"
            index += 2
        # C# attribute targets: [property: JsonPropertyName("x")]
        if at(index) is not None and at(index).value == ":" and name in ("property", "field", "param", "return"):
            index += 1
            continue
        annotation: dict = {"name": name}
        if at(index) is not None and at(index).value == "(":
            depth = 0
            start_index = index
            while index < end:
                current = tokens[index]
                if current.kind != "string":
                    if current.value in ("(", "[", "{"):
                        depth += 1
                    elif current.value in (")", "]", "}"):
                        depth -= 1
                        if depth == 0:
                            break
                index += 1
            stop = tokens[index].start if index < len(tokens) else len(source)
            annotation["args"] = trim(source[tokens[start_index].end : stop])
            index += 1
        annotations.append(annotation)
        # Skip to the next entry
        while index < end - 1 and tokens[index].value != ",":
            index += 1
        index += 1
    return annotations


_POSITIONAL = re.compile(r"^\s*(?:value\s*=\s*)?(?:[rR]|@)?([\"'`])((?:\\.|(?!\1).)*)\1")
_NAMED: dict[str, re.Pattern] = {}


def annotation_arg(annotation: dict | None, name: str | None) -> str | None:
    """Value of a named argument (name = "x", name: 'x', nullable = false) or, with None, the first string
    argument (@JsonProperty("x"))."""
    if not annotation or not annotation.get("args"):
        return None
    args = annotation["args"]
    if name is None:
        match = _POSITIONAL.search(args)
        return match.group(2) if match else None
    pattern = _NAMED.get(name)
    if pattern is None:
        pattern = re.compile(rf"(?:^|[\s,({{]){name}\s*[:=]\s*(?:([\"'`])((?:\\.|(?!\1).)*)\1|([A-Za-z0-9_.\-]+))")
        _NAMED[name] = pattern
    match = pattern.search(args)
    if not match:
        return None
    return coalesce(match.group(2), match.group(3))


_SPLIT = re.compile(r"\.|::|\\")


def _simple(name: str) -> str:
    return _SPLIT.split(name)[-1].lower()


# Names whose first string argument is the name on the wire
_SERIALIZED_NAME = {
    "jsonproperty",
    "serializedname",
    "jsonpropertyname",
    "jsonkey",
    "json",
    "serialname",
    "jsonfield",
    "expose",
    "jsonname",
}
_NOT_NULL = {"notnull", "nonnull", "notblank", "notempty", "required", "isnotempty", "isdefined"}
_NULLABLE = {"nullable", "isoptional", "optional"}
# Values the database or framework fills in: never needed from a mapping
_GENERATED = {
    "generatedvalue",
    "primarygeneratedcolumn",
    "createdatecolumn",
    "updatedatecolumn",
    "deletedatecolumn",
    "versioncolumn",
    "createddate",
    "lastmodifieddate",
    "creationtimestamp",
    "updatetimestamp",
    "databasegenerated",
    "version",
}
_IGNORED = {"transient", "jsonignore", "notmapped", "exclude"}
_QUOTED = re.compile(r"[\"']([^\"']+)[\"']")


def _not_null(field: dict) -> None:
    field["nullable"] = False
    if field.get("type") and field["type"].get("nullable"):
        field["type"] = {**field["type"], "nullable": False}


def apply_annotations(field: dict, annotations: list[dict]) -> bool:
    """Applies what well-known annotations say about a field: its name on the wire or in the database,
    whether it can be null, and whether it is generated. Returns False when the field is not part of the
    data (@Transient, [NotMapped]) and should be dropped."""
    if not annotations:
        return True
    field["annotations"] = [*(field.get("annotations") or []), *annotations]
    for annotation in annotations:
        name = _simple(annotation["name"])
        if name in _IGNORED:
            return False
        if name in _SERIALIZED_NAME:
            wire = coalesce(
                annotation_arg(annotation, None),
                annotation_arg(annotation, "name"),
                annotation_arg(annotation, "value"),
            )
            if wire:
                field["serializedName"] = wire
        if name == "jsonalias":
            aliases = _QUOTED.findall(annotation.get("args") or "")
            if aliases:
                field["aliases"] = aliases
        if name in _NOT_NULL:
            _not_null(field)
        if name in _NULLABLE:
            field["nullable"] = True
            if name != "nullable":
                field["optional"] = True
        if name in _GENERATED:
            field["generated"] = True
        if name in ("column", "joincolumn", "field"):
            column = coalesce(
                annotation_arg(annotation, "name"), annotation_arg(annotation, None) if name == "column" else None
            )
            if column:
                field["serializedName"] = column
            nullable = coalesce(annotation_arg(annotation, "nullable"), annotation_arg(annotation, "null"))
            if nullable in ("false", "False"):
                _not_null(field)
            if nullable in ("true", "True"):
                field["nullable"] = True
            alias = annotation_arg(annotation, "alias")
            if alias:
                field["serializedName"] = alias
        if name == "id" and any(_simple(item["name"]) in _GENERATED for item in annotations):
            field["generated"] = True
    return True


def raw_name(type_ref: RawType | None) -> str:
    """The name of a raw type without generics, for checks like "is this a list?"."""
    return _SPLIT.split(type_ref["name"])[-1] if type_ref else ""
