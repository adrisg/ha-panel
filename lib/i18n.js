/* Panel Hogar — translations, shared by the panel and the configuration web.
 * Texts are written in Spanish in the code and translated with t('Texto'). Each language is a file
 * (lib/i18n-en.js…) that calls I18N.add('en', { 'Texto': 'Text' }, [[/^(\d+) encendidas?$/, '$1 on']]).
 * Strings with numbers or names use patterns (regex → replacement). Anything without a translation stays in Spanish. */
(function () {
  const DICTS = {}, PATTERNS = {};
  const LANGS = { es: 'Español', en: 'English' };
  const I18N = {
    lang: 'es',
    langs: LANGS,
    /** Texts with no translation (the dev tests fill it to find what is missing) */
    missing: null,
    add(lang, dict, patterns) {
      DICTS[lang] = Object.assign(DICTS[lang] || {}, dict || {});
      PATTERNS[lang] = (PATTERNS[lang] || []).concat(patterns || []);
    },
    /** 'auto' → the given fallback (Home Assistant's or the browser's language) */
    resolve(choice, fallback) {
      const want = choice && choice !== 'auto' ? choice : String(fallback || navigator.language || 'es');
      return want.slice(0, 2).toLowerCase() === 'es' ? 'es' : LANGS[want.slice(0, 2)] ? want.slice(0, 2) : 'en';
    },
    set(lang) {
      I18N.lang = LANGS[lang] ? lang : 'es';
      if (typeof document !== 'undefined') document.documentElement.lang = I18N.lang;
    },
    /** For dates and numbers: toLocaleDateString(I18N.locale(), …) */
    locale() { return I18N.lang === 'es' ? 'es-ES' : I18N.lang === 'en' ? 'en-GB' : I18N.lang; },
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
