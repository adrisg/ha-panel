# Traducciones

Los textos del panel y de la web de configuración están en español en el código, y aquí se traducen.

| Archivo | Qué es |
|---|---|
| `i18n.js` | El motor: `t('Texto')` devuelve el texto en el idioma elegido. |
| `es.js` | Español. Solo pone nombre al idioma, porque los textos ya están en español. |
| `en.js` | Inglés: una parte para el panel y otra para la web. |

## Añadir un idioma

1. Copia `en.js` como `xx.js`, donde `xx` es el código del idioma (`fr`, `de`…), y traduce los valores. Las claves son los textos en español; no las cambies.
2. En el último bloque, cambia el nombre y el formato de fechas y números: `{ name: 'Français', locale: 'fr-FR' }`.
3. Añade `<script src="translations/xx.js"></script>` en `index.html` y `<script src="/translations/xx.js"></script>` en `config.html`, detrás de `en.js`.

El idioma nuevo aparece solo en la lista de idiomas del panel y de la web. Los textos sin traducir salen en español.

**Textos con números o nombres:** se traducen con patrones, por ejemplo `[/^(\d+) encendidas?$/, '$1 allumées']`.
