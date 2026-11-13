/* Scripts del panel: burbujas y tarjetas programables.
 * Son archivos .js que se crean o importan en la web de configuración y se guardan en la Pi.
 * El panel los descarga al arrancar y los ejecuta en el navegador; la web los usa para probarlos.
 *
 * Un script es un objeto JavaScript:
 *   {
 *     watch: ['sensor.x', 'light.*'],      // entidades que la actualizan (admite *). Sin watch: cualquier cambio
 *     render(ha) { return {...} }          // devuelve lo que se pinta (JSON) o null para no mostrar nada
 *   }
 * Burbuja → { icon, text, color, go, action, progress, badge }   (o una lista de ellas)
 * Tarjeta → lista de bloques: { title }, { text, size }, { tiles: [ids] }, { stats: [{ icon, value, label }] },
 *           { chips: [burbujas] }, { button: { text, icon, action } }
 *   action = { service: 'light.turn_off', entity: 'light.x', data: {} }
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

  /** Acceso a Home Assistant para el código del usuario. states = { entity_id: {state, attributes, …} } */
  function makeHA(getStates, extra = {}) {
    const st = (id) => getStates()[id];
    const ha = {
      /** Todos los estados (objeto entity_id → estado completo) */
      get states() { return getStates(); },
      /** Estado completo de una entidad: { entity_id, state, attributes, last_changed } */
      entity: (id) => st(id) || null,
      /** Estado como texto ('on', '21.5', 'playing'…) o null si no existe */
      state: (id) => (st(id) ? st(id).state : null),
      /** Estado como número (NaN si no lo es) */
      num: (id) => (st(id) ? parseFloat(st(id).state) : NaN),
      /** Un atributo: ha.attr('light.salon', 'brightness') */
      attr: (id, name) => (st(id) && st(id).attributes ? st(id).attributes[name] : undefined),
      /** Nombre visible */
      name: (id) => (st(id) && st(id).attributes && st(id).attributes.friendly_name) || id,
      /** ¿Está encendida / abierta / activa? */
      isOn: (id) => !!st(id) && ['on', 'open', 'playing', 'home', 'unlocked', 'cleaning', 'heat', 'cool'].includes(st(id).state),
      /** ¿Existe y está disponible? */
      ok: (id) => !!st(id) && !['unavailable', 'unknown'].includes(st(id).state),
      /** Estado con su unidad: '21,5 °C' */
      fmt(id, decimals) {
        const s = st(id);
        if (!s) return '—';
        const n = parseFloat(s.state), u = (s.attributes && s.attributes.unit_of_measurement) || '';
        if (isNaN(n) || !/^-?[\d.]+$/.test(s.state)) return s.state;
        const v = decimals == null ? n.toLocaleString('es-ES', { maximumFractionDigits: 1 }) : n.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        return u ? `${v} ${u}` : v;
      },
      /** Lista de entidades que coinciden: ha.find('light.*'), ha.find('sensor.*', (s) => s.attributes.device_class === 'temperature') */
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
      /** Llamar a una acción de HA: ha.call('light.turn_off', { entity_id: 'light.salon' }) (solo al tocar) */
      call: extra.call || (() => Promise.reject(new Error('Aquí no se pueden lanzar acciones'))),
      /** Ir a una pestaña del panel */
      go: extra.go || (() => {}),
      /** Hora actual */
      now: () => new Date(),
    };
    return ha;
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
    if (!mod || typeof mod.render !== 'function') throw new Error('Tiene que devolver un objeto con render(ha)');
    if (mod.watch != null && !Array.isArray(mod.watch) && typeof mod.watch !== 'string') throw new Error('watch tiene que ser una lista de entidades');
    return { watch: mod.watch == null ? null : [].concat(mod.watch), render: mod.render, matches: matcher(mod.watch == null ? null : mod.watch) };
  }

  const COLORS = { green: '#81c995', verde: '#81c995', red: '#f28b82', rojo: '#f28b82', yellow: '#fdd663', amarillo: '#fdd663',
    blue: '#8ab4f8', azul: '#8ab4f8', orange: '#fcad70', naranja: '#fcad70', grey: '#98a1ad', gris: '#98a1ad', purple: '#c58af9', morado: '#c58af9' };
  const color = (c) => (c ? COLORS[c] || c : null);
  const mdi = (s) => (s ? (String(s).startsWith('mdi-') ? s : 'mdi-' + String(s).replace(/^mdi:/, '')) : null);

  /** Normaliza lo que devuelve una burbuja: siempre una lista de { icon, text, color, go, action, progress, badge }. */
  function bubbles(out) {
    if (out == null || out === false) return [];
    const list = Array.isArray(out) ? out : [out];
    return list.filter(Boolean).map((b) => (typeof b === 'string' ? { text: b } : b)).map((b) => ({
      icon: mdi(b.icon), text: b.text == null ? '' : String(b.text), color: color(b.color), go: b.go || null,
      action: b.action || null, progress: b.progress == null || isNaN(+b.progress) ? null : Math.max(0, Math.min(100, +b.progress)),
      badge: mdi(b.badge), badgeColor: color(b.badgeColor),
    }));
  }

  /** Ejemplos para el editor */
  const EXAMPLES = {
    burbuja: `{
  // Entidades que actualizan la burbuja (admite *)
  watch: ['sensor.temperatura_salon'],
  render(ha) {
    const t = ha.num('sensor.temperatura_salon');
    if (isNaN(t)) return null;                 // null = no se muestra
    return {
      icon: 'mdi:thermometer',
      text: 'Salón ' + ha.fmt('sensor.temperatura_salon'),
      color: t > 26 ? 'rojo' : null,
      go: 'sensors',                           // al tocarla, a esta pestaña
    };
  },
}`,
    luces: `{
  watch: ['light.*'],
  render(ha) {
    const on = ha.find('light.*', (s) => s.state === 'on');
    if (!on.length) return null;
    return {
      icon: 'mdi:lightbulb-on',
      text: on.length === 1 ? ha.name(on[0]) : on.length + ' luces',
      color: 'amarillo',
      // al tocarla las apaga todas
      action: { service: 'light.turn_off', entity: on },
    };
  },
}`,
    tarjeta: `{
  watch: ['sensor.*temperatura*', 'light.*'],
  render(ha) {
    const temps = ha.find('sensor.*', (s) => s.attributes.device_class === 'temperature').slice(0, 4);
    return [
      { title: 'Resumen' },
      { stats: temps.map((id) => ({ icon: 'mdi:thermometer', value: ha.fmt(id), label: ha.name(id) })) },
      { text: ha.count('light.*', 'on') + ' luces encendidas', size: 'small' },
      { tiles: ha.find('light.*').slice(0, 6) },
      { button: { text: 'Apagar todo', icon: 'mdi:power', action: { service: 'light.turn_off', entity: 'all' } } },
    ];
  },
}`,
  };

  /** Burbujas que trae el panel. ambient/home = dónde salen por defecto. */
  const BUILTINS = [
    { key: 'weather', label: 'Tiempo', icon: 'mdi-weather-partly-cloudy', ambient: true, home: false },
    { key: 'alarm', label: 'Próxima alarma', icon: 'mdi-alarm', ambient: true, home: true },
    { key: 'printers', label: 'Impresoras imprimiendo', icon: 'mdi-printer-3d-nozzle', ambient: true, home: false },
    { key: 'scooter', label: 'Patinete', icon: 'mdi-scooter', ambient: true, home: false },
    { key: 'media', label: 'Música sonando', icon: 'mdi-music', ambient: true, home: false },
    { key: 'lights', label: 'Luces encendidas', icon: 'mdi-lightbulb-on', ambient: true, home: true },
    { key: 'openings', label: 'Puertas y ventanas abiertas', icon: 'mdi-door-open', ambient: false, home: true },
  ];

  /** Lista de burbujas guardada o, si no hay, la de siempre (respetando el orden antiguo de ambientChips). */
  function bulletList(saved, ambientChips) {
    if (Array.isArray(saved)) {
      const list = saved.filter((b) => b && (b.type === 'script' || BUILTINS.some((x) => x.key === b.key)));
      for (const x of BUILTINS) if (!list.some((b) => b.type !== 'script' && b.key === x.key))
        list.push({ id: x.key, type: 'builtin', key: x.key, ambient: false, home: false });
      return list;
    }
    const old = Array.isArray(ambientChips) ? ambientChips.filter((c) => BUILTINS.some((x) => x.key === c.key)) : [];
    const keys = [...old.map((c) => c.key), ...BUILTINS.map((x) => x.key).filter((k) => !old.some((c) => c.key === k))];
    return keys.map((key) => {
      const x = BUILTINS.find((b) => b.key === key), o = old.find((c) => c.key === key);
      return { id: key, type: 'builtin', key, ambient: o ? !!o.on : x.ambient, home: x.home };
    });
  }

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
    view: 'Vista del panel', entities: 'Dispositivos', camera: 'Cámara', bullets: 'Burbujas', script: 'Script',
  };

  root.PanelModulos = { matcher, makeHA, compile, bubbles, color, mdi, EXAMPLES, BUILTINS, bulletList, VIEWS, tabList, CARD_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
