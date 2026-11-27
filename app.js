/* Panel Hogar — a panel of your own for Home Assistant (WebSocket API), Nest Hub style.
 * No frameworks: plain JS so it runs smoothly on a Raspberry Pi 2. */
'use strict';

const CFG = Object.assign({
  haUrl: '', token: '', idleSeconds: 90, favorites: [], hiddenEntities: [], weatherEntity: '',
  ambientPhotos: [], photoSeconds: 30, night: { start: '23:00', end: '07:00', dim: 0.6 },
  cameraRefreshSeconds: 10, scooterPlatform: 'mi_scooter_ble', hideCursor: true,
  hideUnavailable: true, excludePlatforms: [],
  sensorClasses: ['temperature', 'humidity', 'power', 'energy', 'battery', 'illuminance', 'carbon_dioxide', 'pm25',
    'door', 'window', 'garage_door', 'opening', 'motion', 'occupancy', 'presence', 'moisture', 'smoke', 'gas',
    'carbon_monoxide', 'safety', 'problem'],
}, window.PANEL_CONFIG || {});
CFG.haUrl = (CFG.haUrl || '').replace(/\/+$/, '');
const PARAMS = new URLSearchParams(location.search);
// With no address or no token there is nothing to show: it shows how to connect it
const NEEDS_SETUP = !CFG.haUrl || !CFG.token || CFG.token === 'PEGA_AQUI_TU_TOKEN';

/* ====================== Utilidades ====================== */
const $ = (s) => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : (k === 'title' || k === 'placeholder' ? t(v) : v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(typeof c === 'string' ? t(c) : String(c)));   // textos traducidos (translations/)
  }
  return el;
}
const icon = (name, cls = '') => h('i', { class: `mdi ${name} ${cls}` });
const domain = (id) => id.split('.')[0];
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const fmtNum = (n) => {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString(I18N.locale())
    : (Math.round(n * 10) / 10).toLocaleString(I18N.locale());
};
const absUrl = (p) => !p ? '' : /^(https?:|data:|blob:)/.test(p) ? p : CFG.haUrl + p;
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return I18N.t('panel.sheets.just_now');
  if (s < 3600) return I18N.t('panel.time.minutes_ago', { n: Math.round(s / 60) });
  if (s < 86400) return I18N.t('panel.time.hours_ago', { n: Math.round(s / 3600) });
  return I18N.t('panel.time.days_ago', { n: Math.round(s / 86400) });
}
function fmtDuration(sec) {
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
  return hh ? `${hh} h ${mm} min` : `${mm} min`;
}
const hhmm = (d) => d.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' });
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = I18N.t(msg);
  t.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast' + (error ? ' error' : '')), 2600);
}

/* ====================== Connection to Home Assistant ====================== */
class HAConn {
  constructor(url, token) {
    this.url = url; this.token = token; this.id = 1;
    this.pending = new Map(); this.subs = new Map(); this.backoff = 1000;
    this.onstatus = () => {}; this.onready = () => {};
  }
  connect() {
    let ws;
    try { ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/api/websocket'); }
    catch (e) { this.onstatus(false, e.message); return; }
    this.ws = ws;
    ws.onmessage = (e) => this.handle(JSON.parse(e.data));
    ws.onclose = () => {
      clearInterval(this.ping);
      this.onstatus(false);
      for (const p of this.pending.values()) p.reject(new Error(I18N.t('panel.status.connection_lost')));
      this.pending.clear(); this.subs.clear();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  }
  handle(m) {
    if (m.type === 'auth_required') {
      this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
    } else if (m.type === 'auth_ok') {
      this.backoff = 1000; this.id = 1;
      this.onstatus(true);
      this.ping = setInterval(() => this.send({ type: 'ping' }).catch(() => {}), 30000);
      this.onready();
    } else if (m.type === 'auth_invalid') {
      this.onstatus(false, I18N.t('panel.status.invalid_token'));
    } else if (m.type === 'result' || m.type === 'pong') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'pong' || m.success) p.resolve(m.result);
      else p.reject(new Error((m.error && m.error.message) || I18N.t('panel.states.error')));
    } else if (m.type === 'event') {
      const cb = this.subs.get(m.id);
      if (cb) cb(m.event);
    }
  }
  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error(I18N.t('panel.status.offline')));
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(Object.assign({}, msg, { id })));
    });
  }
  subscribe(eventType, cb) {
    this.subs.set(this.id, cb);
    return this.send({ type: 'subscribe_events', event_type: eventType });
  }
}

const conn = new HAConn(CFG.haUrl, CFG.token);

const api = {
  callService(dom, service, data, entityId, returnResponse) {
    return conn.send({
      type: 'call_service', domain: dom, service, service_data: data || {},
      target: entityId ? { entity_id: entityId } : undefined,
      return_response: returnResponse || undefined,
    });
  },
  async history(id, hours) {
    const start = new Date(Date.now() - hours * 3600e3).toISOString();
    const res = await conn.send({
      type: 'history/history_during_period', start_time: start, entity_ids: [id],
      minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    return (res[id] || []).map((p) => ({ t: (p.lu || p.lc) * 1000, s: p.s }));
  },
};

/** Calls a service; if it fails it says so and paints the real state again. */
function call(dom, service, data, id, returnResponse) {
  return api.callService(dom, service, data, id, returnResponse).catch((e) => {
    toast(I18N.t('panel.status.error_prefix') + e.message, true);
    if (id) fire(id);
    return null;
  });
}

/* ====================== Estado ====================== */
const S = {
  states: {}, ents: {}, devs: {}, areas: [], areaById: {}, vacuumDevs: new Set(),
  view: 'home', sheetId: null, ambient: false, connected: false,
  viewTimers: [], sheetTimers: [], forecast: null, forecastAt: 0,
};
// Entity → functions that repaint part of the screen (by "scope")
const B = { view: new Map(), sheet: new Map(), np: new Map(), shade: new Map() };
function bind(scope, id, fn) {
  if (!id) return;
  const m = B[scope];
  if (!m.has(id)) m.set(id, []);
  m.get(id).push(fn);
  try { fn(S.states[id]); } catch (e) { console.error(e); }
}
function bindMany(scope, ids, fn) {
  ids = ids.filter(Boolean);
  ids.forEach((id) => { const m = B[scope]; if (!m.has(id)) m.set(id, []); m.get(id).push(fn); });
  try { fn(); } catch (e) { console.error(e); }
}
function fire(id) {
  const st = S.states[id];
  for (const m of Object.values(B)) {
    const fns = m.get(id);
    if (fns) fns.forEach((f) => { try { f(st); } catch (e) { console.error(e); } });
  }
}
let structTimer, ambTimer;
function setState(id, st) {
  const isNew = !(id in S.states), old = S.states[id];
  if (st) S.states[id] = st; else delete S.states[id];
  fire(id);
  onPrinterStatus(id, old, st);
  // If a player starts or stops having something, the Media view is reordered
  if (S.view === 'media' && domain(id) === 'media_player' && mediaRank(old) !== mediaRank(st)) {
    clearTimeout(structTimer);
    structTimer = setTimeout(() => !S.sheetId && render(), 1500);
  }
  onSpeaker(id, old, st);
  onVolumeChange(id, st);
  if (SH.sync) SH.sync(id);
  if (id === SET.voiceSatellite) onVoiceSat(old, st);
  markCode(id);
  clearTimeout(ambTimer);
  ambTimer = setTimeout(paintBullets, 500);
  if (isNew || !st) { clearTimeout(structTimer); structTimer = setTimeout(() => !S.sheetId && render(), 1500); }
}

const reg = (id) => S.ents[id] || {};
function deviceOf(id) { return S.devs[reg(id).device_id]; }
function areaOf(id) {
  const e = reg(id);
  if (e.area_id) return e.area_id;
  const d = deviceOf(id);
  return (d && d.area_id) || null;
}
function isScooter(id) { return reg(id).platform === CFG.scooterPlatform; }
// Domains whose normal state is "unknown" (they must not be hidden because of it)
const STATELESS = ['scene', 'script', 'button', 'input_button', 'camera'];
function visible(id) {
  const e = reg(id), st = S.states[id], d = domain(id);
  if (!st || e.hidden_by || e.disabled_by || e.entity_category) return false;
  if (st.attributes.hidden || CFG.hiddenEntities.includes(id)) return false;
  if (CFG.favorites.includes(id)) return true;
  if (CFG.hideUnavailable && (st.state === 'unavailable' || st.state === 'unknown') && !STATELESS.includes(d)) return false;
  if (/_permit_join$/.test(id)) return false;          // Zigbee: "permitir emparejar"
  if (d !== 'camera') {
    if (CFG.excludePlatforms.includes(e.platform)) return false;
    // Of a vacuum only the vacuum entity itself matters, not its dozens of settings
    if (d !== 'vacuum' && e.device_id && S.vacuumDevs.has(e.device_id)) return false;
  }
  return true;
}
// Names that say nothing without the device in front ("Light", "Temperature"…)
const GENERIC = new Set(['light', 'luz', 'switch', 'interruptor', 'media player', 'reproductor', 'fan', 'ventilador',
  'temperature', 'temperatura', 'humidity', 'humedad', 'power', 'potencia', 'energy', 'energía', 'battery',
  'batería', 'battery level', 'nivel de batería', 'door', 'puerta', 'contact', 'contacto', 'window', 'ventana',
  'camera', 'cámara', 'motion', 'movimiento', 'occupancy', 'ocupación', 'lock', 'cerradura']);
function nameOf(id, strip = true) {
  const st = S.states[id];
  let n = ((st && st.attributes.friendly_name) || id).trim();
  if (strip) {
    const d = deviceOf(id), a = S.areaById[areaOf(id)];
    const dn = d && (d.name_by_user || d.name);
    const rest = (p) => (p && n.toLowerCase().startsWith(p.toLowerCase() + ' ') && n.length > p.length + 1) ? n.slice(p.length + 1) : null;
    const r = rest(dn);
    if (r && !GENERIC.has(r.toLowerCase())) n = r;
    const r2 = rest(a && a.name);
    if (r2) n = r2;
  }
  // Cleans odd names from some integrations: double spaces and “Maripili  Maripili”
  n = n.replace(/\s+/g, ' ').trim();
  const twice = n.match(/^(.+) \1$/i);
  if (twice) n = twice[1];
  return cap(n);
}
/** Order of the players: 0 playing · 1 paused with content · 2 on with something · 3 on and empty · 4 off · 5 unavailable */
function mediaRank(st) {
  if (!st) return 9;
  const a = st.attributes, s = st.state, has = !!(a.media_title || a.entity_picture);
  if (s === 'playing') return 0;
  if ((s === 'paused' || s === 'buffering') && has) return 1;
  if (has && !['off', 'standby', 'unavailable', 'unknown'].includes(s)) return 2;
  if (['idle', 'on', 'paused', 'buffering'].includes(s)) return 3;
  if (s === 'off' || s === 'standby') return 4;
  return 5;
}

/** Removes repeated players (the same TV through Cast, Android TV, Music Assistant…). */
function dedupeMedia(list) {
  const score = (id) => (S.states[id].state !== 'unavailable' ? 2 : 0) + (areaOf(id) ? 1 : 0);
  const best = new Map();
  for (const id of list) {
    if (domain(id) !== 'media_player') continue;
    const k = nameOf(id, false).toLowerCase();
    if (!best.has(k) || score(id) > score(best.get(k))) best.set(k, id);
  }
  const keep = new Set(best.values());
  return list.filter((id) => domain(id) !== 'media_player' || keep.has(id));
}

/* ====================== Textos e iconos ====================== */
const T_KEYS = {
  on: 'panel.states.on', off: 'panel.states.off', unavailable: 'panel.states.unavailable', unknown: '—', open: 'panel.states.open',
  closed: 'panel.states.closed', opening: 'panel.states.opening', closing: 'panel.states.closing', locked: 'panel.states.locked',
  unlocked: 'panel.states.open', locking: 'panel.states.locking', unlocking: 'panel.states.unlocking', jammed: 'panel.states.jammed',
  playing: 'panel.states.playing', paused: 'panel.states.paused', idle: 'panel.states.idle', standby: 'panel.states.standby',
  buffering: 'panel.states.loading', home: 'panel.states.home', not_home: 'panel.states.away', heat: 'panel.states.heat', cool: 'panel.states.cool',
  auto: 'panel.states.auto', heat_cool: 'panel.states.heat_cool', dry: 'panel.states.dry', fan_only: 'panel.states.fan',
  cleaning: 'panel.states.cleaning', docked: 'panel.states.docked', returning: 'panel.states.returning', error: 'panel.states.error',
};
/** States in the panel language (T.on → “On” / “Encendido”). */
const T = new Proxy(T_KEYS, { get: (o, k) => (o[k] != null ? t(o[k]) : undefined) });
const BIN = {
  door: ['panel.states.closed_f', 'panel.states.open_f'], window: ['panel.states.closed_f', 'panel.states.open_f'], garage_door: ['panel.states.closed_f', 'panel.states.open_f'],
  opening: ['panel.states.closed', 'panel.states.open'], motion: ['panel.settings.no_motion', 'panel.settings.motion'], occupancy: ['panel.states.clear', 'panel.states.occupied'],
  presence: ['panel.states.away', 'panel.states.present'], moisture: ['panel.states.dry_state', 'panel.states.leak'], smoke: ['panel.states.ok', 'panel.states.smoke'],
  gas: ['panel.states.ok', 'panel.states.gas'], connectivity: ['panel.states.disconnected', 'panel.settings.connected'], battery_charging: ['panel.states.not_charging', 'panel.states.loading'],
  plug: ['panel.states.unplugged', 'panel.states.plugged_in'], lock: ['panel.states.closed', 'panel.states.open'], moving: ['panel.states.stopped', 'panel.states.moving'],
  power: ['panel.states.off', 'panel.states.on'], problem: ['panel.states.ok', 'panel.states.problem'], battery: ['panel.states.normal', 'panel.states.battery_low'],
};
const ALERT_BIN = ['moisture', 'smoke', 'gas', 'problem', 'safety', 'carbon_monoxide'];
const DOMAIN_ICON = {
  light: 'mdi-lightbulb', switch: 'mdi-toggle-switch-variant', fan: 'mdi-fan', cover: 'mdi-window-shutter',
  climate: 'mdi-thermostat', lock: 'mdi-lock', media_player: 'mdi-speaker', camera: 'mdi-cctv',
  scene: 'mdi-palette', script: 'mdi-script-text-play', vacuum: 'mdi-robot-vacuum', sensor: 'mdi-eye',
  binary_sensor: 'mdi-radiobox-marked', input_boolean: 'mdi-toggle-switch', button: 'mdi-gesture-tap-button',
  number: 'mdi-ray-vertex', weather: 'mdi-weather-partly-cloudy', humidifier: 'mdi-air-humidifier',
  automation: 'mdi-robot',
};
const DC_ICON = {
  temperature: 'mdi-thermometer', humidity: 'mdi-water-percent', power: 'mdi-flash', energy: 'mdi-lightning-bolt',
  battery: 'mdi-battery', illuminance: 'mdi-brightness-5', pressure: 'mdi-gauge', carbon_dioxide: 'mdi-molecule-co2',
  window: 'mdi-window-closed-variant', motion: 'mdi-motion-sensor', occupancy: 'mdi-home-account',
  moisture: 'mdi-water-alert', smoke: 'mdi-smoke-detector', voltage: 'mdi-sine-wave', current: 'mdi-current-ac',
  pm25: 'mdi-blur', presence: 'mdi-account', connectivity: 'mdi-wifi', plug: 'mdi-power-plug', outlet: 'mdi-power-socket-eu',
  distance: 'mdi-map-marker-distance', speed: 'mdi-speedometer', duration: 'mdi-timer-outline', timestamp: 'mdi-clock-outline',
  tv: 'mdi-television', speaker: 'mdi-speaker', gas: 'mdi-gas-cylinder', problem: 'mdi-alert-circle',
  battery_charging: 'mdi-battery-charging', moving: 'mdi-run',
};
function iconOf(st) {
  if (!st) return 'mdi-help-circle-outline';
  const a = st.attributes, d = domain(st.entity_id), s = st.state;
  if (d === 'vacuum') return s === 'error' ? 'mdi-robot-vacuum-alert' : 'mdi-robot-vacuum';   // without the integration's “zzz”
  if (a.icon) return a.icon.replace('mdi:', 'mdi-');
  if (d === 'light') return s === 'on' ? 'mdi-lightbulb-on' : 'mdi-lightbulb-outline';
  if (d === 'lock') return s === 'locked' ? 'mdi-lock' : s === 'unavailable' || s === 'unknown' ? 'mdi-lock-question' : 'mdi-lock-open-variant';
  if (d === 'cover') return s === 'closed' ? 'mdi-window-shutter' : 'mdi-window-shutter-open';
  if (d === 'binary_sensor' && ['door', 'garage_door', 'opening'].includes(a.device_class))
    return s === 'on' ? 'mdi-door-open' : 'mdi-door-closed';
  if (d === 'binary_sensor' && a.device_class === 'window')
    return s === 'on' ? 'mdi-window-open-variant' : 'mdi-window-closed-variant';
  if (d === 'sensor' && a.device_class === 'battery') {
    const n = Math.round(parseFloat(s) / 10) * 10;
    return isNaN(n) ? 'mdi-battery' : n >= 100 ? 'mdi-battery' : n <= 0 ? 'mdi-battery-outline' : 'mdi-battery-' + n;
  }
  if (d === 'media_player' && a.device_class === 'tv') return 'mdi-television';
  if (d === 'media_player' && (a.group_members || []).length > 1) return 'mdi-speaker-multiple';   // a speaker group
  return DC_ICON[a.device_class] || DOMAIN_ICON[d] || 'mdi-help-circle-outline';
}
/** Text of an entity state, already translated. */
const fmtState = (st) => I18N.t(fmtStateRaw(st));
function fmtStateRaw(st) {
  if (!st) return '—';
  const s = st.state, a = st.attributes, d = domain(st.entity_id);
  if (s === 'unavailable' || s === 'unknown') return T[s];
  if (d === 'binary_sensor' && BIN[a.device_class]) return BIN[a.device_class][s === 'on' ? 1 : 0];
  if (['sensor', 'number', 'input_number'].includes(d)) {
    if (a.device_class === 'timestamp') return relTime(s);
    const n = Number(s);
    if (s !== '' && !isNaN(n)) {
      if (a.device_class === 'duration' && a.unit_of_measurement === 's') return fmtDuration(n);
      return fmtNum(n) + (a.unit_of_measurement ? (a.unit_of_measurement === '%' ? ' %' : ' ' + a.unit_of_measurement) : '');
    }
    return cap(s);
  }
  if (d === 'light' && s === 'on' && a.brightness != null) return Math.round(a.brightness / 2.55) + ' %';
  if (d === 'fan' && s === 'on' && a.percentage != null) return a.percentage + ' %';
  if (d === 'climate') {
    const parts = [];
    if (a.current_temperature != null) parts.push(fmtNum(a.current_temperature) + '°');
    parts.push(s === 'off' ? I18N.t('panel.states.off') : (T[s] || s) + (a.temperature != null ? ' → ' + fmtNum(a.temperature) + '°' : ''));
    return parts.join(' · ');
  }
  if (d === 'cover' && s === 'open' && a.current_position != null) return I18N.t('panel.states.open_percent', { n: a.current_position });
  if (d === 'media_player' && (s === 'playing' || s === 'paused') && a.media_title) return a.media_title;
  if (d === 'vacuum') {
    const b = a.battery_level ?? a.battery;
    if (a.charging) return b != null ? I18N.t('panel.states.charging_percent', { n: b }) : I18N.t('panel.states.charging');
    return (T[s] || cap(s)) + (b != null ? ` · ${b} %` : '');
  }
  if (['scene', 'script', 'button', 'input_button'].includes(d)) return I18N.t('panel.states.tap_run');
  return T[s] || cap(s);
}
const ACTIVE = ['on', 'open', 'opening', 'closing', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning', 'returning'];
const isActive = (st) => !!st && ACTIVE.includes(st.state);
const KIND = { light: 'light', climate: 'climate', media_player: 'media', cover: 'cover', lock: 'lock', fan: 'climate' };
const kindOf = (d) => KIND[d] || 'default';

const W = {
  'clear-night': ['mdi-weather-night', 'panel.weather.clear'], cloudy: ['mdi-weather-cloudy', 'panel.weather.cloudy'],
  exceptional: ['mdi-alert-circle-outline', 'panel.weather.exceptional'], fog: ['mdi-weather-fog', 'panel.weather.fog'],
  hail: ['mdi-weather-hail', 'panel.weather.hail'], lightning: ['mdi-weather-lightning', 'panel.weather.thunderstorm'],
  'lightning-rainy': ['mdi-weather-lightning-rainy', 'panel.weather.thunderstorm_rain'],
  partlycloudy: ['mdi-weather-partly-cloudy', 'panel.weather.partly_cloudy'], pouring: ['mdi-weather-pouring', 'panel.weather.heavy_rain'],
  rainy: ['mdi-weather-rainy', 'panel.weather.rain'], snowy: ['mdi-weather-snowy', 'panel.weather.snow'],
  'snowy-rainy': ['mdi-weather-snowy-rainy', 'panel.weather.sleet'], sunny: ['mdi-weather-sunny', 'panel.weather.sunny'],
  windy: ['mdi-weather-windy', 'panel.weather.windy'], 'windy-variant': ['mdi-weather-windy-variant', 'panel.weather.windy_cloudy'],
};
const wIcon = (c) => (W[c] || ['mdi-weather-partly-cloudy'])[0];
const wText = (c) => I18N.t((W[c] || [0, cap(c || '')])[1]);
const weatherId = () => (CFG.weatherEntity && S.states[CFG.weatherEntity]) ? CFG.weatherEntity
  : Object.keys(S.states).find((id) => domain(id) === 'weather');

const FORECASTS = {};      // forecast per weather entity: { id: { list, t } }
async function getForecast(id = weatherId()) {
  if (!id || !S.states[id]) return [];
  const c = FORECASTS[id];
  if (c && S.forecastAt && Date.now() - c.t < 30 * 60e3) return c.list;
  let list;
  try {
    const r = await api.callService('weather', 'get_forecasts', { type: 'daily' }, id, true);
    list = (r && r.response && r.response[id] && r.response[id].forecast) || [];
  } catch (e) {
    list = S.states[id].attributes.forecast || [];
  }
  FORECASTS[id] = { list, t: Date.now() };
  S.forecastAt = Date.now();
  return list;
}

/* ====================== Componentes ====================== */
/** Short tap / long press, without firing when scrolling. */
function pressable(el, onTap, onLong) {
  let timer = null, long = false, sx = 0, sy = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    long = false; sx = e.clientX; sy = e.clientY;
    if (onLong) timer = setTimeout(() => { long = true; timer = null; onLong(); }, 550);
  });
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel(); });
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', (e) => { cancel(); if (long) { e.preventDefault(); return; } onTap && onTap(); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

const TOGGLE = ['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren', 'humidifier', 'cover'];
const HAS_SHEET = ['light', 'fan', 'cover', 'climate', 'media_player', 'lock', 'vacuum', 'camera', 'sensor', 'binary_sensor',
  'switch', 'input_boolean', 'automation', 'siren', 'humidifier', 'weather'];

function tap(id, el) {
  const d = domain(id);
  // A switch with no connection is not turned on: its details open (or it says so)
  if (S.states[id] && S.states[id].state === 'unavailable' && TOGGLE.includes(d)) {
    if (HAS_SHEET.includes(d)) openSheet(id); else toast(I18N.t('panel.status.not_available', { name: nameOf(id) }), true);
    return;
  }
  if (TOGGLE.includes(d)) {
    el.classList.add('pending');
    el.classList.toggle('on');
    toggleChecked(d, id, el);
    return;
  }
  if (d === 'scene') return call('scene', 'turn_on', {}, id).then((r) => r !== null && toast(I18N.t('panel.states.scene_activated')));
  if (d === 'script') return call('script', 'turn_on', {}, id).then((r) => r !== null && toast(I18N.t('panel.states.running')));
  if (d === 'button' || d === 'input_button') return call(d, 'press', {}, id).then((r) => r !== null && toast(I18N.t('panel.states.done')));
  openSheet(id);
}

/* ---------- Real colour of the lights ----------
 * A light that is on paints its tile with its own colour: the RGB if it has it, or the warm/cold white
 * of its colour temperature. The text goes dark or light depending on how bright the background is. */
function kelvinToRgb(k) {          // Tanner Helland's approximation
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}
function lightColor(st) {
  const a = st.attributes;
  if (Array.isArray(a.rgb_color)) return a.rgb_color;
  if (a.color_temp_kelvin) return kelvinToRgb(a.color_temp_kelvin);
  if (Array.isArray(a.hs_color)) {                          // in case it only gives hue/saturation
    const [hh, ss] = a.hs_color, c = ss / 100, x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((v) => Math.round((v + (1 - c)) * 255));
  }
  return null;                                               // no colour: the usual yellow stays
}
function paintLight(el, st) {
  const rgb = st && domain(st.entity_id) === 'light' && st.state === 'on' && lightColor(st);
  if (!rgb) { el.style.removeProperty('background'); el.style.removeProperty('color'); return; }
  // Softened a bit towards white so it reads well and does not dazzle
  const soft = rgb.map((v) => Math.round(v * 0.8 + 255 * 0.2));
  const lum = (0.2126 * soft[0] + 0.7152 * soft[1] + 0.0722 * soft[2]) / 255;
  el.style.background = `rgb(${soft.join(',')})`;
  el.style.color = lum > 0.55 ? '#1d1a12' : '#fff';
}

function tile(id, scope = 'view') {
  const ic = h('div', { class: 'tile-icon' }), nm = h('div', { class: 'tile-name' }), stt = h('div', { class: 'tile-state' });
  const el = h('button', { class: 'tile' }, ic, h('div', { class: 'tile-text' }, nm, stt));
  const d = domain(id);
  el.dataset.kind = kindOf(d);
  bind(scope, id, (st) => {
    if (!st) { el.classList.add('unavail'); return; }
    ic.replaceChildren(icon(iconOf(st)));
    nm.textContent = nameOf(id);
    stt.textContent = fmtState(st);
    el.classList.toggle('on', isActive(st));
    el.classList.toggle('unavail', st.state === 'unavailable');
    el.classList.toggle('charging', d === 'vacuum' && !!st.attributes.charging);
    el.classList.remove('pending');
    paintLight(el, st);
  });
  pressable(el, () => tap(id, el), HAS_SHEET.includes(d) ? () => openSheet(id) : null);
  return el;
}

function sensorTile(id, scope = 'view') {
  const top = h('div', { class: 'tile-top' }), val = h('div', { class: 'tile-value' });
  const el = h('button', { class: 'tile sensor' }, top, val);
  bind(scope, id, (st) => {
    if (!st) return;
    top.replaceChildren(icon(iconOf(st)), h('span', null, nameOf(id)));
    val.textContent = fmtState(st);
    el.classList.toggle('unavail', st.state === 'unavailable');
    el.classList.toggle('alert', domain(id) === 'binary_sensor' && st.state === 'on' && ALERT_BIN.includes(st.attributes.device_class));
  });
  pressable(el, () => openSheet(id));
  return el;
}

function slider({ min = 0, max = 100, step = 1, label, fmt = (v) => v, onchange, cls = '' }) {
  const lab = h('span', { class: 'sl-val' });
  const inp = h('input', { type: 'range', min, max, step, class: 'slider ' + cls });
  let dragging = false;
  const paint = () => inp.style.setProperty('--p', ((inp.value - min) / (max - min)) * 100 + '%');
  inp.addEventListener('input', () => { dragging = true; lab.textContent = fmt(+inp.value); paint(); });
  inp.addEventListener('change', () => { dragging = false; onchange(+inp.value); });
  const wrap = h('div', { class: 'slider-row' }, h('div', { class: 'slider-head' }, h('span', null, label), lab), inp);
  wrap.set = (v) => { if (dragging || v == null) return; inp.value = v; lab.textContent = fmt(v); paint(); };
  return wrap;
}

function cameraImg(id, scope, seconds) {
  const img = h('img', { alt: '' });
  const load = () => {
    const st = S.states[id];
    if (!st || !st.attributes.entity_picture) return;
    const url = absUrl(st.attributes.entity_picture);
    const next = new Image();
    next.onload = () => { img.src = next.src; };
    next.src = url.startsWith('data:') ? url : url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
  };
  load();
  (scope === 'sheet' ? S.sheetTimers : S.viewTimers).push(setInterval(load, seconds * 1000));
  return h('div', { class: 'cam' }, img, h('div', { class: 'cam-label' }, nameOf(id, false)));
}

function mediaCard(id, scope) {
  const art = h('div', { class: 'mc-art' }), title = h('div', { class: 'mc-title' }), sub = h('div', { class: 'mc-sub' });
  const play = h('button', { class: 'round-btn big', onclick: () => call('media_player', 'media_play_pause', {}, id) });
  const rb = (ic, svc) => h('button', { class: 'round-btn', onclick: () => call('media_player', svc, {}, id) }, icon(ic));
  const vol = slider({ label: I18N.t('panel.sheets.volume'), fmt: (v) => v + ' %', onchange: (v) => call('media_player', 'volume_set', { volume_level: v / 100 }, id) });
  const card = h('div', { class: 'media-card' }, art, h('div', { class: 'mc-info' },
    h('div', { class: 'mc-name' }, nameOf(id)), title, sub,
    h('div', { class: 'mc-ctrls' }, rb('mdi-skip-previous', 'media_previous_track'), play, rb('mdi-skip-next', 'media_next_track'), rb('mdi-power', 'toggle')),
    vol));
  let lastPic = null;
  bind(scope, id, (st) => {
    if (!st) return;
    const a = st.attributes;
    title.textContent = a.media_title || T[st.state] || st.state;
    sub.textContent = [a.media_artist, a.media_album_name].filter(Boolean).join(' · ') || a.app_name || a.source || '';
    play.replaceChildren(icon(st.state === 'playing' ? 'mdi-pause' : 'mdi-play'));
    if (a.entity_picture !== lastPic) {
      lastPic = a.entity_picture;
      art.style.backgroundImage = lastPic ? `url("${absUrl(lastPic)}")` : '';
      art.classList.toggle('empty', !lastPic);
    }
    vol.set(Math.round((a.volume_level || 0) * 100));
    card.classList.toggle('off', ['off', 'unavailable', 'standby'].includes(st.state));
  });
  return card;
}

/* ====================== Details sheet (long press) ====================== */
/** Toggle and check that it changed: some devices accept the order but do nothing (a Sonos soundbar's crossfade with
 * the TV source…). If the state is the same 3 s later, it says so and the tile that was tapped (el) goes back to its colour.
 * Two taps in a row (on and off again) are not checked. */
const TOGGLE_WAIT = new Map();
function toggleChecked(d, id, el) {
  if (TOGGLE_WAIT.has(id)) { clearTimeout(TOGGLE_WAIT.get(id)); TOGGLE_WAIT.delete(id); return call(d, 'toggle', {}, id); }
  const before = S.states[id] && S.states[id].state;
  TOGGLE_WAIT.set(id, setTimeout(() => {
    TOGGLE_WAIT.delete(id);
    const st = S.states[id];
    if (!st || st.state !== before || st.state === 'unavailable') return;
    toast(I18N.t('panel.status.not_changed', { name: nameOf(id, false) }), true);
    // the colour changed on tapping (so it answers at once): back to the real one; components too (their repaint does not touch it)
    if (el) { el.classList.remove('pending'); el.classList.toggle('on', isActive(st)); }
    fire(id); markCode(id);
  }, 3000));
  return call(d, 'toggle', {}, id).then((r) => {   // an error already says so itself
    if (r === null && TOGGLE_WAIT.has(id)) {
      clearTimeout(TOGGLE_WAIT.get(id)); TOGGLE_WAIT.delete(id);
      const st = S.states[id];
      if (el && st) { el.classList.remove('pending'); el.classList.toggle('on', isActive(st)); }
    }
    return r;
  });
}
function bigToggle(id) {
  const d = domain(id);
  // changes colour at once (like the tiles); toggleChecked puts it back if the device has not changed in 3 s
  const b = h('button', { class: 'big-toggle', onclick: () => { b.classList.add('pending'); b.classList.toggle('on'); toggleChecked(d, id, b); } });
  b.dataset.kind = kindOf(d);
  bind('sheet', id, (st) => { b.classList.remove('pending'); b.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))); b.classList.toggle('on', isActive(st)); paintLight(b, st); });
  return b;
}
const COLORS = [[255, 147, 41], [255, 214, 170], [255, 255, 255], [255, 80, 80], [255, 60, 180], [150, 90, 255], [60, 130, 255], [40, 210, 200], [80, 220, 100], [255, 220, 60]];

const SHEETS = {
  light(id) {
    const a = S.states[id].attributes, modes = a.supported_color_modes || [];
    const parts = [bigToggle(id)];
    if (modes.some((m) => m !== 'onoff')) {
      const s = slider({ min: 1, label: I18N.t('panel.sheets.brightness'), fmt: (v) => v + ' %', onchange: (v) => call('light', 'turn_on', { brightness_pct: v }, id) });
      bind('sheet', id, (st) => s.set(st.state === 'on' && st.attributes.brightness ? Math.max(1, Math.round(st.attributes.brightness / 2.55)) : 1));
      parts.push(s);
    }
    if (modes.includes('color_temp')) {
      const mn = a.min_color_temp_kelvin || 2000, mx = a.max_color_temp_kelvin || 6500;
      const s = slider({ min: mn, max: mx, step: 50, label: I18N.t('panel.sheets.colour_temperature'), cls: 'warm', fmt: (v) => v + ' K', onchange: (v) => call('light', 'turn_on', { color_temp_kelvin: v }, id) });
      bind('sheet', id, (st) => s.set(st.attributes.color_temp_kelvin || mn));
      parts.push(s);
    }
    if (modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m))) {
      parts.push(h('div', { class: 'swatches' }, COLORS.map((c) =>
        h('button', { class: 'swatch', style: `background:rgb(${c.join(',')})`, onclick: () => call('light', 'turn_on', { rgb_color: c }, id) }))));
    }
    return parts;
  },
  fan(id) {
    const s = slider({ label: I18N.t('panel.sheets.speed'), fmt: (v) => v + ' %', onchange: (v) => call('fan', 'set_percentage', { percentage: v }, id) });
    bind('sheet', id, (st) => s.set(st.attributes.percentage || 0));
    return [bigToggle(id), s];
  },
  cover(id) {
    const btn = (ic, label, svc) => h('button', { class: 'big-action', onclick: () => call('cover', svc, {}, id) }, icon(ic), label);
    const parts = [h('div', { class: 'btn-row' }, btn('mdi-arrow-up', I18N.t('panel.sheets.open'), 'open_cover'), btn('mdi-stop', I18N.t('panel.sheets.stop'), 'stop_cover'), btn('mdi-arrow-down', I18N.t('panel.sheets.close'), 'close_cover'))];
    if (S.states[id].attributes.current_position != null) {
      const s = slider({ label: I18N.t('panel.sheets.position'), fmt: (v) => v + ' %', onchange: (v) => call('cover', 'set_cover_position', { position: v }, id) });
      bind('sheet', id, (st) => s.set(st.attributes.current_position));
      parts.unshift(s);
    }
    return parts;
  },
  climate(id) {
    const a0 = S.states[id].attributes;
    const step = a0.target_temp_step || 0.5;
    let target = a0.temperature, timer = null, editing = false;
    const val = h('div', { class: 'climate-target' }), cur = h('div', { class: 'climate-cur' }), modes = h('div', { class: 'btn-row' });
    const paint = () => (val.textContent = target != null ? fmtNum(target) + '°' : '—');
    const adj = (dx) => {
      if (target == null) return;
      const a = S.states[id].attributes;
      target = Math.min(a.max_temp ?? 35, Math.max(a.min_temp ?? 5, Math.round((target + dx) / step) * step));
      paint(); editing = true; clearTimeout(timer);
      timer = setTimeout(() => call('climate', 'set_temperature', { temperature: target }, id).finally(() => (editing = false)), 800);
    };
    bind('sheet', id, (st) => {
      const a = st.attributes;
      if (!editing) { target = a.temperature; paint(); }
      cur.textContent = (a.current_temperature != null ? I18N.t('panel.sheets.now_value', { value: fmtNum(a.current_temperature) + '°' }) : '') +
        (a.current_humidity != null ? ' · ' + I18N.t('panel.sheets.humidity_percent', { n: a.current_humidity }) : '');
      modes.replaceChildren(...(a.hvac_modes || []).map((m) =>
        h('button', { class: 'big-action' + (st.state === m ? ' active' : ''), onclick: () => call('climate', 'set_hvac_mode', { hvac_mode: m }, id) }, T[m] || m)));
    });
    return [h('div', { class: 'climate' },
      h('button', { class: 'round-btn', onclick: () => adj(-step) }, icon('mdi-minus')), val,
      h('button', { class: 'round-btn', onclick: () => adj(step) }, icon('mdi-plus'))), cur, modes];
  },
  media_player(id) { return [mediaCard(id, 'sheet')]; },
  lock(id) {
    const status = h('div', { class: 'big-toggle' });
    bind('sheet', id, (st) => { status.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))); status.classList.toggle('on', st.state === 'unlocked' || st.state === 'open'); });
    status.dataset.kind = 'cover';
    return [status, h('div', { class: 'btn-row' },
      h('button', { class: 'big-action', onclick: () => call('lock', 'lock', {}, id) }, icon('mdi-lock'), I18N.t('panel.sheets.close')),
      h('button', { class: 'big-action', onclick: () => call('lock', 'unlock', {}, id) }, icon('mdi-lock-open-variant'), I18N.t('panel.sheets.open')))];
  },
  vacuum(id) {
    const status = h('div', { class: 'big-toggle' });
    bind('sheet', id, (st) => {
      status.replaceChildren(...[icon(iconOf(st)), h('span', null, fmtState(st)), st.attributes.charging ? icon('mdi-lightning-bolt', 'vac-bolt') : null].filter(Boolean));
      status.classList.toggle('on', ['cleaning', 'returning'].includes(st.state));
    });
    const a = S.states[id].attributes;
    const dreame = reg(id).platform === 'dreame_vacuum';
    const b = (ic, label, svc, cls = '') => h('button', { class: 'big-action ' + cls, onclick: () => call('vacuum', svc, {}, id).then((r) => r !== null && closeSheet()) }, icon(ic), label);
    const parts = [status];

    // Rooms of the map (Dreame: attributes.rooms[map] = [{id, name, icon}])
    const rooms = a.rooms ? (a.rooms[a.selected_map] || Object.values(a.rooms)[0] || []) : [];
    if (dreame && rooms.length) {
      const sel = new Set();
      const go = h('button', { class: 'big-action primary' }, icon('mdi-play'), h('span'));
      const paint = () => {
        go.lastChild.textContent = sel.size ? I18N.t(sel.size > 1 ? 'panel.sheets.clean_rooms' : 'panel.sheets.clean_rooms_one', { n: sel.size }) : I18N.t('panel.sheets.choose_rooms');
        go.classList.toggle('disabled', !sel.size);
      };
      go.addEventListener('click', () => {
        if (!sel.size) return toast(I18N.t('panel.sheets.choose_one_room'));
        const names = rooms.filter((r) => sel.has(r.id)).map((r) => r.name);
        call('dreame_vacuum', 'vacuum_clean_segment', { segments: [...sel] }, id)
          .then((r) => { if (r !== null) { toast(I18N.t('panel.sheets.cleaning_prefix') + names.join(', ')); closeSheet(); } });
      });
      const chips = h('div', { class: 'room-chips' }, rooms.map((r) => {
        const c = h('button', { class: 'room-chip' }, icon(mdi(r.icon) || 'mdi-home-outline'), h('span', null, r.name));
        c.addEventListener('click', () => { if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id); c.classList.toggle('on', sel.has(r.id)); paint(); });
        return c;
      }));
      paint();
      parts.push(h('div', { class: 'vac-title' }, I18N.t('panel.sheets.which_rooms')), chips,
        h('div', { class: 'btn-row' }, go, b('mdi-home-city-outline', I18N.t('panel.sheets.whole_house'), 'start')));
    } else {
      parts.push(h('div', { class: 'btn-row' }, b('mdi-play', I18N.t('panel.sheets.clean'), 'start', 'primary')));
    }

    // Shortcuts saved in the Dreame app
    const shortcuts = dreame && a.shortcuts ? Object.values(a.shortcuts).filter((s) => s && s.name) : [];
    if (shortcuts.length) {
      parts.push(h('div', { class: 'vac-title' }, I18N.t('panel.sheets.app_shortcuts')), h('div', { class: 'chips vac-shortcuts' }, shortcuts.map((s) =>
        h('button', { class: 'chip', onclick: () => call('dreame_vacuum', 'vacuum_start_shortcut', { shortcut_id: s.id }, id)
          .then((r) => { if (r !== null) { toast(I18N.t('panel.sheets.running_prefix') + s.name); closeSheet(); } }) }, icon('mdi-flash'), s.name))));
    }
    parts.push(h('div', { class: 'btn-row' }, b('mdi-pause', I18N.t('panel.sheets.pause'), 'pause'), b('mdi-home-import-outline', I18N.t('panel.sheets.return_base'), 'return_to_base')));
    return parts;
  },
  camera(id) { return [cameraImg(id, 'sheet', 2)]; },
  sensor(id) { return [historyChart(id)]; },
  binary_sensor(id) { return [historyChart(id)]; },
  // Switches and the like: on/off and their history
  switch(id) { return [bigToggle(id), historyChart(id)]; },
  input_boolean(id) { return [bigToggle(id), historyChart(id)]; },
  automation(id) { return [bigToggle(id), historyChart(id)]; },
  siren(id) { return [bigToggle(id), historyChart(id)]; },
  humidifier(id) { return [bigToggle(id), historyChart(id)]; },
  weather(id) { return [weatherCard(id)]; },
};
/** Details of any other entity: its state and its history */
function genericSheet(id) {
  const val = h('div', { class: 'sheet-state' });
  bind('sheet', id, (st) => { val.textContent = fmtState(st); });
  return [val, historyChart(id)];
}

function historyChart(id) {
  const box = h('div', { class: 'chart' }, h('div', { class: 'muted' }, I18N.t('panel.sheets.loading_last_24')));
  api.history(id, 24).then((pts) => {
    const st = S.states[id];
    const nums = pts.map((p) => ({ t: p.t, v: parseFloat(p.s) })).filter((p) => !isNaN(p.v));
    if (nums.length >= 2 && domain(id) === 'sensor') {
      const t0 = Date.now() - 24 * 3600e3, t1 = Date.now();
      const vs = nums.map((p) => p.v);
      let mn = Math.min(...vs), mx = Math.max(...vs);
      if (mx - mn < 1e-6) { mn -= 1; mx += 1; }
      const pad = (mx - mn) * 0.1; mn -= pad; mx += pad;
      const X = (t) => ((Math.max(t, t0) - t0) / (t1 - t0)) * 600, Y = (v) => 180 - ((v - mn) / (mx - mn)) * 180;
      let d = `M${X(nums[0].t)},${Y(nums[0].v)}`;
      for (let i = 1; i < nums.length; i++) d += ` H${X(nums[i].t)} V${Y(nums[i].v)}`;
      d += ` H600`;
      const area = d + ` V180 H${X(nums[0].t)} Z`;
      const unit = st.attributes.unit_of_measurement || '';
      box.replaceChildren(
        h('div', { html: `<svg viewBox="0 0 600 180" preserveAspectRatio="none"><path class="chart-area" d="${area}"/><path class="chart-line" d="${d}"/></svg>` }),
        h('div', { class: 'chart-meta' }, h('span', null, I18N.t('panel.sheets.24_h_ago')),
          h('span', null, I18N.t('panel.sheets.min_max', { min: `${fmtNum(Math.min(...vs))} ${unit}`, max: `${fmtNum(Math.max(...vs))} ${unit}` })), h('span', null, I18N.t('panel.sheets.now'))));
    } else {
      const fake = (s) => fmtState({ entity_id: id, state: s, attributes: st.attributes });
      const rows = pts.slice(-8).reverse().map((p) => h('div', null, h('span', null, fake(p.s)), h('span', { class: 'muted' }, relTime(new Date(p.t).toISOString()))));
      box.replaceChildren(h('div', { class: 'history-list' }, rows.length ? rows : h('div', null, I18N.t('panel.sheets.no_changes_24h'))));
    }
  }).catch(() => box.replaceChildren(h('div', { class: 'muted' }, I18N.t('panel.sheets.history_unavailable'))));
  return box;
}

/* ====================== The panel's Sendspin speaker ======================
 * If the Pi is a Music Assistant speaker (web → Sound → Speaker) and something starts playing on it,
 * it leaves ambient mode and opens its player; when it stops, it closes by itself. */
const SPK = (window.PANEL_HELPER && window.PANEL_HELPER.speaker) || null;
function speakerEntity() {
  if (!SPK || !SPK.enabled) return null;
  if (SPK.entity) return SPK.entity;
  // Automatic: by the id, which comes from the speaker name and does not change even if you rename it
  // in Home Assistant or Music Assistant (“Panel ha-panel” → media_player.panel_ha_panel)
  const want = String(SPK.name || '').trim().toLowerCase();
  const slug = 'media_player.' + want.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (S.states[slug]) return slug;
  // If that id does not exist (e.g. it was taken and HA added “_2”), by the name
  const found = Object.keys(S.states).filter((id) => domain(id) === 'media_player' &&
    String(S.states[id].attributes.friendly_name || '').trim().toLowerCase() === want);
  return found.find((id) => reg(id).platform === 'music_assistant') || found[0] || null;
}
const resolveSpk = (x) => (x === '@panel' ? speakerEntity() : x);
/** Is it playing something that opens “Now playing”? Not with an ignored source (web → Sound → Now playing), e.g. the TV
 * sound on a soundbar: source “TV” (or Music Assistant's app_id “tv”). */
function npIgnored(st) {
  const a = (st && st.attributes) || {}, list = ((SPK && SPK.npIgnore) || []).map((x) => String(x).trim().toLowerCase());
  return [a.source, a.app_id, a.app_name].some((v) => v != null && list.includes(String(v).trim().toLowerCase()));
}
const spkPlaying = (x) => (S.states[x] || {}).state === 'playing' && !npIgnored(S.states[x]);
/** Speakers that open “Now playing”, by priority (web → Sound → Now playing). '@panel' = this panel's. */
function watchedSpeakers() {
  if (!SPK) return [];
  const list = SPK.npSpeakers || [...(SPK.open ? ['@panel'] : []), ...(SPK.watch || [])];
  return [...new Set(list.map(resolveSpk))].filter((x) => x && S.states[x]);
}
/* Priority: if one with more priority than the one shown starts playing, “Now playing” switches to it; if one with
 * less starts, it only switches if the one shown is not playing. When the one shown stops, it goes to the next one playing. */
function onSpeaker(id, old, st) {
  if (!SPK || domain(id) !== 'media_player') return;
  const w = watchedSpeakers();
  if (!w.includes(id) && id !== NP.id) return;
  // an ignored source (the TV on a soundbar…) counts as not playing
  const was = old && (old.state === 'playing' && npIgnored(old) ? 'idle' : old.state);
  const now = st && (st.state === 'playing' && npIgnored(st) ? 'idle' : st.state);
  if (now === 'playing') {
    if (NP.id === id) { clearTimeout(NP.closeTimer); return; }   // playing again: it no longer closes
    if (!was || was === 'playing' || alertOpen()) return;          // an alarm or an important notification comes first
    if (!NP.id) { if (was !== 'paused') showNowPlaying(id); return; }   // resuming a pause does not open it
    if (NP.manual === NP.id && spkPlaying(NP.id)) return;            // chosen by hand in the ▾ picker: it stays
    if (!w.includes(id)) return;
    const cur = w.indexOf(NP.id);
    if (!spkPlaying(NP.id) || (cur >= 0 && w.indexOf(id) < cur)) { clearTimeout(NP.closeTimer); showNowPlaying(id); }
  } else if (NP.id === id && was === 'playing') {
    const next = w.find((x) => x !== id && spkPlaying(x));   // another one on the list is still playing: switch to it
    if (next && !alertOpen()) { clearTimeout(NP.closeTimer); showNowPlaying(next); return; }
    // Paused or stopped: it stays a while (web → Sound → Speaker) in case it plays again
    const secs = SPK.closeAfter == null ? 60 : SPK.closeAfter;
    clearTimeout(NP.closeTimer);
    // when it closes by itself it goes back to ambient mode (with the ✕ it stays where it was)
    const autoClose = () => { if (!alertOpen() && !S.sheetId) npToAmbient(true); else { hideNowPlaying(true); resetIdle(); } };
    if (secs === 0) autoClose();
    else if (secs > 0) NP.closeTimer = setTimeout(() => { if ((S.states[id] || {}).state !== 'playing') autoClose(); }, secs * 1000);
  }
}

/* “Now playing” screen: big artwork with the blurred background, title, progress and controls (the volume, in the quick access panel) */
const NP = { id: null, timer: null, closeTimer: null, fromAmbient: false, manual: null };   // manual = chosen in the ▾ picker
const npPlaying = () => !!NP.id && (S.states[NP.id] || {}).state === 'playing';
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/* Drag with the finger or the mouse. On the Pi's touch screen pointer events do not always arrive,
 * so touch events are listened to (and pointer ones only for the mouse). start(x, y) returns false to ignore. */
function dragOn(el, { start, move, end }) {
  let on = false;
  const t0 = (e) => e.touches[0] || e.changedTouches[0];
  el.addEventListener('touchstart', (e) => { const t = t0(e); if (start(t.clientX, t.clientY) !== false) { on = true; if (e.cancelable) e.preventDefault(); } }, { passive: false });
  el.addEventListener('touchmove', (e) => { if (on) { if (e.cancelable) e.preventDefault(); const t = t0(e); move(t.clientX, t.clientY); } }, { passive: false });
  const tEnd = () => { if (on) { on = false; end(); } };
  el.addEventListener('touchend', tEnd);
  el.addEventListener('touchcancel', tEnd);
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || start(e.clientX, e.clientY) === false) return;
    on = true; el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => { if (on && e.pointerType !== 'touch') move(e.clientX, e.clientY); });
  const pEnd = (e) => { if (e.pointerType !== 'touch') tEnd(); };
  el.addEventListener('pointerup', pEnd);
  el.addEventListener('pointercancel', pEnd);
}
/* Speaker symbol for the volume (for the bubble). */
const volIconOf = (v) => v <= 0 ? 'mdi-volume-off' : v < 34 ? 'mdi-volume-low' : v < 67 ? 'mdi-volume-medium' : 'mdi-volume-high';
/* Volume in “Now playing” for OTHER speakers (the panel's is changed in the quick access panel): a button with the speaker
 * at the bottom right that opens a vertical bar with the number. It only shows if that speaker lets you change the volume. */
const canSetVolume = (st) => !!st && st.attributes.volume_level != null && ((st.attributes.supported_features || 0) & 4) !== 0;
function npVolume(id) {
  const fill = h('i'), val = h('span', { class: 'vb-val' });
  const track = h('div', { class: 'np-vtrack' }, fill, h('span', { class: 'vb-ic' }, icon('mdi-speaker')), val);
  const btn = h('button', { class: 'np-vbtn' }, icon('mdi-speaker'));
  const el = h('div', { class: 'np-vol' }, h('div', { class: 'np-vpanel' }, track), btn);
  const W = { v: 0, drag: false, sent: -1, sentAt: 0, timer: null, live: null, el };
  const set = (v) => { W.v = v; fill.style.height = v + '%'; val.textContent = v; };
  const send = () => { if (W.v === W.sent) return; W.sent = W.v; W.sentAt = Date.now(); call('media_player', 'volume_set', { volume_level: W.v / 100 }, id); };
  const close = () => el.classList.remove('open');
  const hideLater = () => { clearTimeout(W.timer); W.timer = setTimeout(() => !W.drag && close(), 4000); };
  btn.onclick = () => { if (el.classList.toggle('open')) hideLater(); };
  const at = (y) => { const r = track.getBoundingClientRect(); set(Math.round(Math.max(0, Math.min(1, (r.bottom - y) / r.height)) * 100)); };
  dragOn(track, {
    start: (x, y) => { W.drag = true; clearTimeout(W.timer); at(y); send(); clearInterval(W.live); W.live = setInterval(send, 250); },
    move: (x, y) => at(y),
    end: () => { W.drag = false; clearInterval(W.live); send(); hideLater(); },
  });
  // what comes from Home Assistant (a late echo of your own drag does not make the bar jump)
  W.update = (st) => {
    el.classList.toggle('hidden', !canSetVolume(st));
    if (!canSetVolume(st) || W.drag || Date.now() - W.sentAt < 3000) return;
    set(Math.round(st.attributes.volume_level * 100));
  };
  return W;
}
/* Volume bubble: if the volume of the panel speaker changes from somewhere else (Home Assistant, Music Assistant,
   the phone…), a bubble with the new number shows at the top centre, on any screen. It goes away after 2 s.
   What you change on the panel itself does not show it. */
const OSD = { known: null, sent: -1, sentAt: 0, timer: null };
function volMarkSent(v) { OSD.sent = v; OSD.sentAt = Date.now(); }
function volBubble(v) { osdBubble(volIconOf(v), String(v)); }
/** The same bubble with any icon and text (what an ambient gesture did). Numbers go big. */
function osdBubble(ic, text) {
  let el = $('#vol-bubble');
  if (!el) { el = h('div', { id: 'vol-bubble', class: 'vol-bubble' }); document.body.append(el); }
  el.replaceChildren(icon(ic), /^\d+$/.test(text) ? h('b', null, text) : h('span', null, text));
  el.classList.add('show');
  clearTimeout(OSD.timer);
  OSD.timer = setTimeout(() => el.classList.remove('show'), 2000);
}
function onVolumeChange(id, st) {
  if (!st || id !== speakerEntity() || st.attributes.volume_level == null) return;
  const v = Math.round(st.attributes.volume_level * 100), was = OSD.known;
  OSD.known = v;
  if (was == null || v === was || Date.now() - OSD.sentAt < 4000) return;   // first time, no change or changed here
  volBubble(v);
}
function showNowPlaying(id) {
  if (NP.id === id && $('#np').classList.contains('show')) return;
  // Was it opened from ambient mode? Closing it with the ✕ goes back to it
  const fromAmbient = S.ambient || (!!NP.id && NP.fromAmbient);
  hideNowPlaying(true);
  closeSheet();
  if (S.ambient) { S.ambient = false; $('#ambient').classList.remove('show'); }
  NP.id = id;
  NP.fromAmbient = fromAmbient;
  const bg = h('div', { class: 'np-bg' }), art = h('div', { class: 'np-art' }, icon('mdi-music'));
  const title = h('div', { class: 'np-title' }), sub = h('div', { class: 'np-sub' });
  const bar = h('i'), cur = h('span'), dur = h('span');
  // Progress: a dot marks where it is. Only dragging the dot changes it (on release).
  // With touch and mouse events: on the Pi's touch screen pointer events do not always arrive.
  const tip = h('span', { class: 'np-tip' });   // while you hold it: the time where you are going to leave it
  const knob = h('b', { class: 'np-knob' }, tip);
  const seek = h('div', { class: 'np-seek' }, h('div', { class: 'np-bar' }, bar), knob);
  let seekDrag = false, seekMoved = false, seekPos = 0, seekX = 0, frac = 0, lastPos = null;
  let seekHold = null;   // after releasing: it stays where you left it until the new position arrives
  const canSeek = () => { const a = (S.states[id] || {}).attributes || {}; return !!((a.supported_features || 0) & 2) && +a.media_duration > 0; };
  const paintProg = (f, instant) => {
    if (instant) seek.classList.add('instant');
    bar.style.width = f * 100 + '%'; knob.style.left = f * 100 + '%';
    if (instant) { void seek.offsetWidth; seek.classList.remove('instant'); }
  };
  const seekAt = (x) => {
    const r = seek.getBoundingClientRect(), total = +S.states[id].attributes.media_duration;
    const f = Math.max(0, Math.min(1, (x - r.left) / r.width));
    seekPos = f * total; paintProg(f); tip.textContent = fmtTime(seekPos);
  };
  const seekStart = (x) => {
    const r = seek.getBoundingClientRect();
    if (!canSeek() || Math.abs(x - (r.left + r.width * frac)) > 44) return false;   // only near the dot
    seekDrag = true; seekMoved = false; seekX = x; seek.classList.add('drag');
    tip.textContent = fmtTime(frac * +S.states[id].attributes.media_duration);
    return true;
  };
  const seekMove = (x) => {
    if (!seekDrag) return;
    if (Math.abs(x - seekX) > 4) seekMoved = true;
    if (seekMoved) seekAt(x);
  };
  const seekEnd = () => {
    if (!seekDrag) return;
    seekDrag = false; seek.classList.remove('drag');
    if (!seekMoved) return;
    seekHold = { pos: seekPos, t: Date.now(), upd: ((S.states[id] || {}).attributes || {}).media_position_updated_at };
    lastPos = seekPos;
    call('media_player', 'media_seek', { seek_position: Math.round(seekPos) }, id);
  };
  dragOn(seek, { start: (x) => seekStart(x), move: (x) => seekMove(x), end: seekEnd });
  const clock = h('span', { class: 'np-clock' });
  const svc = (s) => () => call('media_player', s, {}, id);
  const play = h('button', { class: 'np-play', onclick: svc('media_play_pause') });
  // if it is another speaker (not the panel's), its volume right here; the panel's is in the quick access panel
  const vol = id !== speakerEntity() ? npVolume(id) : null;
  const root = $('#np');
  root.classList.toggle('has-vol', !!vol);
  // the speaker's name: with ▾ (if there are others to choose from) it opens the picker
  const spkBtn = h('button', { class: 'np-spk-btn', onclick: () => spkBtn.classList.contains('can') && npPickOpen(spkBtn) },
    icon(iconOf(S.states[id])), h('span', { class: 'np-spk', translate: 'no' }, nameOf(id, false)), icon('mdi-menu-down'));
  root.replaceChildren(bg,
    h('div', { class: 'np-top' }, spkBtn, clock,
      h('button', { class: 'np-close', onclick: () => { if (NP.fromAmbient && !alertOpen()) npToAmbient(); else hideNowPlaying(); } }, icon('mdi-close'))),
    h('div', { class: 'np-main' }, art, h('div', { class: 'np-info' }, title, sub,
      h('div', { class: 'np-ctrls' }, h('button', { onclick: svc('media_previous_track') }, icon('mdi-skip-previous')), play,
        h('button', { onclick: svc('media_next_track') }, icon('mdi-skip-next'))))),
    ...(vol ? [vol.el] : []),   // replaceChildren would paint “null” as text
    // progress: at the very bottom, from side to side
    h('div', { class: 'np-prog' }, h('div', { class: 'np-times' }, cur, dur), seek));
  // If a word does not fit, the font gets smaller (down to 60 %); if it still does not fit, it breaks
  const fitTitle = () => {
    title.style.fontSize = ''; title.style.overflowWrap = 'normal';
    const base = parseFloat(getComputedStyle(title).fontSize);
    for (let f = base; title.scrollWidth > title.clientWidth + 1 && f > base * 0.6; f -= 2) title.style.fontSize = f - 2 + 'px';
    title.style.overflowWrap = '';
  };
  let pic = null;
  bind('np', id, (st) => {
    if (!st) return;
    const a = st.attributes;
    const ttl = a.media_title || T[st.state] || st.state;
    if (title.textContent !== ttl) { title.textContent = ttl; requestAnimationFrame(fitTitle); }
    sub.textContent = [a.media_artist, a.media_album_name].filter(Boolean).join(' · ');
    play.replaceChildren(icon(st.state === 'playing' ? 'mdi-pause' : 'mdi-play'));
    if (vol) vol.update(st);
    if (a.entity_picture !== pic) {
      pic = a.entity_picture;
      const url = pic ? `url("${absUrl(pic)}")` : '';
      art.style.backgroundImage = url; bg.style.backgroundImage = url;
      art.classList.toggle('has', !!pic);
    }
  });
  // Progress and clock, every second
  const tick = () => {
    spkBtn.classList.toggle('can', npChoices().length > 1);
    clock.textContent = new Date().toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' });
    const st = S.states[id], a = (st && st.attributes) || {};
    const total = +a.media_duration || 0;
    root.classList.toggle('no-prog', !total);
    seek.classList.toggle('can', canSeek());
    if (!total) return;
    let pos = +a.media_position || 0;
    if (st.state === 'playing' && a.media_position_updated_at) pos += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
    if (seekHold) {
      if (a.media_position_updated_at === seekHold.upd && Date.now() - seekHold.t < 6000)
        pos = seekHold.pos + (st.state === 'playing' ? (Date.now() - seekHold.t) / 1000 : 0);
      else seekHold = null;
    }
    pos = Math.min(pos, total);
    cur.textContent = fmtTime(pos); dur.textContent = fmtTime(total);   // where the music is (also while you drag)
    if (seekDrag) return;
    const jump = lastPos == null || Math.abs(pos - lastPos - 1) > 1.5;   // jumps (new song, new position): no animation
    lastPos = pos;
    frac = pos / total; paintProg(frac, jump);
  };
  tick();
  NP.timer = setInterval(tick, 1000);
  root.classList.add('show');
  wakeScreen(); resetIdle();
}
/** From “Now playing” to ambient mode without showing the panel in between: ambient is already underneath and “Now playing” fades on top. */
/* Speaker picker in “Now playing” (▾ by the speaker's name): which speakers it lists (web → Sound → Now playing).
 * Playing ones first, then the paused ones (if they are on), then the rest (only with “All”). Ignored sources count as not playing. */
function npChoices() {
  const mode = (SPK && SPK.npPick) || 'list', paused = !SPK || SPK.npPaused !== false;
  const ids = mode === 'list' ? watchedSpeakers() : Object.keys(S.states).filter((x) => domain(x) === 'media_player');
  const rank = (x) => {
    const st = S.states[x];
    if (!st || ['unavailable', 'unknown'].includes(st.state)) return -1;
    if (st.state === 'playing' && !npIgnored(st)) return 0;
    if (st.state === 'paused' && !npIgnored(st)) return paused ? 1 : -1;
    return mode === 'all' && st.state !== 'off' ? 2 : -1;
  };
  const l = ids.map((x, i) => [x, rank(x), i]).filter((x) => x[1] >= 0 || x[0] === NP.id);
  l.sort((a, b) => (a[0] === NP.id ? -1 : b[0] === NP.id ? 1 : 0) || a[1] - b[1] || a[2] - b[2]);
  return [...new Set(l.map((x) => x[0]))];
}
function npPickOpen(anchor) {
  const root = $('#np'), old = $('.np-pick', root);
  if (old) { old.remove(); return; }
  const rows = npChoices().map((x) => {
    const st = S.states[x], a = (st && st.attributes) || {};
    const pic = h('span', { class: 'np-pick-art' }, icon(iconOf(st)));
    if (a.entity_picture) { pic.style.backgroundImage = `url("${absUrl(a.entity_picture)}")`; pic.classList.add('has'); }
    const what = st.state === 'playing' && !npIgnored(st) ? a.media_title || T[st.state] : a.media_title && st.state === 'paused' ? a.media_title : T[st.state] || st.state;
    return h('button', { class: 'np-pick-row' + (x === NP.id ? ' on' : ''), translate: 'no',
      onclick: (e) => { e.stopPropagation(); pick.remove(); if (x !== NP.id) { showNowPlaying(x); NP.manual = x; } } },
      pic, h('span', { class: 'np-pick-txt' }, h('b', null, nameOf(x, false)), h('span', null, what || '')),
      icon(st.state === 'playing' && !npIgnored(st) ? 'mdi-play' : st.state === 'paused' ? 'mdi-pause' : ''));
  });
  const pick = h('div', { class: 'np-pick' }, ...rows);
  root.append(pick);
  const away = (e) => { if (!pick.contains(e.target) && !anchor.contains(e.target)) { pick.remove(); } if (!pick.isConnected) window.removeEventListener('pointerdown', away, true); };
  window.addEventListener('pointerdown', away, true);
  resetIdle();
}
function npToAmbient(quiet) {
  if (STAY.on && !S.ambient) { hideNowPlaying(quiet); return; }
  const a = $('#ambient');
  a.style.transition = 'none';
  showAmbient();
  void a.offsetWidth;
  a.style.transition = '';
  hideNowPlaying(quiet);
}
function hideNowPlaying(quiet) {
  clearInterval(NP.timer); NP.timer = null;
  clearTimeout(NP.closeTimer);
  B.np.clear();
  const was = NP.id;
  NP.id = null; NP.manual = null;
  $('#np').classList.remove('show');
  if (was && !quiet) resetIdle();
}

function openSheet(id) {
  if (SH.open) shade(false);   // a long press on a quick access opens its details
  closeSheet();
  const st = S.states[id];
  if (!st) return;
  const builder = SHEETS[domain(id)] || genericSheet;
  const head = h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }), h('div', { class: 'sheet-title' }, nameOf(id, false)),
    h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close')));
  bind('sheet', id, (s) => head.firstChild.replaceChildren(icon(iconOf(s))));
  const notice = h('div', { class: 'unavail-notice hidden' }, icon('mdi-lan-disconnect'),
    h('span', null, I18N.t('panel.sheets.device_not_available')));
  const body = h('div', { class: 'sheet-body' }, builder(id));
  $('#sheet-card').replaceChildren(head, notice, body);
  // No connection with the device: the controls are disabled (and enabled again by themselves if it comes back)
  bind('sheet', id, (s) => {
    const off = !s || s.state === 'unavailable';
    notice.classList.toggle('hidden', !off);
    body.classList.toggle('disabled', off);
    body.querySelectorAll('button, input, select').forEach((c) => { c.disabled = off; });
  });
  $('#sheet').classList.remove('hidden');
  S.sheetId = id;
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  B.sheet.clear();
  S.sheetTimers.forEach(clearInterval); S.sheetTimers = [];
  S.sheetId = null;
  $('#sheet-card').replaceChildren();
}

/* ====================== Entity utilities ====================== */
const ids = (filter) => Object.keys(S.states).filter((id) => visible(id) && !isScooter(id) && filter(id));
const empty = (ic, msg) => h('div', { class: 'empty-state' }, icon(ic), msg);

function scooterIds() {
  const m = {};
  for (const [id, e] of Object.entries(S.ents)) if (e.platform === CFG.scooterPlatform && e.translation_key && S.states[id]) m[e.translation_key] = id;
  return m;
}
const num = (id) => (id && S.states[id] ? parseFloat(S.states[id].state) : NaN);
const isOn = (id) => !!id && S.states[id] && S.states[id].state === 'on';
/** 'charged' (reached the limit: green) | 'charging' (blue) | false */
const chargeMode = (k) => isOn(k.charged) ? 'charged' : isOn(k.charging_any) ? 'charging' : false;

/** The panel's Settings screen (the cog) */
const VIEWS = { settings: { title: 'panel.nav.settings', icon: 'mdi-cog', render: () => renderSettings() } };
/** Built-in tabs that do not show if there is nothing for them (e.g. Scooter without a scooter) */
const VIEW_VISIBLE = {
  media: () => ids((id) => ['media_player', 'camera'].includes(domain(id))).length > 0,
  printers: () => printers().length > 0,
  scooter: () => !!scooterIds().battery_level,
};

/* ====================== Impresoras 3D ====================== */
// Each integration names its entities its own way: Bambu by translation_key,
// Moonraker (Klipper/Snapmaker) by the end of the entity_id.
const BAMBU = {
  status: 'sensor:print_status', progress: 'sensor:print_progress', remaining: 'sensor:remaining_time',
  layer: 'sensor:current_layer', layers: 'sensor:total_layers', job: 'sensor:subtask_name', file: 'sensor:gcode_file',
  nozzle: 'sensor:nozzle_temp', nozzleTarget: 'sensor:target_nozzle_temp', bed: 'sensor:bed_temp', bedTarget: 'sensor:target_bed_temp',
  camera: 'camera:camera', cover: 'image:cover_image', pause: 'button:pause', resume: 'button:resume', stop: 'button:stop',
  light: 'light:chamber_light',
};
const MOONRAKER = {
  status: 'sensor:current_print_state', progress: 'sensor:progress', remaining: 'sensor:print_time_left',
  layer: 'sensor:current_layer', layers: 'sensor:total_layer', file: 'sensor:filename',
  nozzle: 'sensor:extruder_temperature', nozzleTarget: 'number:extruder_target', bed: 'sensor:bed_temperature',
  bedTarget: 'number:bed_target', chamber: 'sensor:cavity_temp',
  pause: 'button:pause_print', resume: 'button:resume_print', stop: 'button:cancel_print',
};
const PRINTER_MAPS = { bambu_lab: BAMBU, moonraker: MOONRAKER };
const PSTATUS = {
  running: 'printing', printing: 'printing', pause: 'paused', paused: 'paused', prepare: 'preparing', slicing: 'preparing',
  init: 'preparing', finish: 'finished', complete: 'finished', failed: 'error', error: 'error', cancelled: 'cancelled',
  idle: 'idle', standby: 'idle', offline: 'offline', unavailable: 'offline', unknown: 'idle',
};
const ACTIVE_P = ['printing', 'paused', 'preparing'];

let printersCache = null;
function printers() {
  if (printersCache) return printersCache;
  const byDev = new Map();
  for (const [id, e] of Object.entries(S.ents)) {
    if (!PRINTER_MAPS[e.platform] || !e.device_id || e.disabled_by || !S.states[id]) continue;
    if (!byDev.has(e.device_id)) byDev.set(e.device_id, { platform: e.platform, ids: [] });
    byDev.get(e.device_id).ids.push(id);
  }
  const list = [];
  for (const [dev, { platform, ids }] of byDev) {
    const e = {};
    for (const [k, spec] of Object.entries(PRINTER_MAPS[platform])) {
      const [dom, key] = spec.split(':');
      e[k] = ids.find((id) => domain(id) === dom &&
        (platform === 'bambu_lab' ? reg(id).translation_key === key : id.endsWith('_' + key)));
    }
    if (!e.status) continue;               // e.g. Bambu's external spool or MakerWorld
    const d = S.devs[dev] || {};
    const name = d.name_by_user || d.name || I18N.t('panel.sheets.printer');
    let nozzles = [{ label: I18N.t('panel.sheets.nozzle'), cur: e.nozzle, tgt: e.nozzleTarget }];
    if (platform === 'moonraker') {
      const cams = ids.filter((id) => domain(id) === 'camera');
      e.camera = cams.find((id) => !/thumbnail|gui|screen/.test(id)) || cams[0];
      e.screen = cams.find((id) => /gui|screen|pantalla/.test(id));     // the printer's screen
      e.light = ids.find((id) => domain(id) === 'light');
      // Thumbnail: an image.<printer>_thumb… entity (even if it is not in the device) or the "thumbnail" camera
      const prefix = e.status.split('.')[1].replace(/_current_print_state$/, '');
      e.cover = Object.keys(S.states).find((id) => id.startsWith(`image.${prefix}_thumb`)) || cams.find((id) => /thumbnail/.test(id));
      // Varias boquillas (Snapmaker U1: extruder, extruder1, extruder2, extruder3)
      const ext = ids.filter((id) => /^sensor\..*_extruder\d*_temperature$/.test(id))
        .map((id) => ({ id, n: +(id.match(/_extruder(\d*)_temperature$/)[1] || 0) })).sort((a, b) => a.n - b.n);
      if (ext.length) nozzles = ext.map(({ id, n }) => ({
        label: ext.length > 1 ? `T${n + 1}` : I18N.t('panel.sheets.nozzle'), cur: id,
        tgt: ids.find((x) => x.endsWith(`_extruder${n || ''}_target`) && domain(x) === 'number'),
        fil: ids.find((x) => x.endsWith(`_e${n}_filament`)),
      }));
    }
    // Printer plug: config.printerPlugs or a switch ending in its name ("…_bambu_p1s")
    const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).slice(0, 2).join('_').replace(/[^a-z0-9_]/g, '');
    e.plug = (CFG.printerPlugs || {})[name] ||
      Object.keys(S.states).find((id) => domain(id) === 'switch' && id.endsWith('_' + slug) && !PRINTER_MAPS[reg(id).platform]);
    if (e.plug) {
      const plugDev = reg(e.plug).device_id;
      e.plugPower = Object.keys(S.states).find((id) => domain(id) === 'sensor' && S.states[id].attributes.device_class === 'power' &&
        (plugDev ? reg(id).device_id === plugDev : id.startsWith(e.plug.replace('switch.', 'sensor.'))));
    }
    list.push({ dev, platform, name, e, nozzles });
  }
  return (printersCache = list.sort((a, b) => a.name.localeCompare(b.name, I18N.locale())));
}
const pState = (p) => (p.e.plug && S.states[p.e.plug] && S.states[p.e.plug].state === 'off') ? 'off'
  : PSTATUS[(S.states[p.e.status] || { state: 'unavailable' }).state] || 'idle';
const pActive = (p) => ACTIVE_P.includes(pState(p));
function confirmBtn(ic, label, fn, ask = I18N.t('panel.notices.sure_tap_again')) {
  let armed = null;
  const b = h('button', { class: 'big-action' }, icon(ic), label);
  b.addEventListener('click', () => {
    if (armed) { clearTimeout(armed); armed = null; fn(); return; }
    b.replaceChildren(icon('mdi-alert'), ask);
    b.classList.add('danger');
    armed = setTimeout(() => { armed = null; b.replaceChildren(icon(ic), label); b.classList.remove('danger'); }, 4000);
  });
  return b;
}

/** If a printer state changes: notifies when it finishes and repaints (it shows/hides on Home). */
function onPrinterStatus(id, old, st) {
  const p = printers().find((x) => x.e.status === id);
  if (!p) return;
  const was = PSTATUS[old ? old.state : 'unavailable'], now = PSTATUS[st ? st.state : 'unavailable'];
  if (was === now) return;
  if (ACTIVE_P.includes(was) && now === 'finished') toast(I18N.t('panel.printers.finished', { name: p.name }));
  if (ACTIVE_P.includes(was) && now === 'error') toast(I18N.t('panel.printers.failed', { name: p.name }), true);
  clearTimeout(structTimer);
  structTimer = setTimeout(() => !S.sheetId && render(), 300);
}

function weatherCard(id, days = 5) {
  const now = h('div', { class: 'w-now' }), fc = h('div', { class: 'w-fc' });
  bind('view', id, (st) => {
    if (!st) return;
    const a = st.attributes;
    const extra = [a.humidity != null ? I18N.t('panel.weather.humidity', { value: fmtNum(a.humidity) + ' %' }) : null,
      a.wind_speed != null ? I18N.t('panel.weather.wind', { value: `${fmtNum(a.wind_speed)} ${a.wind_speed_unit || ''}`.trim() }) : null].filter(Boolean).join(' · ');
    now.replaceChildren(icon(wIcon(st.state), 'w-icon'), h('div', null,
      h('div', { class: 'w-temp' }, fmtNum(a.temperature) + '°'), h('div', { class: 'w-cond' }, wText(st.state)), h('div', { class: 'muted small' }, extra)));
  });
  if (days > 0) getForecast(id).then((f) => fc.replaceChildren(...f.slice(0, days).map((d) => h('div', { class: 'fc-day' },
    h('div', { class: 'fc-name' }, new Date(d.datetime).toLocaleDateString(I18N.locale(), { weekday: 'short' }).replace('.', '')),
    icon(wIcon(d.condition)), h('div', { class: 'fc-t' }, fmtNum(d.temperature) + '°'),
    // Chance of rain always visible (also 0 %); empty only if the integration does not give it
    d.precipitation_probability != null ? h('div', { class: 'fc-rain' }, icon('mdi-water'), d.precipitation_probability + '%')
      : h('div', { class: 'fc-rain empty' }, ' '),
    d.templow != null ? h('div', { class: 'fc-low' }, fmtNum(d.templow) + '°') : null))));
  return h('div', { class: 'card weather-card' }, now, days > 0 ? fc : null);
}

/* ====================== Notifications from Home Assistant ======================
 * An automation fires:   event: panel_notification   with event_data:
 *   id, title, message, level (info | warning | critical), icon, image (camera/image entity or URL),
 *   timeout (s, 0 = until tapped), sound (true/false) and actions: [{title, icon, service, entity_id, data, confirm, style}]
 * Close it from HA:      event: panel_notification_close   with event_data: {id}
 * Tapping a button fires: panel_notification_action   with {id, action}
 */
const N = { queue: [], history: [], unread: 0, ctx: null, soundTimer: null, closeTimer: null, imgTimer: null };
const LEVELS = { info: 'info', warning: 'warning', critical: 'critical' };
const mdi = (s) => (s || '').replace('mdi:', 'mdi-');

function normNotif(d) {
  d = d || {};
  const level = LEVELS[String(d.level || 'warning').toLowerCase()] || 'warning';
  const def = { info: 10, warning: 120, critical: 0 }[level];
  return {
    id: String(d.id || 'n' + Date.now()),
    title: d.title || I18N.t('panel.notices.notification'),
    message: d.message || '',
    level,
    icon: mdi(d.icon) || (level === 'critical' ? 'mdi-alert' : 'mdi-bell-ring'),
    image: d.image || null,
    timeout: Number(d.timeout ?? def) || 0,
    sound: d.sound ?? level !== 'info',
    actions: (d.actions || []).map((x) => ({
      title: x.title || I18N.t('panel.states.ok'), icon: mdi(x.icon), service: x.service,
      entity: x.entity_id, data: x.data || {}, confirm: !!x.confirm, style: x.style || '',
    })),
    at: new Date(),
  };
}

const alertOpen = () => !!(typeof RING !== 'undefined' && RING.active) || N.queue.some((n) => n.level !== 'info');

function onNotif(ev) {
  const n = normNotif(ev.data);
  N.queue = N.queue.filter((x) => x.id !== n.id);       // same id = it replaces it (e.g. they ring again)
  N.queue.unshift(n);
  N.history = [n, ...N.history.filter((x) => x.id !== n.id || x.at !== n.at)].slice(0, 30);
  N.unread++;
  renderBell();
  if (n.level !== 'info') {                            // wakes the screen up
    if (S.ambient) { S.ambient = false; $('#ambient').classList.remove('show'); }
    closeSheet();
    tick();
  }
  if (n.sound) playSound(n.level);
  showNotif();
  if (SH.paintNotif) SH.paintNotif();
}
function onNotifClose(ev) { closeNotif(String((ev.data || {}).id || ''), false); }

function closeNotif(id, byUser) {
  const was = N.queue.find((n) => n.id === id);
  if (!was) return;
  N.queue = N.queue.filter((n) => n.id !== id);
  if (!N.queue.some((n) => n.sound && n.level !== 'info')) stopSound();
  showNotif();
  tick();
  if (byUser) resetIdle();
}

function showNotif() {
  clearTimeout(N.closeTimer); clearInterval(N.imgTimer);
  const banner = $('#banner'), modal = $('#alert');
  const top = N.queue[0];
  if (!top) { banner.classList.remove('show'); modal.classList.add('hidden'); return; }
  if (top.timeout > 0) {
    const left = top.timeout * 1000 - (Date.now() - top.at.getTime());
    N.closeTimer = setTimeout(() => closeNotif(top.id, false), Math.max(1000, left));
  }
  if (top.level === 'info') {
    modal.classList.add('hidden');
    banner.replaceChildren(icon(top.icon), h('div', null, h('b', null, top.title), top.message ? h('div', { class: 'small' }, top.message) : null));
    banner.onclick = () => closeNotif(top.id, true);
    banner.classList.add('show');
    return;
  }
  banner.classList.remove('show');
  const card = $('#alert-card');
  modal.className = 'alert ' + top.level;
  const parts = [h('div', { class: 'alert-head' },
    h('div', { class: 'alert-icon' }, icon(top.icon)),
    h('div', { class: 'alert-title' }, h('div', null, top.title), h('div', { class: 'alert-time' }, hhmm(top.at))),
    h('button', { class: 'icon-btn', onclick: () => closeNotif(top.id, true) }, icon('mdi-close')))];
  if (top.message) parts.push(h('div', { class: 'alert-msg' }, top.message));
  if (top.image) {
    const img = h('img', { class: 'alert-img', alt: '' });
    img.onerror = () => img.remove();
    const src = () => {
      const st = S.states[top.image];
      const u = st ? absUrl(st.attributes.entity_picture) : top.image;
      if (!u) return;
      img.src = u.startsWith('data:') ? u : u + (u.includes('?') ? '&' : '?') + (st && domain(top.image) === 'camera' ? 'width=640&' : '') + '_t=' + Date.now();
    };
    src();
    if (S.states[top.image] && domain(top.image) === 'camera') N.imgTimer = setInterval(src, 2000);
    parts.push(img);
  }
  const acts = top.actions.length ? top.actions : [{ title: I18N.t('panel.notices.ok'), icon: 'mdi-check' }];
  parts.push(h('div', { class: 'alert-actions' }, acts.map((a, i) => {
    const run = () => runNotifAction(top, a);
    const cls = 'big-action ' + (a.style === 'danger' ? 'danger' : (a.style === 'primary' || i === 0) ? 'primary' : '');
    if (a.confirm) { const b = confirmBtn(a.icon || 'mdi-check', a.title, run); b.className = cls; return b; }
    return h('button', { class: cls, onclick: run }, a.icon ? icon(a.icon) : null, a.title);
  })));
  const more = N.queue.filter((n) => n.level !== 'info').length - 1;
  if (more > 0) parts.push(h('div', { class: 'alert-more' }, I18N.t(more > 1 ? 'panel.notices.more' : 'panel.notices.more_one', { n: more })));
  card.replaceChildren(...parts);
  modal.classList.remove('hidden');
}

/** Opens a notification from the history again, big and without sound, until it is closed. */
function reopenNotif(n) {
  const c = { ...n, level: n.level === 'info' ? 'warning' : n.level, timeout: 0, sound: false };
  N.queue = [c, ...N.queue.filter((x) => x.id !== c.id)];
  showNotif();
}
async function runNotifAction(n, a) {
  if (a.service) {
    const [dom, svc] = String(a.service).split('.');
    const r = await call(dom, svc, a.data, a.entity);
    if (r === null) return;                          // it failed: the notification stays open to try again
    toast(`${a.title} ✓`);
  }
  conn.send({ type: 'fire_event', event_type: 'panel_notification_action', event_data: { id: n.id, action: a.title } }).catch(() => {});
  closeNotif(n.id, true);
}

/* Bell with the notification history */
function renderBell() {
  const b = $('#bell');
  b.classList.toggle('hidden', !N.history.length);
  $('#bell-count').textContent = N.unread > 0 ? N.unread : '';
  refreshBubbles();   // the Notifications bubble shows or goes away at once
}
/** Paints the bubbles again (the ones that depend on the panel, not on Home Assistant, like Notifications). */
function refreshBubbles() {
  try {
    COMPILED.forEach((m) => (m.cache = {}));
    renderAmbientChips();
    if (!S.sheetId) VIEW_CODE.forEach((v) => v && v.paint());
  } catch (e) { /* still starting */ }
}

/* Sounds made with Web Audio (no files needed) */
function tone(freqs, dur, vol) {
  try {
    const ctx = N.ctx || (N.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.02;
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.6 * (vol ?? SET.sound.volume / 100)), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
      t += dur;
    }
  } catch (e) { /* no audio */ }
}
function playSound(level) {
  stopSound();
  if (!SET.sound.enabled) return;
  if (level === 'critical') {                          // insistent beep until you close it
    const beep = () => tone([880, 660, 880, 660], 0.18);
    beep(); N.soundTimer = setInterval(beep, 1500);
  } else if (level === 'warning') {                    // "ding-dong" every 6 s for 30 s
    const dd = () => tone([784, 622], 0.5);
    dd(); N.soundTimer = setInterval(dd, 6000);
    N.soundStop = setTimeout(stopSound, 30000);
  } else tone([988], 0.15);
}
function stopSound() { clearInterval(N.soundTimer); clearTimeout(N.soundStop); N.soundTimer = null; }

/* ====================== Settings ======================
 * On the Pi they are saved in the helper (panel-helper.py), so they survive restarts even if Chromium runs
 * in incognito mode. Without the helper, in the browser. The panel writes nothing in Home Assistant. */
const SETTINGS_KEY = 'panel_hogar_settings';
const DEFAULTS = () => ({
  idleSeconds: CFG.idleSeconds,            // seconds without touching until ambient mode (0 = never)
  screenOffMinutes: 0,                     // minutes in ambient until the screen turns off (0 = never)
  brightness: 100,                         // daytime brightness (%)
  night: {
    enabled: !!(CFG.night && CFG.night.dim), start: (CFG.night && CFG.night.start) || '23:00',
    end: (CFG.night && CFG.night.end) || '07:00', brightness: Math.round((1 - ((CFG.night && CFG.night.dim) ?? 0.6)) * 100),
    screenOff: false,                      // turn the screen off at night when it is not used
  },
  language: 'auto',     // auto (Home Assistant's) | en | es
  theme: 'dark',        // dark | light | auto (light by day, dark at night)
  accent: 'blue',       // accent colour (ACCENTS)
  sound: { enabled: true, volume: 70 },
  photos: { enabled: true, seconds: CFG.photoSeconds || 30, fit: 'blur' },   // fit: cover | blur | contain
  alarms: [],
  ambientChips: null,   // null = default order and selection
  voiceSatellite: '',   // assist_satellite whose voice shows over the screen ('' = none)
  voiceStyle: 'wave',   // voice bar animation: wave | mic | light | eq
  defaultSpeaker: '',   // (from before) the first of ambientSpeakers
  ambientSpeakers: null,   // ambient mode speakers by priority ('@panel' = this panel's); null = [defaultSpeaker]
  ambientSameAsNp: false,  // true = the ambient player uses the “Now playing” speakers (web → Sound) instead of its own list
  ambientGestures: false,  // 🧪 beta: swipe / hold gestures in ambient mode (web → Beta)
  ambientSwipe: 'auto',    // what swiping ← → changes: auto (music if it plays, otherwise photos) | music | photos
  quick: [],            // quick access (entity_id)
  bullets: null,        // bubbles (built-in and script ones); null = the usual ones
  tabs: null,           // tabs with their cards; null = one per view
});
let SET = DEFAULTS();
const mergeSettings = (saved = {}) => {
  saved = window.PanelModules.migrateSettings(saved);   // names of older versions
  const d = DEFAULTS();
  return { ...d, ...saved, night: { ...d.night, ...(saved.night || {}) }, sound: { ...d.sound, ...(saved.sound || {}) },
    photos: { ...d.photos, ...(saved.photos || {}) } };
};
async function loadSettings() {
  let saved = null;
  const helper = window.PANEL_HELPER;
  if (helper && helper.settings && Object.keys(helper.settings).length) saved = helper.settings;   // the web ones
  else {
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || localStorage.getItem('panel_hogar_ajustes') || 'null');
      // Settings from older versions, saved in Home Assistant: only read (never written)
      if (!saved) saved = (await conn.send({ type: 'frontend/get_user_data', key: SETTINGS_KEY }) || {}).value;
    } catch (e) { /* no saved settings: defaults */ }
  }
  SET = mergeSettings(saved || {});
  setLanguage();
  applySettings();
}
let saveTimer;
function saveSettings(quiet) {   // quiet: without the “Settings saved” notice
  applySettings();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (window.PANEL_HELPER) {        // on the Pi: saved in the helper (so the web sees them)
        const r = await fetch(HELPER + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SET) });
        const j = await r.json(); REMOTE.version = j.version;
      } else {                          // no helper: in this browser (nothing is ever written in Home Assistant)
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); } catch (e) { /* no storage */ }
      }
      if (!quiet) toast(I18N.t('panel.settings.settings_saved'));
    } catch (e) { toast(I18N.t('panel.settings.could_not_save_prefix') + e.message, true); }
  }, 600);
}
function applySettings() { setLanguage(); applyTheme(); resetIdle(); screenTick(); try { COMPILED.forEach((m) => (m.cache = {})); } catch (e) { /* not loaded yet */ } }

/** Light or dark theme. “auto”: light while the sun is up (sun.sun) or, without it, from 8:00 to 20:00. */
/* Language of the texts (translations/). “Automatic”: Home Assistant's (or, offline, the browser's). */
let HA_LANG = null;
function setLanguage() {
  const want = I18N.resolve(SET.language, HA_LANG || navigator.language);
  if (want === I18N.lang) return;
  I18N.set(want);
  I18N.page(document.body);   // the fixed texts of index.html (titles…)
  try { renderRail(); render(); } catch (e) { /* still starting */ }
}
I18N.set(I18N.resolve(((window.PANEL_HELPER || {}).settings || {}).language, navigator.language));
I18N.page(document.body);

function themeIsLight() {
  if (SET.theme === 'light') return true;
  if (SET.theme !== 'auto') return false;
  const sun = S.states['sun.sun'];
  if (sun && sun.state !== 'unavailable') return sun.state === 'above_horizon';
  const hr = new Date().getHours();
  return hr >= 8 && hr < 20;
}
/* Accent colours: [name, in dark (colour, text on top, soft background), in light (the same)] */
const ACCENTS = {
  blue:     ['panel.settings.blue',     ['#8ab4f8', '#0b1d3a', '#1d3354'], ['#1a66d6', '#ffffff', '#d5e3fa']],
  teal:     ['panel.settings.teal', ['#78d9ec', '#00363f', '#1b3d45'], ['#00838f', '#ffffff', '#d0f0f3']],
  green:    ['panel.settings.green',    ['#81c995', '#0d2a17', '#1f3b2a'], ['#1e8e3e', '#ffffff', '#d6f0dd']],
  yellow:   ['panel.settings.yellow', ['#fdd663', '#3b2a06', '#4a3f1a'], ['#b58100', '#ffffff', '#fdf0c8']],
  orange:   ['panel.settings.orange',  ['#fcad70', '#3d1c00', '#4a3020'], ['#d96a00', '#ffffff', '#ffe5cc']],
  pink:     ['panel.settings.pink',     ['#ff8bcb', '#4a0a2c', '#4a2238'], ['#c2185b', '#ffffff', '#fbdbe8']],
  purple:   ['panel.settings.purple',   ['#c58af9', '#2a0a47', '#3a2554'], ['#8430ce', '#ffffff', '#ecdcfb']],
};
let accentApplied = '';
function applyTheme() {
  const light = themeIsLight();
  const name = ACCENTS[SET.accent] ? SET.accent : 'blue', key = name + (light ? ':light' : ':dark');
  if (key !== accentApplied) {
    accentApplied = key;
    const [c, ink, soft] = ACCENTS[name][light ? 2 : 1], st = document.documentElement.style;
    st.setProperty('--accent', c); st.setProperty('--accent-ink', ink); st.setProperty('--accent-soft', soft);
  }
  if (document.documentElement.classList.contains('light') === light) return;
  document.documentElement.classList.toggle('light', light);
  try { if (!photosOn()) nextBackground(); } catch (e) { /* still starting */ }   // the ambient mode background without photos changes with the theme
}

/** Circles to choose the accent colour (in the shade of the current theme). */
function accentPicker() {
  const wrap = h('div', { class: 'accents' });
  const paint = () => wrap.replaceChildren(...Object.entries(ACCENTS).map(([k, [label, dark, light]]) => {
    const [c, ink] = themeIsLight() ? light : dark, on = (SET.accent || 'blue') === k;
    return h('button', { class: 'accent-sw' + (on ? ' on' : ''), title: label, style: `background:${c};color:${ink}`,
      onclick: () => { SET.accent = k; saveSettings(); paint(); } }, on ? icon('mdi-check') : null);
  }));
  paint();
  accentPicker.paint = paint;
  return wrap;
}

function isNight(now = new Date()) {
  const n = SET.night;
  if (!n.enabled) return false;
  const m = now.getHours() * 60 + now.getMinutes(), a = toMin(n.start), b = toMin(n.end);
  return a > b ? (m >= a || m < b) : (m >= a && m < b);
}

/* ---------- Screen brightness and turning off ----------
 * With the Pi's helper (panel-helper.py on 127.0.0.1:8766) the real brightness changes and the screen
 * really turns off. Without it, a black layer darkens it (works on any screen). */
const HELPER = window.PANEL_HELPER_URL || 'http://127.0.0.1:8766';
const SCREEN = { off: false, lastTouch: Date.now(), helper: null, level: null, forcedOff: false };
async function helperInit() {
  try {
    const r = await fetch(HELPER + '/status', { cache: 'no-store' });
    SCREEN.helper = await r.json();
  } catch (e) { SCREEN.helper = null; }
  SCREEN.level = null;
  screenTick();
}
const helperPost = (path) => SCREEN.helper && fetch(HELPER + path, { method: 'POST' }).catch(() => {});

function setBrightness(level) {
  const hw = SCREEN.helper && SCREEN.helper.backlight;
  if (hw && level !== SCREEN.level) helperPost('/brightness?value=' + level);
  SCREEN.level = level;
  $('#dim').style.opacity = hw ? 0 : Math.min(0.9, (100 - level) / 100);
}
function setScreenOff(off) {
  if (off === SCREEN.off) return;
  SCREEN.off = off;
  $('#blackout').classList.toggle('hidden', !off);
  if (SCREEN.helper && SCREEN.helper.power) helperPost('/power?on=' + (off ? 0 : 1));
  if (off) stopSound();
  else if (S.entered) enterScreen();   // the screen turns on
}
/** Decides brightness and turning off: called every 5 s, on touch, when settings change and when a notification arrives. */
function screenTick() {
  applyTheme();
  const night = isNight(), alert = alertOpen();
  const idle = (Date.now() - SCREEN.lastTouch) / 1000;
  let off = false;
  if (!alert && !npPlaying() && !STAY.on) {
    if (SET.screenOffMinutes > 0 && idle >= Math.max(0, SET.idleSeconds) + SET.screenOffMinutes * 60) off = true;
    if (night && SET.night.screenOff && idle >= Math.max(60, SET.idleSeconds)) off = true;
  }
  if (SCREEN.forcedOff && !alert) off = true;   // turned off by hand (button or Home Assistant): until it is touched or a notification
  setScreenOff(off);
  setBrightness(alert ? 100 : night ? SET.night.brightness : SET.brightness);
  reportState();
}
/** Turn the screen off now (button, remote control or Home Assistant): it stays off until touched. */
function screenOffNow() { SCREEN.lastTouch = 0; SCREEN.forcedOff = true; screenTick(); }
function wakeScreen() { SCREEN.lastTouch = Date.now(); SCREEN.forcedOff = false; screenTick(); }
/** On start or when the screen turns on: if something plays, “Now playing”; otherwise ambient mode. */
function enterScreen() {
  if (alertOpen() || STAY.on) return;
  const playing = watchedSpeakers().find(spkPlaying);
  if (playing) {
    if (NP.id === playing) return;
    showAmbient();             // so the ✕ of “Now playing” goes back to ambient mode
    showNowPlaying(playing);
  } else {
    npToAmbient(true);
  }
}

/* ---------- Controls of the Settings view ---------- */
/** Touch dropdown: shows the chosen option and, when tapped, opens the list. options: [[value, name, icon, subtitle]] */
function pickList(options, value, onpick) {
  const wrap = h('div', { class: 'pick' });
  let open = false;
  const row = ([, name, ic, sub], cls) => h('button', { class: 'speaker-opt ' + cls }, icon(ic),
    h('div', { class: 'speaker-text' }, h('div', null, name), sub ? h('div', { class: 'muted small' }, sub) : null));
  const paint = () => {
    const cur = options.find((o) => o[0] === value) || options[0];
    const head = row(cur, 'pick-head' + (open ? ' open' : ''));
    head.append(icon('mdi-chevron-down', 'pick-chevron'));
    head.addEventListener('click', () => { open = !open; paint(); });
    const list = h('div', { class: 'pick-list' + (open ? ' open' : '') }, options.filter((o) => o !== cur).map((o) => {
      const b = row(o, '');
      b.addEventListener('click', () => { value = o[0]; open = false; onpick(o[0]); paint(); });
      return b;
    }));
    wrap.replaceChildren(head, list);
  };
  paint();
  return wrap;
}
function segmented(options, value, onpick) {
  const wrap = h('div', { class: 'seg' });
  const paint = (v) => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(v)));
  for (const [v, label] of options) wrap.append(h('button', { 'data-v': String(v), onclick: () => { paint(v); onpick(v); } }, label));
  paint(value);
  return wrap;
}
function switchBtn(value, onchange) {
  const sw = h('button', { class: 'switch' + (value ? ' on' : ''), role: 'switch' }, h('span'));
  sw.addEventListener('click', () => { value = !value; sw.classList.toggle('on', value); onchange(value); });
  return sw;
}
const fmtHM = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
function timeStepper(value, onchange) {
  let m = toMin(value);
  const lab = h('span', { class: 'time-val' }, fmtHM(m));
  const step = (d) => { m = (m + d + 1440) % 1440; lab.textContent = fmtHM(m); onchange(fmtHM(m)); };
  return h('div', { class: 'stepper' }, h('button', { class: 'round-btn', onclick: () => step(-30) }, icon('mdi-minus')), lab,
    h('button', { class: 'round-btn', onclick: () => step(30) }, icon('mdi-plus')));
}
const setRow = (label, sub, control) => h('div', { class: 'set-row' },
  h('div', { class: 'set-text' }, h('div', null, label), sub ? h('div', { class: 'muted small' }, sub) : null), control);
const setBlock = (label, sub, control) => h('div', { class: 'set-block' },
  h('div', { class: 'set-text' }, h('div', null, label), sub ? h('div', { class: 'muted small' }, sub) : null), control);

/* ---------- Network and setting up from the phone ---------- */
async function fetchNet() {
  try { return await (await fetch(HELPER + '/network', { cache: 'no-store' })).json(); } catch (e) { return null; }
}
function qrSvg(text) {
  if (typeof qrcode !== 'function') return null;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}
/** Sheet with the QR of the configuration web and the address written, to open it on the phone. */
async function openConfigQR() {
  closeSheet();
  const net = await fetchNet();
  const body = h('div', { class: 'sheet-body qr-body' });
  if (!net) {
    body.append(h('div', { class: 'muted' }, I18N.t('panel.settings.phone_setup_needs_pi')));
  } else {
    const url = net.urls[0];
    const svg = qrSvg(url);
    body.append(
      svg ? h('div', { class: 'qr', html: svg }) : null,
      h('div', { class: 'qr-url' }, url),
      h('div', { class: 'muted small' }, I18N.t('panel.settings.also_prefix') + net.urls.slice(1).join(' · ')),
      h('div', { class: 'qr-steps' },
        h('div', null, icon('mdi-numeric-1-circle'), I18N.t('panel.settings.scan_code')),
        h('div', null, icon('mdi-numeric-2-circle'), I18N.t('panel.settings.log_in_with_password')),
        h('div', null, icon('mdi-numeric-3-circle'), I18N.t('panel.settings.change_and_save'))));
  }
  $('#sheet-card').replaceChildren(
    h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }, icon('mdi-qrcode')), h('div', { class: 'sheet-title' }, I18N.t('panel.settings.set_up_from')),
      h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close'))), body);
  $('#sheet').classList.remove('hidden');
  S.sheetId = 'qr';
}
function netCard() {
  const rows = h('div', { class: 'set-net' }, h('div', { class: 'muted small' }, I18N.t('panel.settings.reading_network')));
  fetchNet().then((net) => {
    if (!net) { rows.replaceChildren(h('div', { class: 'muted small' }, I18N.t('panel.settings.available_on_pi'))); return; }
    const r = (label, val) => setRow(label, null, h('span', { class: 'net-val' }, val));
    rows.replaceChildren(...[
      r(I18N.t('panel.sheets.name'), net.hostname),
      r(I18N.t('panel.settings.ip'), net.ipv4 ? I18N.t(net.ipv4.method === 'manual' ? 'panel.settings.ip_static' : 'panel.settings.ip_auto', { ip: net.ip }) : net.ip),
      net.wifi ? r(I18N.t('panel.settings.wifi'), `${net.wifi.ssid} · ${net.wifi.signal} %`) : net.connection ? r(I18N.t('panel.settings.connection'), net.connection.type === 'ethernet' ? I18N.t('panel.settings.ethernet') : net.connection.name) : null,
      r(I18N.t('panel.settings.configuration_web'), net.urls[0]),
      net.simulated ? h('div', { class: 'muted small' }, I18N.t('panel.settings.simulated_network')) : null].filter(Boolean));
  });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-wifi'), I18N.t('panel.settings.network_setup_from')),
    rows,
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action primary', onclick: openConfigQR }, icon('mdi-qrcode'), I18N.t('panel.settings.set_up_from'))),
    h('div', { class: 'muted small' }, I18N.t('panel.settings.pi_s_wifi')));
}

/* ---------- Updates (the helper does them with git; also from the web) ---------- */
async function updApi(body) {
  const r = await fetch(HELPER + '/updates', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return body ? d.info : d;
}
function updatesCard() {
  const body = h('div', { class: 'set-body' }, h('div', { class: 'muted small' }, I18N.t('panel.settings.reading')));   // its rows look like the rest of the cards
  let timer = null;
  const fill = (u) => {
    clearTimeout(timer);
    if (!u) { body.replaceChildren(h('div', { class: 'muted small' }, I18N.t('panel.settings.available_on_pi'))); return; }
    const n = u.available.length;
    const status = u.applying ? I18N.t('web.system.updating') : u.checking ? I18N.t('web.system.checking') : n ? I18N.t(n > 1 ? 'panel.settings.new_updates' : 'panel.settings.new_updates_one', { n }) : I18N.t('panel.settings.up_date');
    const val = (t) => h('span', { class: 'net-val', style: 'white-space: nowrap' }, t);
    let hour = u.settings.hour;
    const hourLab = h('span', { class: 'time-val' }, String(hour).padStart(2, '0') + ':00');
    const stepHour = (d) => {
      hour = (hour + d + 24) % 24; hourLab.textContent = String(hour).padStart(2, '0') + ':00';
      updApi({ action: 'settings', hour }).catch((e) => toast(e.message, true));
    };
    body.replaceChildren(...[
      setRow(I18N.t('panel.sheets.version'), u.current ? u.current.subject : null, val(u.current ? u.current.hash : '¿?')),
      setRow(I18N.t('panel.sheets.status'), u.error || null, h('span', { class: 'pill' + (n || u.error ? '' : ' ok') }, status)),
      n ? h('div', { class: 'upd-list muted small' }, ...u.available.slice(0, 6).map((c) => h('div', null, '• ' + c.subject))) : null,
      setBlock(I18N.t('panel.settings.when_there_new'), u.settings.mode === 'auto' ? I18N.t('panel.settings.auto_update_hint') : I18N.t('panel.settings.tells_update_button'),
        segmented([['notify', I18N.t('panel.settings.notify_me')], ['auto', I18N.t('panel.settings.automatic')]], u.settings.mode,
          (v) => updApi({ action: 'settings', mode: v }).then(fill).catch((e) => toast(e.message, true)))),
      u.settings.mode === 'auto' ? setRow(I18N.t('web.system.time'), null, h('div', { class: 'stepper' },
        h('button', { class: 'round-btn', onclick: () => stepHour(-1) }, icon('mdi-minus')), hourLab,
        h('button', { class: 'round-btn', onclick: () => stepHour(1) }, icon('mdi-plus')))) : null,
      !u.sudo ? h('div', { class: 'muted small' }, I18N.t('panel.settings.sudo_hint')) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => { toast(I18N.t('web.system.checking')); updApi({ action: 'check' }).then((i) => { fill(i); toast(i.error ? i.error : i.available.length ? I18N.t('panel.settings.new_version') : I18N.t('panel.settings.already_up_to_date'), !!i.error); }).catch((e) => toast(e.message, true)); } },
          icon('mdi-cloud-search'), I18N.t('panel.settings.check')),
        n && !u.applying ? h('button', { class: 'big-action primary', onclick: () => { toast(I18N.t('panel.settings.updating_restart')); updApi({ action: 'update' }).then(fill).catch((e) => toast(e.message, true)); } },
          icon('mdi-download'), I18N.t('panel.settings.update_now')) : null),
      u.simulated ? h('div', { class: 'muted small' }, I18N.t('panel.settings.no_real_update')) : null].filter(Boolean));
    if (u.applying || u.checking) timer = setTimeout(() => updApi().then(fill).catch(() => {}), 2000);
  };
  updApi().then(fill).catch(() => fill(null));
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-update'), I18N.t('panel.settings.updates')), body);
}

function renderSettings() {
  const pct = (v) => v + ' %';
  const bright = slider({ min: 5, max: 100, step: 5, label: I18N.t('panel.sheets.brightness'), fmt: pct, onchange: (v) => { SET.brightness = v; saveSettings(); } });
  bright.set(SET.brightness);
  const nightBright = slider({ min: 5, max: 100, step: 5, label: I18N.t('panel.settings.night_brightness'), fmt: pct, onchange: (v) => { SET.night.brightness = v; saveSettings(); } });
  nightBright.set(SET.night.brightness);

  const hw = SCREEN.helper;
  const helperText = !hw ? I18N.t('panel.settings.backlight_none')
    : hw.simulated ? I18N.t('panel.settings.simulated_computer_image')
    : hw.backlight ? I18N.t('panel.settings.backlight_full') : hw.power ? I18N.t('panel.settings.backlight_power') : I18N.t('panel.settings.backlight_no_control');

  return [h('div', { class: 'settings' },
    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-monitor'), I18N.t('panel.settings.screen')),
      bright,
      setBlock(I18N.t('panel.settings.language'), null, segmented([['auto', I18N.t('panel.settings.automatic')], ...Object.entries(I18N.langs)], SET.language || 'auto',
        (v) => { SET.language = v; saveSettings(); })),
      setBlock(I18N.t('panel.settings.theme'), I18N.t('panel.settings.automatic_light_by'),
        segmented([['dark', I18N.t('panel.settings.dark')], ['light', I18N.t('panel.settings.theme_light')], ['auto', I18N.t('panel.settings.automatic')]], SET.theme || 'dark', (v) => { SET.theme = v; saveSettings(); if (accentPicker.paint) accentPicker.paint(); })),   // the circles, in the shade of the theme
      setBlock(I18N.t('panel.settings.colour'), I18N.t('panel.settings.buttons_sliders_volume'), accentPicker()),
      setBlock(I18N.t('panel.settings.ambient_mode'), I18N.t('panel.settings.time_without_touching'),
        segmented([[0, I18N.t('panel.settings.never')], [30, '30 s'], [60, '1 min'], [90, I18N.t('panel.settings.1_5_min')], [180, '3 min'], [300, '5 min'], [600, '10 min']],
          SET.idleSeconds, (v) => { SET.idleSeconds = v; saveSettings(); })),
      setBlock(I18N.t('panel.quick.turn_off_screen'), I18N.t('panel.settings.time_ambient_mode'),
        segmented([[0, I18N.t('panel.settings.never')], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h']],
          SET.screenOffMinutes, (v) => { SET.screenOffMinutes = v; saveSettings(); })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), I18N.t('panel.settings.ambient_mode')),
        h('button', { class: 'big-action', onclick: () => { screenOffNow(); } }, icon('mdi-monitor-off'), I18N.t('panel.settings.turn_off_now')))),

    soundCard(),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-image-multiple'), I18N.t('panel.settings.ambient_mode_photos')),
      setRow(I18N.t('panel.settings.show_photos'),
        PHOTOS.length ? I18N.t('panel.settings.photos_loaded', { n: PHOTOS.length }) : photoSources().length ? I18N.t('panel.ambient.could_not_load') : I18N.t('panel.settings.add_photo_sources'),
        switchBtn(SET.photos.enabled, (v) => { SET.photos.enabled = v; saveSettings(); nextBackground(); })),
      setBlock(I18N.t('panel.settings.how_photos_are'), I18N.t('panel.settings.each_source_can'),
        segmented([['cover', I18N.t('panel.settings.fill')], ['blur', I18N.t('panel.settings.whole_blurred')], ['contain', I18N.t('panel.settings.whole')]],
          SET.photos.fit || 'blur', (v) => { SET.photos.fit = v; saveSettings(); refitPhotos(); })),
      setBlock(I18N.t('panel.settings.change_photo_every'), null,
        segmented([[15, '15 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min']],
          SET.photos.seconds, (v) => { SET.photos.seconds = v; saveSettings(); nextBackground(); })),
      ...PHOTO_STATS.map((st) => setRow(st.label, st.error ? I18N.t('panel.status.error_prefix') + st.error : null,
        h('span', { class: 'pill' + (st.error ? '' : ' ok') }, st.error ? I18N.t('panel.states.error') : I18N.t('panel.settings.photos_count', { n: st.count })))),
      photoSources().length ? h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: async () => { toast(I18N.t('panel.settings.reloading_photos')); await loadPhotos(); render(); } }, icon('mdi-image-refresh'), I18N.t('panel.settings.reload_album')),
        h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), I18N.t('panel.sheets.watch_now'))) : null),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-weather-night'), I18N.t('panel.settings.night_mode')),
      setRow(I18N.t('panel.settings.enabled'), I18N.t('panel.settings.dims_screen_at'), switchBtn(SET.night.enabled, (v) => { SET.night.enabled = v; saveSettings(); })),
      setRow(I18N.t('panel.settings.from'), null, timeStepper(SET.night.start, (v) => { SET.night.start = v; saveSettings(); })),
      setRow(I18N.t('panel.settings.until'), null, timeStepper(SET.night.end, (v) => { SET.night.end = v; saveSettings(); })),
      nightBright,
      setRow(I18N.t('panel.settings.turn_off_screen'), I18N.t('panel.settings.when_not_use'),
        switchBtn(SET.night.screenOff, (v) => { SET.night.screenOff = v; saveSettings(); }))),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-bell-ring'), I18N.t('panel.quick.notifications')),
      setRow(I18N.t('panel.settings.sound'), I18N.t('panel.settings.chime_notifications_beeps'), switchBtn(SET.sound.enabled, (v) => { SET.sound.enabled = v; saveSettings(); })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => onNotif({ data: { id: 'settings_test', title: I18N.t('panel.notices.test_notification'), message: I18N.t('panel.notices.test_message'), level: 'warning', icon: 'mdi:bell-ring', timeout: 15 } }) },
          icon('mdi-bell-badge'), I18N.t('panel.notices.send_test_notification')))),

    alarmsCard(),

    bulletsCard(),

    speakerCard(),

    voiceCard(),

    netCard(),

    updatesCard(),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-information-outline'), 'Panel'),
      setRow(I18N.t('web.general.home_assistant'), CFG.haUrl,
        h('span', { class: 'pill' + (S.connected ? ' ok' : '') }, S.connected ? I18N.t('panel.settings.connected') : I18N.t('panel.states.disconnected'))),
      setRow(I18N.t('panel.settings.screen_control'), helperText, h('span', { class: 'pill' + (hw ? ' ok' : '') }, hw ? (hw.simulated ? I18N.t('panel.settings.simulated') : I18N.t('panel.settings.helper')) : I18N.t('panel.settings.software'))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => location.reload() }, icon('mdi-refresh'), I18N.t('panel.settings.reload_panel')))))];
}

/* ====================== Alarms (alarm clock) ======================
 * They belong to the panel: saved in the Settings (SET.alarms) and they ring on the screen. Nothing is read from the phone.
 * Days: 0 = Monday … 6 = Sunday. No days = it rings once and turns off. */
const DAY_LETTERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const idxOfDay = (d) => (d.getDay() + 6) % 7;
const RING = { active: null, lastKey: null, timer: null, stop: null, started: 0, snooze: {} };

function nextOccurrence(al, from = new Date()) {
  const [hh, mm] = al.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh, mm, 0, 0);
    if (d <= from) continue;
    if (al.days && al.days.length && !al.days.includes(idxOfDay(d))) continue;
    return d;
  }
  return null;
}
function whenText(d) {
  const now = new Date(), tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = d.toDateString() === now.toDateString() ? I18N.t('panel.time.today') : d.toDateString() === tom.toDateString() ? I18N.t('panel.time.tomorrow')
    : cap(d.toLocaleDateString(I18N.locale(), { weekday: 'long' }));
  return `${day} ${hhmm(d)}`;
}
function daysText(days) {
  const s = [...(days || [])].sort().join('');
  if (!s) return I18N.t('panel.settings.once');
  if (s === '0123456') return I18N.t('panel.time.every_day');
  if (s === '01234') return I18N.t('panel.settings.monday_friday');
  if (s === '56') return I18N.t('panel.time.weekends');
  return [...days].sort().map((i) => DAY_LETTERS[i]).join(' ');
}
/** The next alarm in the next 24 h, for Home and ambient mode. */

/* ---------- Ringing ---------- */
function checkAlarms(now = new Date()) {
  if (RING.active || NEEDS_SETUP) return;
  const minute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const al of SET.alarms || []) {
    const snoozed = RING.snooze[al.id];
    const dueSnooze = snoozed && now.getTime() >= snoozed;
    const dueTime = al.enabled && al.time === minute && (!al.days || !al.days.length || al.days.includes(idxOfDay(now)));
    const key = al.id + '@' + now.toDateString() + minute;
    if ((dueSnooze || dueTime) && RING.lastKey !== key) {
      RING.lastKey = key;
      delete RING.snooze[al.id];
      ringAlarm(al);
      return;
    }
  }
}
function ringAlarm(al) {
  RING.active = al;
  RING.started = Date.now();
  if (S.ambient) { S.ambient = false; $('#ambient').classList.remove('show'); }
  closeSheet();
  hideNowPlaying(true);
  SCREEN.lastTouch = Date.now();
  screenTick();
  const time = h('div', { class: 'ring-time' }, hhmm(new Date()));
  $('#ring').replaceChildren(h('div', { class: 'ring-box' },
    icon('mdi-alarm', 'ring-icon'), time,
    h('div', { class: 'ring-label' }, al.name || I18N.t('panel.settings.alarm')),
    h('div', { class: 'ring-actions' },
      h('button', { class: 'big-action', onclick: () => stopAlarm(true) }, icon('mdi-sleep'), I18N.t('panel.settings.snooze_9')),
      h('button', { class: 'big-action primary', onclick: () => stopAlarm(false) }, icon('mdi-alarm-off'), I18N.t('panel.sheets.stop')))));
  $('#ring').classList.remove('hidden');
  // Tune that gets louder during the first minute
  const play = () => {
    const ramp = Math.min(1, 0.35 + (Date.now() - RING.started) / 60000);
    const vol = Math.max(SET.sound.volume, 60) / 100 * ramp;
    tone([523, 659, 784, 1047], 0.2, vol);
    time.textContent = hhmm(new Date());
  };
  play();
  RING.timer = setInterval(play, 2200);
  RING.stop = setTimeout(() => stopAlarm(false), 10 * 60e3);     // at most 10 minutes ringing
}
function stopAlarm(snooze) {
  const al = RING.active;
  clearInterval(RING.timer); clearTimeout(RING.stop);
  RING.active = null;
  $('#ring').classList.add('hidden');
  if (!al) return;
  if (snooze) {
    RING.snooze[al.id] = Date.now() + 9 * 60e3;
    toast(`Pospuesta hasta las ${hhmm(new Date(RING.snooze[al.id]))}`);
  } else if (!al.days || !al.days.length) {               // just once: it turns off
    al.enabled = false;
    saveSettings();
  }
  SCREEN.lastTouch = Date.now();
  resetIdle();
  screenTick();
  if (S.view === 'settings') render();
}

/* ---------- Alarm editor ---------- */
function openAlarmEditor(existing) {
  closeSheet();
  const al = existing ? { ...existing, days: [...(existing.days || [])] }
    : { id: 'a' + Date.now().toString(36), time: '07:30', days: [0, 1, 2, 3, 4], enabled: true, name: '' };
  let [hh, mm] = al.time.split(':').map(Number);
  const timeEl = h('div', { class: 'alarm-time' });
  const paint = () => { timeEl.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
  const step = (dh, dm) => { mm += dm; if (mm < 0) { mm += 60; dh -= 1; } if (mm >= 60) { mm -= 60; dh += 1; } hh = (hh + dh + 24) % 24; paint(); };
  const rb = (ic, fn) => h('button', { class: 'round-btn', onclick: fn }, icon(ic));
  const days = h('div', { class: 'alarm-days' }, DAY_LETTERS.map((l, i) => {
    const b = h('button', { class: 'day-btn' + (al.days.includes(i) ? ' on' : '') }, l);
    b.addEventListener('click', () => {
      al.days = al.days.includes(i) ? al.days.filter((x) => x !== i) : [...al.days, i];
      b.classList.toggle('on'); hint.textContent = daysText(al.days);
    });
    return b;
  }));
  const hint = h('div', { class: 'muted small', style: 'text-align:center' }, daysText(al.days));
  const presets = h('div', { class: 'chips', style: 'justify-content:center' }, [[I18N.t('panel.settings.every_day'), [0, 1, 2, 3, 4, 5, 6]], ['L a V', [0, 1, 2, 3, 4]], [I18N.t('panel.settings.weekend'), [5, 6]], [I18N.t('panel.settings.once'), []]]
    .map(([label, d]) => h('button', { class: 'chip', onclick: () => {
      al.days = [...d];
      days.querySelectorAll('.day-btn').forEach((b, i) => b.classList.toggle('on', d.includes(i)));
      hint.textContent = daysText(al.days);
    } }, label)));
  const names = ['panel.settings.alarm', 'panel.settings.wake_up', 'panel.sheets.job', 'panel.settings.nap', 'panel.settings.medicines'];
  const nameRow = h('div', { class: 'chips', style: 'justify-content:center' }, names.map((n) => {
    const c = h('button', { class: 'chip' + ((al.name || 'panel.settings.alarm') === n ? ' sel' : '') }, n);
    c.addEventListener('click', () => { al.name = n; nameRow.querySelectorAll('.chip').forEach((x) => x.classList.toggle('sel', x === c)); });
    return c;
  }));
  const save = () => {
    al.time = timeEl.textContent; al.enabled = true;
    const list = (SET.alarms || []).filter((x) => x.id !== al.id);
    SET.alarms = [...list, al].sort((x, y) => x.time.localeCompare(y.time));
    delete RING.snooze[al.id];
    saveSettings(); closeSheet(); render();
    const n = nextOccurrence(al);
    if (n) toast(I18N.t('panel.settings.will_ring', { when: whenText(n).toLowerCase() }));
  };
  const del = () => { SET.alarms = (SET.alarms || []).filter((x) => x.id !== al.id); saveSettings(); closeSheet(); render(); toast(I18N.t('panel.settings.alarm_deleted')); };
  paint();
  $('#sheet-card').replaceChildren(
    h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }, icon('mdi-alarm')), h('div', { class: 'sheet-title' }, existing ? I18N.t('panel.settings.edit_alarm') : I18N.t('panel.settings.new_alarm')),
      h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close'))),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'alarm-editor' },
        h('div', { class: 'alarm-col' }, rb('mdi-chevron-up', () => step(1, 0)), rb('mdi-chevron-down', () => step(-1, 0))),
        timeEl,
        h('div', { class: 'alarm-col' }, rb('mdi-chevron-up', () => step(0, 5)), rb('mdi-chevron-down', () => step(0, -5)))),
      days, hint, presets, nameRow,
      h('div', { class: 'btn-row' }, existing ? h('button', { class: 'big-action danger-soft', onclick: del }, icon('mdi-delete'), I18N.t('panel.settings.delete')) : null,
        h('button', { class: 'big-action primary', onclick: save }, icon('mdi-check'), I18N.t('panel.settings.save')))));
  $('#sheet').classList.remove('hidden');
  S.sheetId = 'alarma';
}

/** Settings card with the panel alarms. */
function alarmsCard() {
  const list = (SET.alarms || []).map((al) => {
    const next = al.enabled ? nextOccurrence(al) : null;
    const row = h('div', { class: 'alarm-row' + (al.enabled ? '' : ' off') },
      h('div', { class: 'alarm-row-time' }, al.time),
      h('div', { class: 'alarm-row-text' }, h('div', null, al.name || I18N.t('panel.settings.alarm')),
        h('div', { class: 'muted small' }, daysText(al.days) + (next ? ' · ' + whenText(next).toLowerCase() : ''))),
      switchBtn(al.enabled, (v) => { al.enabled = v; delete RING.snooze[al.id]; saveSettings(); render(); }));
    row.firstChild.addEventListener('click', () => openAlarmEditor(al));
    row.children[1].addEventListener('click', () => openAlarmEditor(al));
    return row;
  });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-alarm'), I18N.t('panel.settings.alarms')),
    list.length ? list : h('div', { class: 'muted small' }, I18N.t('panel.settings.no_alarms_panel')),
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action primary', onclick: () => openAlarmEditor(null) }, icon('mdi-alarm-plus'), I18N.t('panel.settings.add_alarm'))));
}

/* ====================== Navigation and rendering ====================== */
/* ====================== Tabs ====================== */
const PM = window.PanelModules;
const tabs = () => PM.tabList(SET.tabs);
const tabViews = (t) => (t.cards || []).filter((c) => c.type === 'view').map((c) => c.view);
/** A tab that only has views that do not apply (e.g. Scooter without a scooter) does not show. */
const tabVisible = (t) => {
  const v = tabViews(t);
  return !v.length || v.length < (t.cards || []).length || v.some((k) => !VIEW_VISIBLE[k] || VIEW_VISIBLE[k]());
};
const visibleTabs = () => tabs().filter(tabVisible);
/** Tab for a destination: its id or the first one that contains that view. */
function tabFor(key) {
  if (key === 'settings') return 'settings';
  const list = visibleTabs();
  const t = list.find((x) => x.id === key) || list.find((x) => tabViews(x).includes(key));
  return t ? t.id : (list[0] || {}).id || 'settings';
}
function renderRail() {
  const rail = $('#rail');
  rail.replaceChildren(...visibleTabs().map((t) => {
    const btn = h('button', { class: 'rail-btn' + (S.view === t.id ? ' active' : ''), onclick: () => go(t.id) }, icon(PM.mdi(t.icon) || 'mdi-tab'), t.title);
    if (t.id === 'scooter' || tabViews(t).includes('scooter')) {          // tiny bolt over the icon while the scooter charges
      const k = scooterIds(), badge = h('span', { class: 'rail-badge hidden' }, icon('mdi-lightning-bolt'));
      btn.append(badge);
      bindMany('view', [k.charging_any, k.charged], () => {
        const m = chargeMode(k);
        badge.classList.toggle('hidden', !m);
        badge.classList.toggle('charged', m === 'charged');
      });
    }
    return btn;
  }),
    h('div', { class: 'rail-spacer' }),
    h('button', { class: 'rail-btn', onclick: showAmbient }, icon('mdi-image-filter-hdr'), I18N.t('panel.nav.ambient')));
}

/** Content of a tab: a 12-column grid; each card takes its width (c.width). */
function renderTab(t) { return [layout(t.cards)]; }
/** Grid with cards (also the one inside a Card component). */
function layout(cards) {
  return h('div', { class: 'layout' }, (cards || []).map((c) => {
    let kids;
    try { kids = renderCard(c); } catch (e) { console.error(e); kids = [codeError(c.title || I18N.t('web.editor.card'), e.message)]; }
    kids = [].concat(kids || []).filter(Boolean);
    if (!kids.length) return null;
    const slot = h('div', { class: 'slot w-' + String(c.width || 'full').replace('/', '-') }, kids);
    // “Only show if…”: checked when its entities change and, with times, night mode or code, every 20 s
    if (c.when && (c.when.rules || []).length) {
      const deps = PM.whenDeps(c.when);
      const check = () => slot.classList.toggle('when-off', !PM.checkWhen(c.when, HA, screenFor('card')));
      bindMany('view', deps.entities, check);
      if (deps.timed) S.viewTimers.push(setInterval(check, 20e3));
    }
    return slot;
  }).filter(Boolean));
}
const anyTile = (id) => (['sensor', 'binary_sensor'].includes(domain(id)) ? sensorTile(id) : tile(id));
function renderCard(c) {
  const title = c.title ? h('div', { class: 'section-title' }, c.title) : null;
  // Old view (or unsaved built-in tab): built on the fly with the same components the web uses
  if (c.type === 'view') {
    if (VIEW_VISIBLE[c.view] && !VIEW_VISIBLE[c.view]()) return [];
    return [layout(PM.viewCards(c.view, HA, { visible: compVisible, favorites: CFG.favorites || [] }))];
  }
  if (c.type === 'entities') return [title, h('div', { class: 'grid' }, (c.entities || []).filter((id) => S.states[id]).map(anyTile))];
  if (c.type === 'camera') return S.states[c.entity] ? [title, h('div', { class: 'cams' }, cameraImg(c.entity, 'view', CFG.cameraRefreshSeconds))] : [];
  if (c.type === 'component') return componentCard(c, title);
  if (c.type === 'bubbles') {
    const box = h('div', { class: 'chips' });
    const items = (c.items || []).filter((it) => it.script in MODULES).map((it) => ({ it, m: moduleOf(it.script) }));   // no script (deleted): it does not show
    let watch = [];
    const paint = () => {
      watch = [];
      box.replaceChildren(...items.flatMap(({ it, m }) => {
        if (m.err) return [bubbleEl({ icon: 'mdi-alert-circle-outline', text: `${it.script}: ${m.err}`, color: PM.color('red') }, 'chip')];
        try {
          const bound = m.mod.bind(it.config, HA);
          watch.push(bound.matches);
          return PM.bubbles(m.mod.render(HA, screenFor('home'), bound.cfg)).map((b) => bubbleEl(b, 'chip'));
        } catch (e) { return [bubbleEl({ icon: 'mdi-alert-circle-outline', text: `${it.script}: ${e.message}`, color: PM.color('red') }, 'chip')]; }
      }));
    };
    paint(); VIEW_CODE.push({ matches: (id) => watch.some((f) => f(id)), paint });
    return [title, box];
  }
  return [];
}
/* ====================== Components ======================
 * Each placed component is a card { type: 'component', component: 'button.js', width, config, cards? }.
 * Its script (type: 'card') says its fields, what it watches, its HTML and its CSS; the values of each place go in config. */
/** Runs the tap / hold action on an entity. */
function runAction(a, id, el) {
  a = PM.actionOf(a);
  if (!a || a.action === 'none') return;
  const target = a.entity || id;
  if (a.action === 'toggle') { if (target) tap(target, el); return; }
  if (a.action === 'more-info') { if (target) openSheet(target); return; }
  if (a.action === 'navigate') { if (a.go) go(a.go); return; }
  if (a.action === 'call') {
    const [d, sv] = String(a.service || '').split('.');
    if (!d || !sv) { toast(I18N.t('panel.status.action_without_service'), true); return; }
    call(d, sv, a.data || {}, target);
  }
}
const hasAction = (a) => { a = PM.actionOf(a); return !!a && a.action !== 'none'; };
/** A placed component: runs its script (type: 'card') and paints its HTML with its CSS (lib/components.js). */
function componentCard(c, title) {
  const name = c.component, m = moduleOf(name);
  if (m.err) return [title, codeError(name, m.err)];
  if (m.mod.type !== 'card') return [title, codeError(name, I18N.t("web.editor.not_a_component"))];
  const host = h('div', { class: 'comp' });
  // The inner ones (<slot>) are created once and stay in place on every repaint
  const kids = m.mod.children ? layout(c.cards) : null;
  let bound = null;
  const paint = () => {
    try {
      bound = m.mod.bind(c.config, HA);
      PanelComp.render(host, name, m.mod, [HA, screenFor('card'), bound.cfg], {
        // Hooked once; p.tap / p.hold are read on tap (they may change on repaint).
        // Holding never counts as tapping: if it has no hold action, it does nothing
        press(el, p) {
          pressable(el, () => { if (isAct(p.tap)) pieceAction(p.tap, p, el); }, () => { if (isAct(p.hold)) pieceAction(p.hold, p, el); });
        },
        children: () => kids,
        widget: componentWidget,
        change(el, fn) {
          el.addEventListener('change', (e) => {
            try { const r = fn(HA_TAP, screenFor('card'), e.target.value); if (r && r.catch) r.catch((x) => toast(x.message || String(x), true)); }
            catch (x) { toast(x.message || String(x), true); }
          });
        },
      });
    } catch (e) { host.replaceChildren(codeError(m.mod.name || name, e.message)); }
  };
  paint(); VIEW_CODE.push({ matches: (id) => !!bound && bound.matches(id), paint });
  // refresh: seconds → it repaints by itself (times, dates…); the timers stop when the tab changes
  if (m.mod.refresh) S.viewTimers.push(setInterval(paint, Math.max(5, m.mod.refresh) * 1000));
  return [title, host];
}
/** The panel tiles and cards a component adds with <ha-tile entity>, <ha-media>, <ha-printer device>… */
function componentWidget(e) {
  const t = e.tagName.toLowerCase(), id = e.getAttribute('entity'), has = id && S.states[id];
  const none = () => document.createTextNode('');
  if (t === 'ha-tile') return has ? tile(id) : none();
  if (t === 'ha-sensor') return has ? sensorTile(id) : none();
  if (t === 'ha-camera') {
    // By address (src): an image that reloads every few seconds. If it is not an image (e.g. the page
    // of the camera player), the page goes in as it is, like Home Assistant's “web page” card
    const src = e.getAttribute('src');
    if (src) {
      const img = h('img', { alt: '' }), box = h('div', { class: 'cam' }, img);
      let page = false;
      const load = () => {
        if (page) return;
        const next = new Image();
        next.onload = () => { img.src = next.src; };
        next.onerror = () => { if (!img.getAttribute('src')) { page = true; box.replaceChildren(h('iframe', { class: 'cam-frame', src: absUrl(src), allow: 'autoplay; fullscreen', scrolling: 'no' })); } };
        next.src = src.startsWith('data:') ? src : absUrl(src) + (src.includes('?') ? '&' : '?') + '_t=' + Date.now();
      };
      load();
      S.viewTimers.push(setInterval(load, (CFG.cameraRefreshSeconds || 5) * 1000));
      return box;
    }
    if (!has) return none();
    const c = cameraImg(id, 'view', CFG.cameraRefreshSeconds);
    pressable(c, () => openSheet(id));
    return c;
  }
  return none();
}
/** On tap / hold: an action ('toggle', { action: 'navigate', go }…) or a function (ha, screen) */
const isAct = (a) => typeof a === 'function' || hasAction(a);
function pieceAction(a, p, el) {
  if (typeof a === 'function') {
    try { const r = a(HA_TAP, screenFor('card')); if (r && r.catch) r.catch((e) => toast(e.message || String(e), true)); }
    catch (e) { toast(e.message || String(e), true); }
    return;
  }
  runAction(a, p.entity, el);
}
const codeError = (name, msg) => h('div', { class: 'code-error' }, icon('mdi-alert-circle-outline'), h('b', null, name + ': '), msg);
/** Cards and bubbles of the current tab that repaint when their entities change. */
let VIEW_CODE = [], viewCodeTimer;
const VIEW_DIRTY = new Set();

/** No connection set up: QR of the configuration web (if there is a helper) or instructions. */
async function showSetup() {
  $('#rail').replaceChildren();
  $('#view-title').textContent = I18N.t('panel.nav.set_up_panel');
  const box = h('div', { class: 'setup' }, icon('mdi-home-assistant', 'setup-icon'), h('h2', null, I18N.t('panel.setup.title')));
  $('#view').replaceChildren(box);
  const net = await fetchNet();
  const svg = net && qrSvg(net.urls[0]);
  if (net) {
    box.append(h('p', { class: 'muted' }, I18N.t('panel.setup.scan')),
      svg ? h('div', { class: 'qr', html: svg }) : null, h('div', { class: 'qr-url' }, net.urls[0]));
  } else {
    box.append(h('p', { class: 'muted' }, I18N.t('panel.setup.config_js')),
      h('p', { class: 'muted small' }, I18N.t('panel.setup.token_where_full') + ' ' +
        I18N.t('panel.setup.also_phone')));
  }
  box.append(h('p', { class: 'muted small' }, net ? I18N.t('panel.setup.starts_by_itself') : I18N.t('panel.setup.then_reload')));
}

function render() {
  if (NEEDS_SETUP) { showSetup(); return; }
  B.view.clear(); VIEW_CODE = []; VIEW_DIRTY.clear();
  S.viewTimers.forEach(clearInterval); S.viewTimers = [];
  if (S.view !== 'settings' && !visibleTabs().some((t) => t.id === S.view)) S.view = tabFor(S.view);
  const t = S.view === 'settings' ? null : visibleTabs().find((x) => x.id === S.view);
  $('#view-title').textContent = I18N.t(t ? t.title : VIEWS.settings.title);
  const view = $('#view');
  const scroll = view.scrollTop;
  view.replaceChildren(...(t ? renderTab(t) : VIEWS.settings.render()).filter(Boolean));
  view.scrollTop = scroll;
  renderRail();
}
function go(view) {
  view = tabFor(view);
  if (S.view !== view) { S.view = view; $('#view').scrollTop = 0; }
  render();
}

/* ====================== Voice assistant ======================
 * A bar at the bottom, over any screen (Home, ambient, “Now playing”…), while the Assist satellite
 * chosen in Settings listens, thinks or answers. The text (what you said and the answer) is read from the
 * Assist debug in Home Assistant (read only). It can also be driven from outside: panelVoice(stage, {heard, reply}). */
const VOICE = { stage: 'idle', heard: '', reply: '', hideT: null, run: null };
const VOICE_TEXT = { listening: 'panel.voice.listening', processing: 'panel.voice.one_moment', responding: '', error: 'panel.voice.not_understood' };
function panelVoice(stage, data = {}) {
  const box = $('#voice');
  clearTimeout(VOICE.hideT);
  if (stage === 'listening' && VOICE.stage !== 'listening') { VOICE.heard = ''; VOICE.reply = ''; }
  if (data.heard != null) VOICE.heard = data.heard;
  if (data.reply != null) VOICE.reply = data.reply;
  if (stage === 'idle') {
    if (VOICE.stage === 'idle') return;
    VOICE.stage = 'idle';
    box.classList.remove('listening', 'processing', 'responding');
    // lets you read the answer for a while and goes away
    VOICE.hideT = setTimeout(() => box.classList.remove('show'), VOICE.reply || VOICE.heard ? 6000 : 400);
    return;
  }
  if (VOICE.stage === 'idle') { wakeScreen(); resetIdle(); }
  VOICE.stage = stage;
  const style = VOICE_STYLES.includes(SET.voiceStyle) ? SET.voiceStyle : 'wave';
  // If it was already visible, the height change (e.g. when the answer arrives) is animated instead of jumping
  const wasShown = box.classList.contains('show'), oldH = wasShown ? box.getBoundingClientRect().height : 0;
  const oldText = (box.querySelector('.voice-text') || {}).textContent || '';
  box.className = `voice show ${stage} vs-${style}`;
  const text = h('div', { class: 'voice-text' },
    VOICE.heard ? h('div', { class: 'voice-heard' }, '«' + VOICE.heard + '»') : null,
    h('div', { class: 'voice-main' + (VOICE.reply ? '' : ' hint') }, VOICE.reply || VOICE_TEXT[stage] || ''));
  box.replaceChildren(voiceAnim(style), text);
  if (wasShown && text.textContent !== oldText) text.classList.add('fresh');      // the new text comes in softly
  if (wasShown) {
    clearTimeout(VOICE.sizeT);
    box.style.height = '';
    const newH = box.getBoundingClientRect().height;
    if (Math.abs(newH - oldH) > 1) {
      box.style.height = oldH + 'px';
      void box.offsetHeight;                     // fixes the old height before animating
      box.style.height = newH + 'px';
      VOICE.sizeT = setTimeout(() => (box.style.height = ''), 450);
    }
  }
  if (stage === 'error') VOICE.hideT = setTimeout(() => panelVoice('idle'), 4000);
  if (style === 'wave') voiceWave();
}
window.panelVoice = panelVoice;
// Touching the bar must not touch what is underneath (lights, bubbles, ambient mode…)
['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'].forEach((t) => $('#voice').addEventListener(t, (e) => {
  e.stopPropagation();
  if (e.cancelable && t !== 'pointerdown') e.preventDefault();
}));
/** Bar animations (chosen in Settings → Voice assistant) */
const VOICE_STYLES = ['wave', 'mic', 'light', 'eq'];
function voiceAnim(style) {
  if (style === 'mic') return h('div', { class: 'voice-anim' }, h('div', { class: 'voice-mic' },
    icon(VOICE.stage === 'responding' ? 'mdi-volume-high' : 'mdi-microphone')));
  if (style === 'light') return h('div', { class: 'voice-light' });
  if (style === 'eq') return h('div', { class: 'voice-anim voice-eq' }, ...[0, .2, .4, .1, .3, .5, .15].map((d) => h('i', { style: `animation-delay:${d}s` })));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 56 44'); svg.setAttribute('class', 'voice-wave');
  svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  return h('div', { class: 'voice-anim' }, svg);
}
/** Wave: drawn while the bar is visible (calmer when thinking, livelier when answering) */
let waveRaf = 0, waveT = 0;
function voiceWave() {
  if (waveRaf) return;
  const step = () => {
    const path = $('#voice .voice-wave path');
    if (!path || !$('#voice').classList.contains('show')) { waveRaf = 0; return; }
    const st = VOICE.stage, amp = st === 'processing' ? 0.25 : st === 'responding' ? 1.15 : st === 'idle' ? 0 : 0.9;
    waveT += st === 'responding' ? 0.16 : st === 'processing' ? 0.05 : 0.09;
    let d = '';
    for (let x = 0; x <= 56; x += 2) {
      const env = Math.sin((x / 56) * Math.PI) * 15 * amp * (0.65 + 0.35 * Math.sin(waveT * 0.7));
      d += (x ? 'L' : 'M') + x + ' ' + (22 + Math.sin(x / 5 + waveT) * env).toFixed(1) + ' ';
    }
    path.setAttribute('d', d);
    waveRaf = requestAnimationFrame(step);
  };
  waveRaf = requestAnimationFrame(step);
}
const VOICE_STAGE = { listening: 'listening', processing: 'processing', responding: 'responding' };
function onVoiceSat(old, st) {
  const stage = VOICE_STAGE[st && st.state] || 'idle';
  if (stage === 'listening' && VOICE.stage === 'idle') VOICE.run = Date.now();
  panelVoice(stage);
  // As soon as it understands the sentence, the text is looked up in the Assist debug
  if (stage === 'responding' || (stage === 'idle' && old && VOICE_STAGE[old.state])) voiceText();
}
/** What was said and what it answered, from the last Assist run (assist_pipeline/pipeline_debug, read only). */
async function voiceText() {
  const since = VOICE.run || 0;
  try {
    const sat = SET.voiceSatellite, dev = reg(sat).device_id;
    // the assistant the satellite uses: its “Assistant” select ('preferred' = the preferred one)
    const sel = Object.keys(S.states).find((id) => domain(id) === 'select' && reg(id).device_id === dev && /pipeline|asistente/.test(id));
    const list = await conn.send({ type: 'assist_pipeline/pipeline/list' });
    const want = sel && S.states[sel].state;
    const pipe = (list.pipelines || []).find((p) => p.name === want) || (list.pipelines || []).find((p) => p.id === list.preferred_pipeline);
    if (!pipe) return;
    const runs = (await conn.send({ type: 'assist_pipeline/pipeline_debug/list', pipeline_id: pipe.id })).pipeline_runs || [];
    const last = runs[runs.length - 1];
    if (!last || new Date(last.timestamp).getTime() < since - 3000) return;
    const run = await conn.send({ type: 'assist_pipeline/pipeline_debug/get', pipeline_id: pipe.id, pipeline_run_id: last.pipeline_run_id });
    let heard = '', reply = '';
    for (const e of run.events || []) {
      if (e.type === 'stt-end') heard = (((e.data || {}).stt_output) || {}).text || heard;
      if (e.type === 'intent-end') {
        const sp = ((((e.data || {}).intent_output || {}).response || {}).speech || {});
        reply = (sp.plain || {}).speech || reply;
      }
      if (e.type === 'error' && VOICE.stage !== 'idle') { panelVoice('error'); return; }
    }
    if (VOICE.run !== since) return;           // another sentence already started
    panelVoice(VOICE.stage === 'idle' ? 'responding' : VOICE.stage, { heard, reply });
    if (S.states[SET.voiceSatellite] && !VOICE_STAGE[S.states[SET.voiceSatellite].state]) panelVoice('idle');
  } catch (e) { console.warn(I18N.t('panel.voice.assist_text'), e.message); }
}
/** Settings: which voice satellite shows on the screen. */
function voiceCard() {
  const sats = Object.keys(S.states).filter((id) => domain(id) === 'assist_satellite')
    .sort((x, y) => nameOf(x, false).localeCompare(nameOf(y, false), I18N.locale()));
  const list = pickList([['', I18N.t('panel.settings.none'), 'mdi-microphone-off', '']].concat(sats.map((id) => [id,
    (deviceOf(id) || {}).name_by_user || (deviceOf(id) || {}).name || nameOf(id, false), 'mdi-microphone-message',
    S.states[id].state === 'unavailable' ? I18N.t('panel.states.unavailable') : (S.areaById[areaOf(id)] || {}).name || ''])),
    SET.voiceSatellite, (id) => { SET.voiceSatellite = id; saveSettings(); panelVoice('idle'); });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-microphone'), I18N.t('panel.settings.voice_assistant')),
    h('div', { class: 'muted small' }, sats.length
      ? I18N.t('panel.voice.hint')
      : I18N.t('panel.settings.there_no_assist')), list,
    setBlock(I18N.t('panel.settings.animation'), null, segmented([['wave', I18N.t('panel.settings.wave')], ['mic', I18N.t('panel.settings.microphone')], ['light', I18N.t('panel.settings.light_line')], ['eq', I18N.t('panel.settings.equaliser')]],
      SET.voiceStyle || 'wave', (v) => { SET.voiceStyle = v; saveSettings(); voiceDemo(); })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'big-action', onclick: voiceDemo }, icon('mdi-play'), I18N.t('panel.settings.preview'))),
    window.PANEL_HELPER ? voiceMicBlock() : null);
}
/** All the volumes together: the general one (the Pi's output) and, inside it, each thing that plays. */
function soundCard() {
  const pct = (v) => v + ' %';
  const card = h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-volume-high'), I18N.t('panel.settings.sound')));
  const post = async (body) => {
    try {
      const r = await (await fetch(HELPER + '/sound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (r.error) throw new Error(r.error);
    } catch (e) { toast(I18N.t('panel.status.could_not_change_prefix') + e.message); }
  };
  // The main volume is the music and media one (the panel speaker in Music Assistant).
  // Without a speaker, the Pi's output.
  const music = speakerEntity();
  const main = h('div', { style: 'display:contents' });
  if (music && S.states[music]) {
    const m = slider({ min: 0, max: 100, step: 1, label: I18N.t('panel.settings.volume_music_media'), fmt: pct,
      // changed from here: the floating bar does not show (you are already looking at it)
      onchange: (v) => { volMarkSent(v); call('media_player', 'volume_set', { volume_level: v / 100 }, music); } });
    // Follows the real volume: if it changes in Music Assistant, it moves here too
    bind('view', music, (st) => st && st.attributes.volume_level != null && m.set(Math.round(st.attributes.volume_level * 100)));
    main.append(m);
  }
  const notices = slider({ min: 10, max: 100, step: 10, label: I18N.t('panel.settings.notifications_alarms'), fmt: pct, onchange: (v) => { SET.sound.volume = v; saveSettings(); tone([784, 622], 0.4); } });
  notices.set(SET.sound.volume);
  card.append(main, notices);
  if (!window.PANEL_HELPER) return card;
  fetch(HELPER + '/sound', { cache: 'no-store' }).then((r) => r.json()).then((r) => {
    if (!main.childNodes.length && r.master.available) {
      const m = slider({ min: 0, max: 100, step: 1, label: I18N.t('panel.sheets.volume'), fmt: pct, onchange: (v) => post({ master: v }) });
      m.set(r.master.value); main.append(m);
    }
    if (r.voice.installed) {
      const vv = slider({ min: 10, max: 100, step: 10, label: I18N.t('panel.settings.voice_assistant_answers'), fmt: pct, onchange: (v) => post({ voiceVolume: v }) });
      vv.set(r.voice.volume);
      card.append(vv);
    }
  }).catch(() => {});
  return card;
}
/** The Pi's own mic (panel-voice service): mic, where it answers and the wake word. */
function voiceMicBlock() {
  const box = h('div', null, h('div', { class: 'muted small' }, I18N.t('panel.settings.loading_panel_s')));
  const save = async (patch) => {
    try {
      const r = await (await fetch(HELPER + '/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).json();
      if (r.error) throw new Error(r.error);
      toast(r.message); paint(r.info);
    } catch (e) { toast(I18N.t('panel.status.could_not_save_prefix') + e.message); }
  };
  const paint = (r) => {
    const s = r.settings;
    const status = !r.installed ? I18N.t('panel.voice.not_installed') : r.active ? I18N.t('web.sound.listening') : s.enabled ? I18N.t('panel.settings.not_working_see') : I18N.t('panel.states.off');
    const opts = (list, ic) => list.map((o) => [o.id, o.name, ic, '']);
    box.replaceChildren(
      setBlock(I18N.t('panel.settings.listen_panel_s'), status, switchBtn(s.enabled, (v) => save({ enabled: v }))),
      setBlock(I18N.t('panel.settings.microphone'), null, pickList(opts(r.inputs, 'mdi-microphone'), s.mic, (v) => save({ mic: v }))),
      setBlock(I18N.t('panel.settings.answers_through'), null, pickList(opts(r.outputs, 'mdi-speaker'), s.output, (v) => save({ output: v }))),
      setBlock(I18N.t('panel.settings.wake_word'), null, segmented(r.wakeWords.map((w) => [w.id, w.name]), s.wake, (v) => save({ wake: v }))));
  };
  fetch(HELPER + '/voice', { cache: 'no-store' }).then((r) => r.json()).then(paint)
    .catch(() => box.replaceChildren(h('div', { class: 'muted small' }, I18N.t('panel.voice.mic_error'))));
  return box;
}
/** Example of the voice bar, without talking to Home Assistant. */
const DEMO_T = [];
function voiceDemo() {
  const at = (ms, f) => DEMO_T.push(setTimeout(f, ms));
  DEMO_T.splice(0).forEach(clearTimeout);
  VOICE.run = null; VOICE.stage = 'idle';
  panelVoice('listening');
  at(1800, () => panelVoice('processing', { heard: I18N.t('panel.voice.demo_heard') }));
  at(3000, () => panelVoice('responding', { reply: I18N.t('panel.voice.demo_reply') }));
  at(5200, () => panelVoice('idle'));
}

/* ====================== Modo ambiente ====================== */
let idleTimer;
/** 📌 on the top bar: the panel stays on the current tab (no ambient mode and the screen does not turn off by itself)
 * until it is tapped again or ambient mode is opened by hand. */
const STAY = { on: false };
function setStay(on) {
  STAY.on = !!on;
  const b = $('#stay');
  if (b) {
    b.classList.toggle('on', STAY.on);
    b.querySelector('i').className = 'mdi ' + (STAY.on ? 'mdi-pin' : 'mdi-pin-outline');
  }
  resetIdle(); screenTick();
}
function resetIdle() {
  clearTimeout(idleTimer);
  if (STAY.on) return;
  if (SET.idleSeconds > 0) idleTimer = setTimeout(() => !S.sheetId && !NP.id && !alertOpen() && showAmbient(), SET.idleSeconds * 1000);
}
/** Menu of the three dots at the top right: it opens with an animation. */
/* Mini player of the quick access panel: artwork, title and previous / play / next.
   Tapping the artwork or the title opens “Now playing”. It repaints by itself while the menu is open. */
const TM = { id: null, paint: null };
function tmPlayer() {
  const id = ambientSpeaker() || speakerEntity();
  TM.id = null; TM.paint = null;
  if (!id || !S.states[id] || S.states[id].state === 'unavailable') return null;
  // Card like Android's music one: the blurred artwork as background, the artwork on the left,
  // the title and the artist and the controls below. Tapping the card opens “Now playing”.
  const art = h('div', { class: 'tm-art' }), title = h('div', { class: 'tm-ptitle' }), sub = h('div', { class: 'tm-psub' });
  const bg = h('div', { class: 'tm-bg' });
  const btn = (ic, svc, cls = '') => h('button', { class: 'tm-pbtn ' + cls, onclick: (e) => { e.stopPropagation(); call('media_player', svc, {}, id); } }, icon(ic));
  const play = btn('mdi-play', 'media_play_pause', 'main');
  const box = h('div', { class: 'tm-player', onclick: () => { shade(false); showNowPlaying(id); } }, bg, art,
    h('div', { class: 'tm-ptext' }, h('div', { class: 'tm-pspk' }, icon(iconOf(S.states[id])), nameOf(id, false)), title, sub),
    h('div', { class: 'tm-pctrls' }, btn('mdi-skip-previous', 'media_previous_track'), play, btn('mdi-skip-next', 'media_next_track')));
  TM.id = id;
  TM.paint = () => {
    const st = S.states[id]; if (!st) return;
    const a = st.attributes, pic = a.entity_picture ? absUrl(a.entity_picture) : '';
    art.style.backgroundImage = bg.style.backgroundImage = pic ? `url("${pic}")` : '';
    art.classList.toggle('empty', !pic); box.classList.toggle('has-art', !!pic);
    title.textContent = a.media_title || nameOf(id);
    sub.textContent = a.media_title ? (a.media_artist || a.app_name || nameOf(id)) : (T[st.state] || cap(st.state));
    play.replaceChildren(icon(st.state === 'playing' ? 'mdi-pause' : 'mdi-play'));
  };
  TM.paint();
  return box;
}
/* ====================== Quick access panel (like on Android) ======================
 * Dragging down from the top edge pulls down the quick access panel, which follows the finger; on release it opens fully
 * if you went down more than a third (or did it fast), otherwise it goes back up.
 * Inside: the time, turning the screen off and settings (top right), the mini player, the volumes and the brightness.
 * It closes by swiping up, tapping outside or choosing something. */
const SH = { open: false, sync: null, tab: 0, paintNotif: null };
const shadeEdge = 30;   // height (px) of the top strip where the gesture starts
/** Android-like bar: a thick pill that fills, with the symbol inside on the left and the value on the right.
 *  Drag (or tap) from side to side. onLive while you drag, onEnd on release. */
function pill(ic, { min = 0, max = 100, step = 1, value = 0, onLive, onEnd } = {}) {
  const fill = h('i'), val = h('span', { class: 'sp-val' });
  const el = h('div', { class: 'sh-pill' }, fill, h('span', { class: 'sp-ic' }, icon(ic)), val);
  const p = { el, v: value, drag: false };
  p.set = (v, force) => {
    if (p.drag && !force) return;
    // 0 is right after the symbol (the part with the symbol always looks filled, like on Android)
    const f = (v - min) / (max - min), base = el.offsetHeight || 70, w = el.offsetWidth;
    p.v = v; fill.style.width = `calc(${base}px + (100% - ${base}px) * ${f})`; val.textContent = v + ' %';
    el.classList.toggle('full', w ? base + (w - base) * f > w - 80 : f > 0.86);   // the value sits on the filled part: in dark
  };
  const at = (x) => {
    const r = el.getBoundingClientRect(), base = r.height;
    const f = Math.max(0, Math.min(1, (x - r.left - base) / Math.max(1, r.width - base - 10)));   // 100 without reaching the very edge
    const v = Math.max(min, Math.min(max, Math.round((min + f * (max - min)) / step) * step));
    if (v !== p.v) { p.set(v, true); if (onLive) onLive(v); }
  };
  dragOn(el, { start: (x) => { p.drag = true; at(x); }, move: (x) => at(x), end: () => { p.drag = false; if (onEnd) onEnd(p.v); } });
  p.set(value);
  return p;
}
/* Windows of the quick access panel that slide sideways: notifications (left) · controls (centre, the one that shows when opening)
 * · quick access (right, SET.quick). Change them by sliding the finger or tapping the tabs at the top. */
const QUICK_KINDS = { light: 'panel.quick.lights', switch: 'panel.quick.plugs', input_boolean: 'panel.quick.switches', fan: 'panel.quick.fans', cover: 'panel.quick.covers',
  lock: 'panel.quick.locks', climate: 'panel.quick.climate', scene: 'panel.nav.scenes', script: 'panel.quick.scripts', button: 'panel.quick.buttons', input_button: 'panel.quick.buttons' };
function shadeTabs(main) {
  const track = h('div', { class: 'sht-track' });
  const pages = h('div', { class: 'sht-pages' }, track);
  const badge = h('span', { class: 'sht-badge' });
  const btns = [h('button', { class: 'sht-tab' }, h('span', { class: 'sht-bell' }, icon('mdi-bell'), badge), I18N.t('panel.quick.notifications')), h('button', { class: 'sht-tab' }, icon('mdi-tune-variant'), I18N.t('panel.quick.controls')),
    h('button', { class: 'sht-tab' }, icon('mdi-lightning-bolt'), I18N.t('panel.quick.quick_access'))];
  const bar = h('div', { class: 'sht-bar' }, btns);
  // the lists do not count for the height: the quick access panel is as tall as the controls and they scroll inside
  const notif = h('div', { class: 'sht-scroll' }), quick = h('div', { class: 'sht-scroll' });
  track.append(h('div', { class: 'sht-page scroll' }, notif), h('div', { class: 'sht-page sht-main' }, main), h('div', { class: 'sht-page scroll' }, quick));

  const paintNotif = () => {
    if (SH.tab === 0) { N.unread = 0; renderBell(); }
    badge.classList.toggle('on', N.unread > 0);
    if (!N.history.length) { notif.replaceChildren(h('div', { class: 'sht-empty' }, icon('mdi-bell-check-outline'), I18N.t('panel.quick.no_notifications'))); return; }
    // tapping a notification opens it again in full (with its image and its buttons); the × removes it from the list
    notif.replaceChildren(...N.history.map((n) => h('div', { class: 'hist-row tappable ' + n.level, onclick: () => { shade(false); reopenNotif(n); } }, icon(n.icono),
      h('div', { class: 'hist-text' }, h('b', null, n.title), n.message ? h('div', { class: 'muted small' }, n.message) : null),
      h('span', { class: 'muted small' }, hhmm(n.at)),
      h('button', { class: 'hist-x', title: I18N.t('panel.quick.remove'), onclick: (e) => { e.stopPropagation(); N.history = N.history.filter((x) => x !== n); renderBell(); paintNotif(); } }, icon('mdi-close')))),
    h('button', { class: 'sht-clear', onclick: () => { N.history = []; N.unread = 0; renderBell(); paintNotif(); } }, icon('mdi-delete-sweep'), I18N.t('panel.quick.clear_all')));
  };
  // Quick access: the chosen ones as tiles and, at the end, one to add or remove
  let editing = false, kind = null;
  const paintQuick = () => {
    B.shade.clear();
    const ids = (SET.quick || []).filter((id) => S.states[id]);
    if (!editing) {
      const add = h('button', { class: 'tile sht-add', onclick: () => { editing = true; paintQuick(); } }, icon('mdi-plus'), ids.length ? I18N.t('panel.quick.edit') : I18N.t('panel.quick.add'));
      quick.replaceChildren(h('div', { class: 'sht-grid' }, ...ids.map((id) => tile(id, 'shade')), add));
      return;
    }
    const all = Object.keys(S.states).filter((id) => QUICK_KINDS[domain(id)] && visible(id));
    const kinds = [...new Set(all.map((id) => QUICK_KINDS[domain(id)]))];
    if (!kinds.includes(kind)) kind = kinds[0];
    const rows = all.filter((id) => QUICK_KINDS[domain(id)] === kind).sort((a, b) => nameOf(a).localeCompare(nameOf(b), I18N.locale())).map((id) => {
      const on = () => (SET.quick || []).includes(id);
      const chk = icon(on() ? 'mdi-check-circle' : 'mdi-plus-circle-outline', 'sht-chk');
      const row = h('button', { class: 'sht-pick' + (on() ? ' on' : '') }, icon(iconOf(S.states[id])), h('span', null, nameOf(id)), chk);
      row.onclick = () => {
        SET.quick = on() ? SET.quick.filter((x) => x !== id) : [...(SET.quick || []), id];
        saveSettings(true);
        row.classList.toggle('on', on()); chk.className = 'mdi ' + (on() ? 'mdi-check-circle' : 'mdi-plus-circle-outline') + ' sht-chk';
      };
      return row;
    });
    quick.replaceChildren(
      h('div', { class: 'sht-edit-head' },
        h('div', { class: 'sht-kinds' }, kinds.map((k) => h('button', { class: 'sht-kind' + (k === kind ? ' on' : ''), onclick: () => { kind = k; paintQuick(); quick.scrollTop = 0; } }, k))),
        h('button', { class: 'sht-done', onclick: () => { editing = false; paintQuick(); } }, icon('mdi-check'), I18N.t('panel.quick.done'))),
      h('div', { class: 'sht-list' }, rows.length ? rows : h('div', { class: 'sht-empty' }, I18N.t('panel.quick.nothing_add'))));
  };

  const goTab = (i, anim = true) => {
    SH.tab = i;
    track.classList.toggle('anim', anim);
    track.style.transform = `translateX(${(-i * 100) / 3}%)`;
    btns.forEach((b, j) => b.classList.toggle('active', j === i));
    if (i === 0) paintNotif();
  };
  btns.forEach((b, i) => { b.onclick = () => goTab(i); });

  // sliding sideways over the pages
  let sw = null, swallow = false;
  const sBegin = (x, y, t) => { sw = t && t.closest('.sh-pill, input') ? null : { x, y, dx: 0, on: false }; };   // the bars are dragged on their own
  const sMove = (x, y, e) => {
    if (!sw) return;
    const dx = x - sw.x, dy = y - sw.y;
    if (!sw.on) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) >= Math.abs(dx)) { sw = null; return; }   // it was to scroll the list
      sw.on = true; track.classList.remove('anim');
    }
    if (e && e.cancelable) e.preventDefault();
    sw.dx = dx;
    const edge = (SH.tab === 0 && dx > 0) || (SH.tab === 2 && dx < 0);   // harder at the ends
    track.style.transform = `translateX(calc(${(-SH.tab * 100) / 3}% + ${edge ? dx / 4 : dx / 3}px))`;
  };
  const sEnd = () => {
    if (!sw) return;
    const was = sw; sw = null;
    if (!was.on) return;
    swallow = true; setTimeout(() => { swallow = false; }, 50);
    goTab(Math.max(0, Math.min(2, SH.tab + (was.dx < -50 ? 1 : was.dx > 50 ? -1 : 0))));
  };
  pages.addEventListener('touchstart', (e) => { if (e.touches.length === 1) sBegin(e.touches[0].clientX, e.touches[0].clientY, e.target); }, { passive: true });
  pages.addEventListener('touchmove', (e) => sMove(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
  pages.addEventListener('touchend', sEnd);
  pages.addEventListener('touchcancel', () => { sw = null; goTab(SH.tab); });
  pages.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') sBegin(e.clientX, e.clientY, e.target); });
  window.addEventListener('pointermove', (e) => { if (sw && e.pointerType !== 'touch') sMove(e.clientX, e.clientY, e); });
  window.addEventListener('pointerup', (e) => { if (sw && e.pointerType !== 'touch') sEnd(); });
  pages.addEventListener('click', (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); } }, true);

  SH.paintNotif = paintNotif;
  paintQuick();
  SH.goTab = goTab;
  paintNotif.badge = () => { badge.classList.toggle('on', N.unread > 0); };
  paintNotif.badge();   // unread notifications: a dot on the tab's bell, even if it opens in another window
  goTab(SH.startTab ?? 1, false);   // it opens on the controls (the bell, on the notifications)
  SH.startTab = null;
  return h('div', { class: 'sht' }, bar, pages);
}
function shadeFill() {
  const box = $('#shade-in');
  const iconBtn = (ic, title, fn) => h('button', { class: 'sh-ibtn', title, onclick: () => { shade(false); fn(); } }, icon(ic));
  const pills = h('div', { class: 'sh-pills' });
  const id = speakerEntity();
  let mus = null;
  if (id && S.states[id] && S.states[id].attributes.volume_level != null) {
    // the music changes while you drag (like in “Now playing”)
    let last = -1, timer = null;
    const send = () => { if (mus.v === last) return; last = mus.v; volMarkSent(mus.v); call('media_player', 'volume_set', { volume_level: mus.v / 100 }, id); };
    mus = pill('mdi-music', { onLive: () => { if (!timer) { send(); timer = setInterval(send, 250); } }, onEnd: () => { clearInterval(timer); timer = null; send(); } });
    pills.append(mus.el);
  }
  const av = pill('mdi-bell-ring', { min: 10, step: 10, value: SET.sound.volume, onEnd: (v) => { SET.sound.volume = v; saveSettings(true); tone([784, 622], 0.4); } });
  const br = pill('mdi-brightness-6', { min: 5, step: 5, value: SET.brightness, onEnd: (v) => { SET.brightness = v; saveSettings(true); } });
  pills.append(av.el, br.el);
  const player = tmPlayer() || h('div', { class: 'tm-player sh-noplayer' }, icon('mdi-music-off'), I18N.t('panel.quick.nothing_playing'));
  // what changes while it is open (the song, the volume from the phone…) shows at once
  SH.sync = (sid) => {
    if (sid === TM.id && TM.paint) TM.paint();
    if (mus && sid === id && S.states[id]) mus.set(Math.round((S.states[id].attributes.volume_level || 0) * 100));
  };
  SH.sync(id);
  const now = new Date();
  box.replaceChildren(
    // top: the time and the date, and on the right the small buttons (turn the screen off and settings)
    h('div', { class: 'sh-head' },
      h('div', { class: 'sh-when' }, h('b', null, now.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' })),
        h('span', null, cap(now.toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' })))),
      h('div', { class: 'sh-ibtns' },
        iconBtn('mdi-monitor-off', I18N.t('panel.quick.turn_off_screen'), () => { screenOffNow(); }),
        iconBtn('mdi-cog', I18N.t('panel.nav.settings'), () => {   // from ambient mode or “Now playing” too
          if ($('#np').classList.contains('show')) hideNowPlaying(true);
          if (S.ambient) hideAmbient('settings'); else go('settings');
        }))),
    shadeTabs(h('div', { class: 'sh-body' }, player, pills)));
}
/** Opens (true) or closes (false) the quick access panel with an animation. With no argument: toggles it. tab: window (0 notifications, 1 controls, 2 quick access). */
function shade(open, tab) {
  if (open && SH.open && tab != null && SH.goTab) { SH.goTab(tab); return; }
  SH.startTab = tab;
  const el = $('#shade'), bg = $('#shade-bg');
  if (open == null) open = !SH.open;
  if (open && !SH.open && !el.classList.contains('dragging')) shadeFill();
  SH.open = open;
  el.classList.remove('dragging'); bg.classList.remove('dragging');
  el.style.transform = ''; bg.style.opacity = '';
  el.classList.toggle('open', open); bg.classList.toggle('open', open);
  if (!open) { TM.id = null; TM.paint = null; SH.sync = null; SH.paintNotif = null; SH.goTab = null; B.shade.clear(); }
}
function shadeGestures() {
  const el = $('#shade'), bg = $('#shade-bg');
  let g = null;   // gesture in progress: { y0, x0, t0, from (0 closed / 1 open), moved, p }
  const blocked = () => alertOpen();   // on every screen (ambient, “Now playing”…) except with an alarm or an important notification
  const begin = (x, y, from) => { g = { x0: x, y0: y, t0: Date.now(), from, moved: false, p: from }; };
  const move = (x, y, e) => {
    if (!g) return;
    const dy = y - g.y0;
    if (!g.moved) {
      if (Math.abs(dy) < 8) return;
      if (Math.abs(x - g.x0) > Math.abs(dy)) { g = null; return; }   // it was a sideways slide
      g.moved = true;
      if (g.from === 0) shadeFill();
      el.classList.add('dragging'); bg.classList.add('dragging');
    }
    if (e && e.cancelable) e.preventDefault();
    const hgt = el.offsetHeight || 1;
    g.p = Math.max(0, Math.min(1, g.from + dy / hgt));
    el.style.transform = `translateY(${(g.p - 1) * 100}%)`;
    bg.style.opacity = g.p;
  };
  const end = (y) => {
    if (!g) return;
    const was = g; g = null;
    if (!was.moved) return;
    const v = (y - was.y0) / Math.max(1, Date.now() - was.t0);   // px/ms (+ downwards)
    shade(v > 0.5 ? true : v < -0.5 ? false : was.p > (was.from ? 0.66 : 0.33));
  };
  // Open: from the top strip (with the finger or the mouse)
  window.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (e.touches.length === 1 && !SH.open && t.clientY <= shadeEdge && !blocked()) begin(t.clientX, t.clientY, 0);
  }, { passive: true, capture: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && !SH.open && e.clientY <= shadeEdge && !blocked()) begin(e.clientX, e.clientY, 0);
  }, true);
  // Close: swiping up over the quick access panel (not over the bars or the buttons) or over the background
  const closeStart = (x, y, target) => { if (SH.open && !target.closest('input, button, .sh-pill, .sht-page.scroll')) begin(x, y, 1); };
  [el, bg].forEach((n) => {
    n.addEventListener('touchstart', (e) => { const t = e.touches[0]; closeStart(t.clientX, t.clientY, e.target); }, { passive: true });
    n.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') closeStart(e.clientX, e.clientY, e.target); });
  });
  window.addEventListener('touchmove', (e) => { if (g) { const t = e.touches[0]; move(t.clientX, t.clientY, e); } }, { passive: false, capture: true });
  window.addEventListener('touchend', (e) => { if (g) end(e.changedTouches[0].clientY); }, true);
  window.addEventListener('touchcancel', () => { if (g) { g = null; shade(SH.open); } }, true);
  window.addEventListener('pointermove', (e) => { if (g && e.pointerType !== 'touch') move(e.clientX, e.clientY, e); }, true);
  window.addEventListener('pointerup', (e) => { if (g && e.pointerType !== 'touch') end(e.clientY); }, true);
  // tapping the background (without dragging) closes it
  bg.addEventListener('click', () => shade(false));
}
function showAmbient() {
  if (STAY.on) setStay(false);
  setTimeout(reportState, 0);   // Home Assistant knows at once
  closeSheet();
  if (SH.open) shade(false);
  S.ambient = true;
  renderAmbientChips();
  if (photosOn()) nextBackground();
  $('#ambient').classList.add('show');
}
/** After leaving ambient mode (or turning the screen on) with a tap: nothing happens until the finger is lifted,
 * neither tapping what is underneath (a light…) nor scrolling the view. */
function swallowTouch() {
  const stop = (e) => { if (e.cancelable) e.preventDefault(); e.stopPropagation(); };
  const evs = ['click', 'touchmove', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'wheel'];
  const opts = { capture: true, passive: false };
  evs.forEach((t) => window.addEventListener(t, stop, opts));
  let done = false;
  const ends = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'];
  const finish = () => {
    if (done) return;
    done = true;
    ends.forEach((t) => window.removeEventListener(t, finish, true));
    // a bit more: the tap's “click” arrives right after lifting the finger
    setTimeout(() => evs.forEach((t) => window.removeEventListener(t, stop, opts)), 400);
  };
  ends.forEach((t) => window.addEventListener(t, finish, true));
  setTimeout(finish, 8000);   // in case the end of the touch never arrives
}
/** Leaves ambient mode to Home, or to the view of the bubble that was tapped. */
function hideAmbient(view = 'home') {
  setTimeout(reportState, 0);
  S.ambient = false;
  $('#ambient').classList.remove('show');
  view = tabFor(view);
  if (S.view !== view) go(view); else render();
  resetIdle();
}
/* ====================== Bubbles ======================
 * They are all scripts: the built-in ones (lib/modules.js) and the ones created or imported in the configuration web,
 * which are saved on the Pi and the panel downloads at start. They run here, in the browser.
 * Each bubble says whether it shows in ambient mode and/or in the Home summary (SET.bullets). */
/* What bubbles and code cards get: render(ha, screen).
 * ha     → Home Assistant as it is (states and entity registry). To paint it only reads; ha.call() only on tap.
 * screen → the screen: where it paints, brightness, night/ambient mode, panel alarms, go to a tab. */
function entInfo(id) {
  const e = S.ents[id];
  if (!e) return {};
  const d = S.devs[e.device_id] || {}, areaId = e.area_id || d.area_id || null;
  return { platform: e.platform || null, device: d.name_by_user || d.name || null, deviceId: e.device_id || null,
    area: areaId ? (S.areaById[areaId] || {}).name || null : null, areaId, key: e.translation_key || null };
}
const FC_LOADING = new Set();
const TODOS = {}, TODO_LOADING = new Set();   // items per to-do list: { id: { list, state, t } }
const HA_OPTS = {
  name: (id) => (S.states[id] ? nameOf(id) : id), info: entInfo,
  format: (id) => (S.states[id] ? fmtState(S.states[id]) : '—'),
  mediaOrder: (list) => dedupeMedia((list || Object.keys(S.states).filter((id) => domain(id) === 'media_player')).filter((id) => S.states[id]))
    .sort((a, b) => (mediaRank(S.states[a]) - mediaRank(S.states[b])) || nameOf(a).localeCompare(nameOf(b), I18N.locale())),
  printers: () => [...printers()].sort((a, b) => pActive(b) - pActive(a)).map((p) => ({
    device: p.dev, name: p.name, platform: p.platform, state: pState(p), active: pActive(p), e: Object.assign({}, p.e), nozzles: p.nozzles.map((n) => Object.assign({}, n)) })),
  picture(id, width) {
    const a = S.states[id] && S.states[id].attributes.entity_picture;
    if (!a) return '';
    const url = absUrl(a);
    return width && domain(id) === 'camera' && !url.startsWith('data:') ? url + (url.includes('?') ? '&' : '?') + 'width=' + width : url;
  },
  icon: (id) => iconOf(S.states[id]),
  /** Forecast: the saved one; if there is none or it is old, it is requested and whatever watches that entity repaints */
  forecast(id) {
    const c = FORECASTS[id];
    if ((!c || Date.now() - c.t > 30 * 60e3) && S.states[id] && !FC_LOADING.has(id)) {
      FC_LOADING.add(id);
      getForecast(id).then(() => { FC_LOADING.delete(id); markCode(id); });
    }
    return c ? c.list : (S.states[id] && S.states[id].attributes.forecast) || [];
  },
  /** Items of a to-do list: the saved ones; asked again when its state (the number pending) changes or every 5 min */
  todo(id) {
    const c = TODOS[id], st = S.states[id];
    if (st && (!c || c.state !== st.state || Date.now() - c.t > 300e3) && !TODO_LOADING.has(id)) {
      TODO_LOADING.add(id);
      const state = st.state;
      api.callService('todo', 'get_items', {}, id, true)
        .then((r) => (r && r.response && r.response[id] && r.response[id].items) || [])
        .catch(() => (c ? c.list : []))
        .then((list) => { TODOS[id] = { list, state, t: Date.now() }; TODO_LOADING.delete(id); markCode(id); });
    }
    return c ? c.list : [];
  },
};
const HA = PM.makeHA(() => S.states, HA_OPTS);
const HA_TAP = PM.makeHA(() => S.states, Object.assign({}, HA_OPTS, {
  call(service, data = {}) {
    const [d, sv] = String(service).split('.');
    if (!d || !sv) throw new Error(I18N.t('panel.status.invalid_service_prefix') + service);
    return call(d, sv, data);
  },
}));
/** Screen data (also sent to the web for testing). */
function screenData(place) {
  return {
    place, brightness: SCREEN.level, on: !SCREEN.off, night: isNight(), ambient: !!S.ambient, light: null, favorites: CFG.favorites || [],
    notices: { unread: N.unread, total: N.history.length, last: (N.history[0] || {}).title || '' },
    alarms: (SET.alarms || []).map((a) => {
      const sn = RING.snooze[a.id];
      const when = sn && sn > Date.now() ? new Date(sn) : a.enabled ? nextOccurrence(a) : null;
      return { name: I18N.t(a.name || 'panel.settings.alarm'), time: a.time, days: a.days || [], enabled: !!a.enabled, when, text: when ? whenText(when) : null };
    }),
  };
}
const compVisible = (id) => !!S.states[id] && visible(id) && !isScooter(id);
const screenFor = (place) => PM.makeScreen(screenData(place), {
  visible: compVisible,
  go: (v) => go(v),
  nowPlaying: (id) => S.states[id] && showNowPlaying(id),
  openNotices: () => shade(true, 0),
});
const bulletList = () => PM.bulletList(SET.bullets, SET.ambientChips);
/* The configuration web tests the bubbles with the same thing the panel sees: we pass the helper
 * the screen data (every 15 s) and the entity registry (ha.info; every 5 min). */
let infoSentAt = 0;
function sendPanelData() {
  if (!window.PANEL_HELPER || !S.states || !Object.keys(S.states).length) return;
  const d = { screen: screenData('ambient'), forecasts: Object.fromEntries(Object.entries(FORECASTS).map(([k, v]) => [k, v.list])) };
  if (Date.now() - infoSentAt > 300e3) {
    d.info = {};
    for (const id of Object.keys(S.states)) { const i = entInfo(id); if (i.platform) d.info[id] = i; }
    infoSentAt = Date.now();
  }
  fetch(HELPER + '/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
    .then((r) => r.json()).then((r) => { if (r && r.hasInfo === false) infoSentAt = 0; })   // the helper restarted: send it again
    .catch(() => {});
}
setInterval(sendPanelData, 15e3);
setTimeout(sendPanelData, 5e3);

/* Built-in scripts + the ones downloaded from the Pi (window.PANEL_HELPER.scripts) or, without a helper, from config.js (scripts). */
const MODULES = PM.allScripts((window.PANEL_HELPER && window.PANEL_HELPER.scripts) || CFG.scripts || CFG.modulos);
const COMPILED = new Map();
function moduleOf(name) {
  let m = COMPILED.get(name);
  if (!m) {
    m = { cache: {}, watch: {} };
    if (!(name in MODULES)) m.err = I18N.t('panel.status.no_script_prefix') + name;
    else try { m.mod = PM.compile(MODULES[name]); } catch (e) { m.err = e.message; }
    COMPILED.set(name, m);
  }
  return m;
}
/** A state change invalidates the bubbles and cards that watch it. */
function markCode(id) {
  for (const m of COMPILED.values()) if (m.mod && Object.values(m.watch || {}).some((f) => f(id))) m.cache = {};
  VIEW_CODE.forEach((v, i) => { if (v.matches(id)) VIEW_DIRTY.add(i); });
  if (VIEW_DIRTY.size) {
    clearTimeout(viewCodeTimer);
    viewCodeTimer = setTimeout(() => { if (!S.sheetId) VIEW_DIRTY.forEach((i) => VIEW_CODE[i] && VIEW_CODE[i].paint()); VIEW_DIRTY.clear(); }, 500);
  }
}
/** What the bubbles marked for ambient mode paint. */
function bulletOutputs() {
  const list = bulletList().filter((b) => b.ambient), place = 'ambient';
  const out = [];
  for (const b of list) {
    if (!(b.script in MODULES)) continue;            // its script was deleted: it does not show
    const m = moduleOf(b.script), name = b.name || b.script;
    // Recalculated if something in its watch changes or after more than a minute (times, alarms…)
    // Each bubble with its settings (b.config); the same cache is split by bubble and place
    const key = b.id + ':' + place;
    if (!m.err && (!m.cache[key] || Date.now() - m.cache[key].t > 60e3)) {
      try {
        const bound = m.mod.bind(b.config, HA);
        m.watch[b.id] = bound.matches;
        m.cache[key] = { out: PM.bubbles(m.mod.render(HA, screenFor(place), bound.cfg)), t: Date.now() };
      } catch (e) { m.cache[key] = { err: e.message, t: Date.now() }; }
    }
    const err = m.err || m.cache[key].err;
    if (err) out.push({ icon: 'mdi-alert-circle-outline', text: `${name}: ${err}`, color: PM.color('red') });
    else out.push(...m.cache[key].out);
  }
  return out;
}
/** A bubble on screen. On tap: its action or go to its tab. */
function bubbleEl(b, cls) {
  const el = h('div', { class: cls + (b.go || b.action || b.onTap ? ' tappable' : '') + (b.progress != null ? ' with-bar' : ''), style: b.color ? `--bc:${b.color}` : null },
    b.icon ? icon(b.icon, 'b-ic') : null, h('span', { style: b.textColor ? `color:${b.textColor}` : null }, b.text),
    b.iconEnd ? h('i', { class: `mdi ${b.iconEnd} b-badge`, style: b.iconEndColor ? `color:${b.iconEndColor}` : null }) : null,
    b.progress != null ? h('span', { class: 'amb-bar' }, h('span', { style: `width:${b.progress}%` })) : null);
  el.bubble = b;
  if (cls === 'chip' && (b.go || b.action || b.onTap)) el.addEventListener('click', () => runBubble(b));
  return el;
}
/** On tap: its onTap(ha, screen) or its action (the only thing that sends something to Home Assistant), or go to its tab. */
function runBubble(b) {
  if (b.onTap) {
    try {
      const r = b.onTap(HA_TAP, screenFor(S.ambient ? 'ambient' : 'home'));
      if (r && r.catch) r.catch((e) => toast(e.message || String(e), true));
    } catch (e) { toast(e.message || String(e), true); }
    return;
  }
  if (b.action) {
    const a = b.action, [d, sv] = String(a.service || '').split('.');
    if (d && sv) call(d, sv, a.data || {}, a.entity);
    return;
  }
  if (b.go) go(b.go);
}
function renderAmbientChips() {
  if (!S.ambient) return;
  $('#amb-chips').replaceChildren(...bulletOutputs().map((b) => bubbleEl(b, 'amb-chip')));
  renderAmbientPlayer();
}
const paintBullets = renderAmbientChips;

/* ---------- Mini player of the default speaker (ambient mode, bottom right) ----------
 * If something is playing on this panel's speaker, that one shows (even if it is not the default);
 * tapping its artwork or the title goes back to the “Now playing” screen. */
/** Ambient mode speakers, by priority (Settings → Ambient mode speakers). */
function ambientSpeakers() {
  if (SET.ambientSameAsNp) return watchedSpeakers();
  const list = SET.ambientSpeakers || (SET.defaultSpeaker ? [SET.defaultSpeaker] : []);
  return [...new Set(list.map(resolveSpk))].filter((x) => x && S.states[x]);
}
function ambientSpeaker() {
  // the first on the list that is playing; otherwise the first paused; otherwise the first that is on.
  // Speakers on an ignored source (the TV on a sound bar…, web → Sound → Now playing) count as not playing.
  const st = (x) => (S.states[x] || {}).state, ok = (x) => !npIgnored(S.states[x]), l = ambientSpeakers().filter(ok);
  if (!l.length && !ambientSpeakers().length) {
    const w = watchedSpeakers().filter(ok);
    return w.find((x) => st(x) === 'playing') || w.find((x) => st(x) === 'paused') || null;
  }
  return l.find((x) => st(x) === 'playing') || l.find((x) => st(x) === 'paused') ||
    l.find((x) => !['unavailable', 'off', 'unknown'].includes(st(x))) || l[0] || null;
}
function renderAmbientPlayer() {
  const box = $('#amb-player'), id = ambientSpeaker(), st = id && S.states[id];
  const show = !!st && st.state !== 'unavailable';
  box.classList.toggle('hidden', !show);
  $('#ambient').classList.toggle('has-player', show);
  if (!show) return;
  const a = st.attributes, playing = st.state === 'playing';
  const pic = a.entity_picture ? absUrl(a.entity_picture) : '';
  const own = id === speakerEntity();
  const title = a.media_title || (own ? I18N.t('panel.ambient.panel') : nameOf(id));
  const sub = a.media_title ? (a.media_artist || a.app_name || nameOf(id)) : (T[st.state] || cap(st.state));
  box.classList.add('own');   // tapping the artwork or the title opens “Now playing”
  const vol = a.volume_level != null ? Math.round(a.volume_level * 100) + ' %' : '';
  const btn = (act, ic, cls = '') => h('button', { class: 'amb-pbtn ' + cls, 'data-act': act }, icon(ic));
  box.replaceChildren(
    h('div', { class: 'amb-pinfo' },
      h('div', { class: 'amb-part' + (pic ? '' : ' empty'), style: pic ? `background-image:url("${pic}")` : '' }),
      h('div', { class: 'amb-ptext' }, h('div', { class: 'amb-ptitle' }, title), h('div', { class: 'amb-psub' }, sub))),
    h('div', { class: 'amb-pctrls' },
      btn('vol-', 'mdi-volume-minus', 'small'),
      btn('prev', 'mdi-skip-previous'), btn('play', playing ? 'mdi-pause' : 'mdi-play', 'main'), btn('next', 'mdi-skip-next'),
      btn('vol+', 'mdi-volume-plus', 'small')),
    ...(vol ? [h('div', { class: 'amb-pvol' }, vol)] : []));
}
/* 🧪 Beta: gestures in ambient mode (SET.ambientGestures; web → Beta). The background then does not leave on touching it
 * but on lifting the finger without moving it: swipe ← → = next / previous song (or photo), ↑ ↓ on the right half = volume,
 * holding it = play / pause. Bubbles, the player and the top strip work as always. */
function swallowClick() {   // the “click” of the finger just lifted must not tap what is underneath
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('click', stop, true);
  setTimeout(() => window.removeEventListener('click', stop, true), 400);
}
function ambientSwipe(dir, st) {
  const what = SET.ambientSwipe || 'auto', music = !!st && !['off', 'unavailable'].includes(st.state);
  const photos = photosOn() && PHOTOS.length > 1;
  const useMusic = what === 'music' ? music : what === 'photos' ? false : (music && st.state === 'playing') || (music && !photos);
  if (useMusic) {
    ambientPlayerAction(dir);
    osdBubble(dir === 'next' ? 'mdi-skip-next' : 'mdi-skip-previous', I18N.t(dir === 'next' ? 'panel.ambient.next_song' : 'panel.ambient.previous_song'));
  } else if (photos && what !== 'music') {
    if (dir === 'prev') photoIdx = (photoIdx - 2 + 2 * PHOTOS.length) % PHOTOS.length;
    nextBackground();
    osdBubble('mdi-image', I18N.t(dir === 'next' ? 'panel.ambient.next_photo' : 'panel.ambient.previous_photo'));
  }
}
function ambientGesture(e0) {
  const x0 = e0.clientX, y0 = e0.clientY, right = x0 > innerWidth / 2;
  const id = ambientSpeaker(), st = id && S.states[id];
  const vol0 = st && st.state !== 'unavailable' && st.attributes.volume_level != null ? st.attributes.volume_level : null;
  let mode = null, vol = vol0;   // null (a tap so far) | 'h' | 'v' | 'hold' | 'none'
  const hold = setTimeout(() => {
    if (mode || !st || ['off', 'unavailable'].includes(st.state)) return;
    mode = 'hold';
    const playing = st.state === 'playing';
    ambientPlayerAction('play');
    osdBubble(playing ? 'mdi-pause' : 'mdi-play', I18N.t(playing ? 'panel.ambient.paused' : 'panel.ambient.playing'));
  }, 600);
  const move = (e) => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!mode && Math.hypot(dx, dy) > 14) {
      clearTimeout(hold);
      mode = Math.abs(dx) > Math.abs(dy) ? 'h' : right && vol0 != null ? 'v' : 'none';
    }
    if (mode === 'v') {
      vol = Math.round(Math.max(0, Math.min(1, vol0 - dy / 300)) * 100) / 100;
      volBubble(Math.round(vol * 100));
    }
  };
  const up = (e) => {
    ['pointermove', 'pointerup', 'pointercancel'].forEach((t) => window.removeEventListener(t, t === 'pointermove' ? move : up, true));
    clearTimeout(hold);
    swallowClick();
    resetIdle();
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - x0;
    if (mode === 'h') { if (Math.abs(dx) > 70) ambientSwipe(dx < 0 ? 'next' : 'prev', st); return; }
    if (mode === 'v') {
      if (vol !== vol0) { volMarkSent(Math.round(vol * 100)); call('media_player', 'volume_set', { volume_level: vol }, id); }
      return;
    }
    if (mode) return;   // held, or a movement that does nothing
    hideAmbient('home');
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}
function ambientPlayerAction(act) {
  const id = ambientSpeaker(), st = id && S.states[id];
  if (!st) return;
  const v = st.attributes.volume_level ?? 0.3;
  if (act === 'play') call('media_player', st.state === 'off' ? 'turn_on' : 'media_play_pause', {}, id);
  else if (act === 'prev') call('media_player', 'media_previous_track', {}, id);
  else if (act === 'next') call('media_player', 'media_next_track', {}, id);
  else if (act === 'vol-' || act === 'vol+')
    call('media_player', 'volume_set', { volume_level: Math.round(Math.max(0, Math.min(1, v + (act === 'vol+' ? 0.05 : -0.05))) * 100) / 100 }, id);
}

/** Settings: choose the default speaker. */
function speakerCard() {
  const players = dedupeMedia(ids((id) => domain(id) === 'media_player'))
    .sort((x, y) => (S.states[x].state === 'unavailable') - (S.states[y].state === 'unavailable') || nameOf(x).localeCompare(nameOf(y), I18N.locale()));
  // “This panel” always shows when the speaker is on (web → Sound → Speaker), even if Music Assistant
  // has not created its player in Home Assistant yet. It is saved as '@panel'.
  const own = speakerEntity();
  if (own && players.includes(own)) players.splice(players.indexOf(own), 1);
  const ownSub = !own ? I18N.t('panel.ambient.not_music_assistant') : S.states[own].state === 'unavailable' ? I18N.t('panel.states.unavailable') : I18N.t('panel.ambient.screen_s_speaker');
  const ownRow = SPK && SPK.enabled ? [['@panel', I18N.t('panel.ambient.panel'), 'mdi-tablet', ownSub]] : [];
  const options = ownRow.concat(players.map((id) => [id,
    nameOf(id), iconOf(S.states[id]), S.states[id].state === 'unavailable' ? I18N.t('panel.states.unavailable') : (S.areaById[areaOf(id)] || {}).name || '']));
  const box = h('div', { class: 'amb-list' });
  // Priority list: the first one playing shows; if none plays, the first paused; otherwise, the first
  const cur = () => (SET.ambientSpeakers || (SET.defaultSpeaker ? [SET.defaultSpeaker] : [])).map((x) => (x === own && own ? '@panel' : x));
  const save = (arr) => { SET.ambientSpeakers = arr; SET.defaultSpeaker = arr[0] || ''; saveSettings(); paint(); renderAmbientPlayer(); };
  const paint = () => {
    if (SET.ambientSameAsNp) return box.replaceChildren(h('div', { class: 'muted small' }, I18N.t('panel.settings.ambient_same_as_np')));
    const list = cur();
    const rows = list.map((x, i) => {
      const o = options.find((op) => op[0] === x) || [x, nameOf(x), 'mdi-speaker', I18N.t('panel.status.does_not_exist')];
      const mv = (d) => { const a = list.slice(); [a[i], a[i + d]] = [a[i + d], a[i]]; save(a); };
      return h('div', { class: 'amb-item prio-row' }, h('span', { class: 'prio-n' }, i + 1), icon(o[2]),
        h('div', { class: 'amb-item-label' }, h('div', null, o[1]), o[3] ? h('div', { class: 'muted small' }, o[3]) : null),
        h('button', { class: 'icon-btn small', disabled: i === 0, onclick: () => mv(-1) }, icon('mdi-chevron-up')),
        h('button', { class: 'icon-btn small', disabled: i === list.length - 1, onclick: () => mv(1) }, icon('mdi-chevron-down')),
        h('button', { class: 'icon-btn small', onclick: () => save(list.filter((y) => y !== x)) }, icon('mdi-close')));
    });
    const rest = options.filter((o) => !list.includes(o[0]));
    box.replaceChildren(...[...rows,
      rows.length ? null : h('div', { class: 'muted small' }, I18N.t('panel.settings.none_one_playing')),
      rest.length ? pickList([['', I18N.t('panel.settings.add_speaker'), 'mdi-plus', '']].concat(rest), '', (id) => { if (id) save([...list, id]); }) : null].filter(Boolean));
  };
  paint();
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-speaker'), I18N.t('panel.settings.ambient_mode_speakers')),
    h('div', { class: 'muted small' }, I18N.t('panel.settings.its_controls_appear')),
    box);
}
/** Settings: which bubbles show in ambient mode and on Home, and in what order. */
function bulletsCard() {
  const list = h('div', { class: 'amb-list' });
  const save = (arr) => { SET.bullets = arr; saveSettings(); paint(); };
  const paint = () => {
    const items = bulletList();
    list.replaceChildren(h('div', { class: 'amb-item amb-head' }, h('span', { class: 'amb-item-label' }), h('span', { class: 'amb-col' }, I18N.t('panel.nav.ambient'))),
      ...items.map((b, i) => {
        const x = PM.BUILTINS.find((y) => y.script === b.script);
        const meta = { label: b.name || b.script, icon: x ? x.icon : 'mdi-script-text-outline' };
        const move = (d) => { const arr = bulletList(), j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; save(arr); };
        const flag = (k) => h('span', { class: 'amb-col' }, switchBtn(!!b[k], (v) => { const arr = bulletList(); arr[i][k] = v; save(arr); }));
        return h('div', { class: 'amb-item' + (b.ambient ? '' : ' off') }, icon(meta.icon), h('span', { class: 'amb-item-label' }, meta.label),
          h('button', { class: 'round-btn small', disabled: i === 0, onclick: () => move(-1), title: I18N.t('panel.sheets.up') }, icon('mdi-chevron-up')),
          h('button', { class: 'round-btn small', disabled: i === items.length - 1, onclick: () => move(1), title: I18N.t('panel.sheets.down') }, icon('mdi-chevron-down')),
          flag('ambient'));
      }));
  };
  paint();
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-format-list-bulleted'), I18N.t('panel.settings.bubbles')),
    h('div', { class: 'muted small' }, I18N.t('panel.settings.choose_which_ones')),
    list,
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), I18N.t('panel.settings.show_ambient_mode'))));
}

// Background: photos (single ones or from an Immich album) or a gradient for the time of day
/* ---------- Ambient mode photos ----------
 * In config.js → ambientPhotos you can put URLs of single photos or an Immich album, which is detected by itself:
 *   https://immich.home/share/<key>   shared link (no API key needed)
 *   https://immich.home/s/<name>      shared link with a custom name
 *   https://immich.home/albums/<id>   private album (needs immichApiKey in config.js)
 */
const IMMICH_SHARED = [
  [/^(https?:\/\/\S+?)\/share\/([\w-]+)\/?(\?.*)?$/, 'key'],
  [/^(https?:\/\/\S+?)\/s\/([\w-]+)\/?(\?.*)?$/, 'slug'],
];
const IMMICH_ALBUM = /^(https?:\/\/\S+?)\/albums\/([0-9a-f-]{36})/;
let PHOTOS = [], photosAt = 0, photoIdx = 0;

/** Reads JSON from Immich. If the browser blocks it by CORS (proxy without headers), it asks the Pi's helper. */
async function getJSON(url, headers) {
  let r;
  try { r = await fetch(url, { headers }); }
  catch (e) {
    const h2 = headers && headers['x-api-key'] ? { 'x-api-key': headers['x-api-key'] } : undefined;
    try { r = await fetch(`${HELPER}/proxy?url=${encodeURIComponent(url)}`, { headers: h2 }); }
    catch (e2) { throw new Error(I18N.t('panel.photos.cors')); }
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${new URL(url).pathname}`);
  return r.json();
}
const monthYear = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : cap(d.toLocaleDateString(I18N.locale(), { month: 'long', year: 'numeric' })); };
// size=preview: ~1440 px, enough for the screen and light for the Pi. c = thumbhash (like the Immich web, for the cache)
const immichUrl = (base, id, thumbhash, auth) =>
  `${base}/api/assets/${id}/thumbnail?size=preview&edited=true${thumbhash ? '&c=' + encodeURIComponent(thumbhash) : ''}&${auth}`;

/** Photos of an album. Immich 1.x/2.x has them in /albums/<id>; Immich 3 gives them through the timeline (by month). */
async function immichAlbumPhotos(base, albumId, auth, headers) {
  const album = await getJSON(`${base}/api/albums/${albumId}?${auth}`, headers);
  if (album.assets && album.assets.length) {
    return Object.assign(album.assets.filter((a) => a.type === 'IMAGE' && !a.isTrashed).map((a) => {
      const ex = a.exifInfo || {};
      return { url: immichUrl(base, a.id, a.thumbhash, auth), caption: [monthYear(ex.dateTimeOriginal || a.localDateTime || a.fileCreatedAt), ex.city].filter(Boolean).join(' · ') };
    }), { albumName: album.albumName || '' });
  }
  const out = [];
  const buckets = await getJSON(`${base}/api/timeline/buckets?albumId=${albumId}&${auth}`, headers);
  for (const b of buckets) {
    const t = await getJSON(`${base}/api/timeline/bucket?albumId=${albumId}&timeBucket=${encodeURIComponent(b.timeBucket)}&${auth}`, headers);
    (t.id || []).forEach((id, i) => {
      if (t.isImage && !t.isImage[i]) return;
      if (t.isTrashed && t.isTrashed[i]) return;
      out.push({ url: immichUrl(base, id, t.thumbhash && t.thumbhash[i], auth),
        caption: [monthYear(t.fileCreatedAt && t.fileCreatedAt[i]), t.city && t.city[i]].filter(Boolean).join(' · ') });
    });
  }
  return Object.assign(out, { albumName: album.albumName || '' });
}
/* ---------- Photo connectors ----------
 * Each source is { id, type, name, enabled, …its configuration } and is saved in photoSources (configuration web).
 *   immich   { url, apiKey? }   shared link of an album, or private album (…/albums/<id>) with an API key
 *   google   { url }            link of a Google Photos shared album (the Pi's helper reads it)
 *   ha_media { folder }         Home Assistant “Media” folder (read only)
 *   urls     { urls: [] }       single photos by URL
 * Without photoSources the old ambientPhotos is used (and Immich links are detected). */
const isImmichUrl = (u) => IMMICH_SHARED.some(([re]) => re.test(u)) || IMMICH_ALBUM.test(u);
function photoSources() {
  if (Array.isArray(CFG.photoSources)) return CFG.photoSources.filter((x) => x && x.enabled !== false);
  const out = [], urls = [];
  for (const u of CFG.ambientPhotos || []) {
    if (isImmichUrl(String(u))) out.push({ type: 'immich', url: String(u).trim(), apiKey: CFG.immichApiKey });
    else urls.push(u);
  }
  if (urls.length) out.push({ type: 'urls', urls });
  return out;
}
const CONNECTORS = {
  immich: {
    label: 'web.ambient.immich',
    async load(src) {
      const u = String(src.url || '').trim();
      for (const [re, param] of IMMICH_SHARED) {
        const m = u.match(re);
        if (!m) continue;
        const base = m[1], auth = `${param}=${encodeURIComponent(m[2])}`;
        const link = await getJSON(`${base}/api/shared-links/me?${auth}`);
        if (link.album) {
          const list = await immichAlbumPhotos(base, link.album.id, auth);
          return { photos: list, name: link.album.albumName || list.albumName };
        }
        return { photos: (link.assets || []).filter((a) => a.type === 'IMAGE').map((a) => ({ url: immichUrl(base, a.id, a.thumbhash, auth), caption: monthYear(a.localDateTime || a.fileCreatedAt) })) };
      }
      const m = u.match(IMMICH_ALBUM);
      if (!m) throw new Error(I18N.t('panel.photos.not_immich'));
      const key = src.apiKey || CFG.immichApiKey;
      if (!key) throw new Error(I18N.t('panel.photos.needs_key'));
      const list = await immichAlbumPhotos(m[1], m[2], 'apiKey=' + encodeURIComponent(key), { 'x-api-key': key });
      return { photos: list, name: list.albumName };
    },
  },
  google: {
    label: I18N.t('web.ambient.google_photos'),
    async load(src) {
      let r;
      try { r = await fetch(`${HELPER}/gphotos?url=${encodeURIComponent(src.url || '')}`, { cache: 'no-store' }); }
      catch (e) { throw new Error(I18N.t('panel.photos.google_needs_helper')); }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      // =w1920-h1080: Google serves the photo already resized to the screen size
      return { photos: j.photos.map((u) => ({ url: u + '=w1920-h1080', caption: '' })), name: j.title };
    },
  },
  ha_media: {
    label: I18N.t('web.general.home_assistant'),
    async load(src) {
      const folder = String(src.folder || '').replace(/^\/+|\/+$/g, '');
      const root = 'media-source://media_source/local' + (folder ? '/' + folder : '');
      const out = [];
      const walk = async (id, depth) => {
        const res = await conn.send({ type: 'media_source/browse_media', media_content_id: id });
        for (const c of res.children || []) {
          if (c.media_class === 'image' || /\.(jpe?g|png|webp|gif)$/i.test(c.media_content_id)) out.push({ ha: c.media_content_id, caption: '' });
          else if (c.can_expand && depth < 3) await walk(c.media_content_id, depth + 1);
        }
      };
      await walk(root, 0);
      return { photos: out, name: folder || I18N.t('panel.photos.media') };
    },
  },
  urls: {
    label: I18N.t('panel.photos.photos'),
    async load(src) { return { photos: (src.urls || []).filter(Boolean).map((u) => ({ url: u, caption: '' })) }; },
  },
};
async function loadPhotos() {
  photosAt = Date.now();
  const out = [], stats = [];
  for (const src of photoSources()) {
    const c = CONNECTORS[src.type];
    if (!c) continue;
    try {
      const { photos, name } = await c.load(src);
      const label = src.name || [I18N.t(c.label), name].filter(Boolean).join(' · ');
      photos.forEach((p) => { p.source = label; p.fit = src.fit || ''; });
      out.push(...photos);
      stats.push({ label, count: photos.length });
    } catch (e) {
      console.warn(I18N.t('panel.photos.photos'), src, e);
      stats.push({ label: src.name || I18N.t(c.label), error: I18N.t(e.message) });
      toast(`${I18N.t(c.label)}: ` + (e.message === 'Failed to fetch' ? I18N.t('panel.photos.could_not_connect') : I18N.t(e.message)), true);
    }
  }
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  PHOTOS = out; photoIdx = 0; PHOTO_STATS = stats;
  // If it could not load (e.g. the helper still starting), retry in 30 s instead of 1 h
  if (!out.length && photoSources().length) photosAt = Date.now() - 3600e3 + 30e3;
  $('#amb-next').classList.toggle('hidden', !photosOn());
}
let PHOTO_STATS = [];
const photosOn = () => SET.photos.enabled && PHOTOS.length > 0;

let bgFront = 'a', bgTimer;
const GRADIENTS = [
  [0, 'linear-gradient(160deg,#0b1026,#1b1f3b 55%,#2a1f3d)'], [6, 'linear-gradient(160deg,#ffb88c,#de6262 60%,#5b2a5c)'],
  [9, 'linear-gradient(160deg,#4facfe,#2b5876 70%,#1a2a44)'], [18, 'linear-gradient(160deg,#f7971e,#c0392b 50%,#3a1c4a)'],
  [21, 'linear-gradient(160deg,#141e30,#243b55)'],
];
// the same moments of the day, in light (light theme and no photos)
const GRADIENTS_LIGHT = [
  [0, 'linear-gradient(160deg,#e6e9f5,#d9def0 55%,#e3dbef)'], [6, 'linear-gradient(160deg,#fff1e4,#fcdcd6 60%,#efd9ee)'],
  [9, 'linear-gradient(160deg,#e7f3ff,#d6e8fb 60%,#e4eefa)'], [18, 'linear-gradient(160deg,#fff0dc,#fbd9cc 55%,#ead7ee)'],
  [21, 'linear-gradient(160deg,#e4e8f2,#d6dcea)'],
];
/** A background layer: photo (filling, whole with a blurred background or whole) or nothing. */
function setPhotoLayer(el, url, fit) {
  const v = url ? `url("${url}")` : '';
  el.style.backgroundImage = '';
  el.querySelector('.amb-fg').style.backgroundImage = v;
  el.querySelector('.amb-blur').style.backgroundImage = v;
  el.dataset.srcfit = fit || '';                       // the source's own mode (empty = the general one)
  el.dataset.fit = fit || SET.photos.fit || 'blur';
}
/** When the general mode changes in Settings it applies to the photo already showing (if its source has no mode of its own). */
function refitPhotos() { document.querySelectorAll('.amb-bg').forEach((el) => { el.dataset.fit = el.dataset.srcfit || SET.photos.fit || 'blur'; }); }

function nextBackground() {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(nextBackground, (photosOn() ? SET.photos.seconds : photoSources().length && !PHOTOS.length ? 30 : 600) * 1000);
  if (photoSources().length && Date.now() - photosAt > 3600e3) {   // albums refresh every hour
    const had = PHOTOS.length;
    loadPhotos().then(() => { if (!had && PHOTOS.length) nextBackground(); });
  }
  const back = bgFront === 'a' ? 'b' : 'a';
  const el = $('#amb-bg-' + back), front = $('#amb-bg-' + bgFront), caption = $('#amb-caption');
  $('#amb-next').classList.toggle('hidden', !photosOn());
  if (photosOn()) {
    if (!S.ambient && front.classList.contains('photo')) return;   // photos are only downloaded while they are seen
    let tries = 0;
    const show = () => {
      let p = PHOTOS[photoIdx++ % PHOTOS.length];
      // the ones that failed before are not requested again
      for (let k = 0; p.bad && k < PHOTOS.length; k++) p = PHOTOS[photoIdx++ % PHOTOS.length];
      if (p.bad) return;
      const img = new Image();
      img.onload = () => {
        setPhotoLayer(el, img.src, p.fit);
        el.classList.add('photo', 'visible'); front.classList.remove('visible'); bgFront = back;
        $('#ambient').classList.remove('lightbg');   // over a photo, always white text
        caption.replaceChildren(...[p.caption ? h('div', { class: 'cap-date' }, p.caption) : null,
          p.source ? h('div', { class: 'cap-src' }, p.source) : null].filter(Boolean));
      };
      // Photo without a large version on the server (or down): skipped, up to 50 in a row
      img.onerror = () => { p.bad = true; if (++tries < 50) show(); };
      if (p.ha) {   // Home Assistant media: URL signed on the spot (read only)
        conn.send({ type: 'media_source/resolve_media', media_content_id: p.ha, expires: 3600 })
          .then((r) => { img.src = absUrl(r.url); }).catch(() => img.onerror());
      } else img.src = p.url;
    };
    show();
  } else {
    caption.replaceChildren();
    const hr = new Date().getHours();
    const g = (themeIsLight() ? GRADIENTS_LIGHT : GRADIENTS).filter(([from]) => hr >= from).pop()[1];
    $('#ambient').classList.toggle('lightbg', themeIsLight());   // no photo: dark text over a light background
    if (front.style.backgroundImage === g && !front.classList.contains('photo')) return;
    setPhotoLayer(el, null);
    el.style.backgroundImage = g;
    el.classList.remove('photo'); el.classList.add('visible'); front.classList.remove('visible'); bgFront = back;
  }
}

/* ====================== Clock and night mode ====================== */
const toMin = (s) => { const [hh, mm] = s.split(':').map(Number); return hh * 60 + mm; };
function tick() {
  const now = new Date();
  const hm = now.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' });
  $('#clock-mini').textContent = hm;
  $('#amb-clock').textContent = hm;
  $('#amb-date').textContent = cap(now.toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' }));
  const wid = weatherId();
  $('#weather-mini').replaceChildren(...(wid ? [icon(wIcon(S.states[wid].state)), ' ' + fmtNum(S.states[wid].attributes.temperature) + '°'] : []));
  checkAlarms(now);
  screenTick();   // brightness, night mode and turning off (with a notification open, screen on and at full)
}

/* ====================== Configuration web (the Pi's helper) ======================
 * The web http://<pi>.local:8080 saves the configuration in the helper. The panel asks it every 5 s:
 * if the version changes it reloads, and it runs the “remote control” commands. */
const REMOTE = { version: window.PANEL_HELPER ? window.PANEL_HELPER.version : null, reload: window.PANEL_HELPER ? window.PANEL_HELPER.reload || 0 : 0,
  command: null, seeded: false };
const SEED_KEYS = ['haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
  'excludePlatforms', 'printerPlugs'];
async function seedHelper() {
  if (!window.PANEL_HELPER || REMOTE.seeded || NEEDS_SETUP) return;
  REMOTE.seeded = true;
  const h = window.PANEL_HELPER;
  if (h.panel && h.panel.haUrl && h.settings && Object.keys(h.settings).length) return;   // it already has everything
  const panel = {};
  for (const k of SEED_KEYS) if (CFG[k] !== undefined && CFG[k] !== '') panel[k] = CFG[k];
  try {
    const r = await fetch(HELPER + '/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panel, settings: SET }) });
    REMOTE.version = (await r.json()).version;
  } catch (e) { /* no helper */ }
}
/** New settings saved from the web: they are applied and what shows repaints, without reloading the panel. */
async function applyRemoteSettings() {
  let j;
  try { j = await (await fetch(HELPER + '/config', { cache: 'no-store' })).json(); } catch (e) { return; }
  if (j.speaker && !SPK) { location.reload(); return; }        // the speaker was just turned on: it has to start with it
  if (SPK && j.speaker) Object.assign(SPK, j.speaker);
  const oldPhotos = JSON.stringify(SET.photos);
  SET = mergeSettings(j.settings || {});
  applySettings();
  if (JSON.stringify(SET.photos) !== oldPhotos) { refitPhotos(); nextBackground(); }
  renderRail();
  if (!S.sheetId) render();
  renderAmbientChips();
  if (SH.open) { SH.open = false; shade(true); }   // the quick access panel, with the new quick access and colours
}
/* Panel state for Home Assistant (over MQTT, in the helper): sent to the helper when it changes.
 * The last touch, at most every 30 s (so it is not sent with every finger). */
let LAST_TOUCH = 0;
const PSTATE = { sent: '', touch: 0 };
function reportState() {
  if (!window.PANEL_HELPER) return;
  if (LAST_TOUCH - PSTATE.touch > 30000) PSTATE.touch = LAST_TOUCH;
  const body = JSON.stringify({ screen_on: !SCREEN.off, brightness: SET.brightness, ambient: !!S.ambient,
    last_touch: PSTATE.touch ? new Date(PSTATE.touch).toISOString() : null });
  if (body === PSTATE.sent) return;
  PSTATE.sent = body;
  fetch(HELPER + '/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => { PSTATE.sent = ''; });
}
function runRemote(type, value) {
  if (type === 'reload') location.reload();
  else if (type === 'brightness' && value) { SET.brightness = value; saveSettings(true); wakeScreen(); }
  else if (type === 'ambient') showAmbient();
  else if (type === 'home') { hideAmbient('home'); wakeScreen(); }
  else if (type === 'screen_off') { screenOffNow(); }
  else if (type === 'screen_on') { wakeScreen(); }
}
async function pollHelper() {
  if (!window.PANEL_HELPER) {
    // On the Pi: if the helper started after the panel, reload to use its configuration
    if (location.protocol === 'file:') fetch(HELPER + '/status', { cache: 'no-store' }).then(() => location.reload()).catch(() => {});
    return;
  }
  if (!SCREEN.helper) helperInit();     // in case it did not answer in time at start
  try {
    const r = await (await fetch(HELPER + '/poll', { cache: 'no-store' })).json();
    if (REMOTE.command === null) REMOTE.command = r.command.id;          // old commands are not repeated at start
    else if (r.command.id !== REMOTE.command) { REMOTE.command = r.command.id; runRemote(r.command.type, r.command.value); }
    // Something changed from the web: if it was the connection, the entities, the photos or the code, it reloads;
    // if it was only settings (brightness, theme, sound, bubbles, tabs…), they apply at once without reloading
    if (REMOTE.version !== null && r.version !== REMOTE.version) {
      if ((r.reload || 0) !== REMOTE.reload) { location.reload(); return; }
      applyRemoteSettings();
    }
    REMOTE.version = r.version; REMOTE.reload = r.reload || 0;
    showPin(r.pin || null);
    if (r.update && r.update !== UPDATE_SEEN) toast(I18N.t('panel.settings.update_available'));
    UPDATE_SEEN = r.update || 0;
  } catch (e) { /* helper restarting */ }
}
let UPDATE_SEEN = 0;

/* Code to pair the speaker: Music Assistant asks for it when adding it; it shows big until it is paired.
 * The ✕ hides it (it shows again if the code changes). */
const PIN = { code: null, hidden: null };
function showPin(code) {
  const box = $('#pin');
  if (!code) { PIN.code = null; box.classList.remove('show'); return; }
  if (code === PIN.hidden) return;
  if (code !== PIN.code) {
    PIN.code = code;
    box.replaceChildren(h('div', { class: 'pin-card' },
      h('button', { class: 'icon-btn', onclick: () => { PIN.hidden = code; box.classList.remove('show'); } }, icon('mdi-close')),
      icon('mdi-link-variant'),
      h('div', { class: 'pin-title' }, I18N.t('panel.notices.pair_music_assistant')),
      h('div', { class: 'pin-hint' }, I18N.t('panel.notices.type_code_music')),
      h('div', { class: 'pin-code' }, code),
      h('div', { class: 'pin-name' }, SPK && SPK.name ? SPK.name : '')));
  }
  box.classList.add('show');
  wakeScreen(); resetIdle();
}

/* ====================== Arranque ====================== */
async function loadAll() {
  const safe = (p) => p.catch(() => []);
  const [states, areas, devs, ents, haConf] = await Promise.all([
    conn.send({ type: 'get_states' }),
    safe(conn.send({ type: 'config/area_registry/list' })),
    safe(conn.send({ type: 'config/device_registry/list' })),
    safe(conn.send({ type: 'config/entity_registry/list' })),
    conn.send({ type: 'get_config' }).catch(() => ({})),
  ]);
  if (haConf && haConf.language) { HA_LANG = haConf.language; setLanguage(); }   // “Automatic” = Home Assistant's language
  S.states = {}; S.ents = {}; S.devs = {};
  states.forEach((s) => (S.states[s.entity_id] = s));
  S.areas = areas; S.areaById = Object.fromEntries(areas.map((a) => [a.area_id, a]));
  devs.forEach((d) => (S.devs[d.id] = d));
  ents.forEach((e) => (S.ents[e.entity_id] = e));
  printersCache = null;
  S.vacuumDevs = new Set(ents.filter((e) => domain(e.entity_id) === 'vacuum' && e.device_id).map((e) => e.device_id));
  await conn.subscribe('state_changed', (ev) => setState(ev.data.entity_id, ev.data.new_state));
  await conn.subscribe('panel_notification', onNotif);
  await conn.subscribe('panel_notification_close', onNotifClose);
  S.forecastAt = 0;
  await loadSettings();
  seedHelper();
  if (!S.sheetId) render();
  tick();
  if (!S.entered) { S.entered = true; if (!PARAMS.has('ambient')) enterScreen(); }   // primera carga
}

function start() {
  // The pointer is only hidden in the Pi kiosk (opened as file://) or with ?kiosk in the URL
  if (CFG.hideCursor && (location.protocol === 'file:' || PARAMS.has('kiosk'))) document.body.classList.add('no-cursor');
  conn.onstatus = (ok, msg) => {
    S.connected = ok;
    $('#conn').classList.toggle('ok', ok);
    if (msg) toast(msg, true);
  };
  conn.onready = () => loadAll().catch((e) => toast(I18N.t('panel.status.loading_error_prefix') + e.message, true));
  if (NEEDS_SETUP) showSetup(); else conn.connect();

  $('#view').replaceChildren(empty('mdi-home-assistant', I18N.t('panel.status.connecting')));
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#bell').addEventListener('click', () => shade(true, 0));
  $('#stay').addEventListener('click', () => setStay(!STAY.on));   // the quick access panel, on the notifications
  shadeGestures();
  // Tapping the background goes back to Home; tapping a bubble opens its view (scooter, printers, music…)
  $('#ambient').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.clientY <= shadeEdge) return;   // that is where the quick access panel starts: it does not leave ambient mode
    if (e.target.closest('#amb-next')) { e.stopPropagation(); nextBackground(); resetIdle(); return; }
    const act = e.target.closest('[data-act]');
    if (act) { e.stopPropagation(); ambientPlayerAction(act.dataset.act); resetIdle(); return; }
    if (e.target.closest('#amb-player.own .amb-pinfo')) { e.stopPropagation(); swallowTouch(); showNowPlaying(ambientSpeaker()); return; }
    if (e.target.closest('#amb-player')) { resetIdle(); return; }
    const chip = e.target.closest('.amb-chip');
    if (chip && chip.bubble && (chip.bubble.action || chip.bubble.onTap)) { e.stopPropagation(); swallowTouch(); runBubble(chip.bubble); resetIdle(); return; }
    if (SET.ambientGestures && !chip) { ambientGesture(e); return; }   // 🧪 beta
    swallowTouch();
    hideAmbient(chip && chip.bubble && chip.bubble.go ? chip.bubble.go : 'home');
  });
  document.addEventListener('pointerdown', () => { SCREEN.lastTouch = LAST_TOUCH = Date.now(); resetIdle(); }, true);
  $('#blackout').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); swallowTouch(); wakeScreen(); });
  helperInit();
  setInterval(pollHelper, 1000);   // commands from the remote and from Home Assistant, at once

  tick(); setInterval(tick, 5000);
  if (photoSources().length) loadPhotos().then(nextBackground); else nextBackground();
  // Refreshes relative texts ("5 min ago") and the greeting from time to time
  setInterval(() => !S.sheetId && !S.ambient && render(), 5 * 60e3);
  if (PARAMS.has('ambient')) showAmbient(); else resetIdle();
}
start();
