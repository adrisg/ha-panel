/* Componentes con HTML y CSS: los pinta el panel (app.js) y la web de configuración (vista previa), igual en los dos.
 *
 * Un componente (type: 'card') trae:
 *   style: `…CSS…`                        solo afecta a ese componente
 *   render(ha, screen, config, html) {    devuelve html`…` (los ${…} se escapan solos)
 *     return html`<button class="btn" tap=${config.tap} entity=${id}><ha-icon icon=${ha.icon(id)}></ha-icon> ${ha.name(id)}</button>`;
 *   }
 *   actions: { apagar: (ha, screen) => ha.call(…) }   para tap="apagar"
 *
 * En el HTML:
 *   <ha-icon icon="mdi:lightbulb">   un icono
 *   tap / hold                       al pulsar / mantener: 'toggle', 'more-info', 'none', una acción de config,
 *                                    el nombre de una de actions, o una función: tap=${(ha) => ha.call(…)}
 *   entity                           sobre qué entidad actúan tap y hold
 *   <slot></slot>                    aquí van los componentes de dentro (componentes con children: true)
 */
(function (root) {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mdi = (s) => (s ? String(s).replace(/^mdi:/, 'mdi-') : '');
  const slug = (s) => String(s || 'x').replace(/\.js$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

  /** Plantilla html`…`: escapa lo que se mete; en atributos (tap=${…}) pone comillas; las funciones se guardan en fns. */
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
    html.raw = raw;            // html.raw('<b>sin escapar</b>')
    return html;
  }

  /** Antepone el ámbito a cada selector del CSS (también dentro de @media); :host es el propio componente. */
  function scopeCss(css, scope) {
    css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '', i = 0;
    const block = (from) => {            // devuelve el índice tras la } que cierra el bloque que empieza en from ('{')
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
  const WNAME = { 'ha-tile': 'Ficha', 'ha-sensor': 'Sensor', 'ha-camera': 'Cámara' };
  /** En la web (vista previa) los widgets del panel se ven como un recuadro con su nombre */
  function placeholder(e) {
    const d = document.createElement('div');
    d.className = 'cmp-widget ' + e.tagName.toLowerCase();
    d.textContent = WNAME[e.tagName.toLowerCase()] + (e.getAttribute('entity') ? ': ' + (e.getAttribute('label') || e.getAttribute('entity')) : '');
    return d;
  }
  /** Estilos de base (para todos) y los de cada componente, una sola vez en el documento */
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

  /** Pinta un componente en host.
   *  mod: script compilado (render, style, actions, children); args: [ha, screen, config]
   *  ctx: { press(el, { tap, hold, entity }), children() → nodo para <slot>, ha } */
  function render(host, name, mod, args, ctx) {
    ensureStyle('cmp-base', BASE);
    const cls = 'cmp-' + slug(name);
    ensureStyle('cmp-style-' + slug(name), scopeCss(mod.style, '.' + cls));
    host.classList.add('cmp', cls);
    const fns = [], html = makeHtml(fns);
    const out = mod.render(args[0], args[1], args[2], html);
    if (out && typeof out === 'object' && out.__html == null) throw new Error('render tiene que devolver html`…` (o un texto con HTML)');
    host.innerHTML = out == null || out === false ? '' : typeof out === 'object' && out.__html != null ? out.__html : String(out);
    // iconos
    host.querySelectorAll('ha-icon').forEach((e) => {
      const i = document.createElement('i');
      i.className = ('mdi ' + mdi(e.getAttribute('icon')) + ' ' + (e.getAttribute('class') || '')).trim();
      if (e.getAttribute('style')) i.setAttribute('style', e.getAttribute('style'));
      e.replaceWith(i);
    });
    // Fichas del panel: <ha-tile>, <ha-sensor>, <ha-camera>. Se guardan entre repintados (la cámara no parpadea)
    const cache = host._w || (host._w = new Map()), used = new Set();
    host.querySelectorAll(WIDGETS.join(',')).forEach((e) => {
      const key = e.outerHTML;
      let n = used.has(key) ? null : cache.get(key);
      if (!n) { n = (ctx.widget && ctx.widget(e)) || placeholder(e); if (!used.has(key)) cache.set(key, n); }
      used.add(key);
      e.replaceWith(n);
    });
    for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
    // componentes de dentro
    const slot = host.querySelector('slot');
    if (slot) slot.replaceWith(ctx.children ? ctx.children() : Object.assign(document.createElement('div'), { className: 'cmp-kids', textContent: 'Aquí van los componentes de dentro' }));
    // pulsar / mantener
    const parse = (v) => {
      if (v == null || v === '') return null;
      if (v.startsWith('fn:')) return fns[+v.slice(3)] || null;
      if (v.startsWith('{')) { try { return JSON.parse(v); } catch (e) { return null; } }
      if (mod.actions && typeof mod.actions[v] === 'function') return mod.actions[v];
      return v;
    };
    // Sin nada que mostrar: no ocupa sitio en la rejilla (.slot:has(> .cmp-empty))
    host.classList.toggle('cmp-empty', !host.children.length && !host.textContent.trim());
    // change=${(ha, screen, valor) => …} en un <input> (deslizadores…)
    host.querySelectorAll('[change]').forEach((el) => {
      const fn = parse(el.getAttribute('change'));
      if (typeof fn === 'function' && ctx.change) ctx.change(el, fn);
    });
    host.querySelectorAll('[tap],[hold]').forEach((el) => {
      if (ctx.press) ctx.press(el, { tap: parse(el.getAttribute('tap')), hold: parse(el.getAttribute('hold')), entity: el.getAttribute('entity') || null });
    });
    return host;
  }

  root.PanelComp = { render, makeHtml, scopeCss, esc, mdi, WIDGETS };
})(typeof window !== 'undefined' ? window : globalThis);
