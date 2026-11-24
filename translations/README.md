# Traducciones

En el código, los textos se escriben con claves: `I18N.t('panel.states.on')` devuelve «Encendido» o «On» según el idioma. En el HTML fijo se usa `data-i18n="clave"`.

| Archivo | Qué es |
|---|---|
| `languages.json` | La lista de idiomas: `{"es": "Español", "en": "English"}` |
| `es.json` | Español: todas las claves |
| `en.json` | Inglés: las mismas claves |
| `i18n.js` | El motor: carga el JSON del idioma elegido y traduce |

## Formato

```json
{
  "name": "English",
  "locale": "en-GB",
  "texts": {
    "panel": {
      "states": { "on": "On", "open_percent": "Open {n} %" }
    },
    "web": {
      "general": { "save": "Save" }
    }
  },
  "patterns": [["^(\\d+) encendidas?$", "$1 on"]]
}
```

- **Claves:** la ruta dentro de `texts` (`panel.states.on`). `panel` es la pantalla y `web` la web de configuración.
- **Variables:** `I18N.t('panel.states.open_percent', { n: 70 })` → «Open 70 %».
- **`locale`:** el formato de fechas y números.
- **`patterns`:** solo traducen textos que llegan ya en español desde fuera del código (el ayudante de la Pi o los scripts de burbujas). Cada patrón es `[expresión regular, reemplazo]`. `$1` pone el trozo tal cual y `{t:$1}` lo pone traducido.

Si a un idioma le falta una clave, sale el texto en español. Los tests (`tests/test_translations.py`) comprueban tres cosas:
- todos los idiomas tienen las mismas claves;
- cada clave que usa el código existe;
- las variables coinciden.

## Añadir un texto

1. Pon la clave en `es.json` y en `en.json`, en su grupo.
2. Úsala en el código: `I18N.t('web.general.mi_texto')`.

## Añadir un idioma

1. Copia `en.json` como `xx.json`, donde `xx` es el código del idioma (`fr`, `de`…).
2. Traduce los valores y cambia `name` y `locale`.
3. Añádelo a `languages.json`: `"fr": "Français"`.

El idioma nuevo aparece solo en la lista de idiomas del panel y de la web.
