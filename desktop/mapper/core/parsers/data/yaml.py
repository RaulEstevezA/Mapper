"""A YAML document used as an example of the model (configuration, fixtures). Mirrors
web/src/core/parsers/data/yaml.ts.

PyYAML follows YAML 1.1 (yes / no are booleans, 012 is octal, dates become dates); the web version's yaml
package follows the YAML 1.2 core schema. The loader below resolves plain values the 1.2 way, so both
versions read the same document the same way.
"""

import re

import yaml

from ...js import trim, trim_start
from ..types import InputParser, failure, root_name
from .infer import from_plain_value
from .json import from_data_value

# key: value at the start of a line, or - item
_MAPPING_LINE = re.compile(r"^[ \t]*(?:- )?[\w\"'][\w .\-\"']*:(?:[ \t]|$)", re.MULTILINE | re.ASCII)
_CODE_LINE_END = re.compile(r"[{};]\s*$", re.MULTILINE)


class _Loader(yaml.SafeLoader):
    """YAML 1.2 core schema: null, true / false, decimal, octal (0o) and hexadecimal (0x) integers and floats."""


_Loader.yaml_implicit_resolvers = {}
_RESOLVERS = (
    ("tag:yaml.org,2002:null", r"^(?:~|null|Null|NULL|)$", list("~nN") + [""]),
    ("tag:yaml.org,2002:bool", r"^(?:true|True|TRUE|false|False|FALSE)$", list("tTfF")),
    ("tag:yaml.org,2002:int", r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$", list("-+0123456789")),
    (
        "tag:yaml.org,2002:float",
        r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$",
        list("-+0123456789."),
    ),
)
for _tag, _pattern, _first in _RESOLVERS:
    _Loader.add_implicit_resolver(_tag, re.compile(_pattern), _first)


def _construct_int(loader: yaml.SafeLoader, node: yaml.Node) -> int:
    value = loader.construct_scalar(node)
    if value.startswith("0o"):
        return int(value[2:], 8)
    if value.startswith("0x"):
        return int(value[2:], 16)
    return int(value)


def _construct_float(loader: yaml.SafeLoader, node: yaml.Node) -> float:
    value = loader.construct_scalar(node).lower()
    if value.endswith(".inf"):
        return float("-inf") if value.startswith("-") else float("inf")
    if value == ".nan":
        return float("nan")
    return float(value)


def _construct_unknown(loader: yaml.SafeLoader, _suffix: str, node: yaml.Node):
    # A tag the core schema does not know (!Ref): the value as written, like the web version
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_scalar(node)


_Loader.add_constructor("tag:yaml.org,2002:int", _construct_int)
_Loader.add_constructor("tag:yaml.org,2002:float", _construct_float)
_Loader.add_multi_constructor("!", _construct_unknown)


def read_yaml(text: str) -> dict:
    """{"ok": True, "value"} with the document as plain values, or {"ok": False, "outcome"} with the error
    and the position of the first problem."""
    if trim(text) == "":
        return {"ok": False, "outcome": failure("empty")}
    try:
        # Aliases are expanded once each by PyYAML, so a document cannot grow without limit
        value = yaml.load(text, Loader=_Loader)  # noqa: S506 - a safe loader with the core schema only
    except yaml.MarkedYAMLError as error:
        mark = error.problem_mark or error.context_mark
        position = {"line": mark.line + 1, "column": mark.column + 1} if mark else None
        message = (error.problem or error.context or "").split("\n")[0]
        return {"ok": False, "outcome": failure("syntax", position, {"message": message})}
    except (yaml.YAMLError, RecursionError) as error:
        return {"ok": False, "outcome": failure("syntax", None, {"message": str(error).split("\n")[0]})}
    return {"ok": True, "value": value}


def _detect(text: str) -> float:
    trimmed = trim_start(text)
    if trimmed.startswith(("{", "[", "<")):
        return 0
    if trimmed.startswith("---"):
        return 0.7
    # Code also has name: type lines; braces and semicolons give it away
    if _CODE_LINE_END.search(text):
        return 0.1
    return 0.5 if _MAPPING_LINE.search(text) else 0


def _parse(text: str, options: dict | None = None) -> dict:
    read = read_yaml(text)
    if not read["ok"]:
        return read["outcome"]
    return from_data_value(from_plain_value(read["value"]), root_name(options, "Root"), "yaml")


yaml_parser = InputParser("yaml", "data", "YAML", (".yaml", ".yml"), "yaml", _detect, _parse)
