"""What a code generator offers. Mirrors web/src/core/generate/types.ts.

Generated code is {"files": [{"name", "code"}], "notes": [{"code", "params"?}]}; settings are {"mode", "naming",
"options"}. Naming modes: auto (as in the input when it is the same language, or plain objects from JSON;
converted otherwise), keep (always as in the input) and convention (always the language's convention).
"""

import re
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass(frozen=True)
class GeneratorOption:
    id: str
    choices: tuple[str, ...]
    # choice: one of choices; text: free text (a package or module name), choices[0] by default
    kind: str = "choice"


@dataclass(frozen=True)
class CodeGenerator:
    id: str
    label: str
    # Highlighting used by the editor
    editor_language: str
    # Ways of writing the mapping; the first is the default
    modes: tuple[str, ...]
    options: tuple[GeneratorOption, ...]
    generate: Callable[[dict, dict], dict]
    # Option values that suit the models, used until the user changes them
    defaults: Callable[[dict], dict] | None = field(default=None)


_TEXT_OPTION = re.compile(r"[\w./@\\-]*", re.ASCII)


def option_value(generator: CodeGenerator, plan: dict | None, settings: dict, option_id: str) -> str:
    option = next((item for item in generator.options if item.id == option_id), None)
    chosen = settings["options"].get(option_id)
    if (
        option
        and chosen is not None
        and (chosen in option.choices or (option.kind == "text" and _TEXT_OPTION.fullmatch(chosen)))
    ):
        return chosen
    fallback = generator.defaults(plan).get(option_id) if plan and generator.defaults else None
    if fallback is not None:
        return fallback
    return option.choices[0] if option else ""
