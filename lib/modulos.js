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
  const FIELD_TYPES = { entity: 'Entidad', text: 'Texto', number: 'Número', bool: 'Sí/No', select: 'Lista' };
  /** Valores de config: los guardados, si no el default y, si es una entidad vacía, la primera que encaje. */
  function resolveConfig(schema, values, ha) {
    const cfg = {};
    for (const [k, f] of Object.entries(schema || {})) {
      let v = values ? values[k] : undefined;
      if (v === '' || v == null || (Array.isArray(v) && !v.length)) v = f.default;
      if (f.type === 'entity') {
        const all = () => (ha ? ha.find(f.domain ? f.domain + '.*' : '*') : []);
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
  watch: [],
  render(ha, screen) {
    const a = screen.nextAlarm();
    if (!a || a.when - screen.now() > 24 * 3600e3) return null;   // solo si suena en menos de 24 h
    return { icon: 'mdi:alarm', text: a.text, go: 'settings' };
  },
}`,
    'impresoras.js': `{
  // Impresoras 3D de Bambu Lab o Moonraker (Klipper): sus entidades se buscan por integración y dispositivo
  watch: ['sensor.*'],
  render(ha, screen) {
    const KEYS = {
      bambu_lab: { status: 'print_status', progress: 'print_progress', remaining: 'remaining_time' },
      moonraker: { status: 'current_print_state', progress: 'progress', remaining: 'print_time_left' },
    };
    const PRINTING = ['running', 'printing', 'pause', 'paused', 'prepare', 'slicing', 'init'];
    const printers = {};
    for (const id of ha.find('sensor.*')) {
      const i = ha.info(id), keys = KEYS[i.platform];
      if (!keys || !i.deviceId) continue;
      const p = printers[i.deviceId] || (printers[i.deviceId] = { name: i.device || 'Impresora' });
      for (const [k, key] of Object.entries(keys))
        if (i.platform === 'bambu_lab' ? i.key === key : id.endsWith('_' + key)) p[k] = id;
    }
    return Object.values(printers).filter((p) => p.status && PRINTING.includes(ha.state(p.status))).map((p) => {
      const prog = ha.num(p.progress), unit = ha.attr(p.remaining, 'unit_of_measurement');
      const left = ha.num(p.remaining) * (unit === 'h' ? 3600 : unit === 'min' ? 60 : unit === 'd' ? 86400 : 1);
      return {
        icon: 'mdi:printer-3d-nozzle',
        text: p.name + ' ' + (isNaN(prog) ? '—' : Math.round(prog) + ' %') + (left > 0 ? ' · ' + ha.duration(left) : ''),
        progress: isNaN(prog) ? null : prog,   // barrita de progreso
        go: 'printers',
      };
    });
  },
}`,
    'patinete.js': `{
  // Patinete de la integración mi_scooter_ble: sus entidades se buscan por integración
  render(ha, screen) {
    const e = {};
    for (const id of Object.keys(ha.states)) {
      const i = ha.info(id);
      if (i.platform === 'mi_scooter_ble' && i.key) e[i.key] = id;
    }
    if (!e.battery_level) return null;
    const battery = ha.num(e.battery_level);
    const mode = ha.isOn(e.charged) ? 'charged' : ha.isOn(e.charging_any) ? 'charging' : null;
    return {
      icon: 'mdi:scooter',
      text: (isNaN(battery) ? '—' : Math.round(battery)) + ' %',
      color: mode === 'charged' ? 'verde' : null,
      // rayito al final mientras carga: amarillo cargando, verde cargado
      iconEnd: mode ? 'mdi:lightning-bolt' : null,
      iconEndColor: mode === 'charged' ? 'verde' : 'amarillo',
      go: 'scooter',
    };
  },
}`,
    'musica.js': `{
  watch: ['media_player.*'],
  render(ha, screen) {
    const p = ha.find('media_player.*', (s) => s.state === 'playing').filter(screen.visible)[0];
    return p ? { icon: 'mdi:music', text: ha.attr(p, 'media_title') || ha.name(p), go: 'media' } : null;
  },
}`,
    'luces.js': `{
  watch: ['light.*'],
  render(ha, screen) {
    const all = ha.find('light.*').filter(screen.visible);
    const on = all.filter((id) => ha.state(id) === 'on');
    if (screen.place === 'home') {       // en el resumen de Inicio: botón para apagarlas
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
  watch: ['binary_sensor.*'],
  render(ha, screen) {
    const open = ha.find('binary_sensor.*', (s) => s.state === 'on' &&
      ['door', 'window', 'garage_door', 'opening'].includes(s.attributes.device_class)).filter(screen.visible);
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
    { key: 'printers', script: 'impresoras.js', label: 'Impresoras imprimiendo', icon: 'mdi-printer-3d-nozzle', ambient: true, home: false },
    { key: 'scooter', script: 'patinete.js', label: 'Patinete', icon: 'mdi-scooter', ambient: true, home: false },
    { key: 'media', script: 'musica.js', label: 'Música sonando', icon: 'mdi-music', ambient: true, home: false },
    { key: 'lights', script: 'luces.js', label: 'Luces encendidas', icon: 'mdi-lightbulb-on', ambient: true, home: true },
    { key: 'openings', script: 'aberturas.js', label: 'Puertas y ventanas abiertas', icon: 'mdi-door-open', ambient: false, home: true },
  ];
  const bulletOf = (x, ambient, home) => ({ id: x.key, type: 'script', script: x.script, name: x.label, ambient, home });

  /** Lista de burbujas guardada o, si no hay, la de serie. Las antiguas «integradas» pasan a su script. */
  function bulletList(saved, ambientChips) {
    if (Array.isArray(saved)) {
      const list = saved.filter(Boolean).map((b) => {
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
  };

  root.PanelModulos = { matcher, makeHA, makeScreen, compile, resolveConfig, FIELD_TYPES, bubbles, color, mdi, EXAMPLES, BUILTINS, DEFAULT_SCRIPTS, allScripts,
    bulletList, VIEWS, tabList, CARD_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
