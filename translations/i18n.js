/* Panel Hogar — translation engine, shared by the panel and the configuration web.
 * The code uses keys: I18N.t('panel.states.on') → «On» / «Encendido». English (en.json) is the base language:
 * a key missing in another language shows the English text. Each language is a JSON file in this folder
 * (see README.md): languages.json lists them, and {"panel": {"states": {"on": "On"}}} is the key panel.states.on.
 * Texts with variables: I18N.t('key', { n: 3 }) and «{n} on».
 * Plain texts that reach t() (static HTML, messages from the Pi's helper, old saved settings in Spanish) are found
 * by their English or Spanish text. Composed ones (from bubble scripts, the helper…) are matched by the language's
 * patterns: ["^(\\d+) on$", "$1 encendidas"] ({t:$2} translates a piece). */
(function () {
  const DICTS = {}, PATTERNS = {}, LOCALES = {};
  // The panel reads them from the Pi's helper (it runs from file://); the web, from its own server.
  const BASE_URL = (typeof window !== 'undefined' && window.PANEL_HELPER_URL ? window.PANEL_HELPER_URL : '') + '/translations/';
  const BASE = 'en';

  function getJSON(name) {   // synchronous on purpose: the texts must be there before the first drawing
    try {
      const x = new XMLHttpRequest();
      x.open('GET', BASE_URL + name, false);
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
    for (const [k, v] of Object.entries(DICTS[lang])) { const n = norm(v); if (!(n in BY_TEXT)) BY_TEXT[n] = k; }
  }
  const norm = (s) => s.trim().replace(/\s+/g, ' ');              // the HTML line breaks don't count
  const BY_TEXT = {};                                              // «On» / «Encendido» → panel.states.on
  const DONE = new Set();                                          // already translated (t of t('…') stays the same)
  const LANGS = getJSON('languages.json') || { en: 'English' };    // {"en": "English", "es": "Español", …}
  load(BASE);
  if (LANGS.es) load('es');                                        // old settings and messages may still be in Spanish
  const EN = DICTS[BASE] || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const I18N = {
    lang: BASE,
    langs: LANGS,
    /** Keys and texts with no translation (the dev tests fill it to find what is missing) */
    missing: null,
    /** 'auto' → the given fallback (Home Assistant's or the browser's language); unknown → English */
    resolve(choice, fallback) {
      const want = choice && choice !== 'auto' ? choice : String(fallback || (typeof navigator !== 'undefined' && navigator.language) || BASE);
      const base = want.slice(0, 2).toLowerCase();
      return LANGS[base] ? base : BASE;
    },
    set(lang) {
      if (lang !== I18N.lang) DONE.clear();
      I18N.lang = LANGS[lang] ? lang : BASE;
      load(I18N.lang);
      if (typeof document !== 'undefined') document.documentElement.lang = I18N.lang;
    },
    /** For dates and numbers: toLocaleDateString(I18N.locale(), …) */
    locale() { return LOCALES[I18N.lang] || I18N.lang; },
    /** Is it a translation key (and not a text)? */
    isKey(s) { return typeof s === 'string' && has(EN, s); },
    t(s, vars) {
      if (typeof s !== 'string' || !s) return s;
      const n = norm(s), dict = DICTS[I18N.lang] || EN;
      let key = has(EN, n) ? n : BY_TEXT[n];
      let r = s;
      if (!key) {   // «🔊 Sonido»: an emoji or symbol before a known text
        const m = /^([^\p{L}\p{N}\s]+\s+)(.+)$/u.exec(n);
        const k = m && (has(EN, m[2]) ? m[2] : BY_TEXT[m[2]]);
        if (k) return s.replace(s.trim(), m[1] + I18N.t(k, vars));
      }
      if (key) {
        const out = has(dict, key) ? dict[key] : EN[key];
        if (!has(dict, key) && I18N.missing) I18N.missing.add(key);
        r = s.replace(s.trim(), out);
        DONE.add(norm(out));
      } else if (!DONE.has(n)) {
        const p = (PATTERNS[I18N.lang] || []).find(([re]) => re.test(n));
        if (p) { r = s.replace(s.trim(), n.replace(p[0], p[1])); DONE.add(norm(r)); }
        else if (I18N.missing && I18N.lang !== BASE && /[a-záéíóúñ]{2}/i.test(n) && !/^(mdi|https?):/.test(n)) I18N.missing.add(n);
      }
      if (vars) {
        r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
        if (key) {
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
