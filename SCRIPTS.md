# Scripts: burbujas y pestañas a tu medida

Las burbujas y las tarjetas de las pestañas se pueden programar con pequeños archivos JavaScript.
**Todas las burbujas funcionan así**, también las de serie (`tiempo.js`, `alarma.js`, `impresoras.js`, `patinete.js`, `musica.js`, `luces.js`, `aberturas.js`). Si editas una, se guarda tu versión. Con «Restaurar» vuelves a la de serie.

- **Dónde:** en la web de configuración, pestaña **🫧 Burbujas**. Cada burbuja tiene un título; al tocarla se despliega su **funcionamiento** (el código), que puedes editar, **probar** con los datos actuales de tu casa, descargar o, en las de serie, restaurar.
- **Nuevas:** pon un título y «Crear», tráela de una URL o sube un archivo `.js`. Después pulsa **Guardar**.
- **Cómo funcionan:** se guardan en la Pi; el panel las descarga y las ejecuta **en el navegador**. Para pintar solo leen; a Home Assistant solo se manda algo cuando tocas la burbuja o el botón (`onTap`).
- **Tarjetas:** en **⚙️ Ajustes → 🧩 Tarjetas con código**, y se usan en **🗂️ Pestañas** con una tarjeta de tipo «Código».

## Forma de un script

```js
{
  watch: ['sensor.temperatura_salon'],     // entidades que lo actualizan (admite *). Sin watch: cualquier cambio
  render(ha, screen) {
    const t = ha.num('sensor.temperatura_salon');
    if (isNaN(t)) return null;             // null = no se muestra
    return {
      icon: 'mdi:thermometer', text: 'Salón ' + ha.fmt('sensor.temperatura_salon'),
      textColor: t > 26 ? 'rojo' : null,          // color del texto
      iconEnd: t > 26 ? 'mdi:alert' : null,       // icono al final
      onTap: (ha) => ha.call('fan.toggle', { entity_id: 'fan.salon' }),   // al tocar
    };
  },
}
```

Recibe dos variables:

**`ha`: Home Assistant**

| | |
|---|---|
| `ha.state(id)`, `ha.num(id)`, `ha.attr(id, 'x')` | estado (texto o número) y atributos |
| `ha.name(id)`, `ha.fmt(id)` | nombre visible y estado con su unidad (`21,5 °C`) |
| `ha.isOn(id)`, `ha.ok(id)` | ¿encendido/abierto? ¿disponible? |
| `ha.find('light.*', filtro)`, `ha.count('light.*', 'on')` | buscar y contar entidades |
| `ha.info(id)` | de qué es: `{ platform, device, deviceId, area, areaId, key }` |
| `ha.minutesSince(id)`, `ha.entity(id)`, `ha.states` | último cambio, estado completo, todo |
| `ha.number(n)`, `ha.duration(segundos)` | `21,5` y `1 h 20 min` |
| `ha.call('light.turn_off', { entity_id })` | mandar a Home Assistant. **Solo dentro de `onTap`** |

**`screen`: la pantalla** (lo que no es de Home Assistant)

| | |
|---|---|
| `screen.place` | dónde se pinta: `'ambient'` (debajo del reloj), `'home'` (Inicio) o `'card'` |
| `screen.brightness`, `screen.on`, `screen.night`, `screen.ambient` | brillo, encendida, modo noche, modo ambiente |
| `screen.alarms`, `screen.nextAlarm()` | alarmas del panel: `{ name, time, days, enabled, when, text }` |
| `screen.light` | luz ambiente del sensor de la pantalla (de momento `null`) |
| `screen.weatherEntity`, `screen.visible(id)` | tiempo elegido en ajustes; ¿la entidad no está oculta? |
| `screen.go('media')`, `screen.now()` | ir a una pestaña; hora actual |

Se recalculan cuando cambia algo de su `watch` y, como mínimo, una vez por minuto.

**Una burbuja devuelve** un objeto, una lista de objetos o `null`. Estos son sus campos:

| | |
|---|---|
| `icon`, `color` | icono del principio y su color |
| `text`, `textColor` | texto y su color |
| `iconEnd`, `iconEndColor` | icono del final y su color |
| `progress` | barrita de progreso (0–100) |
| `go`, `onTap` | al tocarla: ir a una pestaña o `onTap(ha, screen)` |

**Una tarjeta devuelve** una lista de bloques:

```js
{ title: 'Texto' }   { text: '…', size: 'big' | 'small' }   { tiles: ['light.salon', …] }
{ stats: [{ icon, value, label }] }   { chips: [burbujas] }   { button: { text, icon, go, onTap } }
```

- `go`: a qué pestaña lleva al tocar (`home`, `rooms`, `sensors`, `media`, `printers`, `scooter`, `settings` o el id de una pestaña tuya).
- `onTap(ha, screen)`: lo que se hace al tocar, por ejemplo `(ha) => ha.call('light.turn_off', { entity_id: 'light.salon' })`.
- Colores: `verde`, `rojo`, `amarillo`, `azul`, `naranja`, `gris`, `morado` o cualquier color CSS.

## Pestañas

En **🗂️ Pestañas** eliges el nombre, el icono y las tarjetas de cada pestaña:

| Tarjeta | Qué muestra |
|---|---|
| Vista del panel | Inicio, Casa, Sensores, Multimedia, Impresoras o Patinete |
| Dispositivos | los que elijas |
| Cámara | una cámara |
| Burbujas | las burbujas de Inicio |
| Código | lo que devuelva su código |
