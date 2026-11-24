/* Before the panel starts: if the Pi's helper is running, its configuration
 * (the one changed from the web http://<pi>.local:8080) wins over config.js.
 * It is a synchronous request to the Pi itself: if the helper is not there, it fails at once. */
(function () {
  // On the Pi's screen (opened as a file) the pointer is hidden; in test mode (http) it shows
  if (location.protocol === 'file:') document.documentElement.classList.add('kiosk');
  window.PANEL_HELPER = null;
  // Opened from another computer (python dev.py --lan): the helper is reached through the server itself
  var remote = location.protocol.indexOf('http') === 0 && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  window.PANEL_HELPER_URL = remote ? location.origin + '/_helper' : 'http://127.0.0.1:8766';
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', window.PANEL_HELPER_URL + '/config', false);
    xhr.send();
    if (xhr.status !== 200) return;
    var cfg = JSON.parse(xhr.responseText);
    window.PANEL_HELPER = cfg;
    // Only when the helper already has a complete configuration (after the first import)
    if (cfg.panel && cfg.panel.haUrl) {
      var merged = {};
      var base = window.PANEL_CONFIG || {};
      for (var k in base) merged[k] = base[k];
      for (var p in cfg.panel) merged[p] = cfg.panel[p];
      window.PANEL_CONFIG = merged;
    }
  } catch (e) { /* no helper: config.js is used as it is */ }
})();
