# Mapper · Escritorio

Versión de escritorio de Mapper: Python + PySide6.

Hace lo mismo que la versión web, en tu equipo y sin navegador: pasa los mismos casos de prueba de [`shared/test-cases/`](../shared/README.md) y propone las mismas relaciones y genera exactamente el mismo código para cada lenguaje, modo y opción.

Qué hace la herramienta y su filosofía están en el [README principal](../README_es.md).

## Descargar

| Sistema | Archivo |
|---|---|
| macOS (Apple Silicon) | [Mapper-macOS.dmg](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-macOS.dmg) |
| Windows (x64) | [Mapper-Windows.zip](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Windows.zip) |
| Windows (ARM64) | [Mapper-Windows-ARM64.zip](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Windows-ARM64.zip) |
| Linux (x64) | [Mapper-Linux.tar.gz](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Linux.tar.gz) |
| Linux (ARM64, Ubuntu 24.04 o más nueva) | [Mapper-Linux-ARM64.tar.gz](https://github.com/RaulEstevezA/Mapper/releases/latest/download/Mapper-Linux-ARM64.tar.gz) |

Todas las versiones están en [Releases](https://github.com/RaulEstevezA/Mapper/releases).

> [!NOTE]
> La aplicación empaquetada se ha compilado y comprobado en **macOS** (Apple Silicon). Las versiones de Windows y Linux las compila GitHub Actions y pasan los tests y una prueba de arranque automática, pero nadie las ha usado todavía en un equipo real. Si encuentras algún problema, escríbeme a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

- **macOS:** abre el `.dmg` y arrastra Mapper a Aplicaciones.
- **Windows:** descomprime el `.zip` y ejecuta `Mapper.exe` dentro de la carpeta `Mapper`.
- **Linux:** descomprime con `tar -xzf Mapper-Linux.tar.gz` (o `Mapper-Linux-ARM64.tar.gz`) y ejecuta `Mapper/Mapper`. En algunas distribuciones hace falta instalar `libxcb-cursor0`. La versión ARM64 necesita una distribución de 2024 o más nueva (glibc 2.39, como Ubuntu 24.04).

### Abrirla la primera vez

La aplicación no está firmada (firmarla requiere cuentas de pago de Apple y Microsoft), así que el sistema avisa la primera vez que se abre:

- **macOS** dice que no ha podido verificar que la app esté libre de software malicioso. Pulsa **Hecho**, ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta **Seguridad** y pulsa **Abrir igualmente**. Solo hay que hacerlo una vez.
- **Windows** muestra "Windows protegió su PC". Pulsa **Más información** y después **Ejecutar de todas formas**.

El código es el de este repositorio y los archivos los compila GitHub Actions ([workflow](../.github/workflows/release-desktop.yml)).

## Ejecutar en local

Requisitos: Python 3.11 o superior.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest                   # tests (casos compartidos de shared/test-cases/)
ruff check .                       # análisis estático
python -m mapper                   # ejecutar la aplicación
```

## Crear el ejecutable

```bash
pip install -e ".[build]"
pyinstaller packaging/mapper.spec
dist/Mapper.app/Contents/MacOS/Mapper --smoke-test   # macOS; dist/Mapper/Mapper en el resto
```

El resultado queda en `dist/`: `Mapper.app` en macOS y una carpeta `Mapper` con el ejecutable en Windows y Linux. PyInstaller no compila para otros sistemas: cada uno se crea en su propio sistema operativo. `--smoke-test` abre la ventana, carga todos los ejemplos, lee un documento YAML y otro XML, genera todos los lenguajes y guarda un proyecto, para comprobar que no falta nada en el paquete.

## Estructura

```
mapper/
  core/            Lógica sin interfaz: cada módulo equivale a uno de web/src/core/
    parsers/       Todos los formatos de entrada (datos, esquemas, código)
    matching/      Las sugerencias y su confianza
    mapping/       Ediciones y comprobaciones
    generate/      El plan y un módulo por lenguaje de salida
  ui/              Interfaz con PySide6
  assets/          Icono y marca de las casillas
packaging/         Configuración de PyInstaller, iconos de la aplicación y prueba de arranque
tests/             Tests con pytest, leyendo los casos de shared/test-cases/
pyproject.toml     Dependencias y configuración
```

## Tests

El núcleo se comprueba con [`shared/test-cases/`](../shared/README.md), los mismos archivos que leen los tests de la versión web: unas 1.800 llamadas al núcleo (detección de formato, unas 300 entradas en los 23 formatos, sugerencias, ediciones, comprobaciones, expresiones, planes, borradores de destino, proyectos y traspasos) y el código exacto de cada generador, modo, modo de nombres y opción para 8 pares de modelos (336 salidas). Todas dan el mismo resultado que la versión web. Los tests de la interfaz abren la ventana sin mostrarla (`QT_QPA_PLATFORM=offscreen`): ejemplos, ediciones y deshacer, todos los lenguajes, proyectos, el borrador de destino, modelos recibidos de Api2Class y el trabajo guardado en este equipo.

## Diferencias con la versión web

- **Los modelos de otras herramientas** llegan como archivos: las clases que genera Api2Class se abren tal cual, en cualquiera de sus lenguajes, y un archivo de traspaso (model-handoff, [docs/interoperability.md](../docs/interoperability.md)) abierto en cualquiera de las dos entradas rellena el lado al que iba destinado. El botón «Abrir en Mapper» de la versión web de Api2Class solo llega a la versión web.
- **«Recordar en este equipo»** guarda el trabajo en la configuración del sistema en lugar del almacenamiento del navegador.
- **Sin enlaces**: la aplicación funciona sola, sin conexión. El crédito abre la web personal en el navegador.

## Privacidad

No hay llamadas a la red: los archivos se leen y el código se genera en el equipo. Solo se guardan preferencias (idioma, lenguaje de salida, modos, opciones, nombres de campos), en la configuración del sistema; las entradas y las relaciones solo se guardan mientras está activado «Recordar en este equipo».

[Volver al README principal](../README_es.md)
