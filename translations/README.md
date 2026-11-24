# Traducciones

Los textos del panel y de la web de configuración están en español en el código, y aquí se traducen.

| Archivo | Qué es |
|---|---|
| `languages.json` | La lista de idiomas: `{"es": "Español", "en": "English"}` |
| `es.json` | Español. No tiene textos, porque ya están en español en el código |
| `en.json` | Inglés |
| `i18n.js` | El motor: carga el JSON del idioma elegido y `t('Texto')` devuelve la traducción |

## Formato de un idioma

```json
{
  "name": "English",
  "locale": "en-GB",
  "texts": {
    "panel": { "states": { "Encendido": "On" } },
    "web": { "general": { "Guardar": "Save" } }
  },
  "patterns": {
    "panel": [["^(\\d+) encendidas?$", "$1 on"], ["^(-?[\\d.,]+°) (.+)$", "$1 {t:$2}"]]
  }
}
```

- **`texts`**: las claves son los textos en español. Los grupos (`panel`, `states`…) solo sirven para ordenar y se pueden anidar como quieras.
- **`patterns`**: para textos con números o nombres. Cada patrón es `[expresión regular, reemplazo]` y, si hace falta, un tercer valor con las banderas (`"u"`). En el reemplazo, `$1` pone el trozo tal cual y `{t:$1}` lo pone traducido.
- **`locale`**: el formato de fechas y números.

## Añadir un idioma

1. Copia `en.json` como `xx.json`, donde `xx` es el código del idioma (`fr`, `de`…). Traduce los valores y cambia `name` y `locale`.
2. Añádelo a `languages.json`: `"fr": "Français"`.

El idioma aparece solo en la lista de idiomas del panel y de la web. Lo que no esté traducido sale en español.
