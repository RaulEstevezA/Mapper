"""An XML document used as an example of the model. Mirrors web/src/core/parsers/data/xml.ts, which reads
it with the browser's DOMParser; here the standard library's parser (expat) builds the same tree."""

import re
from xml.dom import Node, minidom
from xml.parsers.expat import ExpatError

from ...js import trim, trim_start
from ...model.naming import singularize
from ..types import InputParser, failure, root_name
from .csv import typed_cell
from .json import from_data_value


def _children(element) -> list:
    return [node for node in element.childNodes if node.nodeType == Node.ELEMENT_NODE]


def _text_content(node) -> str:
    if node.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE):
        return node.data
    if node.nodeType == Node.ELEMENT_NODE:
        return "".join(_text_content(child) for child in node.childNodes)
    return ""


def _local_name(node) -> str:
    return node.localName or node.nodeName.split(":")[-1]


def _element_value(element) -> dict:
    """Element as a value: attributes and child elements become keys, repeated children become arrays and
    text becomes a typed value (<age>42</age> is a number). Namespace prefixes are dropped."""
    children = _children(element)
    attributes = [
        element.attributes.item(index)
        for index in range(element.attributes.length)
        if not element.attributes.item(index).name.startswith("xmlns")
    ]
    if not children and not attributes:
        return typed_cell(_text_content(element))

    # <items><item/><item/></items>: a wrapper around a list, even when it holds a single element
    names = [_local_name(child) for child in children]
    single = bool(names) and all(name == names[0] for name in names)
    own = _local_name(element)
    if not attributes and single and (len(names) > 1 or singularize(own) == names[0]) and own != names[0]:
        return {"kind": "array", "items": [_element_value(child) for child in children]}

    entries = [(_local_name(attribute), typed_cell(attribute.value)) for attribute in attributes]
    grouped: dict[str, list] = {}
    for child in children:
        grouped.setdefault(_local_name(child), []).append(child)
    for name, group in grouped.items():
        value = (
            {"kind": "array", "items": [_element_value(child) for child in group]}
            if len(group) > 1
            else _element_value(group[0])
        )
        entries.append((name, value))
    text = trim(
        "".join(node.data for node in element.childNodes if node.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE))
    )
    if text != "":
        entries.append(("value", typed_cell(text)))
    return {"kind": "object", "entries": entries}


_START_TAG = re.compile(r"<[A-Za-z_][\w.:-]*[\s>/]", re.ASCII)


def _detect(text: str) -> float:
    trimmed = trim_start(text)
    if trimmed.startswith("<?xml"):
        return 0.95
    return 0.8 if _START_TAG.match(trimmed) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    if trim(text) == "":
        return failure("empty")
    try:
        # A DOCTYPE could declare entities that expand without limit: documents with one are not read
        if "<!DOCTYPE" in text or "<!ENTITY" in text:
            raise ExpatError("DOCTYPE declarations are not supported")
        document = minidom.parseString(text)
    except ExpatError as error:
        line = getattr(error, "lineno", None)
        position = {"line": line, "column": (getattr(error, "offset", 0) or 0) + 1} if line else None
        return failure("syntax", position, {"message": str(error).split("\n")[0]})
    root = document.documentElement
    # The root element names the model: XML always has a name of its own
    name = _local_name(root) or root_name(options, "Root") or "Root"
    value = _element_value(root)
    if value["kind"] not in ("object", "array"):
        value = {"kind": "object", "entries": [("value", value)]}
    return from_data_value(value, name, "xml")


xml_parser = InputParser("xml", "data", "XML", (".xml",), "xml", _detect, _parse)
