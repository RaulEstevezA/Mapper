"""Every generator against shared/test-cases/generators/<case>/: the models and the mapping in prepared.json
and the code expected for every mode, naming mode and option choice in expected.json, the same files the web
version's tests read (web/src/core/shared.test.ts)."""

import json

import pytest

from mapper.core.generate.generators import GENERATORS
from mapper.core.generate.plan import build_plan

from .conftest import SHARED_CASES, as_json

CASES = sorted(path for path in (SHARED_CASES / "generators").iterdir() if (path / "expected.json").exists())


def variants():
    """Every mode, every naming mode with the first mode, and every choice of the options that have choices."""
    result = []
    for generator in GENERATORS:

        def add(key, settings, generator=generator):
            merged = {"mode": generator.modes[0], "naming": "auto", "options": {}, **settings}
            result.append((f"{generator.id}-{key}", generator, merged))

        for mode in generator.modes:
            add(mode, {"mode": mode})
        for naming in ("keep", "convention"):
            add(f"naming-{naming}", {"naming": naming})
        for option in generator.options:
            if option.kind == "text":
                continue
            for choice in option.choices[1:]:
                add(f"{option.id}-{choice}", {"options": {option.id: choice}})
    return result


@pytest.mark.parametrize("case", CASES, ids=lambda path: path.name)
def test_generators(case):
    prepared = json.loads((case / "prepared.json").read_text(encoding="utf-8"))
    expected = json.loads((case / "expected.json").read_text(encoding="utf-8"))
    plan = build_plan(prepared["set"], prepared["source"], prepared["target"])
    assert plan is not None
    for key, generator, settings in variants():
        assert as_json(generator.generate(plan, settings)) == expected[key], key
    assert sorted(expected) == sorted(key for key, _, _ in variants())
