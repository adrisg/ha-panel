/* Panel Hogar — translation engine, shared by the panel and the configuration web.
 * The code uses keys: t('panel.states.on') → «Encendido» / «On». Each language is a JSON file in this folder
 * (see README.md): languages.json lists them; es.json and en.json have the same keys, grouped
 * ({"panel": {"states": {"on": "On"}}} is the key panel.states.on). Texts with variables: t('key', { n: 3 }) and «{n} on».
 * Spanish texts that still reach t() (from the helper, old saved settings…) are found by their Spanish text;
 * a few composed ones are matched by patterns: ["^(\\d+) encendidas?$", "$1 on"] ({t:$2} translates a piece).
 * A key missing in a language shows the Spanish text. */
(function () {
  const DICTS = {}, PATTERNS = {}, LOCALES = {};
  // The panel reads them from the Pi's helper (it runs from file://); the web, from its own server.
  const BASE = (typeof window !== 'undefined' && window.PANEL_HELPER_URL ? window.PANEL_HELPER_URL : '') + '/translations/';
  const KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;

  function getJSON(name) {   // synchronous on purpose: the texts must be there before the first drawing
    try {
      const x = new XMLHttpRequest();
      x.open('GET', BASE + name, false);
      x.send();
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch (e) { return null; }
  }
  /** {"panel": {"states": {"on": "On"}}} → {"panel.states.on": "On"} */
  function flat(obj, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object') flat(v, prefix + k + '.', out); else out[prefix + k] = v;
    }
    return out;
  }
  /** "Copy «{t:$1}»" → the group translated; "$1" → as it is */
  function replacer(repl) {
    return (...m) => repl.replace(/\{t:\$(\d)\}|\$(\d)/g, (x, tn, n) => (tn ? I18N.t(m[+tn] || '') : m[+n] || ''));
  }
  function load(lang) {
    if (DICTS[lang] || !LANGS[lang]) return;
    const data = getJSON(lang + '.json') || {};
    DICTS[lang] = flat(data.texts);
    LOCALES[lang] = data.locale || lang;
    const pats = Array.isArray(data.patterns) ? data.patterns : [].concat(...Object.values(data.patterns || {}));
    PATTERNS[lang] = [];
    for (const [re, repl, flags] of pats) {
      try { PATTERNS[lang].push([new RegExp(re, flags || ''), replacer(repl)]); } catch (e) { console.warn('translations:', lang, re, e.message); }
    }
  }
  const LANGS = getJSON('languages.json') || { es: 'Español' };   // {"es": "Español", "en": "English", …}
  load('es');
  const ES = DICTS.es || {};
  const BY_TEXT = {};                                              // «Encendido» → panel.states.on
  for (const [k, v] of Object.entries(ES)) if (!(v in BY_TEXT)) BY_TEXT[v] = k;
  const norm = (s) => s.trim().replace(/\s+/g, ' ');              // the HTML line breaks don't count
  const DONE = new Set();

  const I18N = {
    lang: 'es',
    langs: LANGS,
    /** Texts with no translation (the dev tests fill it to find what is missing) */
    missing: null,
    /** 'auto' → the given fallback (Home Assistant's or the browser's language) */
    resolve(choice, fallback) {
      const want = choice && choice !== 'auto' ? choice : String(fallback || navigator.language || 'es');
      const base = want.slice(0, 2).toLowerCase();
      return LANGS[base] ? base : LANGS.en ? 'en' : 'es';
    },
    set(lang) {
      if (lang !== I18N.lang) DONE.clear();
      I18N.lang = LANGS[lang] ? lang : 'es';
      load(I18N.lang);
      if (typeof document !== 'undefined') document.documentElement.lang = I18N.lang;
    },
    /** For dates and numbers: toLocaleDateString(I18N.locale(), …) */
    locale() { return LOCALES[I18N.lang] || I18N.lang; },
    /** Is it a translation key (and not a text)? */
    isKey(s) { return typeof s === 'string' && KEY.test(s) && Object.prototype.hasOwnProperty.call(ES, s); },
    t(s, vars) {
      if (typeof s !== 'string' || !s) return s;
      const n = norm(s), dict = DICTS[I18N.lang] || ES;
      const key = Object.prototype.hasOwnProperty.call(ES, n) ? n : BY_TEXT[n];
      let r = s;
      if (key) {
        const out = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : ES[key];
        if (out !== dict[key] && I18N.missing) I18N.missing.add(key);
        r = s.replace(s.trim(), out);
        if (I18N.lang !== 'es') DONE.add(norm(out));
      } else if (I18N.lang !== 'es' && !DONE.has(n)) {   // DONE: already translated (t of t('…') stays the same)
        const p = (PATTERNS[I18N.lang] || []).find(([re]) => re.test(n));
        if (p) { r = s.replace(s.trim(), n.replace(p[0], p[1])); DONE.add(norm(r)); }
        else if (I18N.missing && /[a-záéíóúñ]{2}/i.test(n) && !/^(mdi|https?):/.test(n)) I18N.missing.add(n);
      }
      if (vars) {
        r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
        if (key && I18N.lang !== 'es') {
          if (DONE.size > 5000) DONE.clear();   // texts with numbers: don't let it grow forever
          DONE.add(norm(r));
        }
      }
      return r;
    },
    /** Translates the static texts of a page once, after loading: elements with data-i18n="key", the other
     * text nodes and title/placeholder/aria-label */
    page(root) {
      if (typeof document === 'undefined') return;
      root = root || document.body;
      for (const e of (root.querySelectorAll ? root.querySelectorAll('[data-i18n]') : [])) e.textContent = I18N.t(e.dataset.i18n);
      if (I18N.lang === 'es') return;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walk.currentNode; n; n = walk.nextNode()) {
        if (n.nodeType === 3) {
          if (n.parentNode && /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/.test(n.parentNode.nodeName)) continue;
          if (n.parentNode && n.parentNode.dataset && n.parentNode.dataset.i18n) continue;
          if (n.nodeValue.trim()) n.nodeValue = I18N.t(n.nodeValue);
        } else for (const a of ['title', 'placeholder', 'aria-label']) if (n.hasAttribute && n.hasAttribute(a)) n.setAttribute(a, I18N.t(n.getAttribute(a)));
      }
    },
  };
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.I18N = I18N;
  g.t = I18N.t;
})();
