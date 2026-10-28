"""Every case in shared/test-cases/calls/: the arguments of a core function and the result the web
version gives for them (web/src/core/shared.test.ts writes and checks the same files)."""

import importlib
import json

import pytest

from .conftest import SHARED_CASES, as_json

# Web function → Python module and function
FUNCTIONS = {
    "naming.splitWords": "model.naming.split_words",
    "naming.toPascalCase": "model.naming.to_pascal_case",
    "naming.toCamelCase": "model.naming.to_camel_case",
    "naming.toSnakeCase": "model.naming.to_snake_case",
    "naming.singularize": "model.naming.singularize",
    "compatibility.compatibility": "model.compatibility.compatibility",
    "registry.detectFormats": "parsers.registry.detect_formats",
    "registry.parseInput": "parsers.registry.parse_input",
    "engine.suggestMapping": "matching.engine.suggest_mapping",
    "engine.resuggestMapping": "matching.engine.resuggest_mapping",
    "engine.sourceOptions": "matching.engine.source_options",
    "engine.suggestEnumPairs": "matching.engine.suggest_enum_pairs",
    "engine.coverage": "matching.engine.coverage",
    "engine.defaultTransform": "matching.engine.default_transform",
    "edit.chooseSources": "mapping.edit.choose_sources",
    "edit.acceptCandidate": "mapping.edit.accept_candidate",
    "edit.rejectSuggestion": "mapping.edit.reject_suggestion",
    "edit.ignoreTarget": "mapping.edit.ignore_target",
    "edit.setTransform": "mapping.edit.set_transform",
    "edit.setFallback": "mapping.edit.set_fallback",
    "edit.resetField": "mapping.edit.reset_field",
    "edit.toggleIgnoredSource": "mapping.edit.toggle_ignored_source",
    "edit.acceptAllReviews": "mapping.edit.accept_all_reviews",
    "edit.pruneMappings": "mapping.edit.prune_mappings",
    "edit.setExpression": "mapping.edit.set_expression",
    "validate.validateMapping": "mapping.validate.validate_mapping",
    "paths.resolvePath": "mapping.paths.resolve_path",
    "expression.parseExpression": "transform.expression.parse_expression",
    "plan.buildPlan": "generate.plan.build_plan",
    "models.draftTarget": "generate.models.draft_target",
    "project.createProject": "project.project.create_project",
    "project.readProject": "project.project.read_project",
    "handoff.readHandoff": "project.handoff.read_handoff",
    "workspace.readInput": "workspace.read_input",
    "workspace.reconcile": "workspace.reconcile",
}

FILES = sorted((SHARED_CASES / "calls").glob("*.json"))


def resolve(name: str):
    module, _, function = FUNCTIONS[name].rpartition(".")
    try:
        return getattr(importlib.import_module(f"mapper.core.{module}"), function)
    except (ImportError, AttributeError):
        return None


def comparable(result):
    """Errors that come from a library (the YAML and XML parsers) keep only their code: each version reads
    those formats with a different library, so messages and positions differ (shared/README.md)."""
    error = result.get("error") if isinstance(result, dict) and result.get("ok") is False else None
    if error and error.get("code") == "syntax" and "message" in error.get("params", {}):
        return {"ok": False, "error": {"code": "syntax", "library": True}}
    return result


def test_every_file_has_a_function():
    assert {path.stem for path in FILES} <= set(FUNCTIONS)


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.stem)
def test_calls(path):
    function = resolve(path.stem)
    if function is None:
        pytest.skip(f"{FUNCTIONS[path.stem]} is not ported yet")
    for index, case in enumerate(json.loads(path.read_text(encoding="utf-8"))):
        expected = comparable(case["result"])
        assert comparable(as_json(function(*case["args"]))) == expected, f"{path.stem} #{index}: {case['args']!r:.300}"
