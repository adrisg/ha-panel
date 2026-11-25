# Scripts: bubbles and components your way

The bubbles and the tab components (buttons, cards, weather…) are small JavaScript files.
**All bubbles work this way**, the built-in ones too (`weather.js`, `alarm.js`, `printers-bambu.js`, `printers-klipper.js`, `vehicle.js`, `music.js`, `lights.js`, `openings.js`). If you edit one, your version is saved. "Restore" brings back the built-in one.

- **Where:** in the configuration web, **🖼️ Ambient mode** tab (🫧 Bubbles card). Each bubble has a title; tapping it opens its **script** (the code), which you can edit, **test** with the current data of your home, download or, for the built-in ones, restore.
- **New ones:** enter a title and "Create", get one from a URL or upload a `.js` file. Then press **Save**.
- **How they work:** they are saved on the Pi; the panel downloads them and runs them **in the browser**. To paint they only read; something is only sent to Home Assistant when you tap the bubble or the button (`onTap`).
- **Components:** in **🧩 Components** (the built-in ones: `button.js`, `info.js`, `list.js`, `card.js`, `weather-card.js`, `vehicle-card.js`, `greeting.js`, `scenes.js`, `printer.js`, `player.js`, `camera.js`, `slider.js` and `summary-example.js`). They are placed in **🗂️ Tabs**. See [Components](#components).

## Shape of a script

```js
{
  watch: ['sensor.living_room_temperature'],   // entities that update it (* allowed). Without watch: any change
  render(ha, screen) {
    const t = ha.num('sensor.living_room_temperature');
    if (isNaN(t)) return null;                 // null = it does not show
    return {
      icon: 'mdi:thermometer', text: 'Living room ' + ha.fmt('sensor.living_room_temperature'),
      textColor: t > 26 ? 'red' : null,          // text colour
      iconEnd: t > 26 ? 'mdi:alert' : null,      // icon at the end
      onTap: (ha) => ha.call('fan.toggle', { entity_id: 'fan.living_room' }),   // on tap
    };
  },
}
```

It gets two variables:

**`ha`: Home Assistant**

| | |
|---|---|
| `ha.state(id)`, `ha.num(id)`, `ha.attr(id, 'x')` | state (text or number) and attributes |
| `ha.name(id)`, `ha.fmt(id)` | visible name and state with its unit (`21.5 °C`) |
| `ha.isOn(id)`, `ha.ok(id)` | on/open? available? |
| `ha.find('light.*', filter)`, `ha.count('light.*', 'on')` | find and count entities |
| `ha.info(id)` | what it belongs to: `{ platform, device, deviceId, area, areaId, key }` |
| `ha.devices('bambu_lab')` | devices of an integration: `[{ id, name, area, entities }]` |
| `ha.minutesSince(id)`, `ha.entity(id)`, `ha.states` | last change, full state, everything |
| `ha.number(n)`, `ha.duration(seconds)` | `21.5` and `1 h 20 min` (in the panel's format) |
| `ha.call('light.turn_off', { entity_id })` | send to Home Assistant. **Only inside `onTap`** |

**`screen`: the screen** (what does not belong to Home Assistant)

| | |
|---|---|
| `screen.place` | where it paints: `'ambient'` (under the clock), `'home'` (in a Row of bubbles of a tab) or `'card'` (a component) |
| `screen.brightness`, `screen.on`, `screen.night`, `screen.ambient` | brightness, on, night mode, ambient mode |
| `screen.alarms`, `screen.nextAlarm()` | panel alarms: `{ name, time, days, enabled, when, text }` |
| `screen.light` | ambient light from the screen sensor (`null` for now) |
| `screen.visible(id)` | is the entity not hidden on the panel? |
| `screen.go('media')`, `screen.now()` | go to a tab; current time |
| `screen.nowPlaying(id)` | open the "Now playing" screen of a player (e.g. `tap=${(ha, screen) => screen.nowPlaying(id)}`) |
| `screen.notices`, `screen.openNotices()` | panel notifications `{ unread, total, last }` and open the quick access panel on Notifications (the **Notifications** bubble uses it) |

**Languages:** write the texts in English. The panel translates the texts it knows; for your own, `I18N.t('Text')` gives the translation if it exists in `translations/`.

## Settings (`config`)

A script can declare fields that are filled in in the web (**🖼️ Ambient mode → 🫧 Bubbles → the bubble → Settings**), without touching the code. They arrive as the third parameter of `render`:

```js
{
  config: {
    entity:   { type: 'entity', domain: 'weather', label: 'Weather entity' },
    showText: { type: 'bool', label: 'Show the description', default: true },
  },
  watch: (config) => [config.entity],      // watch can depend on the settings (and on ha: (config, ha) => …)
  render(ha, screen, config) { … config.entity … },
}
```

| Kind | Options | Value |
|---|---|---|
| `entity` | `domain`, `deviceClass`, `multiple` | id (empty = the first one that fits) or list of ids (empty = all) |
| `device` | `integration`, `has: { key }` or `{ suffix }`, `multiple` | device id or list (empty = all of that integration) |
| `text`, `number` | `default`, `min`, `max`, `step` | text or number |
| `bool` | `default` | `true` / `false` |
| `select` | `options: ['a', 'b']` or `[{ value, label }]` | the chosen option |

They all accept `label`, `default` and `hint`. The values are saved in the bubble, not in the script: if you update or restore the script, they are kept.

They are recalculated when something in their `watch` changes and, at least, once a minute.

**A bubble returns** an object, a list of objects or `null`. These are its fields:

| | |
|---|---|
| `icon`, `color` | icon at the start and its colour |
| `text`, `textColor` | text and its colour |
| `iconEnd`, `iconEndColor` | icon at the end and its colour |
| `progress` | small progress bar (0–100) |
| `go`, `onTap` | on tap: go to a tab or `onTap(ha, screen)` |

- `go`: the tab it leads to on tap (`home`, `rooms`, `sensors`, `media`, `printers`, `scooter`, `settings` or the id of one of your tabs).
- `onTap(ha, screen)`: what happens on tap, for example `(ha) => ha.call('light.turn_off', { entity_id: 'light.living_room' })`.
- Colours: `green`, `red`, `yellow`, `blue`, `orange`, `grey`, `purple` or any CSS colour.

## Components

A component is a script with `type: 'card'`: its **fields** (`config`), what it **watches** (`watch`), its **CSS** (`style`) and its **HTML** (`render`).

```js
{
  type: 'card', name: 'Button', icon: 'mdi:gesture-tap-button', width: '1/4',   // width when added
  config: {
    entity: { type: 'entity', auto: false, label: 'Entity' },
    tap:  { type: 'action', label: 'On tap', default: 'toggle' },
    hold: { type: 'action', label: 'On hold', default: 'more-info' },
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

**HTML (`render`)** returns `html\`…\``. What you put in with `${…}` is escaped by itself; to put HTML inside HTML, use another `html\`…\`` (lists too: `${list.map((x) => html\`<li>${x}</li>\`)}`).

| In the HTML | What it does |
|---|---|
| `<ha-icon icon="mdi:lightbulb">` | an icon (also `icon=${ha.icon(id)}`) |
| `tap=…`, `hold=…` | on tap / hold: `${config.tap}` (what was chosen in the settings), `"toggle"`, `"more-info"`, `"none"`, `${{ action: 'navigate', go: 'media' }}`, the name of a function in `actions` or a function `${(ha) => ha.call(…)}` |
| `entity=…` | the entity `tap` and `hold` act on |
| `<slot></slot>` | the inner components go here (if the script has `children: true`, like **Card**) |
| `<ha-tile entity=…>` | panel tile (tap = on/off, hold = details) |
| `<ha-sensor entity=…>` | sensor tile with its value (hold = history) |
| `<ha-camera entity=…>` | camera image that refreshes by itself |
| `change=${(ha, screen, value) => …}` | on an `<input>` (sliders…): runs on release, with its value |

**CSS (`style`)** only affects that component. Classes that already exist: `card` (card background) and `hint` (grey text). Panel colours:

| Variable | What it is |
|---|---|
| `--bg`, `--surface`, `--surface-2`, `--surface-3` | background and card backgrounds, from darker to lighter |
| `--text`, `--muted`, `--accent`, `--ok`, `--danger` | text, grey text, accent, green, red |
| `--on-light`, `--on-media`, `--on-climate`, `--on-cover`, `--on-lock`, `--on-default` (and `…-ink` for the text) | "on" colours |
| `--radius` | corner rounding of the cards |

**`actions`**: named functions for `tap="off"`:

```js
actions: { off: (ha, screen) => ha.call('light.turn_off', { entity_id: 'all' }) },
```

To paint, besides the usual: `ha.mediaOrder(ids)` (players without duplicates, what is playing first), `ha.printers()` (each printer with its state and its entities: `e.progress`, `e.camera`, `e.pause`…), `ha.picture(id)` (address of its image: artwork, thumbnail…), `screen.favorites` (Favourites from the Settings), `ha.text(id)` (translated state: "On", "21.5 °C"), `ha.icon(id)`, `ha.active(id)`, `ha.color(id)` (`{ bg, ink }`: real colour of a light that is on), `ha.forecast(id)` (daily forecast).

- **Where:** **🧩 Components**. Each one opens with "Test with these settings", how it looks and its code. To create one: from scratch, copying another, from a URL or uploading a `.js`. They are saved on the Pi and the panel downloads them by itself.
- **Placing them:** **🗂️ Tabs → + Add**. Each place you put it has its own settings and width (full, 3/4, 2/3, 1/2, 1/3, 1/4).
- Extra fields: `icon` (an `mdi:…` icon) and `action` (what to do on tap).
- `refresh: 60`: it repaints by itself every those seconds (for times and dates), even if nothing in its `watch` changes.

## Tabs

In **🗂️ Tabs** you choose the tabs of the side bar and, in each one, a grid with what it has: components, rows of bubbles, devices or a camera. Tap a card to change its width or its settings, move it, duplicate it or delete it.

The built-in tabs (Home, House, Sensors, Media, Printers and Scooter) are built with your data and the usual components, one per thing:
House = a **Card** per area with a **Button** per device; Sensors = a Card per area with an **Information** per sensor; Media = a **Player** and a **Camera** for each one; Printers = a **Printer** for each one; Scooter = **Vehicle** and Cards with Information, **Slider** and Buttons; Home = Greeting, bubbles, Weather, Vehicle, Scenes and a Favourites Card.

The old tabs ("panel views") are converted this way when **🗂️ Tabs** opens; press **Save** to keep them and change whatever you like. Until then, the panel builds them the same way by itself.

## Only show if…

Each placed card (in **🗂️ Tabs**, when you tap it) can have conditions to show or not:

| Condition | Example |
|---|---|
| State of an entity | `light.living_room` is on / off / available, is equal to `home`, greater than `25`… |
| Between two times | from 07:00 to 09:00 (or from 22:00 to 07:00) |
| Night mode | is on / is not on |
| Code | `ha.isOn('light.living_room') && !screen.night` |

With several: "All are met" or "Any is met". On the panel it shows and hides at once; in the grid it is marked with 👁 and looks dimmed if it would not show right now.
