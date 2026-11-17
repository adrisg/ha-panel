/* Piezas: lo que devuelve render() de un componente (type: 'card'), convertido en HTML.
 * Lo usan el panel (app.js) y la web de configuración (vista previa), para que se vean igual.
 *
 * Piezas (una o una lista):
 *   'texto'                                   texto suelto
 *   { title: 'Salón' }                        título de sección
 *   { text: '…', size: 'big' | 'small' }      texto
 *   { tile: { icon, name, state, on, kind } } ficha como las de Casa (kind: light, media, climate, cover, lock)
 *   { stat: { icon, value, label } }          un valor en grande
 *   { stats: [{ icon, value, label }] }       varios valores en rejilla
 *   { list: [{ icon, name, value, entity, tap, hold }] }   filas
 *   { ring: { value, mode, center, title, sub, icon } }    anillo de porcentaje (mode: 'charging' | 'charged')
 *   { weather: { icon, temp, cond, extra, forecast: [{ day, icon, temp, low, rain }] } }
 *   { button: { text, icon } }                botón grande
 *   { chips: [burbujas] }                     fila de burbujas
 *   { tiles: ['light.x', …] }                 fichas de entidades (solo en el panel)
 *   { card: [piezas], title }                 fondo de tarjeta con piezas dentro
 *   { children: true }                        aquí van los componentes de dentro (componentes con children: true)
 * Cualquier pieza puede llevar: entity (sobre qué entidad actúa), tap y hold (al pulsar / mantener):
 *   una acción { action: 'toggle' | 'more-info' | 'navigate' | 'call' | 'none', go, service, data, entity }
 *   o una función (ha, screen) => ha.call(…). */
(function (root) {
  function el(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  const mdi = (s) => (s ? String(s).replace(/^mdi:/, 'mdi-') : '');
  const C = 2 * Math.PI * 52;
  const ACTIVE_KIND = ['light', 'media', 'climate', 'cover', 'lock'];

  /** ctx: { icon(name, cls) → nodo, press(el, pieza), light(el, entity), children() → nodo, chip(burbuja) → nodo, tiles(ids) → nodo } */
  function render(out, ctx) {
    const list = out == null || out === false ? [] : Array.isArray(out) ? out : [out];
    return list.filter((p) => p != null && p !== false).map((p) => piece(p, ctx)).filter(Boolean);
  }
  const ic = (ctx, name, cls) => (ctx.icon ? ctx.icon(mdi(name), cls) : el('i', 'mdi ' + mdi(name) + (cls ? ' ' + cls : '')));
  const tappable = (p) => p && (p.tap || p.hold);

  function piece(p, ctx) {
    if (typeof p === 'string' || typeof p === 'number') return el('div', 'cb-text', String(p));
    let node = null;
    if (p.children) node = ctx.children ? ctx.children() : el('div', 'pz-kids', '(componentes de dentro)');
    else if (p.card) {
      node = el('div', 'card pz-card', p.title ? el('div', 'ci-title', p.title) : null, render(p.card, ctx));
    } else if (p.title != null && Object.keys(p).every((k) => ['title', 'tap', 'hold', 'entity'].includes(k))) node = el('div', 'section-title', p.title);
    else if (p.text != null) node = el('div', 'cb-text ' + (p.size || ''), String(p.text));
    else if (p.tile) {
      const t = p.tile;
      node = el('button', 'tile pz-tile' + (t.on ? ' on' : '') + (t.unavailable ? ' unavail' : ''),
        el('div', 'tile-icon', ic(ctx, t.icon || 'mdi:help-circle-outline')),
        el('div', 'tile-text', el('div', 'tile-name', t.name == null ? '' : t.name), t.state != null ? el('div', 'tile-state', String(t.state)) : null));
      if (t.kind && ACTIVE_KIND.includes(t.kind)) node.dataset.kind = t.kind;
      if (t.on && p.entity && ctx.light) ctx.light(node, p.entity);
    } else if (p.stat) node = stat(p.stat, ctx, 'stat pz-stat');
    else if (p.stats) node = el('div', 'stat-grid', [].concat(p.stats).filter(Boolean).map((s) => wrap(stat(s, ctx, 'stat pz-stat'), s, ctx)));
    else if (p.list) {
      node = el('div', 'ci-list', [].concat(p.list).filter(Boolean).map((r) => wrap(el('button', 'ci-row',
        el('span', null, ic(ctx, r.icon || 'mdi:circle-small')), el('div', 'ci-name', r.name == null ? '' : r.name),
        el('div', 'ci-val', r.value == null ? '' : String(r.value))), r, ctx)));
    } else if (p.ring) node = ring(p.ring, ctx);
    else if (p.weather) node = weather(p.weather, ctx);
    else if (p.button) {
      node = el('button', 'big-action pz-btn', ic(ctx, p.button.icon || 'mdi:gesture-tap'), p.button.text || 'Ejecutar');
    } else if (p.chips) node = el('div', 'chips', [].concat(p.chips).filter(Boolean).map((b) => (ctx.chip ? ctx.chip(b) : el('span', 'chip', b.text || ''))));
    else if (p.tiles) node = ctx.tiles ? ctx.tiles([].concat(p.tiles)) : el('div', 'cb-text small', [].concat(p.tiles).join(', '));
    if (!node) return null;
    return wrap(node, p, ctx);
  }
  /** Al pulsar / mantener */
  function wrap(node, p, ctx) {
    if (tappable(p) && ctx.press) ctx.press(node, p);
    else if (node.tagName === 'BUTTON') node.classList.add('static');
    return node;
  }
  function stat(s, ctx, cls) {
    return el('button', cls, ic(ctx, s.icon || 'mdi:information-outline'),
      el('div', 'stat-value', s.value == null ? '—' : String(s.value)), el('div', 'stat-label', s.label == null ? '' : s.label));
  }
  function ring(r, ctx) {
    const v = Math.max(0, Math.min(100, Number(r.value) || 0)), mode = r.mode || (v < 20 ? 'low' : v < 45 ? 'mid' : '');
    const w = el('div', 'ring-wrap');
    w.innerHTML = `<svg class="ring" viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52"/>` +
      `<circle class="ring-fg ${mode}" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v / 100)}" transform="rotate(-90 60 60)"/></svg>`;
    w.append(el('div', 'ring-center', el('div', null, el('div', 'ring-pct', r.center != null ? r.center : isNaN(Number(r.value)) ? '—' : Math.round(v) + '%')),
      r.mode === 'charging' || r.mode === 'charged' ? ic(ctx, 'mdi:lightning-bolt', 'ring-bolt' + (r.mode === 'charged' ? ' charged' : '')) : null));
    return el('button', 'card scooter-card pz-ring', w, el('div', null,
      el('div', 'sc-title', r.icon ? ic(ctx, r.icon, 'veh-ic') : null, r.title || ''), r.sub ? el('div', 'sc-line', r.sub) : null));
  }
  function weather(w, ctx) {
    const now = el('div', 'w-now', ic(ctx, w.icon || 'mdi:weather-partly-cloudy', 'w-icon'), el('div', null,
      el('div', 'w-temp', w.temp == null ? '—' : w.temp), w.cond ? el('div', 'w-cond', w.cond) : null, w.extra ? el('div', 'muted small', w.extra) : null));
    const fc = (w.forecast || []).filter(Boolean);
    return el('button', 'card weather-card pz-weather', now, fc.length ? el('div', 'w-fc', fc.map((d) => el('div', 'fc-day',
      el('div', 'fc-name', d.day || ''), ic(ctx, d.icon || 'mdi:weather-partly-cloudy'), el('div', 'fc-t', d.temp == null ? '' : d.temp),
      d.rain != null ? el('div', 'fc-rain', ic(ctx, 'mdi:water'), d.rain) : el('div', 'fc-rain empty', ' '),
      d.low != null ? el('div', 'fc-low', d.low) : null))) : null);
  }

  root.PanelPiezas = { render, mdi };
})(typeof window !== 'undefined' ? window : globalThis);
