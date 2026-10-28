# Mapper

Herramienta web que relaciona dos modelos de datos (origen y destino), propone el mapping campo a campo y genera el código de transformación. Forma parte de la familia DataCleanr → Api2Class → Mapper → DBCreate, pero funciona sola.

## Referencia de diseño y UX

Este proyecto utiliza personal_web_style como referencia de diseño y UX:
/Users/raulestevez/Documents/Repositorios/personal_web_style

Antes de realizar cambios visuales o crear nuevos componentes, lee AGENT_GUIDE.md
de ese repositorio y sigue sus especificaciones.

Los tokens están copiados en `web/src/styles/tokens/`. Si cambian en personal_web_style, se vuelven a copiar; no se editan aquí.

## Estructura

- `web/`: aplicación React + TypeScript + Vite (mismo stack que Api2Class y DataCleanr).
- `web/src/core/`: núcleo independiente de la interfaz y de cualquier lenguaje (modelo interno, parsers, matching, transformaciones, validación, generadores).
- `docs/`: documentación técnica. Para añadir un lenguaje, empieza por `docs/adding-a-language.md`.

## Comandos (desde `web/`)

- `npm run dev`, `npm run build`
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`
- `npm run check`: todo lo anterior salvo el build

## Reglas del repositorio

- Commits pequeños en inglés con prefijo de tipo (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Sin emojis.
- No hacer `git push`: el usuario sube los cambios.
- Nada de `eval`, `new Function` ni ejecución del código pegado: todo se analiza con parsers propios.
- Los datos del usuario se procesan en el navegador y no se envían a ningún servidor.
- Los textos de la interfaz van en `web/src/i18n/messages.ts` (inglés y español).
