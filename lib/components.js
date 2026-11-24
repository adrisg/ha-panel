/* Components with HTML and CSS: the panel (app.js) and the configuration web (preview) paint them, the same way in both.
 *
 * A component (type: 'card') has:
 *   style: `…CSS…`                        it only affects that component
 *   render(ha, screen, config, html) {    returns html`…` (the ${…} are escaped by themselves)
 *     return html`<button class="btn" tap=${config.tap} entity=${id}><ha-icon icon=${ha.icon(id)}></ha-icon> ${ha.name(id)}</button>`;
 *   }
 *   actions: { off: (ha, screen) => ha.call(…) }   for tap="off"
 *
 * In the HTML:
 *   <ha-icon icon="mdi:lightbulb">   an icon
 *   tap / hold                       on tap / hold: 'toggle', 'more-info', 'none', an action from config,
 *                                    the name of one of the actions, or a function: tap=${(ha) => ha.call(…)}
 *   entity                           the entity tap and hold act on
 *   <slot></slot>                    the inner components go here (components with children: true)
 */
(function (root) {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mdi = (s) => (s ? String(s).replace(/^mdi:/, 'mdi-') : '');
  const slug = (s) => String(s || 'x').replace(/\.js$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

  /** html`…` template: escapes what goes in; in attributes (tap=${…}) it adds quotes; functions are kept in fns. */
  function makeHtml(fns) {
    const raw = (s) => ({ __html: s });
    const text = (v) => {
      if (v == null || v === false || v === true) return '';
      if (Array.isArray(v)) return v.map(text).join('');
      if (typeof v === 'object' && v.__html != null) return v.__html;
      return esc(v);
    };
    const attr = (v) => {
      if (v == null || v === false) return '""';
      if (typeof v === 'function') { fns.push(v); return '"fn:' + (fns.length - 1) + '"'; }
      if (typeof v === 'object' && v.__html == null) return '"' + esc(JSON.stringify(v)) + '"';
      return '"' + esc(typeof v === 'object' ? v.__html : v) + '"';
    };
    function html(strings, ...vals) {
      let out = strings[0];
      vals.forEach((v, i) => { out += (/=\s*$/.test(out) ? attr(v) : text(v)) + strings[i + 1]; });
      return raw(out);
    }
    html.raw = raw;            // html.raw('<b>unescaped</b>')
    return html;
  }

  /** Prefixes the scope to each CSS selector (also inside @media); :host is the component itself. */
  function scopeCss(css, scope) {
    css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '', i = 0;
    const block = (from) => {            // returns the index after the } that closes the block that starts at from ('{')
      let d = 0;
      for (let j = from; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}' && --d === 0) return j + 1; }
      return css.length;
    };
    const walk = (end) => {
      while (i < end) {
        const open = css.indexOf('{', i), close = css.indexOf('}', i);
        if (open < 0 || open >= end || (close >= 0 && close < open)) { i = close >= 0 && close < end ? close + 1 : end; continue; }
        const sel = css.slice(i, open).trim();
        if (/^@(media|supports|container)/.test(sel)) { out += sel + '{'; i = open + 1; const e = block(open) - 1; walk(e); out += '}'; i = e + 1; continue; }
        if (sel.startsWith('@')) { const e = block(open); out += css.slice(i, e); i = e; continue; }   // @keyframes, @font-face…
        const e = block(open);
        out += sel.split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => (s.startsWith(':host') ? scope + s.slice(5) : scope + ' ' + s)).join(', ') + css.slice(open, e);
        i = e;
      }
    };
    walk(css.length);
    return out;
  }

  const WIDGETS = ['ha-tile', 'ha-sensor', 'ha-camera'];
  const WNAME = { 'ha-tile': 'Ficha', 'ha-sensor': 'Sensor', 'ha-camera': 'web.editor.camera' };
  /** In the web (preview) the panel widgets show as a box with their name */
  function placeholder(e) {
    if (e.getAttribute('src')) {   // camera by address: it also shows in the web
      const img = document.createElement('img');
      img.src = e.getAttribute('src'); img.alt = ''; img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
      // if it is not an image (the page of the camera player), the page as it is
      img.onerror = () => img.replaceWith(Object.assign(document.createElement('iframe'), { src: e.getAttribute('src'),
        style: 'width:100%;height:100%;border:0;display:block;background:#000;pointer-events:none' }));
      return img;
    }
    const d = document.createElement('div');
    d.className = 'cmp-widget ' + e.tagName.toLowerCase();
    d.textContent = (typeof I18N !== 'undefined' ? I18N.t(WNAME[e.tagName.toLowerCase()]) : WNAME[e.tagName.toLowerCase()]) + (e.getAttribute('entity') ? ': ' + (e.getAttribute('label') || e.getAttribute('entity')) : '');
    return d;
  }
  /** Base styles (for all) and the ones of each component, only once in the document */
  const BASE = `
.cmp { display: block; min-width: 0; color: var(--text); }
.cmp * { box-sizing: border-box; }
.cmp button { font: inherit; color: inherit; border: 0; background: none; padding: 0; margin: 0; text-align: inherit; cursor: pointer; }
.cmp [tap], .cmp [hold] { cursor: pointer; -webkit-user-select: none; user-select: none; }
.cmp .mdi { line-height: 1; }
.cmp .hint { color: var(--muted); font-size: 13px; padding: 6px 4px; }
.cmp .card { display: block; width: 100%; background: var(--surface); border-radius: var(--radius, 20px); padding: 16px 18px; }
.cmp .cmp-kids { border: 2px dashed var(--surface-3); border-radius: 14px; padding: 14px; color: var(--muted); text-align: center; font-size: 13px; }
.cmp .cmp-err { color: var(--danger); font-size: 13px; padding: 8px; }
.cmp .cmp-widget { background: var(--surface); border-radius: 16px; padding: 14px; color: var(--muted); font-size: 13px; min-height: 60px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp .cmp-widget.ha-camera { min-height: 140px; }`;
  function ensureStyle(id, css) {
    if (typeof document === 'undefined') return;
    let st = document.getElementById(id);
    if (!st) { st = document.createElement('style'); st.id = id; document.head.append(st); }
    if (st.textContent !== css) st.textContent = css;
  }

  /* On repaint not everything is rebuilt: the new one is compared with what is there and only what differs changes (texts, classes,
   * attributes…). So the panel tiles, the camera or the video of a page do not reload or flicker. */
  const isMarker = (n) => n.nodeType === 1 && (n.tagName === 'SLOT' || WIDGETS.includes(n.tagName.toLowerCase()));
  function syncAttrs(x, y) {
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) {
      if (x.getAttribute(at.name) === at.value) continue;
      x.setAttribute(at.name, at.value);
      // a slider reflects the new value, except while it is being moved
      if (at.name === 'value' && 'value' in x && document.activeElement !== x) x.value = at.value;
    }
  }
  function morphChildren(a, b, live) {
    const bn = [...b.childNodes];
    let i = 0;
    for (const y of bn) {
      const x = a.childNodes[i];
      if (isMarker(y)) {
        const n = live(y);
        if (x !== n) a.insertBefore(n, x || null);
      } else if (x && !x._live && x.nodeType === y.nodeType && x.nodeName === y.nodeName) {
        if (y.nodeType === 1) { syncAttrs(x, y); morphChildren(x, y, live); } else if (x.data !== y.data) x.data = y.data;
      } else {
        if (y.nodeType === 1) y.querySelectorAll('slot,' + WIDGETS.join(',')).forEach((m) => m.replaceWith(live(m)));
        a.insertBefore(y, x || null);
      }
      i++;
    }
    while (a.childNodes.length > i) a.removeChild(a.lastChild);
  }

  /** Paints (or repaints) a component in host.
   *  mod: compiled script (render, style, actions, children); args: [ha, screen, config]
   *  ctx: { press(el, p) — p.tap / p.hold / p.entity always up to date —, change(el, fn), children() → node for <slot>, widget(e) } */
  function render(host, name, mod, args, ctx) {
    ensureStyle('cmp-base', BASE);
    const cls = 'cmp-' + slug(name);
    ensureStyle('cmp-style-' + slug(name), scopeCss(mod.style, '.' + cls));
    host.classList.add('cmp', cls);
    const fns = [], html = makeHtml(fns);
    const out = mod.render(args[0], args[1], args[2], html);
    if (out && typeof out === 'object' && out.__html == null) throw new Error(typeof I18N !== 'undefined' ? I18N.t('panel.scripts.render_html') : 'render has to return html`…`');
    const tpl = document.createElement('div');
    tpl.innerHTML = out == null || out === false ? '' : typeof out === 'object' && out.__html != null ? out.__html : String(out);
    if (typeof I18N !== 'undefined') I18N.page(tpl);   // component texts, in the panel language (translations/)
    // iconos
    tpl.querySelectorAll('ha-icon').forEach((e) => {
      const i = document.createElement('i');
      i.className = ('mdi ' + mdi(e.getAttribute('icon')) + ' ' + (e.getAttribute('class') || '')).trim();
      if (e.getAttribute('style')) i.setAttribute('style', e.getAttribute('style'));
      e.replaceWith(i);
    });
    // Panel tiles (<ha-tile>, <ha-sensor>, <ha-camera>) and the inner components (<slot>): kept and reused
    const cache = host._w || (host._w = new Map()), used = new Set();
    const live = (e) => {
      if (e.tagName === 'SLOT') {
        if (!host._slot) host._slot = ctx.children ? ctx.children() : Object.assign(document.createElement('div'), { className: 'cmp-kids', textContent: (typeof I18N !== 'undefined' ? I18N.t : String)('panel.scripts.children_here') });
        host._slot._live = true;
        return host._slot;
      }
      const key = e.outerHTML;
      let n = used.has(key) ? null : cache.get(key);
      if (!n) { n = (ctx.widget && ctx.widget(e)) || placeholder(e); n._live = true; if (!used.has(key)) cache.set(key, n); }
      used.add(key);
      return n;
    };
    morphChildren(host, tpl, live);
    for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
    // tap / hold / change: hooked once; what they do is read at the moment (el._p, el._change)
    const parse = (v) => {
      if (v == null || v === '') return null;
      if (v.startsWith('fn:')) return fns[+v.slice(3)] || null;
      if (v.startsWith('{')) { try { return JSON.parse(v); } catch (e) { return null; } }
      if (mod.actions && typeof mod.actions[v] === 'function') return mod.actions[v];
      return v;
    };
    // Nothing to show: it takes no room in the grid (.slot:has(> .cmp-empty))
    host.classList.toggle('cmp-empty', !host.children.length && !host.textContent.trim());
    host.querySelectorAll('[change]').forEach((el) => {
      el._change = parse(el.getAttribute('change'));
      if (!el._changeOn && ctx.change) { el._changeOn = true; ctx.change(el, (...a) => typeof el._change === 'function' && el._change(...a)); }
    });
    host.querySelectorAll('[tap],[hold]').forEach((el) => {
      el._p = { tap: parse(el.getAttribute('tap')), hold: parse(el.getAttribute('hold')), entity: el.getAttribute('entity') || null };
      if (!el._pressOn && ctx.press) {
        el._pressOn = true;
        ctx.press(el, { get tap() { return el._p.tap; }, get hold() { return el._p.hold; }, get entity() { return el._p.entity; } });
      }
    });
    return host;
  }

  root.PanelComp = { render, makeHtml, scopeCss, esc, mdi, WIDGETS };
})(typeof window !== 'undefined' ? window : globalThis);
