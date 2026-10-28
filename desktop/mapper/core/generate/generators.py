"""Every output language, in the order the selector shows them. Mirrors web/src/core/generate/generators.ts.
Adding a language means adding it here."""

from .languages.typescript import javascript_generator, typescript_generator
from .types import CodeGenerator

GENERATORS: tuple[CodeGenerator, ...] = (
    typescript_generator,
    javascript_generator,
)


def find_generator(generator_id: str) -> CodeGenerator:
    return next((generator for generator in GENERATORS if generator.id == generator_id), typescript_generator)
