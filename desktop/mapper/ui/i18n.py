"""English and Spanish texts. Mirrors web/src/i18n/messages.ts for the texts both versions share; the desktop
says "this computer" where the web says "this browser", and "Save" where it says "Download"."""

import math
from types import SimpleNamespace

from PySide6.QtCore import QLocale, QObject, QSettings, Signal

from ..core.js import js_string


def _en_number(value: int) -> str:
    return f"{value:,}"


def _es_number(value: int) -> str:
    # Spanish groups thousands only from five digits on: 1234, 12.345
    return f"{value:,}".replace(",", ".") if abs(value) >= 10000 else str(value)


def _p(params: dict | None, key: str) -> str:
    value = (params or {}).get(key)
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _plural(count, one: str, many: str) -> str:
    return one if count == 1 else many


_JSON_DETAIL_EN = {
    "json.unexpectedEnd": "The JSON ends too early: something is not closed.",
    "json.unexpectedCharacter": "Unexpected character.",
    "json.trailingComma": "Comma before the end of a list or object: remove it.",
    "json.invalidNumber": "Invalid number: JSON does not allow leading zeros or a dot without decimals.",
    "json.invalidEscape": "Unknown escape sequence.",
    "json.controlCharacter": "Line break or tab inside a text: write it as \\n or \\t.",
    "json.trailingContent": "There is more text after the end of the JSON.",
    "json.tooDeep": "The JSON is nested too deeply.",
    "modelSchema": "This model schema is not valid.",
}

_JSON_DETAIL_ES = {
    "json.unexpectedEnd": "El JSON termina antes de tiempo: algo no está cerrado.",
    "json.unexpectedCharacter": "Carácter inesperado.",
    "json.trailingComma": "Coma antes del final de una lista u objeto: quítala.",
    "json.invalidNumber": "Número no válido: JSON no admite ceros a la izquierda ni un punto sin decimales.",
    "json.invalidEscape": "Secuencia de escape desconocida.",
    "json.controlCharacter": "Salto de línea o tabulador dentro de un texto: escríbelo como \\n o \\t.",
    "json.trailingContent": "Hay más texto después del final del JSON.",
    "json.tooDeep": "El JSON tiene demasiados niveles.",
    "modelSchema": "Este esquema de modelos no es válido.",
}


def _parse_issue_en(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "empty":
        return "There is nothing to read."
    if code == "syntax":
        if params and params.get("detail"):
            detail = _JSON_DETAIL_EN.get(str(params["detail"]), str(params["detail"]))
            return detail + (f" ({_p(params, 'path')})" if params.get("path") else "")
        return f"Not valid: {_p(params, 'message')}"
    texts = {
        "unexpectedToken": f"Unexpected “{_p(params, 'found')}”.",
        "unterminatedString": "A text (string) is not closed.",
        "unterminatedComment": "A comment is not closed.",
        "unclosedBlock": "A block is not closed.",
        "noModels": "No model was found: paste a class, a type, a JSON object or a schema.",
        "unknownType": f"Unknown type “{_p(params, 'type')}”: it is mapped as it is.",
        "mixedTypes": f"“{_p(params, 'field')}” has values of different types: it is read as any value.",
        "duplicateField": f"“{_p(params, 'field')}” appears twice in {_p(params, 'model')}: the first one is used.",
        "duplicateModel": f"{_p(params, 'model')} is declared twice: the first one is used.",
        "emptyModel": f"{_p(params, 'model')} has no fields.",
        "truncatedRows": f"Only the first {_p(params, 'rows')} rows were read to infer the columns.",
    }
    return texts.get(code, code)


def _parse_issue_es(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "empty":
        return "No hay nada que leer."
    if code == "syntax":
        if params and params.get("detail"):
            detail = _JSON_DETAIL_ES.get(str(params["detail"]), str(params["detail"]))
            return detail + (f" ({_p(params, 'path')})" if params.get("path") else "")
        return f"No es válido: {_p(params, 'message')}"
    texts = {
        "unexpectedToken": f"“{_p(params, 'found')}” inesperado.",
        "unterminatedString": "Un texto (string) no está cerrado.",
        "unterminatedComment": "Un comentario no está cerrado.",
        "unclosedBlock": "Un bloque no está cerrado.",
        "noModels": "No se ha encontrado ningún modelo: pega una clase, un tipo, un objeto JSON o un esquema.",
        "unknownType": f"Tipo desconocido “{_p(params, 'type')}”: se relaciona tal cual.",
        "mixedTypes": f"“{_p(params, 'field')}” tiene valores de tipos distintos: se lee como cualquier valor.",
        "duplicateField": f"“{_p(params, 'field')}” aparece dos veces en {_p(params, 'model')}: se usa el primero.",
        "duplicateModel": f"{_p(params, 'model')} está declarado dos veces: se usa el primero.",
        "emptyModel": f"{_p(params, 'model')} no tiene campos.",
        "truncatedRows": f"Solo se han leído las primeras {_p(params, 'rows')} filas para deducir las columnas.",
    }
    return texts.get(code, code)


_REASONS_EN = {
    "sameName": "Same name.",
    "sameWords": "Same name in another naming convention.",
    "serializedName": "Same name on the wire (JSON property or column).",
    "modelContext": "Same name once the model name is taken into account.",
    "synonym": "Names with the same meaning.",
    "abbreviation": "One name is an abbreviation or compound of the other.",
    "similarName": "Similar names ({similarity}%).",
    "containsName": "One name contains the other.",
    "flattened": "Read from the nested field {path}.",
    "typeConversion": "The type is converted.",
    "typeFallible": "The value is converted from text: invalid text fails.",
    "typeLossy": "The conversion may lose precision.",
    "typeTransform": "The types need a transformation.",
    "nullToRequired": "The source may be missing, but the target field is required.",
    "nestedModel": "Both are objects: mapped with their own relations.",
    "collection": "Lists mapped element by element.",
    "combined": "Built by joining several fields.",
    "split": "Taken from part of another field.",
    "cents": "An amount in cents divided by 100.",
    "builtFromRoot": "Built from fields of the source itself.",
}

_REASONS_ES = {
    "sameName": "Mismo nombre.",
    "sameWords": "Mismo nombre en otra convención.",
    "serializedName": "Mismo nombre en el formato de intercambio (propiedad JSON o columna).",
    "modelContext": "Mismo nombre teniendo en cuenta el nombre del modelo.",
    "synonym": "Nombres con el mismo significado.",
    "abbreviation": "Un nombre es una abreviatura o compuesto del otro.",
    "similarName": "Nombres parecidos ({similarity} %).",
    "containsName": "Un nombre contiene al otro.",
    "flattened": "Leído del campo anidado {path}.",
    "typeConversion": "El tipo se convierte.",
    "typeFallible": "El valor se convierte desde texto: un texto no válido falla.",
    "typeLossy": "La conversión puede perder precisión.",
    "typeTransform": "Los tipos necesitan una transformación.",
    "nullToRequired": "El origen puede faltar, pero el campo de destino es obligatorio.",
    "nestedModel": "Los dos son objetos: se relacionan con sus propias relaciones.",
    "collection": "Listas relacionadas elemento a elemento.",
    "combined": "Se construye uniendo varios campos.",
    "split": "Se toma de una parte de otro campo.",
    "cents": "Un importe en céntimos dividido entre 100.",
    "builtFromRoot": "Se construye con campos del propio origen.",
}


def _reason(table: dict):
    def text(reason: dict) -> str:
        params = reason.get("params") or {}
        return table.get(reason["code"], reason["code"]).format(
            similarity=_p(params, "similarity"), path=_p(params, "path")
        )

    return text


def _transform_summary_en(transform: dict) -> str:
    kind = transform["kind"]
    if kind == "concat":
        return f"with “{transform['separator']}”"
    if kind == "split":
        part = transform["part"]
        return {0: "first part", "last": "last part", "rest": "after the first part"}.get(
            part, f"part {_number_plus(part)}"
        )
    if kind == "boolean":
        values = transform["trueValues"]
        return f"true if {', '.join(values)}" if values else "true if… (to choose)"
    if kind == "enum":
        count = len(transform["pairs"])
        return f"{count} {_plural(count, 'value', 'values')} related"
    if kind == "epoch":
        return "seconds since 1970" if transform["unit"] == "seconds" else "milliseconds since 1970"
    if kind == "arithmetic":
        return f"{transform['operator']} {_js(transform['operand'])}"
    return {"direct": "", "constant": "constant", "object": "nested object", "collection": "each element"}.get(
        kind, "expression"
    )


def _transform_summary_es(transform: dict) -> str:
    kind = transform["kind"]
    if kind == "concat":
        return f"con «{transform['separator']}»"
    if kind == "split":
        part = transform["part"]
        return {0: "primera parte", "last": "última parte", "rest": "tras la primera parte"}.get(
            part, f"parte {_number_plus(part)}"
        )
    if kind == "boolean":
        values = transform["trueValues"]
        return f"verdadero si {', '.join(values)}" if values else "verdadero si… (por elegir)"
    if kind == "enum":
        count = len(transform["pairs"])
        return f"{count} {_plural(count, 'valor relacionado', 'valores relacionados')}"
    if kind == "epoch":
        return "segundos desde 1970" if transform["unit"] == "seconds" else "milisegundos desde 1970"
    if kind == "arithmetic":
        return f"{transform['operator']} {_js(transform['operand'])}"
    return {"direct": "", "constant": "constante", "object": "objeto anidado", "collection": "cada elemento"}.get(
        kind, "expresión"
    )


def _number_plus(part) -> str:
    return str(part + 1) if isinstance(part, int) else str(part)


def _js(value) -> str:
    return js_string(value)


def _expression_error_en(error: dict) -> str:
    params = error.get("params")
    code = error["code"]
    column = error["column"]
    if code == "unexpectedToken":
        expected = f", expected “{_p(params, 'expected')}”" if params and params.get("expected") else ""
        return f"Column {column}: unexpected “{_p(params, 'found')}”{expected}."
    if code == "argumentCount":
        count = _p(params, "count")
        return f"{_p(params, 'name')} needs at least {count} {_plural(int(count or 0), 'value', 'values')}."
    texts = {
        "empty": "Write an expression.",
        "unterminatedString": f"Column {column}: a text is not closed.",
        "unknownFunction": f"“{_p(params, 'name')}” is not one of the available functions.",
        "unknownField": f"The source has no field “{_p(params, 'field')}”.",
        "typeMismatch": f"{_p(params, 'operator')} expects {_p(params, 'expected')} but gets {_p(params, 'found')}.",
        "tooComplex": "The expression is too long or too nested.",
    }
    return texts.get(code, code)


def _expression_error_es(error: dict) -> str:
    params = error.get("params")
    code = error["code"]
    column = error["column"]
    if code == "unexpectedToken":
        expected = f", se esperaba “{_p(params, 'expected')}”" if params and params.get("expected") else ""
        return f"Columna {column}: “{_p(params, 'found')}” inesperado{expected}."
    if code == "argumentCount":
        count = _p(params, "count")
        return f"{_p(params, 'name')} necesita al menos {count} {_plural(int(count or 0), 'valor', 'valores')}."
    texts = {
        "empty": "Escribe una expresión.",
        "unterminatedString": f"Columna {column}: un texto no está cerrado.",
        "unknownFunction": f"“{_p(params, 'name')}” no es una de las funciones disponibles.",
        "unknownField": f"El origen no tiene el campo “{_p(params, 'field')}”.",
        "typeMismatch": f"{_p(params, 'operator')} espera {_p(params, 'expected')} pero recibe {_p(params, 'found')}.",
        "tooComplex": "La expresión es demasiado larga o tiene demasiados niveles.",
    }
    return texts.get(code, code)


def _diagnostic_en(code: str, field: str, params: dict | None) -> str:
    count = int(float(_p(params, "count") or 0))
    texts = {
        "requiredMissing": f"“{field}” is required and gets no value. Choose a source, a constant or a default value.",
        "unknownSource": f"“{field}” uses {_p(params, 'path')}, which is not in the source any more.",
        "incompatibleType": f"“{field}”: the source type cannot become the target type.",
        "needsTransform": f"“{field}”: the types need a transformation (choose one).",
        "sourceCount": f"“{field}”: this transformation needs a different number of source fields.",
        "transformType": f"“{field}”: the transformation does not suit these types.",
        "booleanValues": f"“{field}”: say which values mean true.",
        "invalidExpression": f"“{field}”: the expression is not valid.",
        "unresolvedObject": f"“{field}”: the nested object has no relations defined.",
        "constantType": f"“{field}”: the constant does not have the type of the field.",
        "nullToRequired": f"“{field}”: the source may be missing but the field is required. "
        "Add a default value or accept that it fails.",
        "fallibleConversion": f"“{field}”: converted from text; text that is not valid fails at run time.",
        "lossyConversion": f"“{field}”: the conversion may lose precision.",
        "enumIncomplete": f"“{field}”: {_p(params, 'values')} {_plural(count, 'has', 'have')} no target value. "
        f"Relate {_plural(count, 'it', 'them')} or choose a value for the rest.",
        "pendingSuggestion": f"“{field}”: suggestion waiting for review.",
        "conflictPending": f"“{field}”: several sources fit; choose one.",
        "unusedSource": f"{_p(params, 'field')} is not used.",
        "optionalUnmapped": f"“{field}” gets no value (it is optional).",
        "conversion": f"“{field}”: the type is converted automatically.",
        "sharedSource": f"{_p(params, 'path')} fills {_p(params, 'count')} target fields.",
    }
    return texts.get(code, code)


def _diagnostic_es(code: str, field: str, params: dict | None) -> str:
    count = int(float(_p(params, "count") or 0))
    texts = {
        "requiredMissing": f"«{field}» es obligatorio y no recibe valor. "
        "Elige un origen, una constante o un valor por defecto.",
        "unknownSource": f"«{field}» usa {_p(params, 'path')}, que ya no está en el origen.",
        "incompatibleType": f"«{field}»: el tipo de origen no puede convertirse en el de destino.",
        "needsTransform": f"«{field}»: los tipos necesitan una transformación (elige una).",
        "sourceCount": f"«{field}»: esta transformación necesita otro número de campos de origen.",
        "transformType": f"«{field}»: la transformación no encaja con estos tipos.",
        "booleanValues": f"«{field}»: indica qué valores significan verdadero.",
        "invalidExpression": f"«{field}»: la expresión no es válida.",
        "unresolvedObject": f"«{field}»: el objeto anidado no tiene relaciones definidas.",
        "constantType": f"«{field}»: la constante no tiene el tipo del campo.",
        "nullToRequired": f"«{field}»: el origen puede faltar pero el campo es obligatorio. "
        "Añade un valor por defecto o acepta que falle.",
        "fallibleConversion": f"«{field}»: se convierte desde texto; un texto no válido falla al ejecutarse.",
        "lossyConversion": f"«{field}»: la conversión puede perder precisión.",
        "enumIncomplete": f"«{field}»: {_p(params, 'values')} no {_plural(count, 'tiene', 'tienen')} valor de destino. "
        f"{_plural(count, 'Relaciónalo', 'Relaciónalos')} o elige un valor para el resto.",
        "pendingSuggestion": f"«{field}»: sugerencia pendiente de revisar.",
        "conflictPending": f"«{field}»: encajan varios orígenes; elige uno.",
        "unusedSource": f"{_p(params, 'field')} no se usa.",
        "optionalUnmapped": f"«{field}» no recibe valor (es opcional).",
        "conversion": f"«{field}»: el tipo se convierte automáticamente.",
        "sharedSource": f"{_p(params, 'path')} rellena {_p(params, 'count')} campos de destino.",
    }
    return texts.get(code, code)


def _note_en(note: dict) -> str:
    params = note.get("params")
    field = _p(params, "field")
    texts = {
        "missingValue": f"“{field}” has no value: the code has a placeholder marked TODO.",
        "unsafeNull": f"“{field}” is required but the source may be missing: the code fails in that case.",
        "enumFallbackThrows": f"Values of {_p(params, 'enum')} without a pair fail at run time.",
        "namesConverted": "Field names were converted to the language convention.",
        "fallibleConversion": f"“{field}” is converted from text and may fail.",
        "expressionApproximation": f"The expression of “{field}” was adapted to the language.",
    }
    return texts.get(note["code"], note["code"])


def _note_es(note: dict) -> str:
    params = note.get("params")
    field = _p(params, "field")
    texts = {
        "missingValue": f"«{field}» no tiene valor: el código lleva un marcador TODO.",
        "unsafeNull": f"«{field}» es obligatorio pero el origen puede faltar: el código falla en ese caso.",
        "enumFallbackThrows": f"Los valores de {_p(params, 'enum')} sin pareja fallan al ejecutarse.",
        "namesConverted": "Los nombres de los campos se han convertido a la convención del lenguaje.",
        "fallibleConversion": f"«{field}» se convierte desde texto y puede fallar.",
        "expressionApproximation": f"La expresión de «{field}» se ha adaptado al lenguaje.",
    }
    return texts.get(note["code"], note["code"])


def _project_error_en(error: str, path: str | None = None) -> str:
    return {
        "notJson": "The file is not a Mapper project (it is not JSON).",
        "notProject": "The file is not a Mapper project.",
        "newerVersion": "The project was saved by a newer version of Mapper.",
    }.get(error, f"The project is damaged{f' ({path})' if path else ''}.")


def _project_error_es(error: str, path: str | None = None) -> str:
    return {
        "notJson": "El archivo no es un proyecto de Mapper (no es JSON).",
        "notProject": "El archivo no es un proyecto de Mapper.",
        "newerVersion": "El proyecto se guardó con una versión más reciente de Mapper.",
    }.get(error, f"El proyecto está dañado{f' ({path})' if path else ''}.")


def _diagnostics_summary(number, words):
    def text(errors: int, warnings: int, info: int) -> str:
        parts = [
            f"{number(errors)} {_plural(errors, *words['error'])}" if errors else "",
            f"{number(warnings)} {_plural(warnings, *words['warning'])}" if warnings else "",
            f"{number(info)} {_plural(info, *words['info'])}" if info else "",
        ]
        return " · ".join(part for part in parts if part) or words["none"]

    return text


def _score(value: float) -> int:
    return math.floor(value * 100)


EN = SimpleNamespace(
    tagline="Relate two data models and generate the code that converts one into the other",
    intro_description="Paste or open the source and the target (classes, DTOs, JSON, schemas), review the relations "
    "Mapper suggests field by field, adjust the transformations and get the mapping code for TypeScript, Python, Java, "
    "C#, Kotlin, Dart, Swift, Go, Rust or PHP.",
    privacy_short="Processed locally",
    privacy_points=[
        "What you paste or open never leaves your computer.",
        "Code is analyzed, never run.",
        "Nothing is saved unless you turn on “Remember on this computer”.",
    ],
    examples_label="Try an example",
    examples={
        "simple": "Simple mapping",
        "names": "Different names",
        "nested": "Nested objects",
        "transformations": "Transformations",
        "arrays": "Lists",
    },
    example_descriptions={
        "simple": "TypeScript DTO to TypeScript model",
        "names": "JSON in snake_case to a Kotlin data class",
        "nested": "Java classes to C# with flattened fields",
        "transformations": "TypeScript to Pydantic: concatenation, cents, enums, dates",
        "arrays": "JSON order with items to Java records",
    },
    developed_by="Developed by",
    tabs={"source": "Source", "target": "Target", "mapping": "Relations", "code": "Code"},
    source_title="Source",
    target_title="Target",
    input_placeholder="Paste a class, DTO, JSON or schema here, or drop a file…",
    open_file="Open",
    clear="Clear",
    create="Create",
    create_unavailable="Paste or open the source first: the new model starts from its fields.",
    create_title="Create the target model",
    create_description=lambda source: (
        f"Mapper writes here a model with the fields of “{source}”, in the conventions "
        "of the format you choose. Then edit it as text: remove, rename or retype what you need."
    ),
    create_format="Format of the new model",
    create_replace="It replaces the current target.",
    create_confirm="Create",
    cancel="Cancel",
    created=lambda model, source: f"Target model “{model}” created from “{source}”. Edit it in the Target panel.",
    format_label="Format",
    format_auto=lambda detected: f"Detect ({detected})" if detected else "Detect automatically",
    model_label="Model",
    open_dialog="Open a model",
    model_files="Models and documents",
    all_files="All files",
    file_too_large=lambda name: f"“{name}” is larger than 10 MB.",
    file_error=lambda name: f"“{name}” could not be read.",
    received_from=lambda tool: f"Model received from {tool}.",
    input_empty="Paste or open a model to start.",
    undetected="The format could not be detected: choose it in the list.",
    input_summary=lambda format_label, models, fields: (
        f"{format_label} · {_en_number(models)} "
        f"{_plural(models, 'model', 'models')} · {_en_number(fields)} {_plural(fields, 'field', 'fields')}"
    ),
    warnings_count=lambda count: f"{_en_number(count)} {_plural(count, 'note', 'notes')}",
    error_position=lambda line, column: f"Line {_en_number(line)}, column {_en_number(column)}",
    parse_issue=_parse_issue_en,
    mapping_title="Relations",
    mapping_empty="Paste or open the source and the target, or load an example, and the relations will appear here.",
    mapping_waiting=lambda side: (
        "The relations will appear when the source can be read."
        if side == "source"
        else "The relations will appear when the target can be read."
    ),
    summary={
        "total": lambda count: f"{_en_number(count)} target {_plural(count, 'field', 'fields')}",
        "mapped": lambda count: f"{_en_number(count)} mapped",
        "review": lambda count: f"{_en_number(count)} to review",
        "conflict": lambda count: f"{_en_number(count)} {_plural(count, 'conflict', 'conflicts')}",
        "unmapped": lambda count: f"{_en_number(count)} without value",
        "ignored": lambda count: f"{_en_number(count)} ignored",
    },
    filters={
        "all": "All",
        "mapped": "Mapped",
        "review": "To review",
        "unmapped": "Without value",
        "warnings": "With warnings",
    },
    search_placeholder="Find a field…",
    no_results="No field matches the filter.",
    accept_reviews=lambda count: f"Accept {_en_number(count)} {_plural(count, 'suggestion', 'suggestions')}",
    restore_suggestions="Restore suggestions",
    restore_confirm="Restore the suggestions of this model? Your changes to its fields are discarded.",
    undo="Undo",
    redo="Redo",
    undo_title="Undo (Ctrl/Cmd+Z)",
    redo_title="Redo (Ctrl/Cmd+Shift+Z)",
    nested=lambda source, target: f"{source} → {target}",
    required_badge="required",
    root="whole source",
    no_source="no value",
    status={
        "exact": "Exact",
        "high": "High",
        "probable": "Likely",
        "review": "Review",
        "conflict": "Conflict",
        "none": "No match",
        "manual": "Manual",
        "ignored": "Ignored",
    },
    status_with_score=lambda label, score: f"{label} · {_score(score)}%",
    reason=_reason(_REASONS_EN),
    transform={
        "direct": "Direct",
        "concat": "Join",
        "split": "Part of a text",
        "constant": "Constant value",
        "boolean": "Text to true / false",
        "enum": "Value list",
        "epoch": "Timestamp ↔ date",
        "arithmetic": "Arithmetic",
        "object": "Nested object",
        "collection": "List",
        "expression": "Custom expression",
    },
    transform_summary=_transform_summary_en,
    conversion_hint=lambda origin, to: f"{origin} → {to}",
    edit="Edit",
    close="Close",
    edit_field_title=lambda field: f"Relation of “{field}”",
    accept="Accept",
    use_candidate="Use",
    candidates_title="Suggestions",
    sources_label="Source fields",
    add_source="Add field",
    choose_source="Choose a field…",
    transform_label="Transformation",
    separator_label="Separator",
    part_label="Part",
    parts={"first": "First", "last": "Last", "rest": "After the first"},
    constant_label="Value",
    constant_null="empty (null)",
    true_values_label="Values that mean true, separated by commas",
    enum_from_label="Source value",
    enum_to_label="Target value",
    enum_fallback_label="Values without a pair",
    enum_fallback_error="Fail (error in the code)",
    epoch_unit_label="Unit",
    epoch_units={"seconds": "Seconds", "milliseconds": "Milliseconds"},
    operator_label="Operation",
    operand_label="Number",
    expression_label="Expression",
    expression_help='Fields by name (address.city), numbers, "texts", + - * / %, comparisons, && || !, a ?? b, '
    "condition ? a : b and upper, lower, trim, length, concat, substring, replace, round, floor, ceil, abs, min, max, "
    "toString, toNumber. It is translated to the chosen language, never run here.",
    expression_error=_expression_error_en,
    fallback_label="If the source is missing, use",
    fallback_none="Nothing",
    fallback_hint="Leave empty to keep it missing.",
    ignore_field="Leave without value",
    reset_field="Restore suggestion",
    unused_title=lambda count: f"Source fields not used ({_en_number(count)})",
    unused_hint="Not an error: mark them as ignored once reviewed.",
    mark_ignored="Mark as ignored",
    unmark_ignored="Use again",
    ignored_source="ignored",
    diagnostics_title="Checks",
    diagnostics_summary=_diagnostics_summary(
        _en_number,
        {
            "error": ("error", "errors"),
            "warning": ("warning", "warnings"),
            "info": ("note", "notes"),
            "none": "No problems found",
        },
    ),
    severity={"error": "Error", "warning": "Warning", "info": "Note"},
    diagnostic=_diagnostic_en,
    code_title="Generated code",
    code_mode="Style",
    modes={
        "functions": "Functions",
        "manual": "Manual mapping",
        "mapstruct": "MapStruct",
        "automapper": "AutoMapper",
        "extensions": "Extensions",
        "from": "From trait",
        "static": "Static methods",
    },
    naming_label="Field names",
    namings={"auto": "Automatic", "keep": "As in the input", "convention": "Language convention"},
    option_labels={
        "sourceModule": "Source models module",
        "targetModule": "Target models module",
        "modelsModule": "Models module",
        "sourceAccess": "Read the source",
        "targetStyle": "Build the target",
        "package": "Package",
        "namespace": "Namespace",
        "componentModel": "Component model",
        "modelsImport": "Models import",
        "modelsPath": "Models path",
    },
    choice_labels={
        "attribute": "Attributes",
        "dict": "Dictionary",
        "constructor": "Constructor",
        "object": "Object",
        "array": "Array",
        "default": "None",
        "spring": "Spring",
        "cdi": "CDI",
        "jakarta": "Jakarta",
    },
    code_empty="The mapping code will appear here when there are relations.",
    copy="Copy",
    copied="Copied",
    save="Save",
    save_zip=lambda count: f"Save .zip ({_en_number(count)} files)",
    saved=lambda path: f"Saved in {path}",
    note=_note_en,
    notes_count=lambda count: f"{_en_number(count)} {_plural(count, 'thing', 'things')} to check in the code",
    save_project="Save project",
    open_project="Open project",
    export_target="Export target model",
    export_target_title="Model schema of the target, for DBCreate or another tool",
    project_files="Mapper projects",
    model_schema_files="Model schemas",
    project_loaded=lambda name: f"Project “{name}” opened.",
    project_error=_project_error_en,
    remember="Remember on this computer",
    remember_hint="Saves your inputs and relations on this computer only, to continue later.",
    clear_saved="Delete saved work",
    clear_saved_confirm="Delete the work saved on this computer?",
    saved_cleared="Saved work deleted.",
    restored="Your previous work was restored from this computer.",
    confirm_replace="Replace the current inputs and relations?",
)

ES = SimpleNamespace(
    tagline="Relaciona dos modelos de datos y genera el código que convierte uno en el otro",
    intro_description="Pega o abre el origen y el destino (clases, DTOs, JSON, esquemas), revisa las relaciones que "
    "propone Mapper campo a campo, ajusta las transformaciones y obtén el código de mapping para TypeScript, Python, "
    "Java, C#, Kotlin, Dart, Swift, Go, Rust o PHP.",
    privacy_short="Procesado en local",
    privacy_points=[
        "Lo que pegas o abres no sale de tu equipo.",
        "El código se analiza, nunca se ejecuta.",
        "No se guarda nada salvo que actives «Recordar en este equipo».",
    ],
    examples_label="Prueba un ejemplo",
    examples={
        "simple": "Mapping simple",
        "names": "Nombres distintos",
        "nested": "Objetos anidados",
        "transformations": "Transformaciones",
        "arrays": "Listas",
    },
    example_descriptions={
        "simple": "DTO de TypeScript a modelo de TypeScript",
        "names": "JSON en snake_case a una data class de Kotlin",
        "nested": "Clases de Java a C# con campos aplanados",
        "transformations": "TypeScript a Pydantic: concatenación, céntimos, enums, fechas",
        "arrays": "Pedido JSON con líneas a records de Java",
    },
    developed_by="Desarrollado por",
    tabs={"source": "Origen", "target": "Destino", "mapping": "Relaciones", "code": "Código"},
    source_title="Origen",
    target_title="Destino",
    input_placeholder="Pega aquí una clase, un DTO, un JSON o un esquema, o suelta un archivo…",
    open_file="Abrir",
    clear="Limpiar",
    create="Crear",
    create_unavailable="Pega o abre antes el origen: el modelo nuevo parte de sus campos.",
    create_title="Crear el modelo de destino",
    create_description=lambda source: (
        f"Mapper escribe aquí un modelo con los campos de «{source}», con las "
        "convenciones del formato que elijas. Después edítalo como texto: quita, renombra o cambia el tipo de lo que "
        "necesites."
    ),
    create_format="Formato del modelo nuevo",
    create_replace="Sustituye el destino actual.",
    create_confirm="Crear",
    cancel="Cancelar",
    created=lambda model, source: (
        f"Modelo de destino «{model}» creado a partir de «{source}». Edítalo en el panel Destino."
    ),
    format_label="Formato",
    format_auto=lambda detected: f"Detectar ({detected})" if detected else "Detectar automáticamente",
    model_label="Modelo",
    open_dialog="Abrir un modelo",
    model_files="Modelos y documentos",
    all_files="Todos los archivos",
    file_too_large=lambda name: f"“{name}” supera los 10 MB.",
    file_error=lambda name: f"“{name}” no se ha podido leer.",
    received_from=lambda tool: f"Modelo recibido de {tool}.",
    input_empty="Pega o abre un modelo para empezar.",
    undetected="No se ha podido detectar el formato: elígelo en la lista.",
    input_summary=lambda format_label, models, fields: (
        f"{format_label} · {_es_number(models)} "
        f"{_plural(models, 'modelo', 'modelos')} · {_es_number(fields)} {_plural(fields, 'campo', 'campos')}"
    ),
    warnings_count=lambda count: f"{_es_number(count)} {_plural(count, 'aviso', 'avisos')}",
    error_position=lambda line, column: f"Línea {_es_number(line)}, columna {_es_number(column)}",
    parse_issue=_parse_issue_es,
    mapping_title="Relaciones",
    mapping_empty="Pega o abre el origen y el destino, o carga un ejemplo, y las relaciones aparecerán aquí.",
    mapping_waiting=lambda side: (
        "Las relaciones aparecerán cuando se pueda leer el origen."
        if side == "source"
        else "Las relaciones aparecerán cuando se pueda leer el destino."
    ),
    summary={
        "total": lambda count: f"{_es_number(count)} {_plural(count, 'campo', 'campos')} de destino",
        "mapped": lambda count: f"{_es_number(count)} {_plural(count, 'asignado', 'asignados')}",
        "review": lambda count: f"{_es_number(count)} para revisar",
        "conflict": lambda count: f"{_es_number(count)} {_plural(count, 'conflicto', 'conflictos')}",
        "unmapped": lambda count: f"{_es_number(count)} sin valor",
        "ignored": lambda count: f"{_es_number(count)} {_plural(count, 'ignorado', 'ignorados')}",
    },
    filters={
        "all": "Todos",
        "mapped": "Asignados",
        "review": "Para revisar",
        "unmapped": "Sin valor",
        "warnings": "Con avisos",
    },
    search_placeholder="Buscar un campo…",
    no_results="Ningún campo coincide con el filtro.",
    accept_reviews=lambda count: f"Aceptar {_es_number(count)} {_plural(count, 'sugerencia', 'sugerencias')}",
    restore_suggestions="Restaurar sugerencias",
    restore_confirm="¿Restaurar las sugerencias de este modelo? Se descartan tus cambios en sus campos.",
    undo="Deshacer",
    redo="Rehacer",
    undo_title="Deshacer (Ctrl/Cmd+Z)",
    redo_title="Rehacer (Ctrl/Cmd+Mayús+Z)",
    nested=lambda source, target: f"{source} → {target}",
    required_badge="obligatorio",
    root="el origen completo",
    no_source="sin valor",
    status={
        "exact": "Exacta",
        "high": "Alta",
        "probable": "Probable",
        "review": "Revisar",
        "conflict": "Conflicto",
        "none": "Sin coincidencia",
        "manual": "Manual",
        "ignored": "Ignorado",
    },
    status_with_score=lambda label, score: f"{label} · {_score(score)} %",
    reason=_reason(_REASONS_ES),
    transform={
        "direct": "Directa",
        "concat": "Unir",
        "split": "Parte de un texto",
        "constant": "Valor constante",
        "boolean": "Texto a verdadero / falso",
        "enum": "Lista de valores",
        "epoch": "Marca de tiempo ↔ fecha",
        "arithmetic": "Aritmética",
        "object": "Objeto anidado",
        "collection": "Lista",
        "expression": "Expresión personalizada",
    },
    transform_summary=_transform_summary_es,
    conversion_hint=lambda origin, to: f"{origin} → {to}",
    edit="Editar",
    close="Cerrar",
    edit_field_title=lambda field: f"Relación de «{field}»",
    accept="Aceptar",
    use_candidate="Usar",
    candidates_title="Sugerencias",
    sources_label="Campos de origen",
    add_source="Añadir campo",
    choose_source="Elige un campo…",
    transform_label="Transformación",
    separator_label="Separador",
    part_label="Parte",
    parts={"first": "Primera", "last": "Última", "rest": "Tras la primera"},
    constant_label="Valor",
    constant_null="vacío (null)",
    true_values_label="Valores que significan verdadero, separados por comas",
    enum_from_label="Valor de origen",
    enum_to_label="Valor de destino",
    enum_fallback_label="Valores sin pareja",
    enum_fallback_error="Fallar (error en el código)",
    epoch_unit_label="Unidad",
    epoch_units={"seconds": "Segundos", "milliseconds": "Milisegundos"},
    operator_label="Operación",
    operand_label="Número",
    expression_label="Expresión",
    expression_help='Campos por nombre (address.city), números, "textos", + - * / %, comparaciones, && || !, a ?? b, '
    "condición ? a : b y upper, lower, trim, length, concat, substring, replace, round, floor, ceil, abs, min, max, "
    "toString, toNumber. Se traduce al lenguaje elegido; nunca se ejecuta aquí.",
    expression_error=_expression_error_es,
    fallback_label="Si falta el origen, usar",
    fallback_none="Nada",
    fallback_hint="Déjalo vacío para que siga faltando.",
    ignore_field="Dejar sin valor",
    reset_field="Restaurar sugerencia",
    unused_title=lambda count: f"Campos de origen sin usar ({_es_number(count)})",
    unused_hint="No es un error: márcalos como ignorados cuando los hayas revisado.",
    mark_ignored="Marcar como ignorado",
    unmark_ignored="Volver a usar",
    ignored_source="ignorado",
    diagnostics_title="Comprobaciones",
    diagnostics_summary=_diagnostics_summary(
        _es_number,
        {
            "error": ("error", "errores"),
            "warning": ("aviso", "avisos"),
            "info": ("nota", "notas"),
            "none": "No se ha encontrado ningún problema",
        },
    ),
    severity={"error": "Error", "warning": "Aviso", "info": "Nota"},
    diagnostic=_diagnostic_es,
    code_title="Código generado",
    code_mode="Estilo",
    modes={
        "functions": "Funciones",
        "manual": "Mapping manual",
        "mapstruct": "MapStruct",
        "automapper": "AutoMapper",
        "extensions": "Extensiones",
        "from": "Trait From",
        "static": "Métodos estáticos",
    },
    naming_label="Nombres de campos",
    namings={"auto": "Automático", "keep": "Como en la entrada", "convention": "Convención del lenguaje"},
    option_labels={
        "sourceModule": "Módulo de los modelos de origen",
        "targetModule": "Módulo de los modelos de destino",
        "modelsModule": "Módulo de los modelos",
        "sourceAccess": "Leer el origen",
        "targetStyle": "Construir el destino",
        "package": "Paquete",
        "namespace": "Namespace",
        "componentModel": "Modelo de componentes",
        "modelsImport": "Import de los modelos",
        "modelsPath": "Ruta de los modelos",
    },
    choice_labels={
        "attribute": "Atributos",
        "dict": "Diccionario",
        "constructor": "Constructor",
        "object": "Objeto",
        "array": "Array",
        "default": "Ninguno",
        "spring": "Spring",
        "cdi": "CDI",
        "jakarta": "Jakarta",
    },
    code_empty="El código de mapping aparecerá aquí cuando haya relaciones.",
    copy="Copiar",
    copied="Copiado",
    save="Guardar",
    save_zip=lambda count: f"Guardar .zip ({_es_number(count)} archivos)",
    saved=lambda path: f"Guardado en {path}",
    note=_note_es,
    notes_count=lambda count: f"{_es_number(count)} {_plural(count, 'cosa', 'cosas')} que revisar en el código",
    save_project="Guardar proyecto",
    open_project="Abrir proyecto",
    export_target="Exportar modelo de destino",
    export_target_title="Esquema de modelos del destino, para DBCreate u otra herramienta",
    project_files="Proyectos de Mapper",
    model_schema_files="Esquemas de modelos",
    project_loaded=lambda name: f"Proyecto «{name}» abierto.",
    project_error=_project_error_es,
    remember="Recordar en este equipo",
    remember_hint="Guarda tus entradas y relaciones solo en este equipo, para seguir más tarde.",
    clear_saved="Borrar el trabajo guardado",
    clear_saved_confirm="¿Borrar el trabajo guardado en este equipo?",
    saved_cleared="Trabajo guardado borrado.",
    restored="Se ha recuperado tu trabajo anterior de este equipo.",
    confirm_replace="¿Sustituir las entradas y relaciones actuales?",
)

MESSAGES = {"en": EN, "es": ES}


class I18n(QObject):
    """The current language, remembered in the settings. Widgets listen to changed to update their texts."""

    changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        self._settings = settings
        stored = settings.value("language")
        if stored not in MESSAGES:
            stored = "es" if QLocale.system().name().startswith("es") else "en"
        self.language: str = stored

    @property
    def t(self) -> SimpleNamespace:
        return MESSAGES[self.language]

    def set_language(self, language: str) -> None:
        if language == self.language:
            return
        self.language = language
        self._settings.setValue("language", language)
        self.changed.emit()
