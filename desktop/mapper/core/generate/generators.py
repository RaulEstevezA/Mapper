"""Every output language, in the order the selector shows them. Mirrors web/src/core/generate/generators.ts.
Adding a language means adding it here."""

from .languages.csharp import csharp_generator
from .languages.dart import dart_generator
from .languages.go import go_generator
from .languages.java import java_generator
from .languages.kotlin import kotlin_generator
from .languages.php import php_generator
from .languages.python import python_generator
from .languages.rust import rust_generator
from .languages.swift import swift_generator
from .languages.typescript import javascript_generator, typescript_generator
from .types import CodeGenerator

GENERATORS: tuple[CodeGenerator, ...] = (
    typescript_generator,
    javascript_generator,
    python_generator,
    java_generator,
    csharp_generator,
    kotlin_generator,
    dart_generator,
    swift_generator,
    go_generator,
    rust_generator,
    php_generator,
)


def find_generator(generator_id: str) -> CodeGenerator:
    return next((generator for generator in GENERATORS if generator.id == generator_id), typescript_generator)
