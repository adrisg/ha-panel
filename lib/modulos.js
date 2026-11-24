/* Scripts del panel: burbujas y componentes.
 * Son archivos .js que se crean o importan en la web de configuración y se guardan en la Pi. El panel los descarga
 * al arrancar y los ejecuta en el navegador; la web los usa para la vista previa y para probarlos.
 *
 *   Burbuja    { config, watch, render(ha, screen, config) → { icon, text, color, textColor, iconEnd, iconEndColor,
 *                progress, go, onTap } (o una lista, o null) }
 *   Componente { type: 'card', name, icon, width, children, refresh, config, watch, style,
 *                render(ha, screen, config, html) → html`…`, actions }   (lo pinta lib/componentes.js)
 *
 * ha     → Home Assistant: leer estados (ha.state, ha.text, ha.find, ha.info, ha.devices…) y, solo al pulsar, ha.call().
 * screen → la pantalla: dónde se pinta (screen.place), brillo, modo noche/ambiente, alarmas, ir a una pestaña…
 * config → los ajustes de ese sitio (los campos que declara el script). Ver SCRIPTS.md.
 *
 * Aquí también: los scripts de serie, los campos de ajustes, las condiciones «Mostrar solo si…», las pestañas
 * de serie (montadas con componentes) y la lista de burbujas del modo ambiente.
 */
(function (root) {
  'use strict';

  /** ¿Coincide la entidad con alguno de los patrones? ('light.*', 'sensor.*_temperatura', 'switch.enchufe') */
  function matcher(patterns) {
    if (!patterns) return () => true;
    const list = [].concat(patterns).filter(Boolean).map((p) =>
      p.includes('*') ? new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : p);
    return (id) => list.some((p) => (typeof p === 'string' ? p === id : p.test(id)));
  }

  /** Texto traducido (translations/); sin I18N, tal cual */
  const tr = (s) => (typeof I18N !== 'undefined' ? I18N.t(s) : s);
  const ACTIVE = ['on', 'open', 'opening', 'closing', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning', 'returning'];
  const KIND = { light: 'light', climate: 'climate', fan: 'climate', media_player: 'media', cover: 'cover', lock: 'lock' };
  const TXT = { on: 'panel.states.on', off: 'panel.states.off', unavailable: 'panel.states.unavailable', unknown: '—', open: 'panel.states.open', closed: 'panel.states.closed',
    locked: 'panel.states.closed', unlocked: 'panel.states.open', playing: 'panel.states.playing', paused: 'panel.states.paused', idle: 'panel.states.idle', home: 'panel.states.home', not_home: 'panel.states.away' };
  const BIN = { door: ['panel.states.closed_f', 'panel.states.open_f'], window: ['panel.states.closed_f', 'panel.states.open_f'], garage_door: ['panel.states.closed_f', 'panel.states.open_f'], opening: ['panel.states.closed', 'panel.states.open'],
    motion: ['panel.settings.no_motion', 'panel.settings.motion'], occupancy: ['panel.states.clear', 'panel.states.occupied'], presence: ['panel.states.away', 'panel.states.present'], moisture: ['panel.states.dry_state', 'panel.states.wet'],
    plug: ['panel.states.unplugged', 'panel.states.plugged_in'], battery_charging: ['panel.states.not_charging', 'panel.states.loading'], connectivity: ['panel.states.disconnected', 'panel.settings.connected'] };
  /** Estado para mostrar (la web lo usa; el panel pasa el suyo, más completo) */
  function simpleText(s) {
    if (!s) return '—';
    const a = s.attributes || {}, n = Number(s.state), d = s.entity_id.split('.')[0];
    if (d === 'binary_sensor' && BIN[a.device_class] && (s.state === 'on' || s.state === 'off')) return tr(BIN[a.device_class][s.state === 'on' ? 1 : 0]);
    if (s.state !== '' && !isNaN(n)) return n.toLocaleString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { maximumFractionDigits: 1 }) + (a.unit_of_measurement ? ' ' + a.unit_of_measurement : '');
    return TXT[s.state] ? tr(TXT[s.state]) : s.state;
  }
  const DICON = { light: 'mdi:lightbulb', switch: 'mdi:toggle-switch', sensor: 'mdi:eye', binary_sensor: 'mdi:radiobox-marked', media_player: 'mdi:speaker',
    climate: 'mdi:thermostat', cover: 'mdi:window-shutter', lock: 'mdi:lock', fan: 'mdi:fan', weather: 'mdi:weather-partly-cloudy', camera: 'mdi:cctv',
    scene: 'mdi:palette', script: 'mdi:script-text', automation: 'mdi:robot', person: 'mdi:account', vacuum: 'mdi:robot-vacuum' };
  const DCICON = { temperature: 'mdi:thermometer', humidity: 'mdi:water-percent', power: 'mdi:flash', energy: 'mdi:lightning-bolt', battery: 'mdi:battery',
    door: 'mdi:door', window: 'mdi:window-closed-variant', motion: 'mdi:motion-sensor', illuminance: 'mdi:brightness-5' };
  function simpleIcon(s) {
    if (!s) return 'mdi:help-circle-outline';
    const a = s.attributes || {};
    return a.icon || DCICON[a.device_class] || DICON[s.entity_id.split('.')[0]] || 'mdi:help-circle-outline';
  }

  function kelvinToRgb(k) {          // aproximación de Tanner Helland
    const t = k / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))));
  }
  function lightColor(s) {
    if (!s || s.entity_id.split('.')[0] !== 'light' || s.state !== 'on') return null;
    const a = s.attributes || {};
    let rgb = Array.isArray(a.rgb_color) ? a.rgb_color : a.color_temp_kelvin ? kelvinToRgb(a.color_temp_kelvin) : null;
    if (!rgb && Array.isArray(a.hs_color)) {
      const [hh, ss] = a.hs_color, c = ss / 100, x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
      const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
      rgb = [r, g, b].map((v) => Math.round((v + (1 - c)) * 255));
    }
    if (!rgb) return null;
    const soft = rgb.map((v) => Math.round(v * 0.8 + 255 * 0.2));
    const lum = (0.2126 * soft[0] + 0.7152 * soft[1] + 0.0722 * soft[2]) / 255;
    return { bg: `rgb(${soft.join(',')})`, ink: lum > 0.55 ? '#1d1a12' : '#fff' };
  }

  /** ha: acceso a Home Assistant. states = { entity_id: {state, attributes, last_changed…} }
   *  extra.info(id) → registro de la entidad; extra.call(servicio, datos) → mandar a HA (solo al tocar); extra.name(id) */
  function makeHA(getStates, extra = {}) {
    const st = (id) => getStates()[id];
    const ha = {
      /** Todos los estados (objeto entity_id → estado completo) */
      get states() { return getStates(); },
      /** Estado completo: { entity_id, state, attributes, last_changed } */
      entity: (id) => st(id) || null,
      /** Estado como texto ('on', '21.5', 'playing'…) o null si no existe */
      state: (id) => (st(id) ? st(id).state : null),
      /** Estado como número (NaN si no lo es) */
      num: (id) => (st(id) ? parseFloat(st(id).state) : NaN),
      /** Un atributo: ha.attr('light.salon', 'brightness') */
      attr: (id, name) => (st(id) && st(id).attributes ? st(id).attributes[name] : undefined),
      /** Nombre visible */
      name: extra.name || ((id) => (st(id) && st(id).attributes && st(id).attributes.friendly_name) || id),
      /** ¿Encendida / abierta / activa? */
      isOn: (id) => !!st(id) && ['on', 'open', 'playing', 'home', 'unlocked', 'cleaning', 'heat', 'cool'].includes(st(id).state),
      /** ¿Existe y está disponible? */
      ok: (id) => !!st(id) && !['unavailable', 'unknown'].includes(st(id).state),
      /** Estado con su unidad: '21,5 °C' */
      fmt(id, decimals) {
        const s = st(id);
        if (!s) return '—';
        const u = (s.attributes && s.attributes.unit_of_measurement) || '';
        if (!/^-?[\d.]+$/.test(s.state)) return s.state;
        const v = ha.number(parseFloat(s.state), decimals);
        return u ? `${v} ${u}` : v;
      },
      /** Número con coma decimal: ha.number(21.46) → '21,5' */
      number: (n, decimals) => (n == null || isNaN(n) ? '—' : decimals == null
        ? (+n).toLocaleString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { maximumFractionDigits: 1 })
        : (+n).toLocaleString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { minimumFractionDigits: decimals, maximumFractionDigits: decimals })),
      /** Segundos → '1 h 20 min' */
      duration(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        const hh = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60);
        return hh ? `${hh} h ${mm} min` : `${mm} min`;
      },
      /** Entidades que coinciden: ha.find('light.*'), ha.find('sensor.*', (s, id) => s.attributes.device_class === 'temperature') */
      find(pattern, filter) {
        const m = matcher(pattern), all = getStates();
        return Object.keys(all).filter((id) => m(id) && (!filter || filter(all[id], id)));
      },
      /** Cuántas cumplen: ha.count('light.*', 'on') */
      count(pattern, state) {
        return ha.find(pattern, (s) => state == null || (typeof state === 'function' ? state(s) : s.state === state)).length;
      },
      /** Minutos desde el último cambio */
      minutesSince(id) { const s = st(id); return s && s.last_changed ? (Date.now() - new Date(s.last_changed)) / 60000 : NaN; },
      /** Estado para mostrar, traducido y con unidad: 'Encendido', 'Abierta', '21,5 °C' */
      text: (id) => (extra.format ? extra.format(id) : simpleText(st(id))),
      /** Icono de la entidad (el de Home Assistant o uno según su tipo) */
      icon: (id) => (extra.icon ? extra.icon(id) : simpleIcon(st(id))),
      /** ¿Está activa? (encendida, abierta, reproduciendo…) para pintar la ficha encendida */
      active: (id) => !!st(id) && ACTIVE.includes(st(id).state),
      /** Color real de una luz encendida, suavizado para fondo: { bg: 'rgb(…)', ink: color de texto que se lee encima } o null */
      color: (id) => lightColor(st(id)),
      /** Tipo de ficha según el dominio: 'light', 'media', 'climate', 'cover', 'lock' o '' */
      kind: (id) => KIND[String(id).split('.')[0]] || '',
      /** Previsión diaria de una entidad weather: [{ datetime, condition, temperature, templow, precipitation_probability }] */
      forecast: (id) => (extra.forecast ? extra.forecast(id) : (st(id) && st(id).attributes.forecast) || []) || [],
      /** Reproductores sin repetidos y con lo que suena primero. Sin lista: todos */
      mediaOrder: (ids) => (extra.mediaOrder ? extra.mediaOrder(ids && ids.length ? ids : null)
        : (ids && ids.length ? ids : Object.keys(getStates()).filter((id) => id.startsWith('media_player.')))),
      /** Impresoras 3D: [{ device, name, platform, state, active, e: { status, progress, camera, pause, plug… }, nozzles: [{ label, cur, tgt, fil }] }] */
      printers: () => (extra.printers ? extra.printers() : []),
      /** Dirección de la imagen de una entidad (carátula, cámara, miniatura) o '' (en la web, '') */
      picture: (id, width) => (extra.picture ? extra.picture(id, width) : ''),
      /** De qué es la entidad: { platform (integración), device, deviceId, area, areaId, key (translation_key) } */
      info: (id) => (extra.info && extra.info(id)) || {},
      /** Aparatos de una integración: [{ id, name, area, entities: [ids] }]. Sin integración: todos */
      devices(platform) {
        const out = {};
        for (const id of Object.keys(getStates())) {
          const i = ha.info(id);
          if (!i.deviceId || (platform && ![].concat(platform).includes(i.platform))) continue;
          (out[i.deviceId] || (out[i.deviceId] = { id: i.deviceId, name: i.device || i.deviceId, area: i.area || null, entities: [] })).entities.push(id);
        }
        return Object.values(out);
      },
      /** Mandar a Home Assistant: ha.call('light.turn_off', { entity_id: 'light.salon' }). Solo dentro de onTap. */
      call: extra.call || (() => { throw new Error(tr('panel.scripts.call_only_on_tap')); }),
    };
    return ha;
  }

  /** screen: lo que es de la pantalla y no de Home Assistant.
   *  data = { place, brightness, on, night, ambient, light, alarms: [{ name, time, days, enabled, when, text }] } */
  function makeScreen(data = {}, extra = {}) {
    const alarms = (data.alarms || []).map((a) => Object.assign({}, a, { when: a.when ? new Date(a.when) : null }));
    return {
      /** Dónde se pinta: 'ambient' (debajo del reloj), 'home' (en una Fila de burbujas de una pestaña) o 'card' (un componente) */
      place: data.place || 'ambient',
      /** Brillo actual (0–100) */
      brightness: data.brightness == null ? null : data.brightness,
      /** ¿Pantalla encendida? */
      on: data.on !== false,
      /** ¿Modo noche activo? */
      night: !!data.night,
      /** ¿Se está viendo el modo ambiente? */
      ambient: !!data.ambient,
      /** Luz ambiente del sensor de la pantalla (lux). null si no hay sensor */
      light: data.light == null ? null : data.light,
      /** Alarmas del panel: [{ name, time: '07:30', days, enabled, when: Date|null, text: 'Mañana 07:30' }] */
      alarms,
      /** La próxima alarma que va a sonar, o null */
      nextAlarm: () => alarms.filter((a) => a.when).sort((x, y) => x.when - y.when)[0] || null,
      /** ¿Se muestra la entidad en el panel? (no está oculta en sus ajustes) */
      visible: extra.visible || (() => true),
      /** Ir a una pestaña: 'home', 'rooms', 'sensors', 'media', 'printers', 'scooter', 'settings' o el id de una tuya */
      go: extra.go || (() => {}),
      /** Abrir la pantalla «Sonando» (a pantalla completa) de un reproductor */
      nowPlaying: extra.nowPlaying || (() => {}),
      /** Hora actual */
      now: () => new Date(),
      /** Favoritos elegidos en los Ajustes del panel (ids) */
      favorites: Array.isArray(data.favorites) ? data.favorites : [],
      /** Avisos del panel: { unread (sin ver), total, last (título del último) } */
      notices: Object.assign({ unread: 0, total: 0, last: '' }, data.notices),
      /** Abrir el panel de acceso rápido en la ventana de Avisos */
      openNotices: extra.openNotices || (() => {}),
    };
  }

  /** Compila el texto del usuario. Acepta un objeto ({ watch, render }) o un cuerpo de función que lo devuelva. */
  function compile(code) {
    const src = String(code || '').trim();
    if (!src) throw new Error(tr('panel.scripts.no_code'));
    let mod;
    try {
      // eslint-disable-next-line no-new-func
      mod = new Function('"use strict"; return (\n' + src + '\n);')();
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      // eslint-disable-next-line no-new-func
      mod = new Function('"use strict";\n' + src)();
    }
    if (typeof mod === 'function') mod = { render: mod };
    if (!mod || typeof mod.render !== 'function') throw new Error(tr('panel.scripts.needs_render'));
    const w = mod.watch;
    if (w != null && !Array.isArray(w) && typeof w !== 'string' && typeof w !== 'function') throw new Error(tr('panel.scripts.watch_list'));
    const schema = mod.config && typeof mod.config === 'object' ? mod.config : {};
    for (const [k, f] of Object.entries(schema)) if (!f || !FIELD_TYPES[f.type]) throw new Error(`config.${k}: tipo no válido (${Object.keys(FIELD_TYPES).join(', ')})`);
    /** Con los valores guardados de una burbuja: su config final, su watch y si le afecta un cambio. */
    const bind = (values, ha) => {
      const cfg = resolveConfig(schema, values, ha);
      let list = typeof w === 'function' ? w(cfg, ha) : w;
      list = list == null ? null : [].concat(list).filter(Boolean);
      return { cfg, watch: list, matches: matcher(list) };
    };
    const type = mod.type === 'card' ? 'card' : 'bubble';
    return { config: schema, render: mod.render, bind, type, name: mod.name || null, icon: mod.icon || null,
      width: mod.width || null, children: !!mod.children, refresh: Math.max(0, +mod.refresh || 0), style: typeof mod.style === 'string' ? mod.style : '',
      actions: mod.actions && typeof mod.actions === 'object' ? mod.actions : {} };
  }

  /** Tipos de campo de config (lo que la web pinta en «Ajustes» de cada burbuja). */
  const FIELD_TYPES = { entity: 'web.editor.field_entity', device: 'web.editor.field_device', text: 'web.editor.field_text', number: 'web.editor.field_number', bool: 'web.editor.field_bool', select: 'web.editor.field_select',
    icon: 'web.editor.field_icon', action: 'web.editor.field_action' };
  /** Qué puede hacer un componente al pulsarlo o mantenerlo pulsado. */
  const ACTIONS = { toggle: 'web.editor.action_toggle', 'more-info': 'web.editor.action_more_info', navigate: 'web.editor.action_navigate',
    call: 'web.editor.action_call', none: 'web.editor.action_none' };
  /** Acción normalizada: { action, go, service, data, entity } */
  const actionOf = (v) => (v == null || v === '' ? null : typeof v === 'string' ? { action: v } : v);
  /** ¿El aparato tiene la entidad que pide el campo? has: { key } (translation_key) o { suffix } (final del id) */
  const deviceHas = (f, entities, info) => !f.has || entities.some((id) =>
    (f.has.key && (info(id) || {}).key === f.has.key) || (f.has.suffix && id.endsWith('_' + f.has.suffix)));
  /** Entidades que encajan con un campo entity: su domain y, si lo pone, su device_class. */
  const entityMatch = (f) => (s, id) => (!f.domain || id.startsWith(f.domain + '.')) &&
    (!f.deviceClass || [].concat(f.deviceClass).includes(s && s.attributes && s.attributes.device_class));
  /** Valores de config: los guardados, si no el default y, si es una entidad vacía, la primera que encaje. */
  function resolveConfig(schema, values, ha) {
    const cfg = {};
    for (const [k, f] of Object.entries(schema || {})) {
      let v = values ? values[k] : undefined;
      if (v === '' || v == null || (Array.isArray(v) && !v.length)) v = f.default;
      if (f.type === 'action') v = actionOf(v) || { action: 'none' };
      else if ((f.type === 'entity' || f.type === 'device') && f.auto === false) v = f.multiple ? [].concat(v || []) : v || null;
      else if (f.type === 'entity' || f.type === 'device') {
        const all = () => (!ha ? [] : f.type === 'device' ? ha.devices(f.integration).filter((d) => deviceHas(f, d.entities, ha.info)).map((d) => d.id)
          : ha.find('*', (s, id) => entityMatch(f)(s, id)));
        if (f.multiple) v = v == null ? all() : [].concat(v);
        else if (v == null) v = all()[0] || null;
      } else if (f.type === 'number') v = v == null ? null : Number(v);
      else if (f.type === 'bool') v = !!v;
      else if (v == null) v = f.type === 'select' && f.options ? optValue(f.options[0]) : '';
      cfg[k] = v;
    }
    return cfg;
  }
  const optValue = (o) => (o && typeof o === 'object' ? o.value : o);

  const COLORS = { green: '#81c995', red: '#f28b82', yellow: '#fdd663', blue: '#8ab4f8', orange: '#fcad70', grey: '#98a1ad', gray: '#98a1ad', purple: '#c58af9' };
  const color = (c) => (c ? COLORS[c] || c : null);
  const mdi = (s) => (s ? (String(s).startsWith('mdi-') ? s : 'mdi-' + String(s).replace(/^mdi:/, '')) : null);

  /** Normaliza lo que devuelve una burbuja: siempre una lista de
   *  { icon, text, color, textColor, iconEnd, iconEndColor, progress, go, action, onTap }.
   *  color = color del icono; textColor = del texto; iconEnd = icono al final (badge/badgeColor: nombres antiguos). */
  function bubbles(out) {
    if (out == null || out === false) return [];
    const list = Array.isArray(out) ? out : [out];
    return list.filter(Boolean).map((b) => (typeof b === 'string' ? { text: b } : b)).map((b) => ({
      icon: mdi(b.icon), text: b.text == null ? '' : String(b.text), color: color(b.color), go: b.go || null,
      action: b.action || null, onTap: typeof b.onTap === 'function' ? b.onTap : null,
      progress: b.progress == null || isNaN(+b.progress) ? null : Math.max(0, Math.min(100, +b.progress)),
      textColor: color(b.textColor), iconEnd: mdi(b.iconEnd || b.badge), iconEndColor: color(b.iconEndColor || b.badgeColor),
    }));
  }

  /** Ejemplos para el editor */
  const EXAMPLES = {
    burbuja: `{
  // Entidades que actualizan la burbuja (admite *)
  watch: ['sensor.temperatura_salon'],
  render(ha, screen) {
    const t = ha.num('sensor.temperatura_salon');
    if (isNaN(t)) return null;                 // null = no se muestra
    return {
      icon: 'mdi:thermometer',
      text: 'Salón ' + ha.fmt('sensor.temperatura_salon'),
      color: t > 26 ? 'red' : null,           // color del icono
      textColor: t > 26 ? 'red' : null,       // color del texto
      iconEnd: t > 26 ? 'mdi:alert' : null,    // icono al final
      iconEndColor: 'orange',
      go: 'sensors',                           // al tocarla, a esta pestaña
    };
  },
}`,
    luces: `{
  watch: ['light.*'],
  render(ha, screen) {
    const on = ha.find('light.*', (s) => s.state === 'on');
    if (!on.length) return null;
    return {
      icon: 'mdi:lightbulb-on',
      text: on.length === 1 ? ha.name(on[0]) : on.length + ' luces',
      color: 'yellow',
      // al tocarla las apaga todas (solo aquí se puede mandar algo a Home Assistant)
      onTap: (ha) => ha.call('light.turn_off', { entity_id: on }),
    };
  },
}`,
  };

  /** Scripts de serie (burbujas y componentes). Se pueden editar en la web (se guarda tu versión en la Pi);
   *  con «Restaurar» vuelve el de serie. */
  const DEFAULT_SCRIPTS = {
    'tiempo.js': `{
  // Se eligen en la web: Burbujas → Tiempo → Ajustes
  config: {
    entity: { type: 'entity', domain: 'weather', label: 'Entidad del tiempo' },
    showText: { type: 'bool', label: 'Mostrar la descripción (Despejado, Lluvia…)', default: true },
  },
  watch: (config) => [config.entity],
  render(ha, screen, config) {
    const id = config.entity;
    if (!id || !ha.ok(id)) return null;
    const SKY = {
      'clear-night': ['weather-night', 'Despejado'], cloudy: ['weather-cloudy', 'Nublado'],
      exceptional: ['alert-circle-outline', 'Excepcional'], fog: ['weather-fog', 'Niebla'],
      hail: ['weather-hail', 'Granizo'], lightning: ['weather-lightning', 'Tormenta'],
      'lightning-rainy': ['weather-lightning-rainy', 'Tormenta con lluvia'],
      partlycloudy: ['weather-partly-cloudy', 'Parcialmente nublado'], pouring: ['weather-pouring', 'Lluvia fuerte'],
      rainy: ['weather-rainy', 'Lluvia'], snowy: ['weather-snowy', 'Nieve'], 'snowy-rainy': ['weather-snowy-rainy', 'Aguanieve'],
      sunny: ['weather-sunny', 'Soleado'], windy: ['weather-windy', 'Viento'], 'windy-variant': ['weather-windy-variant', 'Viento y nubes'],
    };
    const [icon, text] = SKY[ha.state(id)] || ['weather-partly-cloudy', ha.state(id)];
    return { icon: 'mdi:' + icon, text: ha.number(ha.attr(id, 'temperature')) + '°' + (config.showText ? ' ' + text : ''), go: 'home' };
  },
}`,
    /* ---------- Componentes (type: 'card'): HTML y CSS. Ver lib/componentes.js ---------- */
    'boton.js': `{
  type: 'card', name: 'Botón', icon: 'mdi:gesture-tap-button', width: '1/4',
  config: {
    entity: { type: 'entity', auto: false, label: 'Entidad' },
    name: { type: 'text', label: 'Nombre', hint: 'Vacío: el de Home Assistant' },
    icon: { type: 'icon', label: 'Icono', hint: 'Vacío: el de la entidad' },
    showState: { type: 'bool', label: 'Mostrar el estado', default: true },
    tap: { type: 'action', label: 'Al pulsar', default: 'toggle' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'more-info' },
  },
  watch: (config) => [config.entity],
  style: \`
    .btn { width: 100%; display: flex; align-items: center; gap: 12px; min-height: 72px; padding: 12px 14px;
      border-radius: 20px; background: var(--surface); transition: background-color .2s, transform .1s; }
    .btn:active { transform: scale(.97); }
    .ic { flex: none; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
      font-size: 24px; background: var(--surface-2); }
    .txt { min-width: 0; }
    .name, .state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name { font-weight: 600; }
    .state { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .on { background: var(--on-default); color: var(--on-default-ink); }
    .on .ic { background: rgba(255, 255, 255, .45); }
    .on .state { color: inherit; opacity: .75; }
    .off { opacity: .45; }
  \`,
  render(ha, screen, config, html) {
    const id = config.entity;
    if (!id) return html\`<div class="hint">Elige una entidad</div>\`;
    const on = ha.active(id), c = on ? ha.color(id) : null;   // luz encendida: su color real
    return html\`
      <button class="btn \${on ? 'on' : ''} \${ha.ok(id) ? '' : 'off'}" style=\${c ? \`background:\${c.bg};color:\${c.ink}\` : ''}
        tap=\${config.tap} hold=\${config.hold} entity=\${id}>
        <span class="ic"><ha-icon icon=\${config.icon || ha.icon(id)}></ha-icon></span>
        <span class="txt">
          <div class="name">\${config.name || ha.name(id)}</div>
          \${config.showState ? html\`<div class="state">\${ha.text(id)}</div>\` : ''}
        </span>
      </button>\`;
  },
}`,
    'informacion.js': `{
  type: 'card', name: 'Información', icon: 'mdi:information-outline', width: '1/4',
  config: {
    entity: { type: 'entity', auto: false, label: 'Entidad' },
    name: { type: 'text', label: 'Nombre', hint: 'Vacío: el de Home Assistant' },
    icon: { type: 'icon', label: 'Icono', hint: 'Vacío: el de la entidad' },
    tap: { type: 'action', label: 'Al pulsar', default: 'more-info' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'none' },
  },
  watch: (config) => [config.entity],
  style: \`
    .box { width: 100%; display: block; background: var(--surface); border-radius: 16px; padding: 12px 14px; }
    .mdi { color: var(--accent); font-size: 18px; }
    .value { font-size: 20px; font-weight: 600; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .label { font-size: 12px; color: var(--muted); }
  \`,
  render(ha, screen, config, html) {
    const id = config.entity;
    if (!id) return html\`<div class="hint">Elige una entidad</div>\`;
    return html\`
      <button class="box" tap=\${config.tap} hold=\${config.hold} entity=\${id}>
        <ha-icon icon=\${config.icon || ha.icon(id)}></ha-icon>
        <div class="value">\${ha.text(id)}</div>
        <div class="label">\${config.name || ha.name(id)}</div>
      </button>\`;
  },
}`,
    'lista.js': `{
  type: 'card', name: 'Lista', icon: 'mdi:format-list-bulleted', width: '1/2',
  config: {
    title: { type: 'text', label: 'Título' },
    entities: { type: 'entity', multiple: true, auto: false, label: 'Entidades' },
    tap: { type: 'action', label: 'Al pulsar una fila', default: 'more-info' },
    hold: { type: 'action', label: 'Al mantener pulsada', default: 'none' },
  },
  watch: (config) => config.entities,
  style: \`
    .title { font-weight: 600; font-size: 16px; margin-bottom: 6px; }
    .row { width: 100%; display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 8px;
      padding: 9px 2px; border-top: 1px solid rgba(255, 255, 255, .06); }
    .row:first-of-type { border-top: 0; }
    .row .mdi { font-size: 20px; color: var(--muted); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .value { font-weight: 600; }
  \`,
  render(ha, screen, config, html) {
    if (!config.entities.length) return html\`<div class="hint">Elige alguna entidad</div>\`;
    return html\`
      <div class="card">
        \${config.title ? html\`<div class="title">\${config.title}</div>\` : ''}
        \${config.entities.map((id) => html\`
          <button class="row" tap=\${config.tap} hold=\${config.hold} entity=\${id}>
            <ha-icon icon=\${ha.icon(id)}></ha-icon>
            <span class="name">\${ha.name(id)}</span>
            <span class="value">\${ha.text(id)}</span>
          </button>\`)}
      </div>\`;
  },
}`,
    'tarjeta.js': `{
  // Agrupa otros componentes: se colocan dentro desde el editor de pantallas y van donde está <slot>
  type: 'card', name: 'Tarjeta', icon: 'mdi:card-outline', width: 'full', children: true,
  config: {
    title: { type: 'text', label: 'Título' },
  },
  watch: [],
  style: \`
    .title { font-weight: 600; font-size: 16px; margin-bottom: 10px; }
    /* lo de dentro, un tono más claro: sus colores de fondo pasan a ser los siguientes */
    .card .cmp { --surface: var(--surface-2); }
    .card .cmp > * { --surface-2: var(--surface-3); }
  \`,
  render(ha, screen, config, html) {
    return html\`
      <div class="card">
        \${config.title ? html\`<div class="title">\${config.title}</div>\` : ''}
        <slot></slot>
      </div>\`;
  },
}`,
    'tarjeta-tiempo.js': `{
  type: 'card', name: 'Tiempo', icon: 'mdi:weather-partly-cloudy', width: '1/2',
  config: {
    entity: { type: 'entity', domain: 'weather', label: 'Entidad del tiempo' },
    days: { type: 'number', label: 'Días de previsión (0 = ninguno)', default: 5, min: 0, max: 7 },
    tap: { type: 'action', label: 'Al pulsar', default: 'none' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'more-info' },
  },
  watch: (config) => [config.entity],
  style: \`
    .w { width: 100%; display: flex; flex-direction: column; gap: 14px; }
    .now { display: flex; align-items: center; gap: 16px; }
    .big { font-size: 58px; color: #ffd27a; }
    .temp { font-size: 40px; font-weight: 600; line-height: 1; }
    .cond { font-size: 16px; margin-top: 4px; }
    .extra { font-size: 13px; color: var(--muted); }
    .fc { display: flex; justify-content: space-between; gap: 4px; }
    .day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 13px; }
    .day .mdi { font-size: 24px; color: #ffd27a; }
    .dn { color: var(--muted); text-transform: capitalize; }
    .t { font-weight: 600; }
    .low { color: var(--muted); }
    .rain { color: var(--accent); font-size: 12px; min-height: 17px; }
    .rain .mdi { font-size: 13px; color: var(--accent); }
  \`,
  render(ha, screen, config, html) {
    const id = config.entity;
    if (!id || !ha.ok(id)) return html\`<div class="hint">Elige una entidad del tiempo</div>\`;
    const SKY = {
      'clear-night': ['weather-night', 'Despejado'], cloudy: ['weather-cloudy', 'Nublado'], exceptional: ['alert-circle-outline', 'Excepcional'],
      fog: ['weather-fog', 'Niebla'], hail: ['weather-hail', 'Granizo'], lightning: ['weather-lightning', 'Tormenta'],
      'lightning-rainy': ['weather-lightning-rainy', 'Tormenta con lluvia'], partlycloudy: ['weather-partly-cloudy', 'Parcialmente nublado'],
      pouring: ['weather-pouring', 'Lluvia fuerte'], rainy: ['weather-rainy', 'Lluvia'], snowy: ['weather-snowy', 'Nieve'],
      'snowy-rainy': ['weather-snowy-rainy', 'Aguanieve'], sunny: ['weather-sunny', 'Soleado'], windy: ['weather-windy', 'Viento'],
      'windy-variant': ['weather-windy-variant', 'Viento y nubes'],
    };
    const sky = (c) => SKY[c] || ['weather-partly-cloudy', c || ''];
    const a = (k) => ha.attr(id, k);
    const extra = [a('humidity') != null ? 'Humedad ' + ha.number(a('humidity')) + ' %' : '',
      a('wind_speed') != null ? 'Viento ' + ha.number(a('wind_speed')) + ' ' + (a('wind_speed_unit') || '') : ''].filter(Boolean).join(' · ');
    // ha.forecast(id): previsión diaria (la pide el panel a Home Assistant y la guarda media hora)
    const days = ha.forecast(id).slice(0, config.days);
    return html\`
      <button class="card w" tap=\${config.tap} hold=\${config.hold} entity=\${id}>
        <div class="now">
          <ha-icon class="big" icon=\${'mdi:' + sky(ha.state(id))[0]}></ha-icon>
          <div>
            <div class="temp">\${ha.number(a('temperature'))}°</div>
            <div class="cond">\${sky(ha.state(id))[1]}</div>
            <div class="extra">\${extra}</div>
          </div>
        </div>
        \${days.length ? html\`<div class="fc">\${days.map((d) => html\`
          <div class="day">
            <div class="dn">\${new Date(d.datetime).toLocaleDateString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { weekday: 'short' }).replace('.', '')}</div>
            <ha-icon icon=\${'mdi:' + sky(d.condition)[0]}></ha-icon>
            <div class="t">\${ha.number(d.temperature)}°</div>
            <div class="rain">\${d.precipitation_probability != null ? html\`<ha-icon icon="mdi:water"></ha-icon>\${d.precipitation_probability}%\` : ''}</div>
            \${d.templow != null ? html\`<div class="low">\${ha.number(d.templow)}°</div>\` : ''}
          </div>\`)}</div>\` : ''}
      </button>\`;
  },
}`,
    'tarjeta-vehiculo.js': `{
  // Vehículo eléctrico (patinete, coche, moto…). Sin batería elegida: el patinete de mi_scooter_ble
  type: 'card', name: 'Vehículo', icon: 'mdi:car-electric', width: '1/2',
  config: {
    name: { type: 'text', label: 'Nombre', hint: 'Vacío: el del aparato' },
    kind: { type: 'select', label: 'Icono', default: 'scooter', options: [
      { value: 'scooter', label: 'Patinete' }, { value: 'car-electric', label: 'Coche' },
      { value: 'motorbike-electric', label: 'Moto' }, { value: 'bicycle-electric', label: 'Bici' }] },
    battery: { type: 'entity', domain: 'sensor', deviceClass: 'battery', auto: false, label: 'Batería', hint: 'Vacío: el patinete Xiaomi si lo hay' },
    charging: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargando' },
    charged: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargado' },
    range: { type: 'entity', domain: 'sensor', auto: false, label: 'Autonomía' },
    status: { type: 'entity', auto: false, label: 'Estado', hint: 'Por ejemplo, aparcado o en marcha' },
    tap: { type: 'action', label: 'Al pulsar', default: 'more-info' },
    hold: { type: 'action', label: 'Al mantener pulsado', default: 'none' },
  },
  watch: null,   // cualquier cambio (las entidades del patinete se buscan solas)
  style: \`
    .veh { width: 100%; display: flex; align-items: center; gap: 16px; }
    .ring { position: relative; flex: none; width: 92px; height: 92px; }
    svg { width: 100%; height: 100%; display: block; transform: rotate(-90deg); }
    circle { fill: none; stroke-width: 10; }
    .bg { stroke: var(--surface-3); }
    .fg { stroke: var(--ok); stroke-linecap: round; transition: stroke-dashoffset .6s; }
    .fg.mid { stroke: #fdd663; } .fg.low { stroke: var(--danger); } .fg.charging { stroke: var(--accent); }
    .pct { position: absolute; inset: 0; display: grid; place-items: center; font-size: 22px; font-weight: 700; }
    .bolt { position: absolute; inset: 0; display: grid; place-items: center; font-size: 66px; color: var(--accent); opacity: .25; }
    .bolt.charged { color: var(--ok); }
    .title { font-size: 18px; font-weight: 600; }
    .title .mdi { color: var(--muted); margin-right: 6px; }
    .sub { color: var(--muted); margin-top: 4px; }
  \`,
  render(ha, screen, config, html) {
    let e = { battery: config.battery, charging: config.charging, charged: config.charged, range: config.range, status: config.status }, x = null;
    if (!e.battery) {
      const d = ha.devices('mi_scooter_ble')[0];
      if (d) {
        x = {};
        for (const id of d.entities) if (ha.info(id).key) x[ha.info(id).key] = id;
        e = { battery: x.battery_level, charging: x.charging_any, charged: x.charged, range: x.remaining_range };
      }
    }
    if (!e.battery || !ha.ok(e.battery)) return html\`<div class="hint">Elige la entidad de la batería</div>\`;
    const pct = Math.max(0, Math.min(100, ha.num(e.battery) || 0));
    const mode = ha.isOn(e.charged) ? 'charged' : ha.isOn(e.charging) ? 'charging' : null;
    let status = mode === 'charged' ? 'Carga completa' : mode === 'charging' ? 'Cargando' : e.status ? ha.text(e.status) : '';
    if (x && !mode) status = ha.isOn(x.riding) ? 'En marcha' : ha.isOn(x.powered_on) ? 'Encendido'
      : x.in_range && !ha.isOn(x.in_range) ? 'Fuera de alcance' : 'Aparcado';
    if (mode === 'charging' && x && ha.num(x.power) > 0) status += ' · ' + ha.number(ha.num(x.power)) + ' W';
    const range = ha.num(e.range), C = 2 * Math.PI * 52;
    const color = mode || (pct < 20 ? 'low' : pct < 45 ? 'mid' : '');
    return html\`
      <button class="card veh" tap=\${config.tap} hold=\${config.hold} entity=\${e.battery}>
        <div class="ring">
          <svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="52"></circle>
            <circle class="fg \${color}" cx="60" cy="60" r="52" stroke-dasharray=\${C} stroke-dashoffset=\${C * (1 - pct / 100)}></circle></svg>
          <div class="pct">\${Math.round(pct)}%</div>
          \${mode ? html\`<ha-icon class="bolt \${mode}" icon="mdi:lightning-bolt"></ha-icon>\` : ''}
        </div>
        <div>
          <div class="title"><ha-icon icon=\${'mdi:' + config.kind}></ha-icon>\${config.name || ha.info(e.battery).device || 'Vehículo'}</div>
          <div class="sub">\${[status, isNaN(range) ? '' : '≈ ' + ha.number(range) + ' km'].filter(Boolean).join(' · ')}</div>
        </div>
      </button>\`;
  },
}`,
    'saludo.js': `{
  // Saludo y fecha, como al principio de Inicio. Se repinta cada minuto (refresh)
  type: 'card', name: 'Saludo y fecha', icon: 'mdi:hand-wave-outline', width: 'full', refresh: 60,
  config: {
    name: { type: 'text', label: 'Nombre', hint: 'Opcional: «Buenos días, Adrián»' },
    showDate: { type: 'bool', label: 'Mostrar la fecha', default: true },
    showTime: { type: 'bool', label: 'Mostrar la hora', default: false },
    size: { type: 'select', label: 'Tamaño', default: 'normal', options: [
      { value: 'small', label: 'Pequeño' }, { value: 'normal', label: 'Normal' }, { value: 'big', label: 'Grande' }] },
    tap: { type: 'action', label: 'Al pulsar', default: 'none' },
  },
  watch: [],
  style: \`
    .hello { font-size: 28px; font-weight: 600; margin: 4px 4px 2px; }
    .date { color: var(--muted); margin: 0 4px; }
    .date::first-letter { text-transform: uppercase; }
    .small .hello { font-size: 20px; }
    .big .hello { font-size: 40px; }
    .big .date { font-size: 18px; }
    .time { font-variant-numeric: tabular-nums; }
    @media (max-width: 560px) { .hello { font-size: 22px; } }
  \`,
  render(ha, screen, config, html) {
    const now = screen.now(), hr = now.getHours();
    const hello = hr < 6 ? 'Buenas noches' : hr < 13 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
    const date = now.toLocaleDateString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { weekday: 'long', day: 'numeric', month: 'long' });
    const time = now.toLocaleTimeString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { hour: '2-digit', minute: '2-digit' });
    return html\`
      <div class="\${config.size}" tap=\${config.tap}>
        <div class="hello">\${hello}\${config.name ? ', ' + config.name : ''}</div>
        \${config.showDate || config.showTime ? html\`<div class="date">\${config.showDate ? date : ''}\${config.showDate && config.showTime ? ' · ' : ''}\${config.showTime ? html\`<span class="time">\${time}</span>\` : ''}</div>\` : ''}
      </div>\`;
  },
}`,
    'escenas.js': `{
  // Escenas y scripts para lanzar con un toque
  type: 'card', name: 'Escenas', icon: 'mdi:palette-outline', width: 'full',
  config: {
    title: { type: 'text', label: 'Título', default: 'Escenas' },
    entities: { type: 'entity', multiple: true, auto: false, label: 'Escenas y scripts', hint: 'Vacío: todas las escenas y scripts' },
  },
  watch: [],
  style: \`
    .area { font-size: 15px; font-weight: 600; color: var(--muted); margin: 4px 4px 10px; }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
    .chips::-webkit-scrollbar { height: 0; }
    .chip { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
      background: var(--surface); font-weight: 500; }
    .chip .mdi { font-size: 20px; color: var(--accent); }
    .chip:active { background: var(--surface-3); }
  \`,
  render(ha, screen, config, html) {
    const ids = config.entities.length ? config.entities : ha.find(['scene.*', 'script.*']).filter(screen.visible);
    if (!ids.length) return null;
    return html\`
      \${config.title ? html\`<div class="area">\${config.title}</div>\` : ''}
      <div class="chips">\${ids.map((id) => html\`
        <button class="chip" tap="toggle" hold="more-info" entity=\${id}><ha-icon icon=\${ha.icon(id)}></ha-icon>\${ha.name(id)}</button>\`)}</div>\`;
  },
}`,
    'impresora.js': `{
  // Una impresora 3D (Bambu Lab o Klipper): cámara, progreso, temperaturas y botones.
  // ha.printers() da cada impresora con sus entidades (e.status, e.progress, e.camera, e.pause…) y sus boquillas
  type: 'card', name: 'Impresora', icon: 'mdi:printer-3d', width: 'full',
  config: {
    device: { type: 'device', integration: ['bambu_lab', 'moonraker'], has: { key: 'print_status', suffix: 'current_print_state' }, label: 'Impresora' },
    mini: { type: 'bool', label: 'Tarjeta pequeña', default: false },
    main: { type: 'select', label: 'Imagen grande', default: 'camera', options: [
      { value: 'camera', label: 'Cámara' }, { value: 'screen', label: 'Pantalla de la impresora' }, { value: 'cover', label: 'Imagen del trabajo' }] },
    thumb: { type: 'bool', label: 'Miniatura del trabajo en la esquina', default: true },
    camera: { type: 'entity', auto: false, label: 'Cámara (otra)', hint: 'Una cámara o imagen; o un sensor / input_text cuyo estado sea la dirección. Vacío: la de la impresora' },
    cameraUrl: { type: 'text', label: '…o dirección de la cámara', hint: 'Mejor una imagen (p. ej. …/webcam/snapshot.jpg, se refresca sola); si es una página (el reproductor), se mete tal cual' },
    cover: { type: 'entity', auto: false, label: 'Imagen del trabajo (otra)', hint: 'Igual que la cámara. Vacío: la de la impresora' },
    coverUrl: { type: 'text', label: '…o dirección de la imagen del trabajo' },
    plug: { type: 'entity', domain: 'switch', auto: false, label: 'Enchufe', hint: 'Vacío: el que encuentra solo (si lo hay)' },
    plugPower: { type: 'entity', domain: 'sensor', deviceClass: 'power', auto: false, label: 'Consumo del enchufe', hint: 'Vacío: el del enchufe (si lo hay)' },
    light: { type: 'entity', domain: 'light', auto: false, label: 'Luz', hint: 'Vacío: la de la impresora (si la tiene)' },
    tap: { type: 'action', label: 'Al pulsar (tarjeta pequeña)', default: { action: 'navigate', go: 'printers' } },
  },
  watch: (config, ha) => {
    const p = ha.printers().find((x) => x.device === config.device);
    return p ? Object.values(p.e).concat(p.nozzles.flatMap((n) => [n.cur, n.tgt, n.fil]), [config.plug, config.plugPower, config.light]).filter(Boolean) : [];
  },
  refresh: 60,   // la hora de fin
  style: \`
    .pr { display: grid; grid-template-columns: 320px 1fr; gap: 16px; }
    @media (max-width: 760px) { .pr { grid-template-columns: 1fr; } }
    .img { position: relative; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; display: grid; place-items: center; }
    .img > .mdi { font-size: 56px; color: var(--surface-3); }
    .img img, .img .cam { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .img .cam-label { display: none; }
    .img .thumb { position: absolute; inset: auto 8px 8px auto; width: 32%; height: auto; aspect-ratio: 1; object-fit: cover;
      border-radius: 10px; border: 2px solid rgba(0, 0, 0, .45); background: #000; }
    .info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .head { display: flex; align-items: center; gap: 10px; }
    .name { font-size: 18px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
    .st.printing, .st.preparing { background: #1d3354; color: var(--accent); }
    .st.paused { background: #3b3214; color: #fdd663; }
    .st.finished { background: #1f3b2a; color: var(--ok); }
    .st.error { background: #3a1f1d; color: var(--danger); }
    .job { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info:has(.st.offline) .job { white-space: normal; }
    .prog { display: flex; align-items: center; gap: 10px; }
    .bar { flex: 1; height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
    .bar > div { height: 100%; background: var(--accent); border-radius: 4px; transition: width .6s; }
    .pct { font-weight: 600; min-width: 44px; text-align: right; }
    .muted { color: var(--muted); } .small { font-size: 13px; }
    .temps { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .temp { display: flex; align-items: center; gap: 8px; background: var(--surface-2); border-radius: 12px; padding: 8px 10px; }
    .temp .mdi { color: var(--muted); font-size: 20px; }
    .temp.heating .mdi { color: #fcad70; }
    .temp b { display: block; font-size: 14px; } .temp small { color: var(--muted); font-size: 11px; }
    .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .btn { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: 14px; background: var(--surface-2); font-weight: 600; }
    .btn:active { background: var(--surface-3); }
    .btn.on { background: var(--on-light); color: var(--on-light-ink); }
    .btn.go { background: #1f3b2a; color: var(--ok); }
    .btn.danger { background: #3a1f1d; color: var(--danger); }
    .mini { display: flex; align-items: center; gap: 16px; }
    .ring { position: relative; flex: none; width: 92px; height: 92px; }
    svg { width: 100%; height: 100%; display: block; transform: rotate(-90deg); }
    circle { fill: none; stroke-width: 10; }
    .rbg { stroke: var(--surface-3); } .rfg { stroke: var(--accent); stroke-linecap: round; }
    .rpct { position: absolute; inset: 0; display: grid; place-items: center; font-size: 22px; font-weight: 700; }
    .mini .name { font-size: 17px; } .line { color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  \`,
  render(ha, screen, config, html) {
    const LABEL = { printing: 'Imprimiendo', paused: 'En pausa', preparing: 'Preparando', finished: 'Terminada', error: 'Error',
      cancelled: 'Cancelada', idle: 'Lista', offline: 'Desconectada', off: 'Apagada' };
    const found = ha.printers().find((x) => x.device === config.device);
    if (!found) return html\`<div class="hint">Elige una impresora</div>\`;
    // Lo elegido a mano manda sobre lo detectado. Lo que no tenga (enchufe, luz, cámara…) no sale
    const p = Object.assign({}, found, { e: Object.assign({}, found.e,
      config.plug ? { plug: config.plug, plugPower: config.plugPower || (config.plug === found.e.plug ? found.e.plugPower : null) } : {},
      config.plugPower ? { plugPower: config.plugPower } : {},
      config.light ? { light: config.light } : {}) });
    const job = () => { for (const k of ['job', 'file']) { const s = ha.state(p.e[k]); if (s && !['unknown', 'unavailable'].includes(s)) return s.replace(/(\\.gcode)?(\\.3mf)?$/i, ''); } return ''; };
    const left = () => { const u = ha.attr(p.e.remaining, 'unit_of_measurement'), n = ha.num(p.e.remaining); return n * (u === 'h' ? 3600 : u === 'min' ? 60 : u === 'd' ? 86400 : 1); };
    const timeLine = () => {
      const r = left();
      if (!p.active || !(r > 0)) return '';
      return 'Quedan ' + ha.duration(r) + ' · termina a las ' + new Date(screen.now().getTime() + r * 1000).toLocaleTimeString((typeof I18N !== 'undefined' ? I18N.locale() : 'es-ES'), { hour: '2-digit', minute: '2-digit' });
    };
    const temp = (ic, label, cur, tgt) => {
      const c = ha.num(cur), t = ha.num(tgt);
      if (isNaN(c)) return '';
      return html\`<div class="temp \${t > 0 ? 'heating' : ''}"><ha-icon icon=\${ic}></ha-icon><div><b>\${ha.number(c)}°\${t > 0 ? ' / ' + ha.number(t) + '°' : ''}</b><small>\${label}</small></div></div>\`;
    };
    const s = config.plug && ha.state(config.plug) === 'off' ? 'off' : p.state, prog = ha.num(p.e.progress);   // enchufe apagado = apagada
    if (config.mini) {
      const C = 2 * Math.PI * 52;
      return html\`
        <button class="card mini" tap=\${config.tap}>
          <div class="ring"><svg viewBox="0 0 120 120"><circle class="rbg" cx="60" cy="60" r="52"></circle>
            <circle class="rfg" cx="60" cy="60" r="52" stroke-dasharray=\${C} stroke-dashoffset=\${C * (1 - (isNaN(prog) ? 0 : prog) / 100)}></circle></svg>
            <div class="rpct">\${isNaN(prog) ? '—' : Math.round(prog) + '%'}</div></div>
          <div style="min-width:0"><div class="name">\${p.name}</div>
            <div class="line">\${LABEL[s]}\${job() ? ' · ' + job() : ''}</div><div class="line">\${timeLine()}</div></div>
        </button>\`;
    }
    const showProg = p.active || (s === 'finished' && prog > 0), L = ha.num(p.e.layer), LL = ha.num(p.e.layers), pw = ha.num(p.e.plugPower);
    const off = s === 'off' || s === 'offline';
    // Cámara e imagen: la elegida (entidad o dirección) o la que trae la impresora.
    // Una entidad que no es cámara ni imagen: su estado es la dirección
    const pick = (ent, url, own) => {
      if (url) return { url };
      const id = ent || own;
      if (!id) return {};
      const d = id.split('.')[0];
      if (d === 'camera' || d === 'image') return { entity: id, url: ha.picture(id) };
      const st = ha.state(id);
      return st && (st.startsWith('http') || st.startsWith('/')) ? { url: st } : {};
    };
    const cam = pick(config.camera, config.cameraUrl, p.e.camera), cov = pick(config.cover, config.coverUrl, p.e.cover), cover = cov.url;
    const scr = pick(null, null, p.e.screen);
    // La imagen grande: la elegida si está; si no, cámara → pantalla → imagen del trabajo
    const order = { camera: [cam, scr, cov], screen: [scr, cam, cov], cover: [cov, cam, scr] }[config.main] || [cam, scr, cov];
    // Enchufe apagado: la imagen del trabajo. Si no, la primera que haya de verdad (una cámara de HA no disponible se salta;
    // una dirección puesta a mano se intenta siempre, aunque HA no tenga datos de la impresora)
    const big = s === 'off' ? (cover ? cov : {}) : order.find((x) => x.url) || {};
    const live = (x) => (x.entity && x.entity.startsWith('camera.') ? html\`<ha-camera entity=\${x.entity}></ha-camera>\` : html\`<ha-camera src=\${x.url}></ha-camera>\`);
    return html\`
      <div class="card pr">
        <div class="img" tap=\${big.entity && big.entity.startsWith('camera.') ? 'more-info' : 'none'} entity=\${big.entity}>
          \${big === cov && cover ? html\`<img src=\${cover} alt="" onerror="this.remove()">\` : big.entity || big.url ? live(big) : html\`<ha-icon icon="mdi:printer-3d"></ha-icon>\`}
          \${config.thumb && cover && big !== cov ? html\`<img class="thumb" src=\${cover} alt="" onerror="this.remove()">\` : ''}
        </div>
        <div class="info">
          <div class="head"><div class="name">\${p.name}</div><span class="st \${s}">\${LABEL[s]}</span></div>
          <div class="job">\${s === 'offline' ? 'Home Assistant no tiene datos de la impresora: está apagada, arrancando o sin red'
            : job() || (p.active ? 'Trabajo sin nombre' : 'Sin trabajos en curso')}</div>
          \${showProg ? html\`<div class="prog"><div class="bar"><div style=\${'width:' + (isNaN(prog) ? 0 : prog) + '%'}></div></div>
            <div class="pct">\${isNaN(prog) ? '' : Math.round(prog) + ' %'}</div></div>\` : ''}
          <div class="muted">\${timeLine()}</div>
          \${p.active && LL > 0 ? html\`<div class="muted small">Capa \${L} de \${LL}</div>\` : ''}
          <div class="temps">
            \${p.nozzles.map((n) => temp('mdi:printer-3d-nozzle', n.label, n.cur, n.tgt))}
            \${temp('mdi:radiator', 'Cama', p.e.bed, p.e.bedTarget)}\${temp('mdi:thermometer', 'Cámara', p.e.chamber)}
            \${isNaN(pw) ? '' : html\`<div class="temp"><ha-icon icon="mdi:flash"></ha-icon><div><b>\${ha.number(pw)} W</b><small>Consumo</small></div></div>\`}
          </div>
          <div class="btns">
            \${s === 'printing' && p.e.pause ? html\`<button class="btn" tap=\${(ha) => ha.call('button.press', { entity_id: p.e.pause })}><ha-icon icon="mdi:pause"></ha-icon>Pausar</button>\` : ''}
            \${s === 'paused' && p.e.resume ? html\`<button class="btn" tap=\${(ha) => ha.call('button.press', { entity_id: p.e.resume })}><ha-icon icon="mdi:play"></ha-icon>Continuar</button>\` : ''}
            \${p.active && p.e.stop ? html\`<button class="btn danger" hold=\${(ha) => ha.call('button.press', { entity_id: p.e.stop })}><ha-icon icon="mdi:stop"></ha-icon>Mantén para cancelar</button>\` : ''}
            \${p.e.light && !off ? html\`<button class="btn \${ha.isOn(p.e.light) ? 'on' : ''}" tap="toggle" entity=\${p.e.light}><ha-icon icon=\${ha.isOn(p.e.light) ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline'}></ha-icon>Luz</button>\` : ''}
            \${p.e.plug ? (ha.isOn(p.e.plug)
              ? html\`<button class="btn danger" hold=\${(ha) => ha.call('switch.turn_off', { entity_id: p.e.plug })}><ha-icon icon="mdi:power-plug-off"></ha-icon>Mantén para apagar</button>\`
              : html\`<button class="btn go" tap=\${(ha) => ha.call('switch.turn_on', { entity_id: p.e.plug })}><ha-icon icon="mdi:power-plug"></ha-icon>Encender</button>\`) : ''}
          </div>
        </div>
      </div>\`;
  },
}`,
    'reproductor.js': `{
  // Un reproductor: carátula, título, controles y volumen
  type: 'card', name: 'Reproductor', icon: 'mdi:play-circle-outline', width: '1/2',
  config: {
    entity: { type: 'entity', domain: 'media_player', label: 'Reproductor' },
    volume: { type: 'bool', label: 'Mostrar el volumen', default: true },
    hold: { type: 'action', label: 'Al mantener la carátula', default: 'more-info' },
  },
  watch: (config) => [config.entity],
  style: \`
    .mc { display: flex; gap: 16px; align-items: center; background: var(--surface); border-radius: 20px; padding: 14px; }
    .mc.off { opacity: .55; }
    .art { flex: none; width: 120px; height: 120px; border-radius: 14px; background: var(--surface-3) center / cover no-repeat;
      display: grid; place-items: center; font-size: 46px; color: var(--muted); }
    .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .name { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
    .t { font-size: 18px; font-weight: 600; }
    .t, .sub, .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--muted); }
    .ctrls { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .rb { width: 44px; height: 44px; border-radius: 50%; background: var(--surface-2); display: grid; place-items: center; font-size: 24px; }
    .rb.big { width: 54px; height: 54px; background: var(--accent); color: #0b1d3a; font-size: 30px; }
    .rb.full { margin-left: auto; background: none; color: var(--muted); }
    .rb:active { transform: scale(.94); }
    .vol { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .vol input { flex: 1; accent-color: var(--accent); }
  \`,
  render(ha, screen, config, html) {
    const id = config.entity;
    if (!id || !ha.entity(id)) return html\`<div class="hint">Elige un reproductor</div>\`;
    const st = ha.state(id), a = (k) => ha.attr(id, k), pic = ha.picture(id);
    const sub = [a('media_artist'), a('media_album_name')].filter(Boolean).join(' · ') || a('app_name') || a('source') || '';
    const vol = Math.round((a('volume_level') || 0) * 100);
    const svc = (service) => (ha) => ha.call('media_player.' + service, { entity_id: id });
    return html\`
      <div class="mc \${['off', 'unavailable', 'standby'].includes(st) ? 'off' : ''}">
        <div class="art" style=\${pic ? 'background-image:url("' + pic + '")' : ''} hold=\${config.hold} entity=\${id}>\${pic ? '' : html\`<ha-icon icon="mdi:music"></ha-icon>\`}</div>
        <div class="info">
          <div class="name">\${ha.name(id)}</div>
          <div class="t">\${a('media_title') || ha.text(id)}</div>
          <div class="sub">\${sub}</div>
          <div class="ctrls">
            <button class="rb" tap=\${svc('media_previous_track')}><ha-icon icon="mdi:skip-previous"></ha-icon></button>
            <button class="rb big" tap=\${svc('media_play_pause')}><ha-icon icon=\${st === 'playing' ? 'mdi:pause' : 'mdi:play'}></ha-icon></button>
            <button class="rb" tap=\${svc('media_next_track')}><ha-icon icon="mdi:skip-next"></ha-icon></button>
            <button class="rb" tap=\${svc('toggle')}><ha-icon icon="mdi:power"></ha-icon></button>
            <button class="rb full" tap=\${(ha, screen) => screen.nowPlaying(id)}><ha-icon icon="mdi:fullscreen"></ha-icon></button>
          </div>
          \${config.volume ? html\`<label class="vol"><ha-icon icon="mdi:volume-high"></ha-icon>
            <input type="range" min="0" max="100" value=\${vol} change=\${(ha, screen, v) => ha.call('media_player.volume_set', { entity_id: id, volume_level: v / 100 })}>
            <span>\${vol} %</span></label>\` : ''}
        </div>
      </div>\`;
  },
}`,
    'camara.js': `{
  // La imagen de una cámara, que se refresca sola. <ha-camera> es la imagen del panel
  type: 'card', name: 'Cámara', icon: 'mdi:cctv', width: '1/2',
  config: {
    entity: { type: 'entity', domain: 'camera', label: 'Cámara' },
    tap: { type: 'action', label: 'Al pulsar', default: 'more-info' },
  },
  watch: [],
  render(ha, screen, config, html) {
    if (!config.entity) return html\`<div class="hint">Elige una cámara</div>\`;
    return html\`<div tap=\${config.tap} entity=\${config.entity}><ha-camera entity=\${config.entity}></ha-camera></div>\`;
  },
}`,
    'deslizador.js': `{
  // Deslizador para un número (number, input_number) o el brillo de una luz
  type: 'card', name: 'Deslizador', icon: 'mdi:tune-variant', width: 'full',
  config: {
    entity: { type: 'entity', auto: false, label: 'Entidad', hint: 'number, input_number o light' },
    name: { type: 'text', label: 'Nombre', hint: 'Vacío: el de Home Assistant' },
    unit: { type: 'text', label: 'Unidad', hint: 'Vacío: la de la entidad' },
  },
  watch: (config) => [config.entity],
  style: \`
    .sl { display: flex; flex-direction: column; gap: 8px; }
    .head { display: flex; justify-content: space-between; color: var(--muted); }
    .head b { color: var(--text); }
    input { width: 100%; accent-color: var(--accent); height: 28px; }
  \`,
  render(ha, screen, config, html) {
    const id = config.entity;
    if (!id || !ha.entity(id)) return html\`<div class="hint">Elige una entidad</div>\`;
    const dom = id.split('.')[0], light = dom === 'light';
    const v = light ? Math.round((ha.attr(id, 'brightness') || 0) / 2.55) : ha.num(id);
    const min = light ? 1 : ha.attr(id, 'min') ?? 0, max = light ? 100 : ha.attr(id, 'max') ?? 100, step = light ? 1 : ha.attr(id, 'step') ?? 1;
    const unit = config.unit || (light ? '%' : ha.attr(id, 'unit_of_measurement') || '');
    const set = (ha, screen, val) => (light ? ha.call('light.turn_on', { entity_id: id, brightness_pct: +val })
      : ha.call(dom + '.set_value', { entity_id: id, value: +val }));
    return html\`
      <label class="card sl">
        <span class="head"><span>\${config.name || ha.name(id)}</span><b>\${isNaN(v) ? '—' : ha.number(v) + (unit ? ' ' + unit : '')}</b></span>
        <input type="range" min=\${min} max=\${max} step=\${step} value=\${isNaN(v) ? min : v} change=\${set}>
      </label>\`;
  },
}`,
    'resumen-ejemplo.js': `{
  // Ejemplo: varias cosas en una tarjeta, con un botón que hace algo propio (actions)
  type: 'card', name: 'Resumen (ejemplo)', icon: 'mdi:star-outline', width: 'full',
  config: {
    title: { type: 'text', label: 'Título', default: 'Resumen' },
    sensors: { type: 'entity', domain: 'sensor', deviceClass: 'temperature', multiple: true, label: 'Temperaturas' },
  },
  watch: (config) => config.sensors.concat(['light.*']),
  style: \`
    h3 { margin: 0 0 12px; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
    .stat { background: var(--surface-2); border-radius: 16px; padding: 12px 14px; }
    .stat b { display: block; font-size: 20px; margin-top: 4px; }
    .stat small { color: var(--muted); }
    .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; color: var(--muted); }
    .off { background: var(--accent); color: #0b1d3a; border-radius: 14px; padding: 10px 16px; font-weight: 600; }
  \`,
  actions: {
    // tap="apagar": se ejecuta al pulsar
    apagar: (ha) => ha.call('light.turn_off', { entity_id: ha.find('light.*', (s) => s.state === 'on') }),
  },
  render(ha, screen, config, html) {
    const on = ha.count('light.*', 'on');
    return html\`
      <div class="card">
        <h3>\${config.title}</h3>
        <div class="grid">\${config.sensors.slice(0, 4).map((id) => html\`
          <div class="stat" tap="more-info" entity=\${id}>
            <ha-icon icon=\${ha.icon(id)}></ha-icon><b>\${ha.text(id)}</b><small>\${ha.name(id)}</small>
          </div>\`)}</div>
        <div class="foot">
          <span>\${on} luces encendidas</span>
          \${on ? html\`<button class="off" tap="apagar">Apagarlas</button>\` : ''}
        </div>
      </div>\`;
  },
}`,
    'alarma.js': `{
  // Las alarmas son del panel (screen), no de Home Assistant. Se recalcula al menos una vez por minuto
  config: {
    hours: { type: 'number', label: 'Mostrarla si suena en menos de (horas)', default: 24, min: 1, max: 168 },
  },
  watch: [],
  render(ha, screen, config) {
    const a = screen.nextAlarm();
    if (!a || a.when - screen.now() > config.hours * 3600e3) return null;
    return { icon: 'mdi:alarm', text: a.text, go: 'settings' };
  },
}`,
    'impresoras-bambu.js': `{
  // Impresoras 3D de Bambu Lab (integración bambu_lab). Sus entidades se reconocen por su clave (ha.info(id).key)
  config: {
    printers: { type: 'device', integration: 'bambu_lab', has: { key: 'print_status' }, multiple: true, label: 'Impresoras', hint: 'Si no eliges ninguna: todas' },
  },
  watch: ['sensor.*'],
  render(ha, screen, config) {
    const PRINTING = ['running', 'pause', 'prepare', 'slicing', 'init'];
    return ha.devices('bambu_lab').filter((d) => config.printers.includes(d.id)).map((d) => {
      const by = (key) => d.entities.find((id) => ha.info(id).key === key);
      const status = by('print_status');
      if (!status || !PRINTING.includes(ha.state(status))) return null;
      const prog = ha.num(by('print_progress')), left = ha.num(by('remaining_time')) * 60;   // viene en minutos
      return {
        icon: 'mdi:printer-3d-nozzle',
        text: d.name + ' ' + (isNaN(prog) ? '—' : Math.round(prog) + ' %') + (left > 0 ? ' · ' + ha.duration(left) : ''),
        progress: isNaN(prog) ? null : prog,   // barrita de progreso
        go: 'printers',
      };
    });
  },
}`,
    'impresoras-klipper.js': `{
  // Impresoras 3D con Klipper (integración moonraker). Sus entidades se reconocen por cómo acaba el id
  config: {
    printers: { type: 'device', integration: 'moonraker', has: { suffix: 'current_print_state' }, multiple: true, label: 'Impresoras', hint: 'Si no eliges ninguna: todas' },
  },
  watch: ['sensor.*'],
  render(ha, screen, config) {
    const PRINTING = ['printing', 'paused'];
    return ha.devices('moonraker').filter((d) => config.printers.includes(d.id)).map((d) => {
      const by = (end) => d.entities.find((id) => id.endsWith('_' + end));
      const status = by('current_print_state');
      if (!status || !PRINTING.includes(ha.state(status))) return null;
      const prog = ha.num(by('progress')), rem = by('print_time_left'), unit = ha.attr(rem, 'unit_of_measurement');
      const left = ha.num(rem) * (unit === 'h' ? 3600 : unit === 'min' ? 60 : unit === 'd' ? 86400 : 1);
      return {
        icon: 'mdi:printer-3d-nozzle',
        text: d.name + ' ' + (isNaN(prog) ? '—' : Math.round(prog) + ' %') + (left > 0 ? ' · ' + ha.duration(left) : ''),
        progress: isNaN(prog) ? null : prog,
        go: 'printers',
      };
    });
  },
}`,
    'vehiculo.js': `{
  // Batería de un vehículo eléctrico (patinete, coche, moto…). Se eligen sus entidades;
  // si no eliges batería, busca un patinete de la integración mi_scooter_ble.
  config: {
    battery: { type: 'entity', domain: 'sensor', deviceClass: 'battery', auto: false, label: 'Batería' },
    charging: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargando (opcional)' },
    charged: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargado (opcional)' },
    kind: { type: 'select', label: 'Icono', default: 'scooter', options: [
      { value: 'scooter', label: 'Patinete' }, { value: 'car-electric', label: 'Coche' },
      { value: 'motorbike-electric', label: 'Moto' }, { value: 'bicycle-electric', label: 'Bici' }] },
  },
  render(ha, screen, config) {
    let { battery, charging, charged } = config;
    if (!battery) {
      const d = ha.devices('mi_scooter_ble')[0];
      const by = (key) => d && d.entities.find((id) => ha.info(id).key === key);
      battery = by('battery_level'); charging = by('charging_any'); charged = by('charged');
    }
    const pct = ha.num(battery);
    if (isNaN(pct)) return null;
    const mode = ha.isOn(charged) ? 'charged' : ha.isOn(charging) ? 'charging' : null;
    return {
      icon: 'mdi:' + config.kind,
      text: Math.round(pct) + ' %',
      color: mode === 'charged' ? 'green' : null,
      // rayito al final mientras carga: amarillo cargando, verde cargado
      iconEnd: mode ? 'mdi:lightning-bolt' : null,
      iconEndColor: mode === 'charged' ? 'green' : 'yellow',
      go: 'scooter',
    };
  },
}`,
    'musica.js': `{
  config: {
    players: { type: 'entity', domain: 'media_player', multiple: true, label: 'Reproductores', hint: 'Si no eliges ninguno: todos los visibles' },
    showArtist: { type: 'bool', label: 'Mostrar también el artista', default: false },
  },
  watch: (config) => config.players,
  render(ha, screen, config) {
    const p = config.players.filter(screen.visible).find((id) => ha.state(id) === 'playing');
    if (!p) return null;
    const title = ha.attr(p, 'media_title') || ha.name(p), artist = ha.attr(p, 'media_artist');
    return { icon: 'mdi:music', text: config.showArtist && artist ? title + ' · ' + artist : title, go: 'media' };
  },
}`,
    'luces.js': `{
  config: {
    lights: { type: 'entity', domain: 'light', multiple: true, label: 'Luces', hint: 'Si no eliges ninguna: todas las visibles' },
    offButton: { type: 'bool', label: 'En las pestañas, botón para apagarlas', default: true },
  },
  watch: (config) => config.lights,
  render(ha, screen, config) {
    const all = config.lights.filter(screen.visible);
    const on = all.filter((id) => ha.state(id) === 'on');
    if (screen.place === 'home' && config.offButton) {       // en una Fila de burbujas de una pestaña: botón para apagarlas
      if (on.length) return {
        icon: 'mdi:lightbulb-off-outline',
        text: on.length > 1 ? 'Apagar ' + on.length + ' luces' : 'Apagar ' + ha.name(on[0]),
        onTap: (ha) => ha.call('light.turn_off', { entity_id: on }),
      };
      return all.length ? { icon: 'mdi:lightbulb-outline', text: 'Todas las luces apagadas' } : null;
    }
    return on.length ? { icon: 'mdi:lightbulb-on', text: on.length + (on.length > 1 ? ' encendidas' : ' encendida'), go: 'rooms' } : null;
  },
}`,
    'avisos.js': `{
  // Los avisos son del panel (screen), no de Home Assistant: sale si hay avisos y al tocarla abre el panel de acceso rápido en Avisos
  config: {
    show: { type: 'select', label: 'Cuándo sale', default: 'unread', options: [{ value: 'unread', label: 'Si hay avisos sin ver' }, { value: 'any', label: 'Si hay avisos en la lista' }] },
  },
  watch: [],
  render(ha, screen, config) {
    const n = screen.notices, count = config.show === 'any' ? n.total : n.unread;
    if (!count) return null;
    const text = count === 1 && n.last ? n.last : count + (config.show === 'any' ? ' avisos' : ' avisos sin ver');
    return { icon: 'mdi:bell-ring', color: n.unread ? 'orange' : '', text, onTap: (ha, screen) => screen.openNotices() };
  },
}`,
    'aberturas.js': `{
  config: {
    sensors: { type: 'entity', domain: 'binary_sensor', deviceClass: ['door', 'window', 'garage_door', 'opening'], multiple: true,
      label: 'Puertas y ventanas', hint: 'Si no eliges ninguna: todas las visibles' },
  },
  watch: (config) => config.sensors,
  render(ha, screen, config) {
    const open = config.sensors.filter(screen.visible).filter((id) => ha.state(id) === 'on');
    if (!open.length) return null;
    return {
      icon: 'mdi:door-open',
      text: open.length === 1 ? ha.name(open[0]) + ' abierta'
        : screen.place === 'home' ? open.length + ' puertas/ventanas abiertas' : open.length + ' abiertas',
      go: 'sensors',
    };
  },
}`,
  };
  const BUILTINS = [
    { key: 'weather', script: 'tiempo.js', label: 'panel.settings.weather', icon: 'mdi-weather-partly-cloudy', ambient: true },
    { key: 'alarm', script: 'alarma.js', label: 'panel.settings.next_alarm', icon: 'mdi-alarm', ambient: true },
    { key: 'printers', script: 'impresoras-bambu.js', label: 'panel.settings.bambu_lab_printers', icon: 'mdi-printer-3d-nozzle', ambient: true },
    { key: 'printers_klipper', script: 'impresoras-klipper.js', label: 'panel.settings.klipper_printers', icon: 'mdi-printer-3d-nozzle', ambient: true },
    { key: 'scooter', script: 'vehiculo.js', label: 'panel.nav.vehicle', icon: 'mdi-scooter', ambient: true },
    { key: 'media', script: 'musica.js', label: 'panel.settings.music_playing', icon: 'mdi-music', ambient: true },
    { key: 'lights', script: 'luces.js', label: 'panel.settings.lights', icon: 'mdi-lightbulb-on', ambient: true },
    { key: 'openings', script: 'aberturas.js', label: 'panel.settings.open_doors_windows', icon: 'mdi-door-open', ambient: false },
    { key: 'notices', script: 'avisos.js', label: 'panel.quick.notifications', icon: 'mdi-bell-ring', ambient: true, addOn: true },
  ];
  const bulletOf = (x, ambient) => ({ id: x.key, type: 'script', script: x.script, name: x.label, ambient });

  /** Lista de burbujas guardada o, si no hay, la de serie. Las antiguas «integradas» pasan a su script. */
  function bulletList(saved, ambientChips) {
    if (Array.isArray(saved)) {
      const list = saved.filter(Boolean).flatMap((b) => {
        // La burbuja de impresoras se separó en una por integración (con los mismos sitios)
        if (b.type === 'script' && b.script === 'impresoras.js') return ['printers', 'printers_klipper'].map((k) => bulletOf(BUILTINS.find((x) => x.key === k), !!b.ambient));
        if (b.type === 'script' && b.script === 'patinete.js') return Object.assign({}, b, { script: 'vehiculo.js', name: b.name === 'Patinete' ? tr('panel.nav.vehicle') : b.name });
        if (b.type === 'script') return b;
        const x = BUILTINS.find((y) => y.key === b.key);
        return x ? bulletOf(x, !!b.ambient) : null;
      }).filter(Boolean);
      // las de serie nuevas se añaden apagadas (salvo las marcadas addOn, que salen ya en el modo ambiente)
      for (const x of BUILTINS) if (!list.some((b) => b.script === x.script)) list.push(bulletOf(x, !!x.addOn));
      return list;
    }
    const old = Array.isArray(ambientChips) ? ambientChips.filter((c) => BUILTINS.some((x) => x.key === c.key)) : [];
    const keys = [...old.map((c) => c.key), ...BUILTINS.map((x) => x.key).filter((k) => !old.some((c) => c.key === k))];
    return keys.map((key) => {
      const x = BUILTINS.find((b) => b.key === key), o = old.find((c) => c.key === key);
      return bulletOf(x, o ? !!o.on : x.ambient);
    });
  }
  /** Funcionamientos disponibles: los de serie más los guardados en la Pi (los tuyos mandan si se llaman igual). */
  const allScripts = (saved) => Object.assign({}, DEFAULT_SCRIPTS, saved || {});

  /** Componentes antiguos (antes integrados) → su script */
  const COMPONENT_ALIAS = { button: 'boton.js', info: 'informacion.js', list: 'lista.js', card: 'tarjeta.js',
    weather: 'tarjeta-tiempo.js', vehicle: 'tarjeta-vehiculo.js' };
  /** Normaliza una tarjeta: componente por nombre de script; las «Código» antiguas también son componentes. */
  function normCard(c) {
    if (!c || typeof c !== 'object') return c;
    if (c.type === 'component' && COMPONENT_ALIAS[c.component]) {
      const cfg = Object.assign({}, c.config);
      if (c.component === 'weather' && cfg.forecast === false) { cfg.days = 0; delete cfg.forecast; }
      c = Object.assign({}, c, { component: COMPONENT_ALIAS[c.component], config: cfg });
    }
    if (c.type === 'script' && c.script) { const { script, ...rest } = c; c = Object.assign({}, rest, { type: 'component', component: script }); }
    if (c.type === 'component' && c.component === 'impresora.js' && c.config && c.config.onlyActive) {
      const { onlyActive, ...cfg } = c.config;
      c = Object.assign({}, c, { config: cfg }, c.config.device && !(c.when && (c.when.rules || []).length) ? { when: printingWhen(c.config.device) } : {});
    }
    if (Array.isArray(c.cards)) c = Object.assign({}, c, { cards: c.cards.map(normCard) });
    return c;
  }
  /** Componentes disponibles (scripts con type: 'card'): [{ script, name, icon, width, children, builtin }] */
  function componentList(scripts) {
    const out = [];
    for (const [script, code] of Object.entries(scripts || {})) {
      let m;
      try { m = compile(code); } catch (e) { continue; }
      if (m.type !== 'card') continue;
      out.push({ script, name: m.name || script.replace(/\.js$/, ''), icon: m.icon, width: m.width || 'full', children: m.children, builtin: script in DEFAULT_SCRIPTS });
    }
    return out;
  }
  /* ---------- «Mostrar solo si…» de cada tarjeta colocada: card.when = { mode: 'all' | 'any', rules: [...] } ----------
   *  { type: 'state', entity, op: 'on' | 'off' | 'available' | 'is' | 'not' | 'gt' | 'lt', value }
   *  { type: 'time', from: '07:00', to: '09:00' }   { type: 'night', value: true | false }
   *  { type: 'code', code: "ha.isOn('light.salon') && !screen.night" } */
  const WHEN_TYPES = { state: 'web.editor.when_state', time: 'web.editor.when_time', night: 'panel.settings.night_mode', code: 'web.editor.when_code' };
  const WHEN_OPS = { on: 'web.editor.op_on', off: 'web.editor.op_off', available: 'web.editor.op_available', is: 'web.editor.op_is', not: 'web.editor.op_not',
    gt: 'web.editor.op_above', lt: 'web.editor.op_below' };
  const codeCache = {};
  function ruleOk(r, ha, screen) {
    if (r.type === 'state') {
      if (!r.entity) return true;
      const id = r.entity, on = ha.active(id) || ha.isOn(id);
      switch (r.op) {
        case 'off': return !on && ha.ok(id);
        case 'available': return ha.ok(id);
        case 'is': return String(ha.state(id)) === String(r.value ?? '');
        case 'not': return String(ha.state(id)) !== String(r.value ?? '');
        case 'gt': return ha.num(id) > parseFloat(r.value);
        case 'lt': return ha.num(id) < parseFloat(r.value);
        default: return on;
      }
    }
    if (r.type === 'time') {
      const now = screen.now(), m = now.getHours() * 60 + now.getMinutes();
      const p = (t) => { const [h, mm] = String(t || '0:0').split(':'); return (+h || 0) * 60 + (+mm || 0); };
      const a = p(r.from), b = p(r.to);
      return a <= b ? m >= a && m < b : m >= a || m < b;   // 22:00 → 07:00 cruza la medianoche
    }
    if (r.type === 'night') return !!screen.night === (r.value !== false && r.value !== 'false');
    if (r.type === 'code') {
      if (!String(r.code || '').trim()) return true;
      // eslint-disable-next-line no-new-func
      const f = codeCache[r.code] || (codeCache[r.code] = new Function('ha', 'screen', '"use strict"; return (' + r.code + '\n);'));
      return !!f(ha, screen);
    }
    return true;
  }
  /** ¿Se muestra? Sin condiciones, sí. Una condición con error cuenta como cumplida */
  function checkWhen(when, ha, screen) {
    const rules = ((when && when.rules) || []).filter(Boolean);
    if (!rules.length) return true;
    const ok = rules.map((r) => { try { return ruleOk(r, ha, screen); } catch (e) { return true; } });
    return when.mode === 'any' ? ok.some(Boolean) : ok.every(Boolean);
  }
  /** Entidades de las que dependen; timed = hay horas, modo noche o código (se revisan cada poco) */
  function whenDeps(when) {
    const rules = ((when && when.rules) || []).filter(Boolean);
    return { entities: rules.filter((r) => r.type === 'state' && r.entity).map((r) => r.entity), timed: rules.some((r) => r.type !== 'state') };
  }

  /** Anchos de una tarjeta en la rejilla (de 12 columnas) */
  const WIDTHS = { full: 'panel.nav.complete', '3/4': '3/4', '2/3': '2/3', '1/2': '1/2', '1/3': '1/3', '1/4': '1/4' };

  /** Vistas que trae el panel (se usan como tarjeta «vista» dentro de una pestaña). */
  const VIEWS = [
    { key: 'home', title: 'panel.nav.home', icon: 'mdi-home-variant' },
    { key: 'rooms', title: 'panel.nav.house', icon: 'mdi-sofa-outline' },
    { key: 'sensors', title: 'panel.nav.sensors', icon: 'mdi-thermometer' },
    { key: 'media', title: 'panel.nav.media', icon: 'mdi-play-circle-outline' },
    { key: 'printers', title: 'panel.nav.printers', icon: 'mdi-printer-3d' },
    { key: 'scooter', title: 'panel.vehicle.scooter', icon: 'mdi-scooter' },
  ];
  /** Las pestañas de serie, montadas con componentes (uno por cosa, todos editables) a partir de lo que hay en casa.
   *  opts: { visible(id), favorites: [ids] } */
  const comp = (component, width, config, cards) => Object.assign({ type: 'component', component, width, config: config || {} }, cards ? { cards } : {});
  const bubbleRow = () => ({ type: 'bubbles', width: 'full', items: ['alarma.js', 'luces.js', 'aberturas.js'].map((script) => ({ script, config: {} })) });
  /** Condición «solo mientras esa impresora trabaja» */
  const printingWhen = (device) => ({ mode: 'all', rules: [{ type: 'code', code: `ha.printers().some((p) => p.device === '${device}' && p.active)` }] });
  const CONTROL = ['light', 'switch', 'fan', 'cover', 'climate', 'lock', 'media_player', 'vacuum', 'humidifier'];
  const SENSOR_CLASSES = ['temperature', 'humidity', 'power', 'energy', 'battery', 'illuminance', 'carbon_dioxide', 'pm25', 'door', 'window',
    'garage_door', 'opening', 'motion', 'occupancy', 'presence', 'moisture', 'smoke', 'gas', 'carbon_monoxide', 'safety', 'problem'];
  function viewCards(view, ha, opts = {}) {
    const vis = opts.visible || (() => true);
    const dom = (id) => id.split('.')[0];
    const byArea = (ids) => {
      const g = {};
      for (const id of ids) { const a = ha.info(id).area || tr('panel.nav.others'); (g[a] = g[a] || []).push(id); }
      return Object.keys(g).sort((x, y) => (x === tr('panel.nav.others')) - (y === tr('panel.nav.others')) || x.localeCompare(y, 'es'))
        .map((name) => ({ name, ids: g[name].sort((x, y) => ha.name(x).localeCompare(ha.name(y), 'es')) }));
    };
    const scooter = () => {
      const d = ha.devices('mi_scooter_ble')[0], k = {};
      if (d) for (const id of d.entities) if (ha.info(id).key) k[ha.info(id).key] = id;
      return k;
    };
    if (view === 'home') {
      let fav = (opts.favorites || []).filter((id) => ha.entity(id));
      if (!fav.length) {
        const pick = (d, n) => ha.find(d + '.*').filter(vis).slice(0, n);
        fav = [...pick('climate', 2), ...pick('light', 6), ...pick('media_player', 2)];
      }
      const w = ha.find('weather.*')[0], k = scooter();
      return [comp('saludo.js', 'full'), bubbleRow(),
        // la pequeña solo mientras imprime: es una condición («Mostrar solo si…»), editable en Pantallas
        ...ha.printers().map((p) => Object.assign(comp('impresora.js', '1/2', { device: p.device, mini: true }), { when: printingWhen(p.device) })),
        w ? comp('tarjeta-tiempo.js', '1/2', { entity: w }) : null,
        k.battery_level ? comp('tarjeta-vehiculo.js', '1/2', { tap: { action: 'navigate', go: 'scooter' } }) : null,
        comp('escenas.js', 'full'),
        fav.length ? comp('tarjeta.js', 'full', { title: tr('panel.nav.favourites') }, fav.map((id) => comp('boton.js', '1/4', { entity: id }))) : null].filter(Boolean);
    }
    if (view === 'rooms') {
      const media = ha.mediaOrder(ha.find('media_player.*'));
      const ids = ha.find('*', (s, id) => CONTROL.includes(dom(id)) && dom(id) !== 'media_player').concat(media).filter(vis);
      return byArea(ids).map((g) => comp('tarjeta.js', 'full', { title: g.name }, g.ids.map((id) => comp('boton.js', '1/4', { entity: id }))));
    }
    if (view === 'sensors') {
      const ids = ha.find('*', (s, id) => ['sensor', 'binary_sensor'].includes(dom(id)) && SENSOR_CLASSES.includes(s.attributes.device_class)).filter(vis);
      return byArea(ids).map((g) => comp('tarjeta.js', 'full', { title: g.name }, g.ids.map((id) => comp('informacion.js', '1/4', { entity: id }))));
    }
    if (view === 'media') {
      return [...ha.mediaOrder(ha.find('media_player.*')).filter(vis).map((id) => comp('reproductor.js', '1/2', { entity: id })),
        ...ha.find('camera.*').filter(vis).map((id) => comp('camara.js', '1/2', { entity: id }))];
    }
    if (view === 'printers') return ha.printers().map((p) => comp('impresora.js', 'full', { device: p.device }));
    if (view === 'scooter') {
      const k = scooter();
      if (!k.battery_level) return [];
      const STATS = [['remaining_range', 'mdi:map-marker-distance', 'panel.settings.range'], ['voltage', 'mdi:sine-wave', 'panel.vehicle.voltage'],
        ['power', 'mdi:flash', 'panel.vehicle.power'], ['battery_temperature', 'mdi:thermometer', 'panel.vehicle.battery_temp'],
        ['scooter_temperature', 'mdi:thermometer-lines', 'panel.vehicle.scooter_temp'], ['total_distance', 'mdi:counter', 'panel.vehicle.odometer'],
        ['trip_distance', 'mdi:map-marker-path', 'panel.vehicle.last_trip'], ['average_speed', 'mdi:speedometer-medium', 'panel.vehicle.average_speed'],
        ['charge_cycles', 'mdi:battery-sync', 'panel.vehicle.charge_cycles'], ['battery_health', 'mdi:battery-heart-variant', 'panel.vehicle.battery_health']];
      const SWITCHES = [['tail_light', 'panel.vehicle.tail_light'], ['auto_light', 'panel.vehicle.auto_light'], ['ambient_light', 'panel.vehicle.ambient_light'],
        ['cruise_control', 'panel.vehicle.cruise_control'], ['tcs', 'panel.vehicle.traction_control'], ['intelligent_downhill', 'panel.vehicle.smart_descent'],
        ['hill_parking', 'panel.vehicle.hill_brake'], ['charge_control', 'panel.vehicle.stop_at_limit']];
      const stats = STATS.filter(([key]) => k[key]).map(([key, icon, name]) => comp('informacion.js', '1/4', { entity: k[key], name: tr(name), icon }));
      const charge = [k.charge_limit ? comp('deslizador.js', 'full', { entity: k.charge_limit, name: tr('panel.settings.charge_limit') }) : null,
        k.refresh ? comp('boton.js', '1/2', { entity: k.refresh, name: tr('panel.vehicle.refresh_now'), icon: 'mdi:refresh', showState: false }) : null].filter(Boolean);
      const sw = SWITCHES.filter(([key]) => k[key]).map(([key, name]) => comp('boton.js', '1/4', { entity: k[key], name }));
      return [comp('tarjeta-vehiculo.js', 'full', { tap: 'more-info' }),
        stats.length ? comp('tarjeta.js', 'full', { title: tr('panel.settings.data') }, stats) : null,
        charge.length ? comp('tarjeta.js', 'full', { title: tr('panel.settings.charging') }, charge) : null,
        sw.length ? comp('tarjeta.js', 'full', { title: tr('panel.nav.settings') }, sw) : null].filter(Boolean);
    }
    return [];
  }
  /** Las vistas antiguas de una lista de tarjetas, convertidas en componentes (si hay datos de Home Assistant) */
  function expandViews(cards, ha, opts) {
    return (cards || []).flatMap((c) => (c && c.type === 'view' && ha ? viewCards(c.view, ha, opts) : [c]));
  }
  /** Pestañas guardadas o, si no hay, las de serie. Las vistas se quedan como { type: 'view' } hasta que se conviertan
   *  (el panel las monta al vuelo con viewCards; la web las convierte al abrir Pantallas). */
  function tabList(saved) {
    const conv = (t) => (c) => (c && c.type === 'bullets'
      // las burbujas de Inicio: si la pestaña ya tenía la vista Inicio, esa ya trae su fila
      ? ((t.cards || []).some((x) => x && x.type === 'view' && x.view === 'home') ? [] : [bubbleRow()])
      : [c && c.type === 'view' ? c : normCard(c)]);
    if (Array.isArray(saved) && saved.length) return saved.filter((t) => t && t.id).map((t) => Object.assign({}, t, { cards: (t.cards || []).flatMap(conv(t)) }));
    return VIEWS.map((v) => ({ id: v.key, title: v.title, icon: v.icon, cards: [{ type: 'view', view: v.key }] }));
  }
  /** Tipos de tarjeta de una pestaña */
  const CARD_TYPES = {
    entities: 'web.editor.card_entities', camera: 'web.editor.camera', component: 'web.editor.card_component', bubbles: 'web.editor.card_bubbles', view: 'web.editor.card_view',
  };

  root.PanelModulos = { matcher, makeHA, makeScreen, compile, resolveConfig, FIELD_TYPES, entityMatch, deviceHas, ACTIONS, actionOf, WIDTHS, WHEN_TYPES, WHEN_OPS, checkWhen, whenDeps, componentList, normCard, COMPONENT_ALIAS, viewCards, expandViews, bubbles, color, mdi, EXAMPLES, BUILTINS, DEFAULT_SCRIPTS, allScripts,
    bulletList, VIEWS, tabList, CARD_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
