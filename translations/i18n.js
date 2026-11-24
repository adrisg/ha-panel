/* Panel Hogar — translation engine, shared by the panel and the configuration web.
 * Texts are written in Spanish in the code and translated with t('Texto'). The languages are JSON files in this
 * folder (see README.md): languages.json lists them and each one (en.json…) has its texts and patterns.
 * Strings with numbers or names use patterns: ["^(\\d+) encendidas?$", "$1 on"]; {t:$2} translates a piece.
 * Anything without a translation stays in Spanish. */
(function () {
  const DICTS = {}, PATTERNS = {}, LOCALES = {};
  // The panel reads them from the Pi's helper (it runs from file://); the web, from its own server.
  const BASE = (typeof window !== 'undefined' && window.PANEL_HELPER_URL ? window.PANEL_HELPER_URL : '') + '/translations/';

  function getJSON(name) {   // synchronous on purpose: the texts must be there before the first drawing
    try {
      const x = new XMLHttpRequest();
      x.open('GET', BASE + name, false);
      x.send();
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch (e) { return null; }
  }
  /** {"group": {"Texto": "Text"}} at any depth → {"Texto": "Text"} */
  function flat(obj, out = {}) {
    for (const [k, v] of Object.entries(obj || {})) if (v && typeof v === 'object') flat(v, out); else out[k] = v;
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
      I18N.lang = LANGS[lang] ? lang : 'es';
      load(I18N.lang);
      if (typeof document !== 'undefined') document.documentElement.lang = I18N.lang;
    },
    /** For dates and numbers: toLocaleDateString(I18N.locale(), …) */
    locale() { return LOCALES[I18N.lang] || I18N.lang; },
    t(s, vars) {
      if (typeof s !== 'string' || !s) return s;
      let r = s;
      if (I18N.lang !== 'es') {
        const key = s.trim().replace(/\s+/g, ' '), dict = DICTS[I18N.lang] || {};   // the HTML line breaks don't count
        if (Object.prototype.hasOwnProperty.call(dict, key)) r = s.replace(s.trim(), dict[key]);
        else {
          const p = (PATTERNS[I18N.lang] || []).find(([re]) => re.test(key));
          if (p) r = s.replace(s.trim(), key.replace(p[0], p[1]));
          else if (I18N.missing && /[a-záéíóúñ]{2}/i.test(key) && !/^(mdi|https?):/.test(key)) I18N.missing.add(key);
        }
      }
      if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
      return r;
    },
    /** Translates the static texts of a page (text nodes and title/placeholder) once, after loading */
    page(root) {
      if (I18N.lang === 'es' || typeof document === 'undefined') return;
      const walk = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walk.currentNode; n; n = walk.nextNode()) {
        if (n.nodeType === 3) {
          if (n.parentNode && /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/.test(n.parentNode.nodeName)) continue;
          if (n.nodeValue.trim()) n.nodeValue = I18N.t(n.nodeValue);
        } else for (const a of ['title', 'placeholder', 'aria-label']) if (n.hasAttribute && n.hasAttribute(a)) n.setAttribute(a, I18N.t(n.getAttribute(a)));
      }
    },
  };
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.I18N = I18N;
  g.t = I18N.t;
})();
