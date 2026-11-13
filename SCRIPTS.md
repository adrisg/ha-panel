# Scripts: burbujas y pestañas a tu medida

Las burbujas y las tarjetas de las pestañas se pueden programar con pequeños archivos JavaScript.
**Todas las burbujas son scripts**, también las de serie (`tiempo.js`, `alarma.js`, `impresoras.js`, `patinete.js`, `musica.js`, `luces.js`, `aberturas.js`). Si editas una, se guarda tu versión. Con «Restaurar» vuelves a la de serie.

- **Dónde:** en la web de configuración, apartado **📜 Scripts**. Ahí puedes crearlos, importarlos (desde una URL o un archivo .js), editarlos y **probarlos** con los datos actuales de tu casa.
- **Cómo funcionan:** se guardan en la Pi; el panel los descarga y los ejecuta **en el navegador**. Desde Home Assistant solo se leen estados. Lo único que se manda a Home Assistant es una `action` cuando tú tocas la burbuja o el botón.
- **Para usarlos:**
  - Una **burbuja**: en **🫧 Burbujas**, «Añadir burbuja de script». Después eliges si sale en Ambiente, en Inicio o en los dos.
  - Una **tarjeta**: en **🗂️ Pestañas**, añade una tarjeta de tipo «Script».

## Forma de un script

```js
{
  watch: ['sensor.temperatura_salon'],     // entidades que lo actualizan (admite *). Sin watch: cualquier cambio
  render(ha) {
    const t = ha.num('sensor.temperatura_salon');
    if (isNaN(t)) return null;             // null = no se muestra
    return {
      icon: 'mdi:thermometer', text: 'Salón ' + ha.fmt('sensor.temperatura_salon'),
      textColor: t > 26 ? 'rojo' : null,          // color del texto
      iconEnd: t > 26 ? 'mdi:alert' : null,       // icono al final
      go: 'sensors',
    };
  },
}
```

## Qué puedes usar

| | |
|---|---|
| `ha.state(id)`, `ha.num(id)`, `ha.attr(id, 'x')` | estado (texto o número) y atributos |
| `ha.name(id)`, `ha.fmt(id)` | nombre visible y estado con su unidad (`21,5 °C`) |
| `ha.isOn(id)`, `ha.ok(id)` | ¿encendido/abierto? ¿disponible? |
| `ha.find('light.*', filtro)`, `ha.count('light.*', 'on')` | buscar y contar entidades |
| `ha.minutesSince(id)`, `ha.entity(id)`, `ha.states`, `ha.now()` | último cambio, estado completo, todo, hora |
| `ha.visible(id)` | ¿se muestra en el panel? (`ha.find('light.*').filter(ha.visible)`) |
| `ha.panel.weather()`, `.alarm()`, `.printers()`, `.scooter()`, `.duration(s)` | datos que ya calcula el panel. En «Probar» de la web dan `null` |

`render(ha, where)`: `where` es `'ambient'` (debajo del reloj) o `'home'` (resumen de Inicio). Las burbujas se recalculan cuando cambia algo de su `watch` y, como mínimo, una vez por minuto.

**Una burbuja devuelve** un objeto, una lista de objetos o `null`. Estos son sus campos:

| | |
|---|---|
| `icon`, `color` | icono del principio y su color |
| `text`, `textColor` | texto y su color |
| `iconEnd`, `iconEndColor` | icono del final y su color |
| `progress` | barrita de progreso (0–100) |
| `go`, `action` | qué hace al tocarla |

**Una tarjeta devuelve** una lista de bloques:

```js
{ title: 'Texto' }   { text: '…', size: 'big' | 'small' }   { tiles: ['light.salon', …] }
{ stats: [{ icon, value, label }] }   { chips: [burbujas] }   { button: { text, icon, action } }
```

- `go`: a qué pestaña lleva al tocar (`home`, `rooms`, `sensors`, `media`, `printers`, `scooter` o el id de una pestaña tuya).
- `action`: lo que se hace al tocar, por ejemplo `{ service: 'light.turn_off', entity: 'light.salon', data: {} }`.
- Colores: `verde`, `rojo`, `amarillo`, `azul`, `naranja`, `gris`, `morado` o cualquier color CSS.

## Pestañas

En **🗂️ Pestañas** eliges el nombre, el icono y las tarjetas de cada pestaña:

| Tarjeta | Qué muestra |
|---|---|
| Vista del panel | Inicio, Casa, Sensores, Multimedia, Impresoras o Patinete |
| Dispositivos | los que elijas |
| Cámara | una cámara |
| Burbujas | las burbujas de Inicio |
| Script | lo que devuelva tu script |
