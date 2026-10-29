# Mapper

Mapper relaciona dos modelos de datos y genera el código que convierte uno en el otro. Todo ocurre en tu lado, en el navegador o en la aplicación de escritorio: lo que pegas o abres no se envía a ningún sitio, y el código se analiza, nunca se ejecuta.

```text
Pegar el origen y el destino  →  Revisar las relaciones sugeridas  →  Ajustar transformaciones  →  Copiar el código de mapping
```

## Qué hace

1. **Lee los dos modelos** en cualquiera de los formatos admitidos, o **crea el destino** a partir del origen: «Crear» en el panel Destino escribe un modelo con los mismos campos en TypeScript, Python, Kotlin, Java, C# o JSON Schema, listo para editar como texto. Los lee detectando el formato y el framework (Pydantic, JPA, Entity Framework, TypeORM, Django, SQLAlchemy, serde, Codable, freezed…). Si una entrada tiene varios modelos, eliges cuál relacionar; los modelos anidados se siguen.
2. **Sugiere un origen para cada campo de destino**, con un nivel de confianza: exacta, alta, probable, revisar, conflicto o sin coincidencia. Reconoce:
   - convenciones de nombres (`userId`, `user_id`) y nombres en el formato de intercambio (`@JsonProperty`);
   - abreviaturas (`qty`), palabras compuestas (`surname`) y sinónimos (`creationDate` → `created_at`);
   - el nombre del modelo (`userId` → `id`) y los campos anidados (`customer.id` → `customer_id`);
   - la compatibilidad de tipos, y combinaciones: nombre + apellido → nombre completo, céntimos → importe, estado → activo, marcas de tiempo → fechas, valores de enums.
3. **Nunca decide una ambigüedad.** Dos orígenes que encajan casi igual, o un origen que quieren dos campos, se marcan como conflicto para que lo resuelvas. Las sugerencias por revisar no se aplican hasta que las aceptas.
4. **Te deja cambiarlo todo:**
   - elegir orígenes, también varios o anidados, sin necesidad de arrastrar;
   - escoger una transformación (unir, parte de un texto, constante, texto a verdadero/falso, lista de valores, marca de tiempo ↔ fecha, aritmética, objeto anidado, lista o una expresión personalizada);
   - indicar un valor por defecto si falta el origen, dejar campos sin valor, deshacer y rehacer.
5. **Comprueba el resultado:** errores (un campo obligatorio sin valor, tipos incompatibles), avisos (null en un campo obligatorio, conversiones que pueden fallar, valores de enum sin pareja) y notas (campos de origen sin usar).
6. **Genera el código de mapping**, con mappers anidados, recorrido de listas, tratamiento de nulos, funciones auxiliares para enums y solo los imports necesarios.

## Entradas y salidas

| Entradas | |
|---|---|
| Código | TypeScript (también esquemas Zod), JavaScript, Python, Java, C#, Kotlin, Dart, Swift, Go, Rust, PHP, Scala |
| Esquemas | JSON Schema, OpenAPI / Swagger, GraphQL, Protocol Buffers, Smithy, Prisma, esquema de modelos de Mapper |
| Documentos de ejemplo | JSON, YAML, XML, CSV |

| Salida | Estilos |
|---|---|
| TypeScript, JavaScript | Funciones |
| Python | Funciones (atributos o diccionarios; dataclasses, Pydantic y clases normales) |
| Java | Mapper manual (setters, records, builders de Lombok) o MapStruct |
| C# | Métodos de extensión o perfil de AutoMapper |
| Kotlin, Dart, Swift | Funciones de extensión |
| Go | Funciones que devuelven los errores de conversión |
| Rust | Implementaciones de `From` |
| PHP | Métodos estáticos (objetos o arrays) |

## Trabajar con otras herramientas

- **Desde Api2Class:** las clases que genera Api2Class, en cualquiera de sus lenguajes y estilos, se abren tal cual en Mapper como origen; solo queda aportar el destino.
- **Hacia Model2DB:** «Exportar modelo de destino» descarga el destino como esquema de modelos, que Model2DB (también su versión de escritorio) abre como archivo.
- **Proyectos:** «Guardar proyecto» descarga las entradas, las relaciones y la configuración de salida; «Abrir proyecto» permite seguir más tarde. «Recordar en este navegador» («Recordar en este equipo» en la aplicación de escritorio) guarda el trabajo solo ahí, hasta que lo borres. Un proyecto guardado en una versión se abre en la otra.

Los formatos están documentados en [docs/interoperability.md](docs/interoperability.md) (en inglés).

## Versiones

| | Web | Escritorio |
|---|---|---|
| Tecnología | React + TypeScript + Vite | Python + PySide6 |
| Dónde se ejecuta | En el navegador | Aplicación instalable (Windows, macOS, Linux) |
| Estado | Publicada: [raulesteveza.github.io/tools/Mapper](https://raulesteveza.github.io/tools/Mapper/) | [Descargar](./desktop/README_es.md#descargar) (compilada y comprobada en macOS) |
| Documentación | Este README y [docs/](./docs) | [desktop/README_es.md](./desktop/README_es.md) |

La aplicación de escritorio hace lo mismo que la versión web, con el mismo aspecto, los mismos ejemplos e inglés o castellano. Recibe los modelos de otras herramientas como archivos, en lugar de desde otra pestaña del navegador.

## Comportamiento compartido

Las dos versiones se escriben por separado (TypeScript y Python), pero **se comportan igual**: la carpeta [`shared/`](./shared/README.md) contiene los casos de prueba que definen qué debe hacer cada parte del núcleo, desde detectar y leer cada formato de entrada hasta las sugerencias, las ediciones, las comprobaciones, los borradores de destino, los proyectos y el código exacto de cada generador en cada modo y opción. Los tests de la web y los del escritorio leen los mismos archivos, así que una diferencia en cualquiera de las dos versiones hace fallar sus tests.

## Desarrollo

La versión web está en [`web/`](./web): React, TypeScript y Vite, sin librerías de componentes; su aspecto sigue el diseño común de la web personal y del resto de herramientas.

```bash
cd web
npm install
npm run dev      # servidor de desarrollo
npm run check    # tipos, lint, formato y tests
npm run build    # build de producción en web/dist
```

Los tests cubren los parsers de cada formato, el motor de matching, las transformaciones, la validación, los generadores (instantáneas, y una compilación o comprobación de sintaxis cuando están instalados `python3`, `javac`, `dart`, `swiftc`, `rustfmt` o `php`), los casos compartidos y los flujos principales de la interfaz.

La versión de escritorio está en [`desktop/`](./desktop): consulta [desktop/README_es.md](./desktop/README_es.md#ejecutar-en-local) para ejecutarla, probarla y crear el ejecutable.

## Estructura del repositorio

```
web/                     Versión web (React + TypeScript + Vite)
  src/core/              Lógica sin interfaz: modelo, parsers, matching, mapping, expresiones, generadores, proyectos
  src/components/        Interfaz React
desktop/                 Versión de escritorio (Python + PySide6)
  mapper/core/           La misma lógica que web/src/core/, en Python
  mapper/ui/             Interfaz con PySide6
shared/                  Comportamiento común a ambas versiones
  test-cases/            Llamadas al núcleo y código esperado de cada generador
docs/                    Documentación técnica e imágenes
```

## Documentación técnica

En inglés, en [`docs/`](./docs):

| Documento | Contenido |
|---|---|
| [architecture.md](docs/architecture.md) | Etapas, carpetas y principios |
| [internal-model.md](docs/internal-model.md) | El esquema de modelos y el mapping |
| [parsers.md](docs/parsers.md) | Qué lee cada formato y cómo funcionan los parsers de código |
| [mapping-engine.md](docs/mapping-engine.md) | Cómo se calculan las sugerencias y la confianza |
| [transformations.md](docs/transformations.md) | Transformaciones, conversiones, el lenguaje de expresiones y la validación |
| [generators.md](docs/generators.md) | Del mapping al código, por lenguaje |
| [interoperability.md](docs/interoperability.md) | Esquema de modelos, traspaso entre herramientas, archivos de proyecto |
| [adding-a-language.md](docs/adding-a-language.md) | Paso a paso para un nuevo lenguaje de entrada o salida |
| [decisions.md](docs/decisions.md) | Decisiones de diseño y sus motivos |

## Sugerencias

Ideas de mejora, errores o un formato que te gustaría que Mapper leyera: escribe a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](./LICENSE)
