/* Antes de arrancar el panel: si el ayudante de la Pi está en marcha, su configuración
 * (la que se cambia desde la web http://<pi>.local:8080) manda sobre config.js.
 * Es una petición síncrona a la propia Pi: si el ayudante no está, falla al instante. */
(function () {
  window.PANEL_HELPER = null;
  // Abierto desde otro equipo (python dev.py --lan): al ayudante se llega a través del propio servidor
  var remote = location.protocol.indexOf('http') === 0 && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  window.PANEL_HELPER_URL = remote ? location.origin + '/_helper' : 'http://127.0.0.1:8766';
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', window.PANEL_HELPER_URL + '/config', false);
    xhr.send();
    if (xhr.status !== 200) return;
    var cfg = JSON.parse(xhr.responseText);
    window.PANEL_HELPER = cfg;
    // Solo cuando el ayudante ya tiene una configuración completa (tras la primera importación)
    if (cfg.panel && cfg.panel.haUrl) {
      var merged = {};
      var base = window.PANEL_CONFIG || {};
      for (var k in base) merged[k] = base[k];
      for (var p in cfg.panel) merged[p] = cfg.panel[p];
      window.PANEL_CONFIG = merged;
    }
  } catch (e) { /* sin ayudante: se usa config.js tal cual */ }
})();
