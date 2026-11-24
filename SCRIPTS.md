# Scripts: burbujas y componentes a tu medida

Las burbujas y los componentes de las pestañas (botones, tarjetas, tiempo…) son pequeños archivos JavaScript.
**Todas las burbujas funcionan así**, también las de serie (`tiempo.js`, `alarma.js`, `impresoras-bambu.js`, `impresoras-klipper.js`, `vehiculo.js`, `musica.js`, `luces.js`, `aberturas.js`). Si editas una, se guarda tu versión. Con «Restaurar» vuelves a la de serie.

- **Dónde:** en la web de configuración, pestaña **🖼️ Modo ambiente** (tarjeta 🫧 Burbujas). Cada burbuja tiene un título; al tocarla se despliega su **funcionamiento** (el código), que puedes editar, **probar** con los datos actuales de tu casa, descargar o, en las de serie, restaurar.
- **Nuevas:** pon un título y «Crear», tráela de una URL o sube un archivo `.js`. Después pulsa **Guardar**.
- **Cómo funcionan:** se guardan en la Pi; el panel las descarga y las ejecuta **en el navegador**. Para pintar solo leen; a Home Assistant solo se manda algo cuando tocas la burbuja o el botón (`onTap`).
- **Componentes:** en **🧩 Componentes** (los de serie: `boton.js`, `informacion.js`, `lista.js`, `tarjeta.js`, `tarjeta-tiempo.js`, `tarjeta-vehiculo.js`, `saludo.js`, `escenas.js`, `impresora.js`, `reproductor.js`, `camara.js`, `deslizador.js` y `resumen-ejemplo.js`). Se colocan en **🗂️ Pantallas**. Ver [Componentes](#componentes).

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
| `screen.place` | dónde se pinta: `'ambient'` (debajo del reloj), `'home'` (en una Fila de burbujas de una pestaña) o `'card'` (un componente) |
| `screen.brightness`, `screen.on`, `screen.night`, `screen.ambient` | brillo, encendida, modo noche, modo ambiente |
| `screen.alarms`, `screen.nextAlarm()` | alarmas del panel: `{ name, time, days, enabled, when, text }` |
| `screen.light` | luz ambiente del sensor de la pantalla (de momento `null`) |
| `screen.visible(id)` | ¿la entidad no está oculta en el panel? |
| `screen.go('media')`, `screen.now()` | ir a una pestaña; hora actual |
| `screen.nowPlaying(id)` | abrir la pantalla «Sonando» de un reproductor (p. ej. `tap=${(ha, screen) => screen.nowPlaying(id)}`) |

## Ajustes (`config`)

Un script puede declarar campos que se rellenan en la web (**🖼️ Modo ambiente → 🫧 Burbujas → la burbuja → Ajustes**), sin tocar el código. Llegan como tercer parámetro de `render`:

```js
{
  config: {
    entity:   { type: 'entity', domain: 'weather', label: 'Entidad del tiempo' },
    showText: { type: 'bool', label: 'Mostrar descripción', default: true },
  },
  watch: (config) => [config.entity],      // watch puede depender de los ajustes (y de ha: (config, ha) => …)
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

Un componente es un script con `type: 'card'`: sus **campos** (`config`), qué **vigila** (`watch`), su **CSS** (`style`) y su **HTML** (`render`).

```js
{
  type: 'card', name: 'Botón', icon: 'mdi:gesture-tap-button', width: '1/4',   // ancho al añadirlo
  config: {
    entity: { type: 'entity', auto: false, label: 'Entidad' },
    tap:  { type: 'action', label: 'Al pulsar', default: 'toggle' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'more-info' },
  },
  watch: (config) => [config.entity],
  style: `
    .btn { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px;
           border-radius: 20px; background: var(--surface); }
    .on  { background: var(--on-light); color: var(--on-light-ink); }
  `,
  render(ha, screen, config, html) {
    const id = config.entity;
    return html`
      <button class="btn ${ha.active(id) ? 'on' : ''}" tap=${config.tap} hold=${config.hold} entity=${id}>
        <ha-icon icon=${ha.icon(id)}></ha-icon>
        <span><b>${ha.name(id)}</b> ${ha.text(id)}</span>
      </button>`;
  },
}
```

**HTML (`render`)** devuelve `html\`…\``. Lo que metes con `${…}` se escapa solo; para meter HTML dentro de HTML, usa otro `html\`…\`` (también listas: `${lista.map((x) => html\`<li>${x}</li>\`)}`).

| En el HTML | Qué hace |
|---|---|
| `<ha-icon icon="mdi:lightbulb">` | un icono (también `icon=${ha.icon(id)}`) |
| `tap=…`, `hold=…` | al pulsar / mantener: `${config.tap}` (lo elegido en ajustes), `"toggle"`, `"more-info"`, `"none"`, `${{ action: 'navigate', go: 'media' }}`, el nombre de una función de `actions` o una función `${(ha) => ha.call(…)}` |
| `entity=…` | sobre qué entidad actúan `tap` y `hold` |
| `<slot></slot>` | aquí van los componentes de dentro (si el script lleva `children: true`, como **Tarjeta**) |
| `<ha-tile entity=…>` | ficha del panel (pulsar = encender/apagar, mantener = detalle) |
| `<ha-sensor entity=…>` | ficha de sensor con su valor (mantener = historial) |
| `<ha-camera entity=…>` | imagen de una cámara que se refresca sola |
| `change=${(ha, screen, valor) => …}` | en un `<input>` (deslizadores…): se ejecuta al soltarlo, con su valor |

**CSS (`style`)** solo afecta a ese componente. Clases que ya existen: `card` (fondo de tarjeta) y `hint` (texto gris). Colores del panel:

| Variable | Qué es |
|---|---|
| `--bg`, `--surface`, `--surface-2`, `--surface-3` | fondo y fondos de tarjeta, de más oscuro a más claro |
| `--text`, `--muted`, `--accent`, `--ok`, `--danger` | texto, texto gris, azul, verde, rojo |
| `--on-light`, `--on-media`, `--on-climate`, `--on-cover`, `--on-lock`, `--on-default` (y `…-ink` para el texto) | colores de «encendido» |
| `--radius` | redondeo de las tarjetas |

**`actions`**: funciones con nombre para `tap="apagar"`:

```js
actions: { apagar: (ha, screen) => ha.call('light.turn_off', { entity_id: 'all' }) },
```

Para pintar, además de lo de siempre: `ha.mediaOrder(ids)` (reproductores sin repetidos, lo que suena primero), `ha.printers()` (cada impresora con su estado y sus entidades: `e.progress`, `e.camera`, `e.pause`…), `ha.picture(id)` (dirección de su imagen: carátula, miniatura…), `screen.favorites` (Favoritos de los Ajustes), `ha.text(id)` (estado traducido: «Encendido», «21,5 °C»), `ha.icon(id)`, `ha.active(id)`, `ha.color(id)` (`{ bg, ink }`: color real de una luz encendida), `ha.forecast(id)` (previsión diaria).

- **Dónde:** **🧩 Componentes**. Cada uno se despliega con «Probar con estos ajustes», cómo se ve y su código. Para crear uno: desde cero, copiando otro, de una URL o subiendo un `.js`. Se guardan en la Pi y el panel los descarga solo.
- **Colocarlos:** **🗂️ Pantallas → + Añadir**. Cada sitio donde lo pones tiene sus propios ajustes y su ancho (completo, 3/4, 2/3, 1/2, 1/3, 1/4).
- Campos de más: `icon` (un icono `mdi:…`) y `action` (qué hacer al pulsar).
- `refresh: 60`: se repinta solo cada esos segundos (para horas y fechas), aunque no cambie nada de su `watch`.

## Pantallas

En **🗂️ Pantallas** eliges las pestañas de la barra lateral y, en cada una, una rejilla con lo que lleva: componentes, filas de burbujas, dispositivos o una cámara. Toca una tarjeta para cambiar su ancho, sus ajustes, moverla, duplicarla o borrarla.

Las pestañas de serie (Inicio, Casa, Sensores, Multimedia, Impresoras y Patinete) se montan con tus datos y con los componentes de siempre, uno por cosa:
Casa = una **Tarjeta** por zona con un **Botón** por aparato; Sensores = una Tarjeta por zona con una **Información** por sensor; Multimedia = un **Reproductor** y una **Cámara** por cada uno; Impresoras = una **Impresora** por cada una; Patinete = **Vehículo** y Tarjetas con Información, **Deslizador** y Botones; Inicio = Saludo, burbujas, Tiempo, Vehículo, Escenas y una Tarjeta de Favoritos.

Las pestañas antiguas («vistas del panel») se convierten así al abrir **🗂️ Pantallas**; pulsa **Guardar** para quedártelas y cambiar lo que quieras. Hasta entonces, el panel las monta igual por su cuenta.

## Mostrar solo si…

Cada tarjeta colocada (en **🗂️ Pantallas**, al tocarla) puede llevar condiciones para aparecer o no:

| Condición | Ejemplo |
|---|---|
| Estado de una entidad | `light.salon` está encendida / apagada / disponible, es igual a `home`, mayor que `25`… |
| Entre dos horas | de 07:00 a 09:00 (o de 22:00 a 07:00) |
| Modo noche | está activo / no está activo |
| Código | `ha.isOn('light.salon') && !screen.night` |

Con varias: «Se cumplen todas» o «Se cumple alguna». En el panel aparece y desaparece al momento; en la rejilla se marca con 👁 y se ve atenuada si ahora no saldría.
