/* Burbujas y tarjetas programables.
 * Su funcionamiento son archivos .js que se crean o importan en la web de configuración y se guardan en la Pi.
 * El panel los descarga al arrancar y los ejecuta en el navegador; la web los usa para probarlos.
 *
 *   {
 *     watch: ['sensor.x', 'light.*'],        // entidades que la actualizan (admite *). Sin watch: cualquier cambio
 *     render(ha, screen) { return {...} }    // lo que se pinta (JSON) o null para no mostrar nada
 *   }
 *
 * ha     → Home Assistant: leer estados (ha.state, ha.find, ha.info…) y, solo al tocar, ha.call().
 * screen → la pantalla: dónde se pinta (screen.place), brillo, modo noche/ambiente, alarmas del panel, ir a una pestaña…
 *
 * Burbuja → { icon, text, color, textColor, iconEnd, iconEndColor, progress, go, action, onTap }   (o una lista, o null)
 * Tarjeta → lista de bloques: { title }, { text, size }, { tiles: [ids] }, { stats: [{ icon, value, label }] },
 *           { chips: [burbujas] }, { button: { text, icon, go, action, onTap } }
 *   onTap(ha, screen) → lo que se hace al tocar (aquí sí se puede usar ha.call)
 *   action = { service: 'light.turn_off', entity: 'light.x', data: {} }   (lo mismo, escrito como datos)
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
        ? (+n).toLocaleString('es-ES', { maximumFractionDigits: 1 })
        : (+n).toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })),
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
      /** De qué es la entidad: { platform (integración), device, deviceId, area, areaId, key (translation_key) } */
      info: (id) => (extra.info && extra.info(id)) || {},
      /** Aparatos de una integración: [{ id, name, area, entities: [ids] }]. Sin integración: todos */
      devices(platform) {
        const out = {};
        for (const id of Object.keys(getStates())) {
          const i = ha.info(id);
          if (!i.deviceId || (platform && i.platform !== platform)) continue;
          (out[i.deviceId] || (out[i.deviceId] = { id: i.deviceId, name: i.device || i.deviceId, area: i.area || null, entities: [] })).entities.push(id);
        }
        return Object.values(out);
      },
      /** Mandar a Home Assistant: ha.call('light.turn_off', { entity_id: 'light.salon' }). Solo dentro de onTap. */
      call: extra.call || (() => { throw new Error('ha.call solo se puede usar al tocar (onTap)'); }),
    };
    return ha;
  }

  /** screen: lo que es de la pantalla y no de Home Assistant.
   *  data = { place, brightness, on, night, ambient, light, alarms: [{ name, time, days, enabled, when, text }] } */
  function makeScreen(data = {}, extra = {}) {
    const alarms = (data.alarms || []).map((a) => Object.assign({}, a, { when: a.when ? new Date(a.when) : null }));
    return {
      /** Dónde se pinta: 'ambient' (debajo del reloj), 'home' (resumen de Inicio) o 'card' (tarjeta de una pestaña) */
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
      /** Hora actual */
      now: () => new Date(),
    };
  }

  /** Compila el texto del usuario. Acepta un objeto ({ watch, render }) o un cuerpo de función que lo devuelva. */
  function compile(code) {
    const src = String(code || '').trim();
    if (!src) throw new Error('Sin código');
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
    if (!mod || typeof mod.render !== 'function') throw new Error('Tiene que devolver un objeto con render(ha, screen, config)');
    const w = mod.watch;
    if (w != null && !Array.isArray(w) && typeof w !== 'string' && typeof w !== 'function') throw new Error('watch tiene que ser una lista de entidades');
    const schema = mod.config && typeof mod.config === 'object' ? mod.config : {};
    for (const [k, f] of Object.entries(schema)) if (!f || !FIELD_TYPES[f.type]) throw new Error(`config.${k}: tipo no válido (${Object.keys(FIELD_TYPES).join(', ')})`);
    /** Con los valores guardados de una burbuja: su config final, su watch y si le afecta un cambio. */
    const bind = (values, ha) => {
      const cfg = resolveConfig(schema, values, ha);
      let list = typeof w === 'function' ? w(cfg) : w;
      list = list == null ? null : [].concat(list).filter(Boolean);
      return { cfg, watch: list, matches: matcher(list) };
    };
    return { config: schema, render: mod.render, bind };
  }

  /** Tipos de campo de config (lo que la web pinta en «Ajustes» de cada burbuja). */
  const FIELD_TYPES = { entity: 'Entidad', device: 'Aparato', text: 'Texto', number: 'Número', bool: 'Sí/No', select: 'Lista',
    icon: 'Icono', action: 'Acción' };
  /** Qué puede hacer un componente al pulsarlo o mantenerlo pulsado. */
  const ACTIONS = { toggle: 'Encender / apagar', 'more-info': 'Abrir el detalle', navigate: 'Ir a una pestaña',
    call: 'Llamar a un servicio', none: 'Nada' };
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

  const COLORS = { green: '#81c995', verde: '#81c995', red: '#f28b82', rojo: '#f28b82', yellow: '#fdd663', amarillo: '#fdd663',
    blue: '#8ab4f8', azul: '#8ab4f8', orange: '#fcad70', naranja: '#fcad70', grey: '#98a1ad', gris: '#98a1ad', purple: '#c58af9', morado: '#c58af9' };
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
      color: t > 26 ? 'rojo' : null,           // color del icono
      textColor: t > 26 ? 'rojo' : null,       // color del texto
      iconEnd: t > 26 ? 'mdi:alert' : null,    // icono al final
      iconEndColor: 'naranja',
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
      color: 'amarillo',
      // al tocarla las apaga todas (solo aquí se puede mandar algo a Home Assistant)
      onTap: (ha) => ha.call('light.turn_off', { entity_id: on }),
    };
  },
}`,
    tarjeta: `{
  watch: ['sensor.*temperatura*', 'light.*'],
  render(ha, screen) {
    const temps = ha.find('sensor.*', (s) => s.attributes.device_class === 'temperature').slice(0, 4);
    return [
      { title: 'Resumen' },
      { stats: temps.map((id) => ({ icon: 'mdi:thermometer', value: ha.fmt(id), label: ha.name(id) })) },
      { text: ha.count('light.*', 'on') + ' luces encendidas', size: 'small' },
      { tiles: ha.find('light.*').slice(0, 6) },
      { button: { text: 'Apagar todo', icon: 'mdi:power', onTap: (ha) => ha.call('light.turn_off', { entity_id: 'all' }) } },
    ];
  },
}`,
  };

  /** Burbujas de serie. Se pueden editar en la web (se guarda tu versión en la Pi);
   *  con «Restaurar» vuelve la de serie. ambient/home = dónde salen la primera vez. */
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
      color: mode === 'charged' ? 'verde' : null,
      // rayito al final mientras carga: amarillo cargando, verde cargado
      iconEnd: mode ? 'mdi:lightning-bolt' : null,
      iconEndColor: mode === 'charged' ? 'verde' : 'amarillo',
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
    offButton: { type: 'bool', label: 'En Inicio, botón para apagarlas', default: true },
  },
  watch: (config) => config.lights,
  render(ha, screen, config) {
    const all = config.lights.filter(screen.visible);
    const on = all.filter((id) => ha.state(id) === 'on');
    if (screen.place === 'home' && config.offButton) {       // en el resumen de Inicio: botón para apagarlas
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
    { key: 'weather', script: 'tiempo.js', label: 'Tiempo', icon: 'mdi-weather-partly-cloudy', ambient: true, home: false },
    { key: 'alarm', script: 'alarma.js', label: 'Próxima alarma', icon: 'mdi-alarm', ambient: true, home: true },
    { key: 'printers', script: 'impresoras-bambu.js', label: 'Impresoras Bambu Lab', icon: 'mdi-printer-3d-nozzle', ambient: true, home: false },
    { key: 'printers_klipper', script: 'impresoras-klipper.js', label: 'Impresoras Klipper', icon: 'mdi-printer-3d-nozzle', ambient: true, home: false },
    { key: 'scooter', script: 'vehiculo.js', label: 'Vehículo', icon: 'mdi-scooter', ambient: true, home: false },
    { key: 'media', script: 'musica.js', label: 'Música sonando', icon: 'mdi-music', ambient: true, home: false },
    { key: 'lights', script: 'luces.js', label: 'Luces encendidas', icon: 'mdi-lightbulb-on', ambient: true, home: true },
    { key: 'openings', script: 'aberturas.js', label: 'Puertas y ventanas abiertas', icon: 'mdi-door-open', ambient: false, home: true },
  ];
  const bulletOf = (x, ambient, home) => ({ id: x.key, type: 'script', script: x.script, name: x.label, ambient, home });

  /** Lista de burbujas guardada o, si no hay, la de serie. Las antiguas «integradas» pasan a su script. */
  function bulletList(saved, ambientChips) {
    if (Array.isArray(saved)) {
      const list = saved.filter(Boolean).flatMap((b) => {
        // La burbuja de impresoras se separó en una por integración (con los mismos sitios)
        if (b.type === 'script' && b.script === 'impresoras.js') return ['printers', 'printers_klipper'].map((k) => bulletOf(BUILTINS.find((x) => x.key === k), !!b.ambient, !!b.home));
        if (b.type === 'script' && b.script === 'patinete.js') return Object.assign({}, b, { script: 'vehiculo.js', name: b.name === 'Patinete' ? 'Vehículo' : b.name });
        if (b.type === 'script') return b;
        const x = BUILTINS.find((y) => y.key === b.key);
        return x ? bulletOf(x, !!b.ambient, !!b.home) : null;
      }).filter(Boolean);
      for (const x of BUILTINS) if (!list.some((b) => b.script === x.script)) list.push(bulletOf(x, false, false));
      return list;
    }
    const old = Array.isArray(ambientChips) ? ambientChips.filter((c) => BUILTINS.some((x) => x.key === c.key)) : [];
    const keys = [...old.map((c) => c.key), ...BUILTINS.map((x) => x.key).filter((k) => !old.some((c) => c.key === k))];
    return keys.map((key) => {
      const x = BUILTINS.find((b) => b.key === key), o = old.find((c) => c.key === key);
      return bulletOf(x, o ? !!o.on : x.ambient, x.home);
    });
  }
  /** Funcionamientos disponibles: los de serie más los guardados en la Pi (los tuyos mandan si se llaman igual). */
  const allScripts = (saved) => Object.assign({}, DEFAULT_SCRIPTS, saved || {});

  /** Componentes de serie que se colocan en las pestañas. Cada uno colocado lleva sus propios ajustes
   *  (card.config); los campos son los mismos que los de los scripts (config). */
  const tapHold = (tap, hold) => ({
    tap: { type: 'action', label: 'Al pulsar', default: tap },
    hold: { type: 'action', label: 'Al mantener pulsado', default: hold },
  });
  const COMPONENTS = {
    button: { kind: 'card', label: 'Botón', icon: 'mdi-gesture-tap-button', config: Object.assign({
      entity: { type: 'entity', auto: false, label: 'Entidad' },
      name: { type: 'text', label: 'Nombre', hint: 'Vacío: el de Home Assistant' },
      icon: { type: 'icon', label: 'Icono', hint: 'Vacío: el de la entidad' },
      showState: { type: 'bool', label: 'Mostrar el estado', default: true },
    }, tapHold('toggle', 'more-info')) },
    info: { kind: 'card', label: 'Información', icon: 'mdi-information-outline', config: Object.assign({
      entity: { type: 'entity', auto: false, label: 'Entidad' },
      name: { type: 'text', label: 'Nombre', hint: 'Vacío: el de Home Assistant' },
      icon: { type: 'icon', label: 'Icono', hint: 'Vacío: el de la entidad' },
    }, tapHold('more-info', 'none')) },
    list: { kind: 'card', label: 'Lista', icon: 'mdi-format-list-bulleted', config: Object.assign({
      title: { type: 'text', label: 'Título' },
      entities: { type: 'entity', multiple: true, auto: false, label: 'Entidades' },
    }, tapHold('more-info', 'none')) },
    card: { kind: 'group', label: 'Tarjeta', icon: 'mdi-card-outline', config: {
      title: { type: 'text', label: 'Título' },
    } },
    weather: { kind: 'card', label: 'Tiempo', icon: 'mdi-weather-partly-cloudy', config: Object.assign({
      entity: { type: 'entity', domain: 'weather', label: 'Entidad del tiempo' },
      forecast: { type: 'bool', label: 'Mostrar la previsión', default: true },
      days: { type: 'number', label: 'Días de previsión', default: 5, min: 1, max: 7 },
    }, tapHold('none', 'more-info')) },
    vehicle: { kind: 'card', label: 'Vehículo', icon: 'mdi-car-electric', config: Object.assign({
      name: { type: 'text', label: 'Nombre', hint: 'Vacío: el del aparato' },
      kind: { type: 'select', label: 'Icono', default: 'scooter', options: [
        { value: 'scooter', label: 'Patinete' }, { value: 'car-electric', label: 'Coche' },
        { value: 'motorbike-electric', label: 'Moto' }, { value: 'bicycle-electric', label: 'Bici' }] },
      battery: { type: 'entity', domain: 'sensor', deviceClass: 'battery', auto: false, label: 'Batería', hint: 'Vacío: el patinete Xiaomi si lo hay' },
      charging: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargando' },
      charged: { type: 'entity', domain: 'binary_sensor', auto: false, label: 'Cargado' },
      range: { type: 'entity', domain: 'sensor', auto: false, label: 'Autonomía' },
      status: { type: 'entity', auto: false, label: 'Estado', hint: 'Por ejemplo, aparcado o en marcha' },
    }, tapHold('more-info', 'none')) },
    bubbles: { kind: 'row', label: 'Fila de burbujas', icon: 'mdi-dots-horizontal-circle-outline', config: {} },
  };
  /** Anchos de una tarjeta en la rejilla (de 12 columnas) */
  const WIDTHS = { full: 'Completo', '3/4': '3/4', '2/3': '2/3', '1/2': '1/2', '1/3': '1/3', '1/4': '1/4' };

  /** Vistas que trae el panel (se usan como tarjeta «vista» dentro de una pestaña). */
  const VIEWS = [
    { key: 'home', title: 'Inicio', icon: 'mdi-home-variant' },
    { key: 'rooms', title: 'Casa', icon: 'mdi-sofa-outline' },
    { key: 'sensors', title: 'Sensores', icon: 'mdi-thermometer' },
    { key: 'media', title: 'Multimedia', icon: 'mdi-play-circle-outline' },
    { key: 'printers', title: 'Impresoras', icon: 'mdi-printer-3d' },
    { key: 'scooter', title: 'Patinete', icon: 'mdi-scooter' },
  ];
  /** Pestañas guardadas o, si no hay, una por cada vista del panel. */
  function tabList(saved) {
    if (Array.isArray(saved) && saved.length) return saved.filter((t) => t && t.id);
    return VIEWS.map((v) => ({ id: v.key, title: v.title, icon: v.icon, cards: [{ type: 'view', view: v.key }] }));
  }
  /** Tipos de tarjeta de una pestaña */
  const CARD_TYPES = {
    view: 'Vista del panel', entities: 'Dispositivos', camera: 'Cámara', bullets: 'Burbujas', script: 'Código',
    component: 'Componente', bubbles: 'Fila de burbujas',
  };

  root.PanelModulos = { matcher, makeHA, makeScreen, compile, resolveConfig, FIELD_TYPES, entityMatch, deviceHas, ACTIONS, actionOf, COMPONENTS, WIDTHS, bubbles, color, mdi, EXAMPLES, BUILTINS, DEFAULT_SCRIPTS, allScripts,
    bulletList, VIEWS, tabList, CARD_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
