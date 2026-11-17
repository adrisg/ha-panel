# Scripts: burbujas y componentes a tu medida

Las burbujas y los componentes de las pestañas (botones, tarjetas, tiempo…) son pequeños archivos JavaScript.
**Todas las burbujas funcionan así**, también las de serie (`tiempo.js`, `alarma.js`, `impresoras-bambu.js`, `impresoras-klipper.js`, `vehiculo.js`, `musica.js`, `luces.js`, `aberturas.js`). Si editas una, se guarda tu versión. Con «Restaurar» vuelves a la de serie.

- **Dónde:** en la web de configuración, pestaña **🫧 Burbujas**. Cada burbuja tiene un título; al tocarla se despliega su **funcionamiento** (el código), que puedes editar, **probar** con los datos actuales de tu casa, descargar o, en las de serie, restaurar.
- **Nuevas:** pon un título y «Crear», tráela de una URL o sube un archivo `.js`. Después pulsa **Guardar**.
- **Cómo funcionan:** se guardan en la Pi; el panel las descarga y las ejecuta **en el navegador**. Para pintar solo leen; a Home Assistant solo se manda algo cuando tocas la burbuja o el botón (`onTap`).
- **Componentes:** en **🧩 Componentes** (los de serie: `boton.js`, `informacion.js`, `lista.js`, `tarjeta.js`, `tarjeta-tiempo.js`, `tarjeta-vehiculo.js` y `resumen-ejemplo.js`). Se colocan en **🗂️ Pantallas**. Ver [Componentes](#componentes).

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
| `ha.devices('bambu_lab')` | aparatos de una integración: `[{ id, name, area, entities }]` |
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
| `screen.visible(id)` | ¿la entidad no está oculta en el panel? |
| `screen.go('media')`, `screen.now()` | ir a una pestaña; hora actual |

## Ajustes (`config`)

Un script puede declarar campos que se rellenan en la web (**🫧 Burbujas → la burbuja → Ajustes**), sin tocar el código. Llegan como tercer parámetro de `render`:

```js
{
  config: {
    entity:   { type: 'entity', domain: 'weather', label: 'Entidad del tiempo' },
    showText: { type: 'bool', label: 'Mostrar descripción', default: true },
  },
  watch: (config) => [config.entity],      // watch puede depender de los ajustes
  render(ha, screen, config) { … config.entity … },
}
```

| Tipo | Opciones | Valor |
|---|---|---|
| `entity` | `domain`, `deviceClass`, `multiple` | id (vacío = la primera que encaje) o lista de ids (vacía = todas) |
| `device` | `integration`, `has: { key }` o `{ suffix }`, `multiple` | id del aparato o lista (vacía = todos los de esa integración) |
| `text`, `number` | `default`, `min`, `max`, `step` | texto o número |
| `bool` | `default` | `true` / `false` |
| `select` | `options: ['a', 'b']` o `[{ value, label }]` | la opción elegida |

Todos admiten `label`, `default` y `hint`. Los valores se guardan en la burbuja, no en el script: si actualizas o restauras el script, se conservan.

Se recalculan cuando cambia algo de su `watch` y, como mínimo, una vez por minuto.

**Una burbuja devuelve** un objeto, una lista de objetos o `null`. Estos son sus campos:

| | |
|---|---|
| `icon`, `color` | icono del principio y su color |
| `text`, `textColor` | texto y su color |
| `iconEnd`, `iconEndColor` | icono del final y su color |
| `progress` | barrita de progreso (0–100) |
| `go`, `onTap` | al tocarla: ir a una pestaña o `onTap(ha, screen)` |

- `go`: a qué pestaña lleva al tocar (`home`, `rooms`, `sensors`, `media`, `printers`, `scooter`, `settings` o el id de una pestaña tuya).
- `onTap(ha, screen)`: lo que se hace al tocar, por ejemplo `(ha) => ha.call('light.turn_off', { entity_id: 'light.salon' })`.
- Colores: `verde`, `rojo`, `amarillo`, `azul`, `naranja`, `gris`, `morado` o cualquier color CSS.

## Componentes

Un componente es un script con `type: 'card'`. Además de `config`, `watch` y `render`, dice cómo se llama y cómo se coloca:

```js
{
  type: 'card', name: 'Botón', icon: 'mdi:gesture-tap-button', width: '1/4',   // ancho al añadirlo
  config: {
    entity: { type: 'entity', auto: false, label: 'Entidad' },
    tap:  { type: 'action', label: 'Al pulsar', default: 'toggle' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'more-info' },
  },
  watch: (config) => [config.entity],
  render(ha, screen, config) {
    const id = config.entity;
    return {
      tile: { icon: ha.icon(id), name: ha.name(id), state: ha.text(id), on: ha.active(id), kind: ha.kind(id) },
      entity: id, tap: config.tap, hold: config.hold,
    };
  },
}
```

- **Dónde:** **🧩 Componentes**. Cada uno se despliega con «Probar con estos ajustes», cómo se ve y su código. Para crear uno: desde cero, copiando otro, de una URL o subiendo un `.js`. Se guardan en la Pi y el panel los descarga solo.
- **Colocarlos:** **🗂️ Pantallas → + Añadir**. Cada sitio donde lo pones tiene sus propios ajustes y su ancho (completo, 3/4, 2/3, 1/2, 1/3, 1/4).
- `children: true`: el componente lleva otros dentro (como **Tarjeta**); van donde pongas la pieza `{ children: true }`.
- Campos de más: `icon` (un icono `mdi:…`) y `action` (qué hacer al pulsar: `toggle`, `more-info`, `navigate` con `go`, `call` con `service` y `data`, o `none`).
- Para pintar: `ha.text(id)` (estado traducido: «Encendido», «21,5 °C»), `ha.icon(id)`, `ha.active(id)`, `ha.kind(id)` y `ha.forecast(id)` (previsión diaria).

**`render` devuelve piezas** (una o una lista):

| Pieza | Qué es |
|---|---|
| `{ tile: { icon, name, state, on, kind } }` | ficha como las de Casa |
| `{ stat: { icon, value, label } }`, `{ stats: [...] }` | un valor en grande, o varios |
| `{ list: [{ icon, name, value, entity, tap, hold }] }` | filas |
| `{ ring: { value, mode, title, sub, icon } }` | anillo de porcentaje (`mode`: `charging`, `charged`) |
| `{ weather: { icon, temp, cond, extra, forecast } }` | tiempo con previsión |
| `{ card: [piezas], title }` | fondo de tarjeta con piezas dentro |
| `{ button: { text, icon } }`, `{ chips: [burbujas] }`, `{ tiles: [ids] }` | botón, burbujas, fichas |
| `{ title }`, `{ text, size }`, `'texto'` | títulos y texto |
| `{ children: true }` | los componentes de dentro |

Cualquier pieza admite `entity`, `tap` y `hold`. `tap`/`hold` es una acción (`config.tap`, `'toggle'`, `{ action: 'navigate', go: 'media' }`…) o una función `(ha, screen) => ha.call(…)`.

## Pantallas

En **🗂️ Pantallas** eliges las pestañas de la barra lateral y, en cada una, una rejilla con lo que lleva: componentes, filas de burbujas y las vistas del panel (Inicio, Casa, Sensores…), dispositivos o una cámara. Toca una tarjeta para cambiar su ancho, sus ajustes, moverla, duplicarla o borrarla.
