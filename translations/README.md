# Translations

The code uses keys: `I18N.t('panel.states.on')` gives "On" or "Encendido" depending on the language. The static HTML uses `data-i18n="key"`. English is the base language: if a key is missing in another language, the English text shows.

| File | What it is |
|---|---|
| `languages.json` | The list of languages: `{"en": "English", "es": "Español"}` |
| `en.json` | English: every key (the base) |
| `es.json` | Spanish: the same keys |
| `i18n.js` | The engine: loads the JSON of the chosen language and translates |

## Format

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
  "patterns": [["^(\\d+) on$", "$1 encendidas"]]
}
```

- **Keys:** the path inside `texts` (`panel.states.on`). `panel` is the screen and `web` the configuration web.
- **Variables:** `I18N.t('panel.states.open_percent', { n: 70 })` → "Open 70 %".
- **`locale`:** the format of dates and numbers.
- **`patterns`:** they only translate texts that arrive already composed in English from outside the code (the Pi's helper or the bubble scripts). Each pattern is `[regular expression, replacement]`. `$1` puts the piece as it is and `{t:$1}` puts it translated.

Plain texts that reach `t()` (static HTML, helper messages, old settings saved in Spanish) are found by their English or Spanish text.

The tests (`tests/test_translations.py`) check three things:
- every language has the same keys;
- every key the code uses exists;
- the variables match.

## Adding a text

1. Add the key to `en.json` and to `es.json`, in its group.
2. Use it in the code: `I18N.t('web.general.my_text')`.

## Adding a language

1. Copy `en.json` as `xx.json`, where `xx` is the language code (`fr`, `de`…).
2. Translate the values and change `name` and `locale`.
3. Add it to `languages.json`: `"fr": "Français"`.

The new language shows by itself in the language list of the panel and the web.
