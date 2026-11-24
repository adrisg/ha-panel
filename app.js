/* Panel Hogar — panel propio para Home Assistant (API WebSocket), estilo Nest Hub.
 * Sin frameworks: JS puro para que vaya fluido en una Raspberry Pi 2. */
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
// Sin dirección o sin token no hay nada que mostrar: se enseña cómo conectarlo
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
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
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

/* ====================== Conexión con Home Assistant ====================== */
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
      for (const p of this.pending.values()) p.reject(new Error('Conexión perdida'));
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
      this.onstatus(false, 'Token no válido: revisa config.js');
    } else if (m.type === 'result' || m.type === 'pong') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'pong' || m.success) p.resolve(m.result);
      else p.reject(new Error((m.error && m.error.message) || 'Error'));
    } else if (m.type === 'event') {
      const cb = this.subs.get(m.id);
      if (cb) cb(m.event);
    }
  }
  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Sin conexión'));
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

/** Llama a un servicio; si falla avisa y repinta el estado real. */
function call(dom, service, data, id, returnResponse) {
  return api.callService(dom, service, data, id, returnResponse).catch((e) => {
    toast('Error: ' + e.message, true);
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
// Enlaces entidad → funciones que repintan una parte de la pantalla (por "ámbito")
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
  // Si un reproductor empieza o deja de tener algo, se reordena la vista Multimedia
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
// Dominios cuyo estado normal es "unknown" (no deben ocultarse por eso)
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
    // De un aspirador solo interesa la propia entidad vacuum, no sus decenas de ajustes
    if (d !== 'vacuum' && e.device_id && S.vacuumDevs.has(e.device_id)) return false;
  }
  return true;
}
// Nombres que no dicen nada sin el dispositivo delante ("Light", "Temperatura"…)
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
  // Limpia nombres raros de algunas integraciones: espacios dobles y «Maripili  Maripili»
  n = n.replace(/\s+/g, ' ').trim();
  const twice = n.match(/^(.+) \1$/i);
  if (twice) n = twice[1];
  return cap(n);
}
/** Orden de los reproductores: 0 sonando · 1 en pausa con contenido · 2 encendido con algo · 3 encendido vacío · 4 apagado · 5 no disponible */
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

/** Quita reproductores repetidos (la misma TV por Cast, Android TV, Music Assistant…). */
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
const T_ES = {
  on: 'Encendido', off: 'Apagado', unavailable: 'No disponible', unknown: '—', open: 'Abierto',
  closed: 'Cerrado', opening: 'Abriendo', closing: 'Cerrando', locked: 'Cerrado con llave',
  unlocked: 'Abierto', locking: 'Cerrando…', unlocking: 'Abriendo…', jammed: 'Atascado',
  playing: 'Reproduciendo', paused: 'En pausa', idle: 'Inactivo', standby: 'En espera',
  buffering: 'Cargando', home: 'En casa', not_home: 'Fuera', heat: 'Calor', cool: 'Frío',
  auto: 'Auto', heat_cool: 'Calor/Frío', dry: 'Deshumidificar', fan_only: 'Ventilador',
  cleaning: 'Limpiando', docked: 'En la base', returning: 'Volviendo', error: 'Error',
};
/** Estados en el idioma del panel (T.on → «Encendido» / «On»). */
const T = new Proxy(T_ES, { get: (o, k) => (o[k] != null ? t(o[k]) : undefined) });
const BIN = {
  door: ['Cerrada', 'Abierta'], window: ['Cerrada', 'Abierta'], garage_door: ['Cerrada', 'Abierta'],
  opening: ['Cerrado', 'Abierto'], motion: ['Sin movimiento', 'Movimiento'], occupancy: ['Libre', 'Ocupado'],
  presence: ['Fuera', 'Presente'], moisture: ['Seco', 'Fuga de agua'], smoke: ['OK', 'Humo'],
  gas: ['OK', 'Gas'], connectivity: ['Desconectado', 'Conectado'], battery_charging: ['No carga', 'Cargando'],
  plug: ['Desenchufado', 'Enchufado'], lock: ['Cerrado', 'Abierto'], moving: ['Parado', 'En movimiento'],
  power: ['Apagado', 'Encendido'], problem: ['OK', 'Problema'], battery: ['Normal', 'Batería baja'],
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
  if (d === 'vacuum') return s === 'error' ? 'mdi-robot-vacuum-alert' : 'mdi-robot-vacuum';   // sin el «zzz» de la integración
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
  return DC_ICON[a.device_class] || DOMAIN_ICON[d] || 'mdi-help-circle-outline';
}
function fmtState(st) {
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
    parts.push(s === 'off' ? 'Apagado' : (T[s] || s) + (a.temperature != null ? ' → ' + fmtNum(a.temperature) + '°' : ''));
    return parts.join(' · ');
  }
  if (d === 'cover' && s === 'open' && a.current_position != null) return `Abierto ${a.current_position} %`;
  if (d === 'media_player' && (s === 'playing' || s === 'paused') && a.media_title) return a.media_title;
  if (d === 'vacuum') {
    const b = a.battery_level ?? a.battery;
    if (a.charging) return `Cargando${b != null ? ' · ' + b + ' %' : ''}`;
    return (T[s] || cap(s)) + (b != null ? ` · ${b} %` : '');
  }
  if (['scene', 'script', 'button', 'input_button'].includes(d)) return 'Toca para activar';
  return T[s] || cap(s);
}
const ACTIVE = ['on', 'open', 'opening', 'closing', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning', 'returning'];
const isActive = (st) => !!st && ACTIVE.includes(st.state);
const KIND = { light: 'light', climate: 'climate', media_player: 'media', cover: 'cover', lock: 'lock', fan: 'climate' };
const kindOf = (d) => KIND[d] || 'default';

const W = {
  'clear-night': ['mdi-weather-night', 'Despejado'], cloudy: ['mdi-weather-cloudy', 'Nublado'],
  exceptional: ['mdi-alert-circle-outline', 'Excepcional'], fog: ['mdi-weather-fog', 'Niebla'],
  hail: ['mdi-weather-hail', 'Granizo'], lightning: ['mdi-weather-lightning', 'Tormenta'],
  'lightning-rainy': ['mdi-weather-lightning-rainy', 'Tormenta con lluvia'],
  partlycloudy: ['mdi-weather-partly-cloudy', 'Parcialmente nublado'], pouring: ['mdi-weather-pouring', 'Lluvia fuerte'],
  rainy: ['mdi-weather-rainy', 'Lluvia'], snowy: ['mdi-weather-snowy', 'Nieve'],
  'snowy-rainy': ['mdi-weather-snowy-rainy', 'Aguanieve'], sunny: ['mdi-weather-sunny', 'Soleado'],
  windy: ['mdi-weather-windy', 'Viento'], 'windy-variant': ['mdi-weather-windy-variant', 'Viento y nubes'],
};
const wIcon = (c) => (W[c] || ['mdi-weather-partly-cloudy'])[0];
const wText = (c) => (W[c] || [0, cap(c || '')])[1];
const weatherId = () => (CFG.weatherEntity && S.states[CFG.weatherEntity]) ? CFG.weatherEntity
  : Object.keys(S.states).find((id) => domain(id) === 'weather');

const FORECASTS = {};      // previsión por entidad del tiempo: { id: { list, t } }
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
/** Toque corto / pulsación larga, sin disparar al hacer scroll. */
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
  // Un interruptor sin conexión no se intenta encender: se abre su detalle (o se avisa)
  if (S.states[id] && S.states[id].state === 'unavailable' && TOGGLE.includes(d)) {
    if (HAS_SHEET.includes(d)) openSheet(id); else toast(`${nameOf(id)} no está disponible`, true);
    return;
  }
  if (TOGGLE.includes(d)) {
    el.classList.add('pending');
    el.classList.toggle('on');
    call(d, 'toggle', {}, id);
    return;
  }
  if (d === 'scene') return call('scene', 'turn_on', {}, id).then((r) => r !== null && toast('Escena activada'));
  if (d === 'script') return call('script', 'turn_on', {}, id).then((r) => r !== null && toast('En marcha'));
  if (d === 'button' || d === 'input_button') return call(d, 'press', {}, id).then((r) => r !== null && toast('Hecho'));
  openSheet(id);
}

/* ---------- Color real de las luces ----------
 * Una luz encendida pinta su ficha con su propio color: el RGB si lo tiene, o el blanco cálido/frío
 * de su temperatura de color. El texto se pone oscuro o claro según lo luminoso que sea el fondo. */
function kelvinToRgb(k) {          // aproximación de Tanner Helland
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
  if (Array.isArray(a.hs_color)) {                          // por si solo da tono/saturación
    const [hh, ss] = a.hs_color, c = ss / 100, x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((v) => Math.round((v + (1 - c)) * 255));
  }
  return null;                                               // sin color: se queda el amarillo de siempre
}
function paintLight(el, st) {
  const rgb = st && domain(st.entity_id) === 'light' && st.state === 'on' && lightColor(st);
  if (!rgb) { el.style.removeProperty('background'); el.style.removeProperty('color'); return; }
  // Un poco suavizado hacia el blanco para que se lea bien y no deslumbre
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
  const vol = slider({ label: 'Volumen', fmt: (v) => v + ' %', onchange: (v) => call('media_player', 'volume_set', { volume_level: v / 100 }, id) });
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

/* ====================== Hoja de detalle (pulsación larga) ====================== */
function bigToggle(id) {
  const d = domain(id);
  const b = h('button', { class: 'big-toggle', onclick: () => call(d, 'toggle', {}, id) });
  b.dataset.kind = kindOf(d);
  bind('sheet', id, (st) => { b.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))); b.classList.toggle('on', isActive(st)); paintLight(b, st); });
  return b;
}
const COLORS = [[255, 147, 41], [255, 214, 170], [255, 255, 255], [255, 80, 80], [255, 60, 180], [150, 90, 255], [60, 130, 255], [40, 210, 200], [80, 220, 100], [255, 220, 60]];

const SHEETS = {
  light(id) {
    const a = S.states[id].attributes, modes = a.supported_color_modes || [];
    const parts = [bigToggle(id)];
    if (modes.some((m) => m !== 'onoff')) {
      const s = slider({ min: 1, label: 'Brillo', fmt: (v) => v + ' %', onchange: (v) => call('light', 'turn_on', { brightness_pct: v }, id) });
      bind('sheet', id, (st) => s.set(st.state === 'on' && st.attributes.brightness ? Math.max(1, Math.round(st.attributes.brightness / 2.55)) : 1));
      parts.push(s);
    }
    if (modes.includes('color_temp')) {
      const mn = a.min_color_temp_kelvin || 2000, mx = a.max_color_temp_kelvin || 6500;
      const s = slider({ min: mn, max: mx, step: 50, label: 'Tono', cls: 'warm', fmt: (v) => v + ' K', onchange: (v) => call('light', 'turn_on', { color_temp_kelvin: v }, id) });
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
    const s = slider({ label: 'Velocidad', fmt: (v) => v + ' %', onchange: (v) => call('fan', 'set_percentage', { percentage: v }, id) });
    bind('sheet', id, (st) => s.set(st.attributes.percentage || 0));
    return [bigToggle(id), s];
  },
  cover(id) {
    const btn = (ic, label, svc) => h('button', { class: 'big-action', onclick: () => call('cover', svc, {}, id) }, icon(ic), label);
    const parts = [h('div', { class: 'btn-row' }, btn('mdi-arrow-up', 'Abrir', 'open_cover'), btn('mdi-stop', 'Parar', 'stop_cover'), btn('mdi-arrow-down', 'Cerrar', 'close_cover'))];
    if (S.states[id].attributes.current_position != null) {
      const s = slider({ label: 'Posición', fmt: (v) => v + ' %', onchange: (v) => call('cover', 'set_cover_position', { position: v }, id) });
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
      cur.textContent = (a.current_temperature != null ? `Ahora ${fmtNum(a.current_temperature)}°` : '') +
        (a.current_humidity != null ? ` · ${a.current_humidity} % humedad` : '');
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
      h('button', { class: 'big-action', onclick: () => call('lock', 'lock', {}, id) }, icon('mdi-lock'), 'Cerrar'),
      h('button', { class: 'big-action', onclick: () => call('lock', 'unlock', {}, id) }, icon('mdi-lock-open-variant'), 'Abrir'))];
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

    // Habitaciones del mapa (Dreame: attributes.rooms[mapa] = [{id, name, icon}])
    const rooms = a.rooms ? (a.rooms[a.selected_map] || Object.values(a.rooms)[0] || []) : [];
    if (dreame && rooms.length) {
      const sel = new Set();
      const go = h('button', { class: 'big-action primary' }, icon('mdi-play'), h('span'));
      const paint = () => {
        go.lastChild.textContent = sel.size ? `Limpiar ${sel.size} habitaci${sel.size > 1 ? 'ones' : 'ón'}` : 'Elige habitaciones';
        go.classList.toggle('disabled', !sel.size);
      };
      go.addEventListener('click', () => {
        if (!sel.size) return toast('Elige al menos una habitación');
        const names = rooms.filter((r) => sel.has(r.id)).map((r) => r.name);
        call('dreame_vacuum', 'vacuum_clean_segment', { segments: [...sel] }, id)
          .then((r) => { if (r !== null) { toast('Limpiando: ' + names.join(', ')); closeSheet(); } });
      });
      const chips = h('div', { class: 'room-chips' }, rooms.map((r) => {
        const c = h('button', { class: 'room-chip' }, icon(mdi(r.icon) || 'mdi-home-outline'), h('span', null, r.name));
        c.addEventListener('click', () => { if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id); c.classList.toggle('on', sel.has(r.id)); paint(); });
        return c;
      }));
      paint();
      parts.push(h('div', { class: 'vac-title' }, '¿Qué habitaciones limpio?'), chips,
        h('div', { class: 'btn-row' }, go, b('mdi-home-city-outline', 'Toda la casa', 'start')));
    } else {
      parts.push(h('div', { class: 'btn-row' }, b('mdi-play', 'Limpiar', 'start', 'primary')));
    }

    // Atajos guardados en la app de Dreame
    const shortcuts = dreame && a.shortcuts ? Object.values(a.shortcuts).filter((s) => s && s.name) : [];
    if (shortcuts.length) {
      parts.push(h('div', { class: 'vac-title' }, 'Atajos de la app'), h('div', { class: 'chips vac-shortcuts' }, shortcuts.map((s) =>
        h('button', { class: 'chip', onclick: () => call('dreame_vacuum', 'vacuum_start_shortcut', { shortcut_id: s.id }, id)
          .then((r) => { if (r !== null) { toast('En marcha: ' + s.name); closeSheet(); } }) }, icon('mdi-flash'), s.name))));
    }
    parts.push(h('div', { class: 'btn-row' }, b('mdi-pause', 'Pausa', 'pause'), b('mdi-home-import-outline', 'A la base', 'return_to_base')));
    return parts;
  },
  camera(id) { return [cameraImg(id, 'sheet', 2)]; },
  sensor(id) { return [historyChart(id)]; },
  binary_sensor(id) { return [historyChart(id)]; },
  // Interruptores y parecidos: encender/apagar y su historial
  switch(id) { return [bigToggle(id), historyChart(id)]; },
  input_boolean(id) { return [bigToggle(id), historyChart(id)]; },
  automation(id) { return [bigToggle(id), historyChart(id)]; },
  siren(id) { return [bigToggle(id), historyChart(id)]; },
  humidifier(id) { return [bigToggle(id), historyChart(id)]; },
  weather(id) { return [weatherCard(id)]; },
};
/** Detalle de cualquier otra entidad: su estado y su historial */
function genericSheet(id) {
  const val = h('div', { class: 'sheet-state' });
  bind('sheet', id, (st) => { val.textContent = fmtState(st); });
  return [val, historyChart(id)];
}

function historyChart(id) {
  const box = h('div', { class: 'chart' }, h('div', { class: 'muted' }, 'Cargando últimas 24 h…'));
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
        h('div', { class: 'chart-meta' }, h('span', null, 'Hace 24 h'),
          h('span', null, `mín ${fmtNum(Math.min(...vs))} ${unit} · máx ${fmtNum(Math.max(...vs))} ${unit}`), h('span', null, 'Ahora')));
    } else {
      const fake = (s) => fmtState({ entity_id: id, state: s, attributes: st.attributes });
      const rows = pts.slice(-8).reverse().map((p) => h('div', null, h('span', null, fake(p.s)), h('span', { class: 'muted' }, relTime(new Date(p.t).toISOString()))));
      box.replaceChildren(h('div', { class: 'history-list' }, rows.length ? rows : h('div', null, 'Sin cambios en 24 h')));
    }
  }).catch(() => box.replaceChildren(h('div', { class: 'muted' }, 'Historial no disponible')));
  return box;
}

/* ====================== Altavoz Sendspin del panel ======================
 * Si la Pi es altavoz de Music Assistant (web → Sonido → Altavoz) y empieza a sonar algo en ella,
 * sale del modo ambiente y abre su reproductor; al parar, se cierra solo. */
const SPK = (window.PANEL_HELPER && window.PANEL_HELPER.altavoz) || null;
function speakerEntity() {
  if (!SPK || !SPK.enabled) return null;
  if (SPK.entity) return SPK.entity;
  // Automático: por el identificador, que sale del nombre del altavoz y no cambia aunque lo renombres
  // en Home Assistant o Music Assistant («Panel ha-panel» → media_player.panel_ha_panel)
  const want = String(SPK.name || '').trim().toLowerCase();
  const slug = 'media_player.' + want.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (S.states[slug]) return slug;
  // Si no existe ese identificador (p. ej. ya estaba cogido y HA le puso «_2»), por el nombre
  const found = Object.keys(S.states).filter((id) => domain(id) === 'media_player' &&
    String(S.states[id].attributes.friendly_name || '').trim().toLowerCase() === want);
  return found.find((id) => reg(id).platform === 'music_assistant') || found[0] || null;
}
const resolveSpk = (x) => (x === '@panel' ? speakerEntity() : x);
const spkPlaying = (x) => (S.states[x] || {}).state === 'playing';
/** Altavoces que abren «Sonando», por orden de prioridad (web → Sonido → Sonando). '@panel' = el de este panel. */
function watchedSpeakers() {
  if (!SPK) return [];
  const list = SPK.npSpeakers || [...(SPK.open ? ['@panel'] : []), ...(SPK.watch || [])];
  return [...new Set(list.map(resolveSpk))].filter((x) => x && S.states[x]);
}
/* Prioridad: si empieza a sonar uno con más prioridad que el que se ve, «Sonando» pasa a ese; si empieza uno con
 * menos, solo se cambia si el que se ve no está sonando. Al parar el que se ve, pasa al siguiente que esté sonando. */
function onSpeaker(id, old, st) {
  if (!SPK || domain(id) !== 'media_player') return;
  const w = watchedSpeakers();
  if (!w.includes(id)) return;
  const was = old && old.state, now = st && st.state;
  if (now === 'playing') {
    if (NP.id === id) { clearTimeout(NP.closeTimer); return; }   // vuelve a sonar: ya no se cierra
    if (!was || was === 'playing' || alertOpen()) return;          // una alarma o un aviso importante mandan
    if (!NP.id) { if (was !== 'paused') showNowPlaying(id); return; }   // reanudar una pausa no la abre
    const cur = w.indexOf(NP.id);
    if (!spkPlaying(NP.id) || (cur >= 0 && w.indexOf(id) < cur)) { clearTimeout(NP.closeTimer); showNowPlaying(id); }
  } else if (NP.id === id && was === 'playing') {
    const next = w.find((x) => x !== id && spkPlaying(x));   // otro de la lista sigue sonando: pasa a ese
    if (next && !alertOpen()) { clearTimeout(NP.closeTimer); showNowPlaying(next); return; }
    // En pausa o parada: se queda un rato (web → Sonido → Altavoz) por si vuelve a sonar
    const secs = SPK.closeAfter == null ? 60 : SPK.closeAfter;
    clearTimeout(NP.closeTimer);
    // al cerrarse sola vuelve al modo ambiente (con la ✕ se queda donde estaba)
    const autoClose = () => { if (!alertOpen() && !S.sheetId) npToAmbient(true); else { hideNowPlaying(true); resetIdle(); } };
    if (secs === 0) autoClose();
    else if (secs > 0) NP.closeTimer = setTimeout(() => { if ((S.states[id] || {}).state !== 'playing') autoClose(); }, secs * 1000);
  }
}

/* Pantalla «Sonando»: carátula grande con el fondo difuminado, título, progreso y controles (el volumen, en el panel de acceso rápido) */
const NP = { id: null, timer: null, closeTimer: null, fromAmbient: false };
const npPlaying = () => !!NP.id && (S.states[NP.id] || {}).state === 'playing';
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/* Arrastrar con el dedo o el ratón. En la pantalla táctil de la Pi los eventos de puntero no siempre llegan,
 * así que se escuchan los táctiles (y los de puntero solo para ratón). start(x, y) devuelve false para ignorar. */
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
/* Símbolo del altavoz según el volumen (para la burbuja). */
const volIconOf = (v) => v <= 0 ? 'mdi-volume-off' : v < 34 ? 'mdi-volume-low' : v < 67 ? 'mdi-volume-medium' : 'mdi-volume-high';
/* Volumen en «Sonando» para OTROS altavoces (el del panel se cambia en el panel de acceso rápido): un botón con el altavoz
 * abajo a la derecha que despliega una barra vertical con el número. Solo sale si ese altavoz deja cambiar el volumen. */
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
  // lo que llega de Home Assistant (lo que llega tarde de un arrastre propio no hace saltar la barra)
  W.update = (st) => {
    el.classList.toggle('hidden', !canSetVolume(st));
    if (!canSetVolume(st) || W.drag || Date.now() - W.sentAt < 3000) return;
    set(Math.round(st.attributes.volume_level * 100));
  };
  return W;
}
/* Burbuja de volumen: si cambia el volumen del altavoz del panel desde otro sitio (Home Assistant, Music Assistant,
   el móvil…), sale arriba en el centro una burbuja con el número nuevo, en cualquier pantalla. Se va sola a los 2 s.
   Lo que cambias desde el propio panel no la saca. */
const OSD = { known: null, sent: -1, sentAt: 0, timer: null };
function volMarkSent(v) { OSD.sent = v; OSD.sentAt = Date.now(); }
function volBubble(v) {
  let el = $('#vol-bubble');
  if (!el) { el = h('div', { id: 'vol-bubble', class: 'vol-bubble' }); document.body.append(el); }
  el.replaceChildren(icon(volIconOf(v)), h('b', null, String(v)));
  el.classList.add('show');
  clearTimeout(OSD.timer);
  OSD.timer = setTimeout(() => el.classList.remove('show'), 2000);
}
function onVolumeChange(id, st) {
  if (!st || id !== speakerEntity() || st.attributes.volume_level == null) return;
  const v = Math.round(st.attributes.volume_level * 100), was = OSD.known;
  OSD.known = v;
  if (was == null || v === was || Date.now() - OSD.sentAt < 4000) return;   // primera vez, sin cambios o cambiado aquí
  volBubble(v);
}
function showNowPlaying(id) {
  if (NP.id === id && $('#np').classList.contains('show')) return;
  // ¿Se abrió desde el modo ambiente? Al cerrarla con la ✕ se vuelve a él
  const fromAmbient = S.ambient || (!!NP.id && NP.fromAmbient);
  hideNowPlaying(true);
  closeSheet();
  if (S.ambient) { S.ambient = false; $('#ambient').classList.remove('show'); }
  NP.id = id;
  NP.fromAmbient = fromAmbient;
  const bg = h('div', { class: 'np-bg' }), art = h('div', { class: 'np-art' }, icon('mdi-music'));
  const title = h('div', { class: 'np-title' }), sub = h('div', { class: 'np-sub' });
  const bar = h('i'), cur = h('span'), dur = h('span');
  // Progreso: un puntito marca por dónde va. Solo arrastrando el puntito se cambia (al soltar).
  // Con eventos táctiles y de ratón: en la pantalla táctil de la Pi los de puntero no siempre llegan.
  const tip = h('span', { class: 'np-tip' });   // mientras lo mantienes: el tiempo donde lo vas a dejar
  const knob = h('b', { class: 'np-knob' }, tip);
  const seek = h('div', { class: 'np-seek' }, h('div', { class: 'np-bar' }, bar), knob);
  let seekDrag = false, seekMoved = false, seekPos = 0, seekX = 0, frac = 0, lastPos = null;
  let seekHold = null;   // tras soltar: se queda donde lo dejaste hasta que llegue la posición nueva
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
    if (!canSeek() || Math.abs(x - (r.left + r.width * frac)) > 44) return false;   // solo cerca del puntito
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
  // si es otro altavoz (no el del panel), su volumen aquí mismo; el del panel está en el panel de acceso rápido
  const vol = id !== speakerEntity() ? npVolume(id) : null;
  const root = $('#np');
  root.classList.toggle('has-vol', !!vol);
  root.replaceChildren(bg,
    h('div', { class: 'np-top' }, icon('mdi-speaker'), h('span', { class: 'np-spk' }, nameOf(id, false)), clock,
      h('button', { class: 'np-close', onclick: () => { if (NP.fromAmbient && !alertOpen()) npToAmbient(); else hideNowPlaying(); } }, icon('mdi-close'))),
    h('div', { class: 'np-main' }, art, h('div', { class: 'np-info' }, title, sub,
      h('div', { class: 'np-ctrls' }, h('button', { onclick: svc('media_previous_track') }, icon('mdi-skip-previous')), play,
        h('button', { onclick: svc('media_next_track') }, icon('mdi-skip-next'))))),
    ...(vol ? [vol.el] : []),   // replaceChildren pintaría «null» como texto
    // progreso: abajo del todo, de lado a lado
    h('div', { class: 'np-prog' }, h('div', { class: 'np-times' }, cur, dur), seek));
  // Si una palabra no cabe, la letra se hace más pequeña (hasta un 60 %); si aun así no cabe, se parte
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
  // Progreso y reloj, cada segundo
  const tick = () => {
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
    cur.textContent = fmtTime(pos); dur.textContent = fmtTime(total);   // por dónde va la música (también mientras arrastras)
    if (seekDrag) return;
    const jump = lastPos == null || Math.abs(pos - lastPos - 1) > 1.5;   // saltos (canción nueva, posición nueva): sin animación
    lastPos = pos;
    frac = pos / total; paintProg(frac, jump);
  };
  tick();
  NP.timer = setInterval(tick, 1000);
  root.classList.add('show');
  wakeScreen(); resetIdle();
}
/** De «Sonando» al modo ambiente sin que se vea el panel en medio: el ambiente sale ya debajo y «Sonando» se desvanece encima. */
function npToAmbient(quiet) {
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
  NP.id = null;
  $('#np').classList.remove('show');
  if (was && !quiet) resetIdle();
}

function openSheet(id) {
  if (SH.open) shade(false);   // la pulsación larga en un acceso rápido abre su detalle
  closeSheet();
  const st = S.states[id];
  if (!st) return;
  const builder = SHEETS[domain(id)] || genericSheet;
  const head = h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }), h('div', { class: 'sheet-title' }, nameOf(id, false)),
    h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close')));
  bind('sheet', id, (s) => head.firstChild.replaceChildren(icon(iconOf(s))));
  const notice = h('div', { class: 'unavail-notice hidden' }, icon('mdi-lan-disconnect'),
    h('span', null, 'Este dispositivo no está disponible ahora mismo. Los controles se activarán cuando vuelva a conectarse.'));
  const body = h('div', { class: 'sheet-body' }, builder(id));
  $('#sheet-card').replaceChildren(head, notice, body);
  // Sin conexión con el dispositivo: los controles se desactivan (y se reactivan solos si vuelve)
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

/* ====================== Utilidades de entidades ====================== */
const ids = (filter) => Object.keys(S.states).filter((id) => visible(id) && !isScooter(id) && filter(id));
const empty = (ic, msg) => h('div', { class: 'empty-state' }, icon(ic), msg);

function scooterIds() {
  const m = {};
  for (const [id, e] of Object.entries(S.ents)) if (e.platform === CFG.scooterPlatform && e.translation_key && S.states[id]) m[e.translation_key] = id;
  return m;
}
const num = (id) => (id && S.states[id] ? parseFloat(S.states[id].state) : NaN);
const isOn = (id) => !!id && S.states[id] && S.states[id].state === 'on';
/** 'charged' (llegó al límite: verde) | 'charging' (azul) | false */
const chargeMode = (k) => isOn(k.charged) ? 'charged' : isOn(k.charging_any) ? 'charging' : false;

/** La pantalla de Ajustes del panel (la ruedecita) */
const VIEWS = { settings: { title: 'Ajustes', icon: 'mdi-cog', render: () => renderSettings() } };
/** Pestañas de serie que no salen si no hay de qué (p. ej. Patinete sin patinete) */
const VIEW_VISIBLE = {
  media: () => ids((id) => ['media_player', 'camera'].includes(domain(id))).length > 0,
  printers: () => printers().length > 0,
  scooter: () => !!scooterIds().battery_level,
};

/* ====================== Impresoras 3D ====================== */
// Cada integración nombra sus entidades a su manera: Bambu por translation_key,
// Moonraker (Klipper/Snapmaker) por el final del entity_id.
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
    if (!e.status) continue;               // p. ej. la bobina externa o MakerWorld de Bambu
    const d = S.devs[dev] || {};
    const name = d.name_by_user || d.name || 'Impresora';
    let nozzles = [{ label: 'Boquilla', cur: e.nozzle, tgt: e.nozzleTarget }];
    if (platform === 'moonraker') {
      const cams = ids.filter((id) => domain(id) === 'camera');
      e.camera = cams.find((id) => !/thumbnail|gui|screen/.test(id)) || cams[0];
      e.screen = cams.find((id) => /gui|screen|pantalla/.test(id));     // la pantalla de la impresora
      e.light = ids.find((id) => domain(id) === 'light');
      // Miniatura: una entidad image.<impresora>_thumb… (aunque no esté en el dispositivo) o la cámara "thumbnail"
      const prefix = e.status.split('.')[1].replace(/_current_print_state$/, '');
      e.cover = Object.keys(S.states).find((id) => id.startsWith(`image.${prefix}_thumb`)) || cams.find((id) => /thumbnail/.test(id));
      // Varias boquillas (Snapmaker U1: extruder, extruder1, extruder2, extruder3)
      const ext = ids.filter((id) => /^sensor\..*_extruder\d*_temperature$/.test(id))
        .map((id) => ({ id, n: +(id.match(/_extruder(\d*)_temperature$/)[1] || 0) })).sort((a, b) => a.n - b.n);
      if (ext.length) nozzles = ext.map(({ id, n }) => ({
        label: ext.length > 1 ? `T${n + 1}` : 'Boquilla', cur: id,
        tgt: ids.find((x) => x.endsWith(`_extruder${n || ''}_target`) && domain(x) === 'number'),
        fil: ids.find((x) => x.endsWith(`_e${n}_filament`)),
      }));
    }
    // Enchufe de la impresora: config.printerPlugs o un switch que acabe en su nombre ("…_bambu_p1s")
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
  return (printersCache = list.sort((a, b) => a.name.localeCompare(b.name, 'es')));
}
const pState = (p) => (p.e.plug && S.states[p.e.plug] && S.states[p.e.plug].state === 'off') ? 'off'
  : PSTATUS[(S.states[p.e.status] || { state: 'unavailable' }).state] || 'idle';
const pActive = (p) => ACTIVE_P.includes(pState(p));
function confirmBtn(ic, label, fn, ask = '¿Seguro? Toca otra vez') {
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

/** Si cambia el estado de una impresora: avisa al terminar y repinta (aparece/desaparece en Inicio). */
function onPrinterStatus(id, old, st) {
  const p = printers().find((x) => x.e.status === id);
  if (!p) return;
  const was = PSTATUS[old ? old.state : 'unavailable'], now = PSTATUS[st ? st.state : 'unavailable'];
  if (was === now) return;
  if (ACTIVE_P.includes(was) && now === 'finished') toast(`${p.name}: impresión terminada`);
  if (ACTIVE_P.includes(was) && now === 'error') toast(`${p.name}: error en la impresión`, true);
  clearTimeout(structTimer);
  structTimer = setTimeout(() => !S.sheetId && render(), 300);
}

function weatherCard(id, days = 5) {
  const now = h('div', { class: 'w-now' }), fc = h('div', { class: 'w-fc' });
  bind('view', id, (st) => {
    if (!st) return;
    const a = st.attributes;
    const extra = [a.humidity != null ? `Humedad ${fmtNum(a.humidity)} %` : null,
      a.wind_speed != null ? `Viento ${fmtNum(a.wind_speed)} ${a.wind_speed_unit || ''}` : null].filter(Boolean).join(' · ');
    now.replaceChildren(icon(wIcon(st.state), 'w-icon'), h('div', null,
      h('div', { class: 'w-temp' }, fmtNum(a.temperature) + '°'), h('div', { class: 'w-cond' }, wText(st.state)), h('div', { class: 'muted small' }, extra)));
  });
  if (days > 0) getForecast(id).then((f) => fc.replaceChildren(...f.slice(0, days).map((d) => h('div', { class: 'fc-day' },
    h('div', { class: 'fc-name' }, new Date(d.datetime).toLocaleDateString(I18N.locale(), { weekday: 'short' }).replace('.', '')),
    icon(wIcon(d.condition)), h('div', { class: 'fc-t' }, fmtNum(d.temperature) + '°'),
    // Probabilidad de lluvia siempre visible (también 0 %); vacía solo si la integración no la da
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
    title: d.title || 'Aviso',
    message: d.message || '',
    level,
    icon: mdi(d.icon) || (level === 'critical' ? 'mdi-alert' : 'mdi-bell-ring'),
    image: d.image || null,
    timeout: Number(d.timeout ?? def) || 0,
    sound: d.sound ?? level !== 'info',
    actions: (d.actions || []).map((x) => ({
      title: x.title || 'OK', icon: mdi(x.icon), service: x.service,
      entity: x.entity_id, data: x.data || {}, confirm: !!x.confirm, style: x.style || '',
    })),
    at: new Date(),
  };
}

const alertOpen = () => !!(typeof RING !== 'undefined' && RING.active) || N.queue.some((n) => n.level !== 'info');

function onNotif(ev) {
  const n = normNotif(ev.data);
  N.queue = N.queue.filter((x) => x.id !== n.id);       // mismo id = lo sustituye (p. ej. vuelven a llamar)
  N.queue.unshift(n);
  N.history = [n, ...N.history.filter((x) => x.id !== n.id || x.at !== n.at)].slice(0, 30);
  N.unread++;
  renderBell();
  if (n.level !== 'info') {                            // despierta la pantalla
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
  const acts = top.actions.length ? top.actions : [{ title: 'Entendido', icon: 'mdi-check' }];
  parts.push(h('div', { class: 'alert-actions' }, acts.map((a, i) => {
    const run = () => runNotifAction(top, a);
    const cls = 'big-action ' + (a.style === 'danger' ? 'danger' : (a.style === 'primary' || i === 0) ? 'primary' : '');
    if (a.confirm) { const b = confirmBtn(a.icon || 'mdi-check', a.title, run); b.className = cls; return b; }
    return h('button', { class: cls, onclick: run }, a.icon ? icon(a.icon) : null, a.title);
  })));
  const more = N.queue.filter((n) => n.level !== 'info').length - 1;
  if (more > 0) parts.push(h('div', { class: 'alert-more' }, `+${more} aviso${more > 1 ? 's' : ''} más`));
  card.replaceChildren(...parts);
  modal.classList.remove('hidden');
}

/** Vuelve a abrir un aviso del historial, en grande y sin sonido, hasta que se cierre. */
function reopenNotif(n) {
  const c = { ...n, level: n.level === 'info' ? 'warning' : n.level, timeout: 0, sound: false };
  N.queue = [c, ...N.queue.filter((x) => x.id !== c.id)];
  showNotif();
}
async function runNotifAction(n, a) {
  if (a.service) {
    const [dom, svc] = String(a.service).split('.');
    const r = await call(dom, svc, a.data, a.entity);
    if (r === null) return;                          // falló: el aviso sigue abierto para reintentar
    toast(`${a.title} ✓`);
  }
  conn.send({ type: 'fire_event', event_type: 'panel_notification_action', event_data: { id: n.id, action: a.title } }).catch(() => {});
  closeNotif(n.id, true);
}

/* Campana con el historial de avisos */
function renderBell() {
  const b = $('#bell');
  b.classList.toggle('hidden', !N.history.length);
  $('#bell-count').textContent = N.unread > 0 ? N.unread : '';
  refreshBubbles();   // la burbuja de Avisos sale o se va al momento
}
/** Vuelve a pintar las burbujas (las que dependen del panel, no de Home Assistant, como la de Avisos). */
function refreshBubbles() {
  try {
    COMPILED.forEach((m) => (m.cache = {}));
    renderAmbientChips();
    if (!S.sheetId) VIEW_CODE.forEach((v) => v && v.paint());
  } catch (e) { /* aún arrancando */ }
}

/* Sonidos generados con Web Audio (no hacen falta archivos) */
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
  } catch (e) { /* sin audio */ }
}
function playSound(level) {
  stopSound();
  if (!SET.sound.enabled) return;
  if (level === 'critical') {                          // pitido insistente hasta que lo cierres
    const beep = () => tone([880, 660, 880, 660], 0.18);
    beep(); N.soundTimer = setInterval(beep, 1500);
  } else if (level === 'warning') {                    // "ding-dong" cada 6 s durante 30 s
    const dd = () => tone([784, 622], 0.5);
    dd(); N.soundTimer = setInterval(dd, 6000);
    N.soundStop = setTimeout(stopSound, 30000);
  } else tone([988], 0.15);
}
function stopSound() { clearInterval(N.soundTimer); clearTimeout(N.soundStop); N.soundTimer = null; }

/* ====================== Ajustes (se guardan en Home Assistant) ======================
 * En la Pi se guardan en el ayudante (panel-helper.py), así sobreviven a reinicios aunque Chromium vaya
 * en modo incógnito. Sin ayudante, en el navegador. El panel no escribe nada en Home Assistant. */
const SETTINGS_KEY = 'panel_hogar_ajustes';
const DEFAULTS = () => ({
  idleSeconds: CFG.idleSeconds,            // segundos sin tocar hasta el modo ambiente (0 = nunca)
  screenOffMinutes: 0,                     // minutos en ambiente hasta apagar la pantalla (0 = nunca)
  brightness: 100,                         // brillo de día (%)
  night: {
    enabled: !!(CFG.night && CFG.night.dim), start: (CFG.night && CFG.night.start) || '23:00',
    end: (CFG.night && CFG.night.end) || '07:00', brightness: Math.round((1 - ((CFG.night && CFG.night.dim) ?? 0.6)) * 100),
    screenOff: false,                      // apagar la pantalla de noche cuando no se usa
  },
  language: 'auto',     // auto (el de Home Assistant) | es | en
  theme: 'oscuro',      // oscuro | claro | auto (claro de día y oscuro de noche)
  accent: 'azul',       // color de acento (ACCENTS)
  sound: { enabled: true, volume: 70 },
  photos: { enabled: true, seconds: CFG.photoSeconds || 30, fit: 'blur' },   // fit: cover | blur | contain
  alarms: [],
  ambientChips: null,   // null = orden y selección por defecto
  voiceSatellite: '',   // assist_satellite cuya voz se muestra encima de la pantalla ('' = ninguno)
  voiceStyle: 'onda',   // animación de la barra de voz: onda | micro | luz | eq
  defaultSpeaker: '',   // (de antes) el primero de ambientSpeakers
  ambientSpeakers: null,   // altavoces del modo ambiente por prioridad ('@panel' = el de este panel); null = [defaultSpeaker]
  quick: [],            // accesos rápidos (entity_id)
  bullets: null,        // burbujas (integradas y de script); null = las de siempre
  tabs: null,           // pestañas con sus tarjetas; null = una por cada vista
});
let SET = DEFAULTS();
const mergeSettings = (saved = {}) => {
  const d = DEFAULTS();
  return { ...d, ...saved, night: { ...d.night, ...(saved.night || {}) }, sound: { ...d.sound, ...(saved.sound || {}) },
    photos: { ...d.photos, ...(saved.photos || {}) } };
};
async function loadSettings() {
  let saved = null;
  const helper = window.PANEL_HELPER;
  if (helper && helper.ajustes && Object.keys(helper.ajustes).length) saved = helper.ajustes;   // los de la web
  else {
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      // Ajustes de versiones anteriores, guardados en Home Assistant: solo se leen (nunca se escriben)
      if (!saved) saved = (await conn.send({ type: 'frontend/get_user_data', key: SETTINGS_KEY }) || {}).value;
    } catch (e) { /* sin ajustes guardados: valores por defecto */ }
  }
  SET = mergeSettings(saved || {});
  setLanguage();
  applySettings();
}
let saveTimer;
function saveSettings(quiet) {   // quiet: sin el aviso «Ajustes guardados»
  applySettings();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (window.PANEL_HELPER) {        // en la Pi: se guardan en el ayudante (así la web los ve)
        const r = await fetch(HELPER + '/ajustes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SET) });
        const j = await r.json(); REMOTE.version = j.version;
      } else {                          // sin ayudante: en este navegador (nunca se escribe nada en Home Assistant)
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); } catch (e) { /* sin almacenamiento */ }
      }
      if (!quiet) toast('Ajustes guardados');
    } catch (e) { toast('No se pudieron guardar: ' + e.message, true); }
  }, 600);
}
function applySettings() { setLanguage(); applyTheme(); resetIdle(); screenTick(); try { COMPILED.forEach((m) => (m.cache = {})); } catch (e) { /* aún no cargado */ } }

/** Tema claro u oscuro. «auto»: claro mientras el sol está arriba (sun.sun) o, sin él, de 8:00 a 20:00. */
/* Idioma de los textos (translations/). «Automático»: el de Home Assistant (o, sin conexión, el del navegador). */
let HA_LANG = null;
function setLanguage() {
  const want = I18N.resolve(SET.language, HA_LANG || navigator.language);
  if (want === I18N.lang) return;
  I18N.set(want);
  try { renderRail(); render(); } catch (e) { /* aún arrancando */ }
}
I18N.set(I18N.resolve(((window.PANEL_HELPER || {}).ajustes || {}).language, navigator.language));

function themeIsLight() {
  if (SET.theme === 'claro') return true;
  if (SET.theme !== 'auto') return false;
  const sun = S.states['sun.sun'];
  if (sun && sun.state !== 'unavailable') return sun.state === 'above_horizon';
  const hr = new Date().getHours();
  return hr >= 8 && hr < 20;
}
/* Colores de acento: [nombre, en oscuro (color, letra encima, fondo suave), en claro (lo mismo)] */
const ACCENTS = {
  azul:     ['Azul',     ['#8ab4f8', '#0b1d3a', '#1d3354'], ['#1a66d6', '#ffffff', '#d5e3fa']],
  turquesa: ['Turquesa', ['#78d9ec', '#00363f', '#1b3d45'], ['#00838f', '#ffffff', '#d0f0f3']],
  verde:    ['Verde',    ['#81c995', '#0d2a17', '#1f3b2a'], ['#1e8e3e', '#ffffff', '#d6f0dd']],
  amarillo: ['Amarillo', ['#fdd663', '#3b2a06', '#4a3f1a'], ['#b58100', '#ffffff', '#fdf0c8']],
  naranja:  ['Naranja',  ['#fcad70', '#3d1c00', '#4a3020'], ['#d96a00', '#ffffff', '#ffe5cc']],
  rosa:     ['Rosa',     ['#ff8bcb', '#4a0a2c', '#4a2238'], ['#c2185b', '#ffffff', '#fbdbe8']],
  morado:   ['Morado',   ['#c58af9', '#2a0a47', '#3a2554'], ['#8430ce', '#ffffff', '#ecdcfb']],
};
let accentApplied = '';
function applyTheme() {
  const light = themeIsLight();
  const name = ACCENTS[SET.accent] ? SET.accent : 'azul', key = name + (light ? ':claro' : ':oscuro');
  if (key !== accentApplied) {
    accentApplied = key;
    const [c, ink, soft] = ACCENTS[name][light ? 2 : 1], st = document.documentElement.style;
    st.setProperty('--accent', c); st.setProperty('--accent-ink', ink); st.setProperty('--accent-soft', soft);
  }
  if (document.documentElement.classList.contains('light') === light) return;
  document.documentElement.classList.toggle('light', light);
  try { if (!photosOn()) nextBackground(); } catch (e) { /* aún arrancando */ }   // el fondo sin fotos del modo ambiente cambia con el tema
}

/** Círculos para elegir el color de acento (se ven en el tono del tema actual). */
function accentPicker() {
  const wrap = h('div', { class: 'accents' });
  const paint = () => wrap.replaceChildren(...Object.entries(ACCENTS).map(([k, [label, dark, light]]) => {
    const [c, ink] = themeIsLight() ? light : dark, on = (SET.accent || 'azul') === k;
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

/* ---------- Brillo y apagado de pantalla ----------
 * Con el ayudante de la Pi (panel-helper.py en 127.0.0.1:8766) se cambia el brillo real y se apaga
 * la pantalla de verdad. Sin él, se oscurece con una capa negra (funciona en cualquier pantalla). */
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
  else if (S.entered) enterScreen();   // se enciende la pantalla
}
/** Decide brillo y apagado: se llama cada 5 s, al tocar, al cambiar ajustes y al llegar un aviso. */
function screenTick() {
  applyTheme();
  const night = isNight(), alert = alertOpen();
  const idle = (Date.now() - SCREEN.lastTouch) / 1000;
  let off = false;
  if (!alert && !npPlaying()) {
    if (SET.screenOffMinutes > 0 && idle >= Math.max(0, SET.idleSeconds) + SET.screenOffMinutes * 60) off = true;
    if (night && SET.night.screenOff && idle >= Math.max(60, SET.idleSeconds)) off = true;
  }
  if (SCREEN.forcedOff && !alert) off = true;   // apagada a mano (botón o Home Assistant): hasta tocarla o un aviso
  setScreenOff(off);
  setBrightness(alert ? 100 : night ? SET.night.brightness : SET.brightness);
  reportState();
}
/** Apagar la pantalla ya (botón, mando a distancia o Home Assistant): sigue apagada hasta que la toquen. */
function screenOffNow() { SCREEN.lastTouch = 0; SCREEN.forcedOff = true; screenTick(); }
function wakeScreen() { SCREEN.lastTouch = Date.now(); SCREEN.forcedOff = false; screenTick(); }
/** Al arrancar o al encenderse la pantalla: si suena algo, «Sonando»; si no, el modo ambiente. */
function enterScreen() {
  if (alertOpen()) return;
  const playing = watchedSpeakers().find((x) => (S.states[x] || {}).state === 'playing');
  if (playing) {
    if (NP.id === playing) return;
    showAmbient();             // así la ✕ de «Sonando» vuelve al modo ambiente
    showNowPlaying(playing);
  } else {
    npToAmbient(true);
  }
}

/* ---------- Controles de la vista Ajustes ---------- */
/** Desplegable táctil: enseña la opción elegida y, al tocarla, abre la lista. options: [[valor, nombre, icono, subtítulo]] */
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

/* ---------- Red y configuración desde el móvil ---------- */
async function fetchNet() {
  try { return await (await fetch(HELPER + '/red', { cache: 'no-store' })).json(); } catch (e) { return null; }
}
function qrSvg(text) {
  if (typeof qrcode !== 'function') return null;
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}
/** Hoja con el QR de la web de configuración y la dirección escrita, para abrirla con el móvil. */
async function openConfigQR() {
  closeSheet();
  const net = await fetchNet();
  const body = h('div', { class: 'sheet-body qr-body' });
  if (!net) {
    body.append(h('div', { class: 'muted' }, 'La configuración desde el móvil funciona en la Raspberry Pi, con el ayudante (panel-helper.py) en marcha.'));
  } else {
    const url = net.urls[0];
    const svg = qrSvg(url);
    body.append(
      svg ? h('div', { class: 'qr', html: svg }) : null,
      h('div', { class: 'qr-url' }, url),
      h('div', { class: 'muted small' }, 'También: ' + net.urls.slice(1).join(' · ')),
      h('div', { class: 'qr-steps' },
        h('div', null, icon('mdi-numeric-1-circle'), 'Escanea el código con la cámara del móvil (conectado a la misma WiFi)'),
        h('div', null, icon('mdi-numeric-2-circle'), 'Entra con la contraseña que pusiste al instalar el panel'),
        h('div', null, icon('mdi-numeric-3-circle'), 'Cambia lo que quieras y pulsa Guardar: el panel se actualiza solo')));
  }
  $('#sheet-card').replaceChildren(
    h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }, icon('mdi-qrcode')), h('div', { class: 'sheet-title' }, 'Configurar desde el móvil'),
      h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close'))), body);
  $('#sheet').classList.remove('hidden');
  S.sheetId = 'qr';
}
function netCard() {
  const rows = h('div', { class: 'set-net' }, h('div', { class: 'muted small' }, 'Leyendo la red…'));
  fetchNet().then((net) => {
    if (!net) { rows.replaceChildren(h('div', { class: 'muted small' }, 'Disponible en la Raspberry Pi (con el ayudante panel-helper.py).')); return; }
    const r = (label, val) => setRow(label, null, h('span', { class: 'net-val' }, val));
    rows.replaceChildren(...[
      r('Nombre', net.hostname),
      r('IP', net.ip + (net.ipv4 ? (net.ipv4.method === 'manual' ? ' · fija' : ' · automática') : '')),
      net.wifi ? r('WiFi', `${net.wifi.ssid} · ${net.wifi.signal} %`) : net.connection ? r('Conexión', net.connection.type === 'ethernet' ? 'Cable de red' : net.connection.name) : null,
      r('Web de configuración', net.urls[0]),
      net.simulated ? h('div', { class: 'muted small' }, '🧪 Red simulada (modo pruebas en el ordenador)') : null].filter(Boolean));
  });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-wifi'), 'Red y configuración desde el móvil'),
    rows,
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action primary', onclick: openConfigQR }, icon('mdi-qrcode'), 'Configurar desde el móvil')),
    h('div', { class: 'muted small' }, 'La WiFi, la IP y el nombre de la Pi se cambian desde esa web, en el apartado «Red de la Pi».'));
}

/* ---------- Actualizaciones (las hace el ayudante con git; también desde la web) ---------- */
async function updApi(body) {
  const r = await fetch(HELPER + '/actualizaciones', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return body ? d.info : d;
}
function updatesCard() {
  const body = h('div', { class: 'set-body' }, h('div', { class: 'muted small' }, 'Leyendo…'));   // sus filas van como las del resto de tarjetas
  let timer = null;
  const fill = (u) => {
    clearTimeout(timer);
    if (!u) { body.replaceChildren(h('div', { class: 'muted small' }, 'Disponible en la Raspberry Pi (con el ayudante panel-helper.py).')); return; }
    const n = u.available.length;
    const estado = u.applying ? 'Actualizando…' : u.checking ? 'Comprobando…' : n ? `${n} novedad${n > 1 ? 'es' : ''}` : 'Al día';
    const val = (t) => h('span', { class: 'net-val', style: 'white-space: nowrap' }, t);
    let hour = u.settings.hour;
    const hourLab = h('span', { class: 'time-val' }, String(hour).padStart(2, '0') + ':00');
    const stepHour = (d) => {
      hour = (hour + d + 24) % 24; hourLab.textContent = String(hour).padStart(2, '0') + ':00';
      updApi({ accion: 'ajustes', hour }).catch((e) => toast(e.message, true));
    };
    body.replaceChildren(...[
      setRow('Versión', u.current ? u.current.subject : null, val(u.current ? u.current.hash : '¿?')),
      setRow('Estado', u.error || null, h('span', { class: 'pill' + (n || u.error ? '' : ' ok') }, estado)),
      n ? h('div', { class: 'upd-list muted small' }, ...u.available.slice(0, 6).map((c) => h('div', null, '• ' + c.subject))) : null,
      setBlock('Cuando haya una versión nueva', u.settings.mode === 'auto' ? 'Se actualiza sola cada día a esa hora (el panel se reinicia unos segundos)' : 'Te avisa y actualizas con el botón',
        segmented([['avisar', 'Avisarme'], ['auto', 'Automático']], u.settings.mode,
          (v) => updApi({ accion: 'ajustes', mode: v }).then(fill).catch((e) => toast(e.message, true)))),
      u.settings.mode === 'auto' ? setRow('Hora', null, h('div', { class: 'stepper' },
        h('button', { class: 'round-btn', onclick: () => stepHour(-1) }, icon('mdi-minus')), hourLab,
        h('button', { class: 'round-btn', onclick: () => stepHour(1) }, icon('mdi-plus')))) : null,
      !u.sudo ? h('div', { class: 'muted small' }, 'Para instalar paquetes nuevos sin pedir contraseña, lanza una vez scripts/setup-kiosk.sh en la Pi.') : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => { toast('Comprobando…'); updApi({ accion: 'comprobar' }).then((i) => { fill(i); toast(i.error ? i.error : i.available.length ? 'Hay una versión nueva' : 'Ya está al día ✓', !!i.error); }).catch((e) => toast(e.message, true)); } },
          icon('mdi-cloud-search'), 'Comprobar'),
        n && !u.applying ? h('button', { class: 'big-action primary', onclick: () => { toast('Actualizando… el panel se reiniciará solo'); updApi({ accion: 'actualizar' }).then(fill).catch((e) => toast(e.message, true)); } },
          icon('mdi-download'), 'Actualizar ahora') : null),
      u.simulated ? h('div', { class: 'muted small' }, '🧪 En el ordenador no se actualiza de verdad') : null].filter(Boolean));
    if (u.applying || u.checking) timer = setTimeout(() => updApi().then(fill).catch(() => {}), 2000);
  };
  updApi().then(fill).catch(() => fill(null));
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-update'), 'Actualizaciones'), body);
}

function renderSettings() {
  const pct = (v) => v + ' %';
  const bright = slider({ min: 5, max: 100, step: 5, label: 'Brillo', fmt: pct, onchange: (v) => { SET.brightness = v; saveSettings(); } });
  bright.set(SET.brightness);
  const nightBright = slider({ min: 5, max: 100, step: 5, label: 'Brillo de noche', fmt: pct, onchange: (v) => { SET.night.brightness = v; saveSettings(); } });
  nightBright.set(SET.night.brightness);

  const hw = SCREEN.helper;
  const helperText = !hw ? 'No detectado: el brillo y el apagado se hacen oscureciendo la imagen'
    : hw.simulated ? 'Simulado en el ordenador: se oscurece la imagen y no se toca el hardware'
    : hw.backlight ? 'Brillo real y apagado de la pantalla' : hw.power ? 'Apagado real de la pantalla; brillo por software' : 'Detectado, pero esta pantalla no se puede controlar';

  return [h('div', { class: 'settings' },
    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-monitor'), 'Pantalla'),
      bright,
      setBlock('Idioma', null, segmented([['auto', 'Automático'], ...Object.entries(I18N.langs)], SET.language || 'auto',
        (v) => { SET.language = v; saveSettings(); })),
      setBlock('Tema', 'Automático: claro de día y oscuro de noche (con la salida y la puesta del sol)',
        segmented([['oscuro', 'Oscuro'], ['claro', 'Claro'], ['auto', 'Automático']], SET.theme || 'oscuro', (v) => { SET.theme = v; saveSettings(); if (accentPicker.paint) accentPicker.paint(); })),   // los círculos, en el tono del tema
      setBlock('Color', 'El de los botones, las barras y la burbuja del volumen', accentPicker()),
      setBlock('Modo ambiente', 'Tiempo sin tocar la pantalla hasta mostrar el reloj',
        segmented([[0, 'Nunca'], [30, '30 s'], [60, '1 min'], [90, '1,5 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']],
          SET.idleSeconds, (v) => { SET.idleSeconds = v; saveSettings(); })),
      setBlock('Apagar la pantalla', 'Tiempo en modo ambiente hasta apagarla. Se enciende al tocarla o si llega un aviso',
        segmented([[0, 'Nunca'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h']],
          SET.screenOffMinutes, (v) => { SET.screenOffMinutes = v; saveSettings(); })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), 'Modo ambiente'),
        h('button', { class: 'big-action', onclick: () => { screenOffNow(); } }, icon('mdi-monitor-off'), 'Apagar ahora'))),

    soundCard(),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-image-multiple'), 'Fotos del modo ambiente'),
      setRow('Mostrar fotos',
        PHOTOS.length ? `${PHOTOS.length} fotos cargadas` : photoSources().length ? 'No se han podido cargar las fotos' : 'Añade fuentes de fotos desde la web de configuración',
        switchBtn(SET.photos.enabled, (v) => { SET.photos.enabled = v; saveSettings(); nextBackground(); })),
      setBlock('Cómo se ve la foto (por defecto)', 'Cada fuente puede tener el suyo en la web de configuración. Entera + difuminado: sin recortar, con la misma foto desenfocada detrás',
        segmented([['cover', 'Rellenar'], ['blur', 'Entera + difuminado'], ['contain', 'Entera']],
          SET.photos.fit || 'blur', (v) => { SET.photos.fit = v; saveSettings(); refitPhotos(); })),
      setBlock('Cambiar de foto cada', null,
        segmented([[15, '15 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min']],
          SET.photos.seconds, (v) => { SET.photos.seconds = v; saveSettings(); nextBackground(); })),
      ...PHOTO_STATS.map((st) => setRow(st.label, st.error ? 'Error: ' + st.error : null,
        h('span', { class: 'pill' + (st.error ? '' : ' ok') }, st.error ? 'Error' : `${st.count} fotos`))),
      photoSources().length ? h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: async () => { toast('Recargando fotos…'); await loadPhotos(); render(); } }, icon('mdi-image-refresh'), 'Recargar álbum'),
        h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), 'Ver ahora')) : null),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-weather-night'), 'Modo noche'),
      setRow('Activado', 'Baja el brillo por la noche', switchBtn(SET.night.enabled, (v) => { SET.night.enabled = v; saveSettings(); })),
      setRow('Desde', null, timeStepper(SET.night.start, (v) => { SET.night.start = v; saveSettings(); })),
      setRow('Hasta', null, timeStepper(SET.night.end, (v) => { SET.night.end = v; saveSettings(); })),
      nightBright,
      setRow('Apagar la pantalla de noche', 'Si no la estás usando (al minuto de dejar de tocarla)',
        switchBtn(SET.night.screenOff, (v) => { SET.night.screenOff = v; saveSettings(); }))),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-bell-ring'), 'Avisos'),
      setRow('Sonido', 'Ding-dong en los avisos y pitido en los críticos (su volumen, en Sonido)', switchBtn(SET.sound.enabled, (v) => { SET.sound.enabled = v; saveSettings(); })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => onNotif({ data: { id: 'prueba_ajustes', title: 'Aviso de prueba', message: 'Así se ven los avisos que lances desde Home Assistant', level: 'warning', icon: 'mdi:bell-ring', timeout: 15 } }) },
          icon('mdi-bell-badge'), 'Probar aviso'))),

    alarmsCard(),

    bulletsCard(),

    speakerCard(),

    voiceCard(),

    netCard(),

    updatesCard(),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-information-outline'), 'Panel'),
      setRow('Home Assistant', CFG.haUrl,
        h('span', { class: 'pill' + (S.connected ? ' ok' : '') }, S.connected ? 'Conectado' : 'Desconectado')),
      setRow('Control de pantalla', helperText, h('span', { class: 'pill' + (hw ? ' ok' : '') }, hw ? (hw.simulated ? 'Simulado' : 'Ayudante') : 'Software')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => location.reload() }, icon('mdi-refresh'), 'Recargar panel'))))];
}

/* ====================== Alarmas (despertador) ======================
 * Son del propio panel: se guardan en los Ajustes (SET.alarms) y suenan en la pantalla. No se lee nada del móvil.
 * Días: 0 = lunes … 6 = domingo. Sin días = suena una vez y se desactiva. */
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
  const day = d.toDateString() === now.toDateString() ? 'Hoy' : d.toDateString() === tom.toDateString() ? 'Mañana'
    : cap(d.toLocaleDateString(I18N.locale(), { weekday: 'long' }));
  return `${day} ${hhmm(d)}`;
}
function daysText(days) {
  const s = [...(days || [])].sort().join('');
  if (!s) return 'Una vez';
  if (s === '0123456') return 'Todos los días';
  if (s === '01234') return 'De lunes a viernes';
  if (s === '56') return 'Fines de semana';
  return [...days].sort().map((i) => DAY_LETTERS[i]).join(' ');
}
/** La próxima alarma de las próximas 24 h, para Inicio y el modo ambiente. */

/* ---------- Que suene ---------- */
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
    h('div', { class: 'ring-label' }, al.name || 'Alarma'),
    h('div', { class: 'ring-actions' },
      h('button', { class: 'big-action', onclick: () => stopAlarm(true) }, icon('mdi-sleep'), 'Posponer 9 min'),
      h('button', { class: 'big-action primary', onclick: () => stopAlarm(false) }, icon('mdi-alarm-off'), 'Parar'))));
  $('#ring').classList.remove('hidden');
  // Melodía que va subiendo de volumen durante el primer minuto
  const play = () => {
    const ramp = Math.min(1, 0.35 + (Date.now() - RING.started) / 60000);
    const vol = Math.max(SET.sound.volume, 60) / 100 * ramp;
    tone([523, 659, 784, 1047], 0.2, vol);
    time.textContent = hhmm(new Date());
  };
  play();
  RING.timer = setInterval(play, 2200);
  RING.stop = setTimeout(() => stopAlarm(false), 10 * 60e3);     // como mucho 10 minutos sonando
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
  } else if (!al.days || !al.days.length) {               // una sola vez: se desactiva
    al.enabled = false;
    saveSettings();
  }
  SCREEN.lastTouch = Date.now();
  resetIdle();
  screenTick();
  if (S.view === 'settings') render();
}

/* ---------- Editor de alarmas ---------- */
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
  const presets = h('div', { class: 'chips', style: 'justify-content:center' }, [['Diario', [0, 1, 2, 3, 4, 5, 6]], ['L a V', [0, 1, 2, 3, 4]], ['Finde', [5, 6]], ['Una vez', []]]
    .map(([label, d]) => h('button', { class: 'chip', onclick: () => {
      al.days = [...d];
      days.querySelectorAll('.day-btn').forEach((b, i) => b.classList.toggle('on', d.includes(i)));
      hint.textContent = daysText(al.days);
    } }, label)));
  const names = ['Alarma', 'Despertador', 'Trabajo', 'Siesta', 'Medicinas'];
  const nameRow = h('div', { class: 'chips', style: 'justify-content:center' }, names.map((n) => {
    const c = h('button', { class: 'chip' + ((al.name || 'Alarma') === n ? ' sel' : '') }, n);
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
    if (n) toast(`Sonará ${whenText(n).toLowerCase()}`);
  };
  const del = () => { SET.alarms = (SET.alarms || []).filter((x) => x.id !== al.id); saveSettings(); closeSheet(); render(); toast('Alarma borrada'); };
  paint();
  $('#sheet-card').replaceChildren(
    h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }, icon('mdi-alarm')), h('div', { class: 'sheet-title' }, existing ? 'Editar alarma' : 'Nueva alarma'),
      h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close'))),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'alarm-editor' },
        h('div', { class: 'alarm-col' }, rb('mdi-chevron-up', () => step(1, 0)), rb('mdi-chevron-down', () => step(-1, 0))),
        timeEl,
        h('div', { class: 'alarm-col' }, rb('mdi-chevron-up', () => step(0, 5)), rb('mdi-chevron-down', () => step(0, -5)))),
      days, hint, presets, nameRow,
      h('div', { class: 'btn-row' }, existing ? h('button', { class: 'big-action danger-soft', onclick: del }, icon('mdi-delete'), 'Borrar') : null,
        h('button', { class: 'big-action primary', onclick: save }, icon('mdi-check'), 'Guardar'))));
  $('#sheet').classList.remove('hidden');
  S.sheetId = 'alarma';
}

/** Tarjeta de Ajustes con las alarmas del panel. */
function alarmsCard() {
  const list = (SET.alarms || []).map((al) => {
    const next = al.enabled ? nextOccurrence(al) : null;
    const row = h('div', { class: 'alarm-row' + (al.enabled ? '' : ' off') },
      h('div', { class: 'alarm-row-time' }, al.time),
      h('div', { class: 'alarm-row-text' }, h('div', null, al.name || 'Alarma'),
        h('div', { class: 'muted small' }, daysText(al.days) + (next ? ' · ' + whenText(next).toLowerCase() : ''))),
      switchBtn(al.enabled, (v) => { al.enabled = v; delete RING.snooze[al.id]; saveSettings(); render(); }));
    row.firstChild.addEventListener('click', () => openAlarmEditor(al));
    row.children[1].addEventListener('click', () => openAlarmEditor(al));
    return row;
  });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-alarm'), 'Alarmas'),
    list.length ? list : h('div', { class: 'muted small' }, 'No hay alarmas. El panel encenderá la pantalla y sonará a la hora que elijas.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action primary', onclick: () => openAlarmEditor(null) }, icon('mdi-alarm-plus'), 'Añadir alarma')));
}

/* ====================== Navegación y renderizado ====================== */
/* ====================== Pestañas ====================== */
const PM = window.PanelModulos;
const tabs = () => PM.tabList(SET.tabs);
const tabViews = (t) => (t.cards || []).filter((c) => c.type === 'view').map((c) => c.view);
/** Una pestaña que solo tiene vistas que no aplican (p. ej. Patinete sin patinete) no sale. */
const tabVisible = (t) => {
  const v = tabViews(t);
  return !v.length || v.length < (t.cards || []).length || v.some((k) => !VIEW_VISIBLE[k] || VIEW_VISIBLE[k]());
};
const visibleTabs = () => tabs().filter(tabVisible);
/** Pestaña para un destino: su id o la primera que contenga esa vista. */
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
    if (t.id === 'scooter' || tabViews(t).includes('scooter')) {          // mini rayo sobre el icono mientras el patinete carga
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
    h('button', { class: 'rail-btn', onclick: showAmbient }, icon('mdi-image-filter-hdr'), 'Ambiente'));
}

/** Contenido de una pestaña: una rejilla de 12 columnas; cada tarjeta ocupa su ancho (c.width). */
function renderTab(t) { return [layout(t.cards)]; }
/** Rejilla con tarjetas (también la de dentro de un componente Tarjeta). */
function layout(cards) {
  return h('div', { class: 'layout' }, (cards || []).map((c) => {
    let kids;
    try { kids = renderCard(c); } catch (e) { console.error(e); kids = [codeError(c.title || 'Tarjeta', e.message)]; }
    kids = [].concat(kids || []).filter(Boolean);
    if (!kids.length) return null;
    const slot = h('div', { class: 'slot w-' + String(c.width || 'full').replace('/', '-') }, kids);
    // «Mostrar solo si…»: se revisa al cambiar sus entidades y, si hay horas, modo noche o código, cada 20 s
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
  // Vista antigua (o pestaña de serie sin guardar): se monta al vuelo con los mismos componentes que pone la web
  if (c.type === 'view') {
    if (VIEW_VISIBLE[c.view] && !VIEW_VISIBLE[c.view]()) return [];
    return [layout(PM.viewCards(c.view, HA, { visible: compVisible, favorites: CFG.favorites || [] }))];
  }
  if (c.type === 'entities') return [title, h('div', { class: 'grid' }, (c.entities || []).filter((id) => S.states[id]).map(anyTile))];
  if (c.type === 'camera') return S.states[c.entity] ? [title, h('div', { class: 'cams' }, cameraImg(c.entity, 'view', CFG.cameraRefreshSeconds))] : [];
  if (c.type === 'component') return componentCard(c, title);
  if (c.type === 'bubbles') {
    const box = h('div', { class: 'chips' });
    const items = (c.items || []).filter((it) => it.script in MODULES).map((it) => ({ it, m: moduleOf(it.script) }));   // sin script (borrado): no sale
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
/* ====================== Componentes ======================
 * Cada componente colocado es una tarjeta { type: 'component', component: 'boton.js', width, config, cards? }.
 * Su script (type: 'card') dice sus campos, qué vigila, su HTML y su CSS; los valores de cada sitio van en config. */
/** Ejecuta la acción de pulsar / mantener pulsado sobre una entidad. */
function runAction(a, id, el) {
  a = PM.actionOf(a);
  if (!a || a.action === 'none') return;
  const target = a.entity || id;
  if (a.action === 'toggle') { if (target) tap(target, el); return; }
  if (a.action === 'more-info') { if (target) openSheet(target); return; }
  if (a.action === 'navigate') { if (a.go) go(a.go); return; }
  if (a.action === 'call') {
    const [d, sv] = String(a.service || '').split('.');
    if (!d || !sv) { toast('Acción sin servicio', true); return; }
    call(d, sv, a.data || {}, target);
  }
}
const hasAction = (a) => { a = PM.actionOf(a); return !!a && a.action !== 'none'; };
/** Un componente colocado: ejecuta su script (type: 'card') y pinta su HTML con su CSS (lib/componentes.js). */
function componentCard(c, title) {
  const name = c.component, m = moduleOf(name);
  if (m.err) return [title, codeError(name, m.err)];
  if (m.mod.type !== 'card') return [title, codeError(name, "no es un componente (le falta type: 'card')")];
  const host = h('div', { class: 'comp' });
  // Los de dentro (<slot>) se crean una vez y se quedan en su sitio en cada repintado
  const kids = m.mod.children ? layout(c.cards) : null;
  let bound = null;
  const paint = () => {
    try {
      bound = m.mod.bind(c.config, HA);
      PanelComp.render(host, name, m.mod, [HA, screenFor('card'), bound.cfg], {
        // Se engancha una vez; p.tap / p.hold se leen al pulsar (al repintar pueden cambiar).
        // Mantener pulsado nunca cuenta como pulsar: si no tiene acción al mantener, no hace nada
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
  // refresh: segundos → se repinta solo (horas, fechas…); los temporizadores se paran al cambiar de pestaña
  if (m.mod.refresh) S.viewTimers.push(setInterval(paint, Math.max(5, m.mod.refresh) * 1000));
  return [title, host];
}
/** Las fichas y tarjetas del panel que un componente pone con <ha-tile entity>, <ha-media>, <ha-printer device>… */
function componentWidget(e) {
  const t = e.tagName.toLowerCase(), id = e.getAttribute('entity'), has = id && S.states[id];
  const none = () => document.createTextNode('');
  if (t === 'ha-tile') return has ? tile(id) : none();
  if (t === 'ha-sensor') return has ? sensorTile(id) : none();
  if (t === 'ha-camera') {
    // Por dirección (src): una imagen que se recarga cada pocos segundos. Si no es una imagen (p. ej. la página
    // del reproductor de la cámara), se mete la página tal cual, como la tarjeta «página web» de Home Assistant
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
/** Al pulsar / mantener: una acción ('toggle', { action: 'navigate', go }…) o una función (ha, screen) */
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
/** Tarjetas y burbujas de la pestaña actual que se repintan al cambiar sus entidades. */
let VIEW_CODE = [], viewCodeTimer;
const VIEW_DIRTY = new Set();

/** Sin conexión configurada/** Sin conexión configurada: QR de la web de configuración (si hay ayudante) o instrucciones. */
async function showSetup() {
  $('#rail').replaceChildren();
  $('#view-title').textContent = I18N.t('Configurar el panel');
  const box = h('div', { class: 'setup' }, icon('mdi-home-assistant', 'setup-icon'), h('h2', null, 'Conecta el panel con Home Assistant'));
  $('#view').replaceChildren(box);
  const net = await fetchNet();
  const svg = net && qrSvg(net.urls[0]);
  if (net) {
    box.append(h('p', { class: 'muted' }, 'Escanea el código con el móvil (en la misma WiFi), entra con la contraseña del panel y pon la dirección de Home Assistant y un token de larga duración.'),
      svg ? h('div', { class: 'qr', html: svg }) : null, h('div', { class: 'qr-url' }, net.urls[0]));
  } else {
    box.append(h('p', { class: 'muted' }, 'Abre config.js y rellena haUrl (la dirección de tu Home Assistant) y token.'),
      h('p', { class: 'muted small' }, 'El token se crea en Home Assistant → tu perfil → Seguridad → Tokens de acceso de larga duración. ' +
        'Con el ayudante (panel-helper.py) en marcha también puedes configurarlo desde el móvil.'));
  }
  box.append(h('p', { class: 'muted small' }, net ? 'En cuanto lo guardes, el panel se pondrá en marcha solo.' : 'Después recarga el panel (o reinicia la Pi).'));
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

/* ====================== Asistente de voz ======================
 * Una barra abajo, encima de cualquier pantalla (Inicio, ambiente, «Sonando»…), mientras el satélite de Assist
 * elegido en Ajustes escucha, piensa o contesta. El texto (lo que has dicho y la respuesta) se lee de la
 * depuración de Assist en Home Assistant (solo lectura). También se puede mover desde fuera: panelVoice(fase, {heard, reply}). */
const VOICE = { stage: 'idle', heard: '', reply: '', hideT: null, run: null };
const VOICE_TEXT = { listening: 'Te escucho…', processing: 'Un momento…', responding: '', error: 'No te he entendido' };
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
    // deja leer la respuesta un rato y se va
    VOICE.hideT = setTimeout(() => box.classList.remove('show'), VOICE.reply || VOICE.heard ? 6000 : 400);
    return;
  }
  if (VOICE.stage === 'idle') { wakeScreen(); resetIdle(); }
  VOICE.stage = stage;
  const style = VOICE_STYLES.includes(SET.voiceStyle) ? SET.voiceStyle : 'onda';
  // Si ya estaba a la vista, el cambio de alto (p. ej. al llegar la respuesta) se anima en vez de saltar
  const wasShown = box.classList.contains('show'), oldH = wasShown ? box.getBoundingClientRect().height : 0;
  const oldText = (box.querySelector('.voice-text') || {}).textContent || '';
  box.className = `voice show ${stage} vs-${style}`;
  const text = h('div', { class: 'voice-text' },
    VOICE.heard ? h('div', { class: 'voice-heard' }, '«' + VOICE.heard + '»') : null,
    h('div', { class: 'voice-main' + (VOICE.reply ? '' : ' hint') }, VOICE.reply || VOICE_TEXT[stage] || ''));
  box.replaceChildren(voiceAnim(style), text);
  if (wasShown && text.textContent !== oldText) text.classList.add('fresh');      // el texto nuevo entra suave
  if (wasShown) {
    clearTimeout(VOICE.sizeT);
    box.style.height = '';
    const newH = box.getBoundingClientRect().height;
    if (Math.abs(newH - oldH) > 1) {
      box.style.height = oldH + 'px';
      void box.offsetHeight;                     // fija el alto viejo antes de animar
      box.style.height = newH + 'px';
      VOICE.sizeT = setTimeout(() => (box.style.height = ''), 450);
    }
  }
  if (stage === 'error') VOICE.hideT = setTimeout(() => panelVoice('idle'), 4000);
  if (style === 'onda') voiceWave();
}
window.panelVoice = panelVoice;
// Tocar la barra no debe tocar lo que hay debajo (luces, burbujas, el modo ambiente…)
['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'].forEach((t) => $('#voice').addEventListener(t, (e) => {
  e.stopPropagation();
  if (e.cancelable && t !== 'pointerdown') e.preventDefault();
}));
/** Animaciones de la barra (se eligen en Ajustes → Asistente de voz) */
const VOICE_STYLES = ['onda', 'micro', 'luz', 'eq'];
function voiceAnim(style) {
  if (style === 'micro') return h('div', { class: 'voice-anim' }, h('div', { class: 'voice-mic' },
    icon(VOICE.stage === 'responding' ? 'mdi-volume-high' : 'mdi-microphone')));
  if (style === 'luz') return h('div', { class: 'voice-light' });
  if (style === 'eq') return h('div', { class: 'voice-anim voice-eq' }, ...[0, .2, .4, .1, .3, .5, .15].map((d) => h('i', { style: `animation-delay:${d}s` })));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 56 44'); svg.setAttribute('class', 'voice-wave');
  svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  return h('div', { class: 'voice-anim' }, svg);
}
/** Onda: se dibuja mientras la barra está a la vista (más quieta al pensar, más viva al contestar) */
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
  // En cuanto entiende la frase, se busca el texto en la depuración de Assist
  if (stage === 'responding' || (stage === 'idle' && old && VOICE_STAGE[old.state])) voiceText();
}
/** Lo que se dijo y lo que contestó, de la última ejecución de Assist (assist_pipeline/pipeline_debug, solo lectura). */
async function voiceText() {
  const since = VOICE.run || 0;
  try {
    const sat = SET.voiceSatellite, dev = reg(sat).device_id;
    // el asistente que usa el satélite: su select «Asistente» ('preferred' = el preferido)
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
    if (VOICE.run !== since) return;           // ya empezó otra frase
    panelVoice(VOICE.stage === 'idle' ? 'responding' : VOICE.stage, { heard, reply });
    if (S.states[SET.voiceSatellite] && !VOICE_STAGE[S.states[SET.voiceSatellite].state]) panelVoice('idle');
  } catch (e) { console.warn('Texto de Assist:', e.message); }
}
/** Ajustes: qué satélite de voz se muestra en la pantalla. */
function voiceCard() {
  const sats = Object.keys(S.states).filter((id) => domain(id) === 'assist_satellite')
    .sort((x, y) => nameOf(x, false).localeCompare(nameOf(y, false), 'es'));
  const list = pickList([['', 'Ninguno', 'mdi-microphone-off', '']].concat(sats.map((id) => [id,
    (deviceOf(id) || {}).name_by_user || (deviceOf(id) || {}).name || nameOf(id, false), 'mdi-microphone-message',
    S.states[id].state === 'unavailable' ? 'No disponible' : (S.areaById[areaOf(id)] || {}).name || ''])),
    SET.voiceSatellite, (id) => { SET.voiceSatellite = id; saveSettings(); panelVoice('idle'); });
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-microphone'), 'Asistente de voz'),
    h('div', { class: 'muted small' }, sats.length
      ? 'Cuando le hables a este satélite de Assist, lo que dices y su respuesta salen abajo, encima de cualquier pantalla.'
      : 'No hay ningún satélite de Assist en Home Assistant (p. ej. un Home Assistant Voice).'), list,
    setBlock('Animación', null, segmented([['onda', 'Onda'], ['micro', 'Micrófono'], ['luz', 'Línea de luz'], ['eq', 'Ecualizador']],
      SET.voiceStyle || 'onda', (v) => { SET.voiceStyle = v; saveSettings(); voiceDemo(); })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'big-action', onclick: voiceDemo }, icon('mdi-play'), 'Ver cómo queda')),
    window.PANEL_HELPER ? voiceMicBlock() : null);
}
/** Todos los volúmenes juntos: el general (la salida de la Pi) y, dentro de él, cada cosa que suena. */
function soundCard() {
  const pct = (v) => v + ' %';
  const card = h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-volume-high'), 'Sonido'));
  const post = async (body) => {
    try {
      const r = await (await fetch(HELPER + '/sonido', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (r.error) throw new Error(r.error);
    } catch (e) { toast('No se pudo cambiar: ' + e.message); }
  };
  // El volumen principal es el de la música y lo multimedia (el altavoz del panel en Music Assistant).
  // Sin altavoz, el de la salida de la Pi.
  const music = speakerEntity();
  const main = h('div', { style: 'display:contents' });
  if (music && S.states[music]) {
    const m = slider({ min: 0, max: 100, step: 1, label: 'Volumen (música y multimedia)', fmt: pct,
      // cambiado desde aquí: no sale la barra flotante (ya lo estás viendo)
      onchange: (v) => { volMarkSent(v); call('media_player', 'volume_set', { volume_level: v / 100 }, music); } });
    // Sigue al volumen real: si se cambia en Music Assistant, se mueve aquí también
    bind('view', music, (st) => st && st.attributes.volume_level != null && m.set(Math.round(st.attributes.volume_level * 100)));
    main.append(m);
  }
  const avisos = slider({ min: 10, max: 100, step: 10, label: 'Avisos y alarmas', fmt: pct, onchange: (v) => { SET.sound.volume = v; saveSettings(); tone([784, 622], 0.4); } });
  avisos.set(SET.sound.volume);
  card.append(main, avisos);
  if (!window.PANEL_HELPER) return card;
  fetch(HELPER + '/sonido', { cache: 'no-store' }).then((r) => r.json()).then((r) => {
    if (!main.childNodes.length && r.master.available) {
      const m = slider({ min: 0, max: 100, step: 1, label: 'Volumen', fmt: pct, onchange: (v) => post({ master: v }) });
      m.set(r.master.value); main.append(m);
    }
    if (r.voice.installed) {
      const vv = slider({ min: 10, max: 100, step: 10, label: 'Respuestas del asistente de voz', fmt: pct, onchange: (v) => post({ voiceVolume: v }) });
      vv.set(r.voice.volume);
      card.append(vv);
    }
  }).catch(() => {});
  return card;
}
/** El micro de la propia Pi (servicio panel-voz): micro, por dónde contesta y palabra para despertarlo. */
function voiceMicBlock() {
  const box = h('div', null, h('div', { class: 'muted small' }, 'Cargando el micro de este panel…'));
  const save = async (patch) => {
    try {
      const r = await (await fetch(HELPER + '/voz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).json();
      if (r.error) throw new Error(r.error);
      toast(r.mensaje); paint(r.info);
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  };
  const paint = (r) => {
    const s = r.settings;
    const estado = !r.installed ? 'Sin instalar: bash ~/ha-panel/scripts/setup-voz.sh' : r.active ? 'Escuchando' : s.enabled ? 'No está funcionando (mira el registro en la web)' : 'Apagado';
    const opts = (list, ic) => list.map((o) => [o.id, o.name, ic, '']);
    box.replaceChildren(
      setBlock('Escuchar con el micro de este panel (beta)', estado, switchBtn(s.enabled, (v) => save({ enabled: v }))),
      setBlock('Micrófono', null, pickList(opts(r.inputs, 'mdi-microphone'), s.mic, (v) => save({ mic: v }))),
      setBlock('Por dónde contesta', null, pickList(opts(r.outputs, 'mdi-speaker'), s.output, (v) => save({ output: v }))),
      setBlock('Palabra para despertarlo', null, segmented(r.wakeWords.map((w) => [w.id, w.name]), s.wake, (v) => save({ wake: v }))));
  };
  fetch(HELPER + '/voz', { cache: 'no-store' }).then((r) => r.json()).then(paint)
    .catch(() => box.replaceChildren(h('div', { class: 'muted small' }, 'No se pudo leer el micro de este panel.')));
  return box;
}
/** Ejemplo de la barra de voz, sin hablar con Home Assistant. */
const DEMO_T = [];
function voiceDemo() {
  const at = (ms, f) => DEMO_T.push(setTimeout(f, ms));
  DEMO_T.splice(0).forEach(clearTimeout);
  VOICE.run = null; VOICE.stage = 'idle';
  panelVoice('listening');
  at(1800, () => panelVoice('processing', { heard: 'Enciende la luz del salón' }));
  at(3000, () => panelVoice('responding', { reply: 'Hecho, he encendido la luz del salón' }));
  at(5200, () => panelVoice('idle'));
}

/* ====================== Modo ambiente ====================== */
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (SET.idleSeconds > 0) idleTimer = setTimeout(() => !S.sheetId && !NP.id && !alertOpen() && showAmbient(), SET.idleSeconds * 1000);
}
/** Menú de los tres puntitos de arriba a la derecha: se despliega con una animación. */
/* Mini reproductor del panel de acceso rápido: carátula, título y anterior / play / siguiente.
   Tocar la carátula o el título abre «Sonando». Se repinta solo mientras el menú está abierto. */
const TM = { id: null, paint: null };
function tmPlayer() {
  const id = ambientSpeaker() || speakerEntity();
  TM.id = null; TM.paint = null;
  if (!id || !S.states[id] || S.states[id].state === 'unavailable') return null;
  // Tarjeta como la de música de Android: la carátula difuminada de fondo, la carátula a la izquierda,
  // el título y el artista y debajo los controles. Tocar la tarjeta abre «Sonando».
  const art = h('div', { class: 'tm-art' }), title = h('div', { class: 'tm-ptitle' }), sub = h('div', { class: 'tm-psub' });
  const bg = h('div', { class: 'tm-bg' });
  const btn = (ic, svc, cls = '') => h('button', { class: 'tm-pbtn ' + cls, onclick: (e) => { e.stopPropagation(); call('media_player', svc, {}, id); } }, icon(ic));
  const play = btn('mdi-play', 'media_play_pause', 'main');
  const box = h('div', { class: 'tm-player', onclick: () => { shade(false); showNowPlaying(id); } }, bg, art,
    h('div', { class: 'tm-ptext' }, h('div', { class: 'tm-pspk' }, icon('mdi-speaker'), nameOf(id, false)), title, sub),
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
/* ====================== Panel de acceso rápido (como en Android) ======================
 * Arrastrando hacia abajo desde el borde de arriba baja el panel de acceso rápido, que sigue al dedo; al soltar se abre del todo
 * si has bajado más de un tercio (o lo has hecho rápido) y si no se recoge.
 * Dentro: la hora, apagar la pantalla y ajustes (arriba a la derecha), el mini reproductor, los volúmenes y el brillo.
 * Se cierra deslizando hacia arriba, tocando fuera o eligiendo algo. */
const SH = { open: false, sync: null, tab: 0, paintNotif: null };
const shadeEdge = 30;   // alto (px) de la franja de arriba donde empieza el gesto
/** Barra tipo Android: una píldora gruesa que se llena, con el símbolo dentro a la izquierda y el valor a la derecha.
 *  Se arrastra (o se toca) de lado a lado. onLive mientras arrastras, onEnd al soltar. */
function pill(ic, { min = 0, max = 100, step = 1, value = 0, onLive, onEnd } = {}) {
  const fill = h('i'), val = h('span', { class: 'sp-val' });
  const el = h('div', { class: 'sh-pill' }, fill, h('span', { class: 'sp-ic' }, icon(ic)), val);
  const p = { el, v: value, drag: false };
  p.set = (v, force) => {
    if (p.drag && !force) return;
    // El 0 está justo después del símbolo (la parte con el símbolo siempre se ve llena, como en Android)
    const f = (v - min) / (max - min), base = el.offsetHeight || 70, w = el.offsetWidth;
    p.v = v; fill.style.width = `calc(${base}px + (100% - ${base}px) * ${f})`; val.textContent = v + ' %';
    el.classList.toggle('full', w ? base + (w - base) * f > w - 80 : f > 0.86);   // el valor queda sobre la parte llena: en oscuro
  };
  const at = (x) => {
    const r = el.getBoundingClientRect(), base = r.height;
    const f = Math.max(0, Math.min(1, (x - r.left - base) / Math.max(1, r.width - base - 10)));   // el 100 sin apurar hasta el borde
    const v = Math.max(min, Math.min(max, Math.round((min + f * (max - min)) / step) * step));
    if (v !== p.v) { p.set(v, true); if (onLive) onLive(v); }
  };
  dragOn(el, { start: (x) => { p.drag = true; at(x); }, move: (x) => at(x), end: () => { p.drag = false; if (onEnd) onEnd(p.v); } });
  p.set(value);
  return p;
}
/* Ventanas del panel de acceso rápido que se deslizan de lado: avisos (izquierda) · controles (centro, la que sale al abrir)
 * · accesos rápidos (derecha, SET.quick). Se cambia deslizando el dedo o tocando las pestañas de arriba. */
const QUICK_KINDS = { light: 'Luces', switch: 'Enchufes', input_boolean: 'Interruptores', fan: 'Ventiladores', cover: 'Persianas',
  lock: 'Cerraduras', climate: 'Clima', scene: 'Escenas', script: 'Scripts', button: 'Botones', input_button: 'Botones' };
function shadeTabs(main) {
  const track = h('div', { class: 'sht-track' });
  const pages = h('div', { class: 'sht-pages' }, track);
  const badge = h('span', { class: 'sht-badge' });
  const btns = [h('button', { class: 'sht-tab' }, h('span', { class: 'sht-bell' }, icon('mdi-bell'), badge), 'Avisos'), h('button', { class: 'sht-tab' }, icon('mdi-tune-variant'), 'Controles'),
    h('button', { class: 'sht-tab' }, icon('mdi-lightning-bolt'), 'Accesos rápidos')];
  const bar = h('div', { class: 'sht-bar' }, btns);
  // las listas no cuentan para el alto: el panel de acceso rápido mide lo que miden los controles y ellas se desplazan dentro
  const notif = h('div', { class: 'sht-scroll' }), quick = h('div', { class: 'sht-scroll' });
  track.append(h('div', { class: 'sht-page scroll' }, notif), h('div', { class: 'sht-page sht-main' }, main), h('div', { class: 'sht-page scroll' }, quick));

  const paintNotif = () => {
    if (SH.tab === 0) { N.unread = 0; renderBell(); }
    badge.classList.toggle('on', N.unread > 0);
    if (!N.history.length) { notif.replaceChildren(h('div', { class: 'sht-empty' }, icon('mdi-bell-check-outline'), 'No hay avisos')); return; }
    // tocar un aviso lo vuelve a abrir entero (con su imagen y sus botones); la × lo quita de la lista
    notif.replaceChildren(...N.history.map((n) => h('div', { class: 'hist-row tappable ' + n.level, onclick: () => { shade(false); reopenNotif(n); } }, icon(n.icono),
      h('div', { class: 'hist-text' }, h('b', null, n.title), n.message ? h('div', { class: 'muted small' }, n.message) : null),
      h('span', { class: 'muted small' }, hhmm(n.at)),
      h('button', { class: 'hist-x', title: 'Quitar', onclick: (e) => { e.stopPropagation(); N.history = N.history.filter((x) => x !== n); renderBell(); paintNotif(); } }, icon('mdi-close')))),
    h('button', { class: 'sht-clear', onclick: () => { N.history = []; N.unread = 0; renderBell(); paintNotif(); } }, icon('mdi-delete-sweep'), 'Borrar todos'));
  };
  // Accesos rápidos: los elegidos como baldosas y, al final, una para añadir o quitar
  let editing = false, kind = null;
  const paintQuick = () => {
    B.shade.clear();
    const ids = (SET.quick || []).filter((id) => S.states[id]);
    if (!editing) {
      const add = h('button', { class: 'tile sht-add', onclick: () => { editing = true; paintQuick(); } }, icon('mdi-plus'), ids.length ? 'Editar' : 'Añadir');
      quick.replaceChildren(h('div', { class: 'sht-grid' }, ...ids.map((id) => tile(id, 'shade')), add));
      return;
    }
    const all = Object.keys(S.states).filter((id) => QUICK_KINDS[domain(id)] && visible(id));
    const kinds = [...new Set(all.map((id) => QUICK_KINDS[domain(id)]))];
    if (!kinds.includes(kind)) kind = kinds[0];
    const rows = all.filter((id) => QUICK_KINDS[domain(id)] === kind).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es')).map((id) => {
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
        h('button', { class: 'sht-done', onclick: () => { editing = false; paintQuick(); } }, icon('mdi-check'), 'Listo')),
      h('div', { class: 'sht-list' }, rows.length ? rows : h('div', { class: 'sht-empty' }, 'Nada que añadir')));
  };

  const goTab = (i, anim = true) => {
    SH.tab = i;
    track.classList.toggle('anim', anim);
    track.style.transform = `translateX(${(-i * 100) / 3}%)`;
    btns.forEach((b, j) => b.classList.toggle('active', j === i));
    if (i === 0) paintNotif();
  };
  btns.forEach((b, i) => { b.onclick = () => goTab(i); });

  // deslizar de lado sobre las páginas
  let sw = null, swallow = false;
  const sBegin = (x, y, t) => { sw = t && t.closest('.sh-pill, input') ? null : { x, y, dx: 0, on: false }; };   // las barras se arrastran solas
  const sMove = (x, y, e) => {
    if (!sw) return;
    const dx = x - sw.x, dy = y - sw.y;
    if (!sw.on) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) >= Math.abs(dx)) { sw = null; return; }   // era para subir o bajar la lista
      sw.on = true; track.classList.remove('anim');
    }
    if (e && e.cancelable) e.preventDefault();
    sw.dx = dx;
    const edge = (SH.tab === 0 && dx > 0) || (SH.tab === 2 && dx < 0);   // en los extremos cuesta más
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
  paintNotif.badge();   // avisos sin ver: un puntito en la campana de la pestaña, aunque abra en otra ventana
  goTab(SH.startTab ?? 1, false);   // abre en los controles (la campana, en los avisos)
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
    // la música cambia mientras arrastras (como en «Sonando»)
    let last = -1, timer = null;
    const send = () => { if (mus.v === last) return; last = mus.v; volMarkSent(mus.v); call('media_player', 'volume_set', { volume_level: mus.v / 100 }, id); };
    mus = pill('mdi-music', { onLive: () => { if (!timer) { send(); timer = setInterval(send, 250); } }, onEnd: () => { clearInterval(timer); timer = null; send(); } });
    pills.append(mus.el);
  }
  const av = pill('mdi-bell-ring', { min: 10, step: 10, value: SET.sound.volume, onEnd: (v) => { SET.sound.volume = v; saveSettings(true); tone([784, 622], 0.4); } });
  const br = pill('mdi-brightness-6', { min: 5, step: 5, value: SET.brightness, onEnd: (v) => { SET.brightness = v; saveSettings(true); } });
  pills.append(av.el, br.el);
  const player = tmPlayer() || h('div', { class: 'tm-player sh-noplayer' }, icon('mdi-music-off'), 'Nada sonando');
  // lo que cambie mientras está abierta (la canción, el volumen desde el móvil…) se ve al momento
  SH.sync = (sid) => {
    if (sid === TM.id && TM.paint) TM.paint();
    if (mus && sid === id && S.states[id]) mus.set(Math.round((S.states[id].attributes.volume_level || 0) * 100));
  };
  SH.sync(id);
  const now = new Date();
  box.replaceChildren(
    // arriba: la hora y la fecha, y a la derecha los botones pequeños (apagar la pantalla y ajustes)
    h('div', { class: 'sh-head' },
      h('div', { class: 'sh-when' }, h('b', null, now.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' })),
        h('span', null, cap(now.toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' })))),
      h('div', { class: 'sh-ibtns' },
        iconBtn('mdi-monitor-off', 'Apagar la pantalla', () => { screenOffNow(); }),
        iconBtn('mdi-cog', 'Ajustes', () => {   // desde el modo ambiente o «Sonando» también
          if ($('#np').classList.contains('show')) hideNowPlaying(true);
          if (S.ambient) hideAmbient('settings'); else go('settings');
        }))),
    shadeTabs(h('div', { class: 'sh-body' }, player, pills)));
}
/** Abre (true) o cierra (false) el panel de acceso rápido con animación. Sin argumento: lo cambia. tab: ventana (0 avisos, 1 controles, 2 accesos). */
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
  let g = null;   // gesto en curso: { y0, x0, t0, from (0 cerrada / 1 abierta), moved, p }
  const blocked = () => alertOpen();   // en todas las pantallas (ambiente, «Sonando»…) menos con una alarma o un aviso importante
  const begin = (x, y, from) => { g = { x0: x, y0: y, t0: Date.now(), from, moved: false, p: from }; };
  const move = (x, y, e) => {
    if (!g) return;
    const dy = y - g.y0;
    if (!g.moved) {
      if (Math.abs(dy) < 8) return;
      if (Math.abs(x - g.x0) > Math.abs(dy)) { g = null; return; }   // era un deslizamiento de lado
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
    const v = (y - was.y0) / Math.max(1, Date.now() - was.t0);   // px/ms (+ hacia abajo)
    shade(v > 0.5 ? true : v < -0.5 ? false : was.p > (was.from ? 0.66 : 0.33));
  };
  // Abrir: desde la franja de arriba (con el dedo o con el ratón)
  window.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (e.touches.length === 1 && !SH.open && t.clientY <= shadeEdge && !blocked()) begin(t.clientX, t.clientY, 0);
  }, { passive: true, capture: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && !SH.open && e.clientY <= shadeEdge && !blocked()) begin(e.clientX, e.clientY, 0);
  }, true);
  // Cerrar: deslizando hacia arriba sobre el panel de acceso rápido (no sobre las barras ni los botones) o sobre el fondo
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
  // tocar el fondo (sin arrastrar) la cierra
  bg.addEventListener('click', () => shade(false));
}
function showAmbient() {
  setTimeout(reportState, 0);   // Home Assistant lo sabe al momento
  closeSheet();
  if (SH.open) shade(false);
  S.ambient = true;
  renderAmbientChips();
  if (photosOn()) nextBackground();
  $('#ambient').classList.add('show');
}
/** Tras salir del modo ambiente (o encender la pantalla) con un toque: hasta que se levanta el dedo no se hace nada,
 * ni pulsar lo que haya debajo (una luz…) ni desplazar la vista. */
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
    // un poco más: el «click» del toque llega justo después de levantar el dedo
    setTimeout(() => evs.forEach((t) => window.removeEventListener(t, stop, opts)), 400);
  };
  ends.forEach((t) => window.addEventListener(t, finish, true));
  setTimeout(finish, 8000);   // por si no llega el final del toque
}
/** Sale del modo ambiente a Inicio, o a la vista de la burbuja que se haya tocado. */
function hideAmbient(view = 'home') {
  setTimeout(reportState, 0);
  S.ambient = false;
  $('#ambient').classList.remove('show');
  view = tabFor(view);
  if (S.view !== view) go(view); else render();
  resetIdle();
}
/* ====================== Burbujas ======================
 * Todas son scripts: los de serie (lib/modulos.js) y los que se crean o importan en la web de configuración,
 * que se guardan en la Pi y el panel descarga al arrancar. Se ejecutan aquí, en el navegador.
 * Cada burbuja dice si sale en el modo ambiente y/o en el resumen de Inicio (SET.bullets). */
/* Lo que reciben las burbujas y tarjetas de código: render(ha, screen).
 * ha     → Home Assistant tal cual (estados y registro de entidades). Para pintar solo lee; ha.call() solo al tocar.
 * screen → la pantalla: dónde se pinta, brillo, modo noche/ambiente, alarmas del panel, ir a una pestaña. */
function entInfo(id) {
  const e = S.ents[id];
  if (!e) return {};
  const d = S.devs[e.device_id] || {}, areaId = e.area_id || d.area_id || null;
  return { platform: e.platform || null, device: d.name_by_user || d.name || null, deviceId: e.device_id || null,
    area: areaId ? (S.areaById[areaId] || {}).name || null : null, areaId, key: e.translation_key || null };
}
const FC_LOADING = new Set();
const HA_OPTS = {
  name: (id) => (S.states[id] ? nameOf(id) : id), info: entInfo,
  format: (id) => (S.states[id] ? fmtState(S.states[id]) : '—'),
  mediaOrder: (list) => dedupeMedia((list || Object.keys(S.states).filter((id) => domain(id) === 'media_player')).filter((id) => S.states[id]))
    .sort((a, b) => (mediaRank(S.states[a]) - mediaRank(S.states[b])) || nameOf(a).localeCompare(nameOf(b), 'es')),
  printers: () => [...printers()].sort((a, b) => pActive(b) - pActive(a)).map((p) => ({
    device: p.dev, name: p.name, platform: p.platform, state: pState(p), active: pActive(p), e: Object.assign({}, p.e), nozzles: p.nozzles.map((n) => Object.assign({}, n)) })),
  picture(id, width) {
    const a = S.states[id] && S.states[id].attributes.entity_picture;
    if (!a) return '';
    const url = absUrl(a);
    return width && domain(id) === 'camera' && !url.startsWith('data:') ? url + (url.includes('?') ? '&' : '?') + 'width=' + width : url;
  },
  icon: (id) => iconOf(S.states[id]),
  /** Previsión: la guardada; si no hay o es vieja, se pide y se repinta lo que vigile esa entidad */
  forecast(id) {
    const c = FORECASTS[id];
    if ((!c || Date.now() - c.t > 30 * 60e3) && S.states[id] && !FC_LOADING.has(id)) {
      FC_LOADING.add(id);
      getForecast(id).then(() => { FC_LOADING.delete(id); markCode(id); });
    }
    return c ? c.list : (S.states[id] && S.states[id].attributes.forecast) || [];
  },
};
const HA = PM.makeHA(() => S.states, HA_OPTS);
const HA_TAP = PM.makeHA(() => S.states, Object.assign({}, HA_OPTS, {
  call(service, data = {}) {
    const [d, sv] = String(service).split('.');
    if (!d || !sv) throw new Error('Servicio no válido: ' + service);
    return call(d, sv, data);
  },
}));
/** Datos de la pantalla (también se mandan a la web para probar). */
function screenData(place) {
  return {
    place, brightness: SCREEN.level, on: !SCREEN.off, night: isNight(), ambient: !!S.ambient, light: null, favorites: CFG.favorites || [],
    notices: { unread: N.unread, total: N.history.length, last: (N.history[0] || {}).title || '' },
    alarms: (SET.alarms || []).map((a) => {
      const sn = RING.snooze[a.id];
      const when = sn && sn > Date.now() ? new Date(sn) : a.enabled ? nextOccurrence(a) : null;
      return { name: a.name || 'Alarma', time: a.time, days: a.days || [], enabled: !!a.enabled, when, text: when ? whenText(when) : null };
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
/* La web de configuración prueba las burbujas con lo mismo que ve el panel: le pasamos al ayudante
 * los datos de la pantalla (cada 15 s) y el registro de entidades (ha.info; cada 5 min). */
let infoSentAt = 0;
function sendPanelData() {
  if (!window.PANEL_HELPER || !S.states || !Object.keys(S.states).length) return;
  const d = { screen: screenData('ambient'), forecasts: Object.fromEntries(Object.entries(FORECASTS).map(([k, v]) => [k, v.list])) };
  if (Date.now() - infoSentAt > 300e3) {
    d.info = {};
    for (const id of Object.keys(S.states)) { const i = entInfo(id); if (i.platform) d.info[id] = i; }
    infoSentAt = Date.now();
  }
  fetch(HELPER + '/datos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
    .then((r) => r.json()).then((r) => { if (r && r.hasInfo === false) infoSentAt = 0; })   // el ayudante se reinició: se reenvía
    .catch(() => {});
}
setInterval(sendPanelData, 15e3);
setTimeout(sendPanelData, 5e3);

/* Scripts de serie + los descargados de la Pi (window.PANEL_HELPER.modulos) o, sin ayudante, de config.js (modulos). */
const MODULES = PM.allScripts((window.PANEL_HELPER && window.PANEL_HELPER.modulos) || CFG.modulos);
const COMPILED = new Map();
function moduleOf(name) {
  let m = COMPILED.get(name);
  if (!m) {
    m = { cache: {}, watch: {} };
    if (!(name in MODULES)) m.err = 'no existe el script ' + name;
    else try { m.mod = PM.compile(MODULES[name]); } catch (e) { m.err = e.message; }
    COMPILED.set(name, m);
  }
  return m;
}
/** Un cambio de estado invalida las burbujas y tarjetas que lo vigilan. */
function markCode(id) {
  for (const m of COMPILED.values()) if (m.mod && Object.values(m.watch || {}).some((f) => f(id))) m.cache = {};
  VIEW_CODE.forEach((v, i) => { if (v.matches(id)) VIEW_DIRTY.add(i); });
  if (VIEW_DIRTY.size) {
    clearTimeout(viewCodeTimer);
    viewCodeTimer = setTimeout(() => { if (!S.sheetId) VIEW_DIRTY.forEach((i) => VIEW_CODE[i] && VIEW_CODE[i].paint()); VIEW_DIRTY.clear(); }, 500);
  }
}
/** Lo que pintan las burbujas marcadas para el modo ambiente. */
function bulletOutputs() {
  const list = bulletList().filter((b) => b.ambient), place = 'ambient';
  const out = [];
  for (const b of list) {
    if (!(b.script in MODULES)) continue;            // su script se borró: no sale
    const m = moduleOf(b.script), name = b.name || b.script;
    // Se recalcula si cambia algo de su watch o si lleva más de un minuto (horas, alarmas…)
    // Cada burbuja con sus ajustes (b.config); la misma caché se separa por burbuja y sitio
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
/** Una burbuja en pantalla. Al tocarla: su acción o ir a su pestaña. */
function bubbleEl(b, cls) {
  const el = h('div', { class: cls + (b.go || b.action || b.onTap ? ' tappable' : '') + (b.progress != null ? ' with-bar' : ''), style: b.color ? `--bc:${b.color}` : null },
    b.icon ? icon(b.icon, 'b-ic') : null, h('span', { style: b.textColor ? `color:${b.textColor}` : null }, b.text),
    b.iconEnd ? h('i', { class: `mdi ${b.iconEnd} b-badge`, style: b.iconEndColor ? `color:${b.iconEndColor}` : null }) : null,
    b.progress != null ? h('span', { class: 'amb-bar' }, h('span', { style: `width:${b.progress}%` })) : null);
  el.bubble = b;
  if (cls === 'chip' && (b.go || b.action || b.onTap)) el.addEventListener('click', () => runBubble(b));
  return el;
}
/** Al tocar: su onTap(ha, screen) o su action (lo único que manda algo a Home Assistant), o ir a su pestaña. */
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

/* ---------- Mini reproductor del altavoz por defecto (modo ambiente, abajo a la derecha) ----------
 * Si está sonando algo en el altavoz de este panel, sale ese (aunque no sea el de por defecto);
 * tocar su carátula o el título vuelve a la pantalla «Sonando». */
/** Altavoces del modo ambiente, por orden de prioridad (Ajustes → Altavoces del modo ambiente). */
function ambientSpeakers() {
  const list = SET.ambientSpeakers || (SET.defaultSpeaker ? [SET.defaultSpeaker] : []);
  return [...new Set(list.map(resolveSpk))].filter((x) => x && S.states[x]);
}
function ambientSpeaker() {
  // el primero de la lista que esté sonando; si no, el primero en pausa; si no, el primero que esté encendido
  const st = (x) => (S.states[x] || {}).state, l = ambientSpeakers();
  if (!l.length) { const w = watchedSpeakers(); return w.find((x) => st(x) === 'playing') || w.find((x) => st(x) === 'paused') || null; }
  return l.find((x) => st(x) === 'playing') || l.find((x) => st(x) === 'paused') ||
    l.find((x) => !['unavailable', 'off', 'unknown'].includes(st(x))) || l[0];
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
  const title = a.media_title || (own ? 'Este panel' : nameOf(id));
  const sub = a.media_title ? (a.media_artist || a.app_name || nameOf(id)) : (T[st.state] || cap(st.state));
  box.classList.add('own');   // tocar la carátula o el título abre «Sonando»
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

/** Ajustes: elegir el altavoz por defecto. */
function speakerCard() {
  const players = dedupeMedia(ids((id) => domain(id) === 'media_player'))
    .sort((x, y) => (S.states[x].state === 'unavailable') - (S.states[y].state === 'unavailable') || nameOf(x).localeCompare(nameOf(y), 'es'));
  // «Este panel» sale siempre que el altavoz esté activado (web → Sonido → Altavoz), aunque Music Assistant
  // aún no haya creado su reproductor en Home Assistant. Se guarda como '@panel'.
  const own = speakerEntity();
  if (own && players.includes(own)) players.splice(players.indexOf(own), 1);
  const ownSub = !own ? 'Aún no está en Music Assistant' : S.states[own].state === 'unavailable' ? 'No disponible' : 'El altavoz de esta pantalla';
  const ownRow = SPK && SPK.enabled ? [['@panel', 'Este panel', 'mdi-tablet', ownSub]] : [];
  const options = ownRow.concat(players.map((id) => [id,
    nameOf(id), iconOf(S.states[id]), S.states[id].state === 'unavailable' ? 'No disponible' : (S.areaById[areaOf(id)] || {}).name || '']));
  const box = h('div', { class: 'amb-list' });
  // Lista con prioridad: sale el primero que esté sonando; si no suena ninguno, el primero en pausa; si no, el primero
  const cur = () => (SET.ambientSpeakers || (SET.defaultSpeaker ? [SET.defaultSpeaker] : [])).map((x) => (x === own && own ? '@panel' : x));
  const save = (arr) => { SET.ambientSpeakers = arr; SET.defaultSpeaker = arr[0] || ''; saveSettings(); paint(); renderAmbientPlayer(); };
  const paint = () => {
    const list = cur();
    const rows = list.map((x, i) => {
      const o = options.find((op) => op[0] === x) || [x, nameOf(x), 'mdi-speaker', 'No existe'];
      const mv = (d) => { const a = list.slice(); [a[i], a[i + d]] = [a[i + d], a[i]]; save(a); };
      return h('div', { class: 'amb-item prio-row' }, h('span', { class: 'prio-n' }, i + 1), icon(o[2]),
        h('div', { class: 'amb-item-label' }, h('div', null, o[1]), o[3] ? h('div', { class: 'muted small' }, o[3]) : null),
        h('button', { class: 'icon-btn small', disabled: i === 0, onclick: () => mv(-1) }, icon('mdi-chevron-up')),
        h('button', { class: 'icon-btn small', disabled: i === list.length - 1, onclick: () => mv(1) }, icon('mdi-chevron-down')),
        h('button', { class: 'icon-btn small', onclick: () => save(list.filter((y) => y !== x)) }, icon('mdi-close')));
    });
    const rest = options.filter((o) => !list.includes(o[0]));
    box.replaceChildren(...[...rows,
      rows.length ? null : h('div', { class: 'muted small' }, 'Ninguno: sale el que esté sonando de los que abren «Sonando».'),
      rest.length ? pickList([['', 'Añadir un altavoz…', 'mdi-plus', '']].concat(rest), '', (id) => { if (id) save([...list, id]); }) : null].filter(Boolean));
  };
  paint();
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-speaker'), 'Altavoces del modo ambiente'),
    h('div', { class: 'muted small' }, 'Sus controles salen abajo a la derecha. Manda el primero de la lista que esté sonando; si no suena ninguno, el primero en pausa y, si no, el primero.'),
    box);
}
/** Ajustes: qué burbujas salen en el modo ambiente y en Inicio, y en qué orden. */
function bulletsCard() {
  const list = h('div', { class: 'amb-list' });
  const save = (arr) => { SET.bullets = arr; saveSettings(); paint(); };
  const paint = () => {
    const items = bulletList();
    list.replaceChildren(h('div', { class: 'amb-item amb-head' }, h('span', { class: 'amb-item-label' }), h('span', { class: 'amb-col' }, 'Ambiente')),
      ...items.map((b, i) => {
        const x = PM.BUILTINS.find((y) => y.script === b.script);
        const meta = { label: b.name || b.script, icon: x ? x.icon : 'mdi-script-text-outline' };
        const move = (d) => { const arr = bulletList(), j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; save(arr); };
        const flag = (k) => h('span', { class: 'amb-col' }, switchBtn(!!b[k], (v) => { const arr = bulletList(); arr[i][k] = v; save(arr); }));
        return h('div', { class: 'amb-item' + (b.ambient ? '' : ' off') }, icon(meta.icon), h('span', { class: 'amb-item-label' }, meta.label),
          h('button', { class: 'round-btn small', disabled: i === 0, onclick: () => move(-1), title: 'Subir' }, icon('mdi-chevron-up')),
          h('button', { class: 'round-btn small', disabled: i === items.length - 1, onclick: () => move(1), title: 'Bajar' }, icon('mdi-chevron-down')),
          flag('ambient'));
      }));
  };
  paint();
  return h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-format-list-bulleted'), 'Burbujas'),
    h('div', { class: 'muted small' }, 'Elige cuáles salen debajo del reloj (modo ambiente). Solo aparecen cuando tienen algo que contar. En las pestañas se ponen con una «Fila de burbujas». Se editan y se crean nuevas en la web de configuración.'),
    list,
    h('div', { class: 'btn-row' }, h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), 'Ver el modo ambiente')));
}

// Fondo: fotos (sueltas o de un álbum de Immich) o degradado según la hora del día
/* ---------- Fotos del modo ambiente ----------
 * En config.js → ambientPhotos se pueden poner URLs de fotos sueltas o un álbum de Immich, que se detecta solo:
 *   https://immich.casa/share/<clave>   enlace compartido (no necesita clave de API)
 *   https://immich.casa/s/<nombre>      enlace compartido con nombre personalizado
 *   https://immich.casa/albums/<id>     álbum privado (necesita immichApiKey en config.js)
 */
const IMMICH_SHARED = [
  [/^(https?:\/\/\S+?)\/share\/([\w-]+)\/?(\?.*)?$/, 'key'],
  [/^(https?:\/\/\S+?)\/s\/([\w-]+)\/?(\?.*)?$/, 'slug'],
];
const IMMICH_ALBUM = /^(https?:\/\/\S+?)\/albums\/([0-9a-f-]{36})/;
let PHOTOS = [], photosAt = 0, photoIdx = 0;

/** Lee JSON de Immich. Si el navegador lo bloquea por CORS (proxy sin cabeceras), lo pide al ayudante de la Pi. */
async function getJSON(url, headers) {
  let r;
  try { r = await fetch(url, { headers }); }
  catch (e) {
    const h2 = headers && headers['x-api-key'] ? { 'x-api-key': headers['x-api-key'] } : undefined;
    try { r = await fetch(`${HELPER}/proxy?url=${encodeURIComponent(url)}`, { headers: h2 }); }
    catch (e2) { throw new Error('tu servidor no deja leer el álbum desde el navegador (CORS) y el ayudante de la Pi no está en marcha'); }
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${new URL(url).pathname}`);
  return r.json();
}
const monthYear = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : cap(d.toLocaleDateString(I18N.locale(), { month: 'long', year: 'numeric' })); };
// size=preview: ~1440 px, suficiente para la pantalla y ligero para la Pi. c = thumbhash (como la web de Immich, para la caché)
const immichUrl = (base, id, thumbhash, auth) =>
  `${base}/api/assets/${id}/thumbnail?size=preview&edited=true${thumbhash ? '&c=' + encodeURIComponent(thumbhash) : ''}&${auth}`;

/** Fotos de un álbum. Immich 1.x/2.x las trae en /albums/<id>; Immich 3 las da por la línea de tiempo (por meses). */
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
/* ---------- Conectores de fotos ----------
 * Cada fuente es { id, type, name, enabled, …su configuración } y se guarda en photoSources (web de configuración).
 *   immich   { url, apiKey? }   enlace compartido de un álbum, o álbum privado (…/albums/<id>) con clave API
 *   google   { url }            enlace de un álbum compartido de Google Fotos (lo lee el ayudante de la Pi)
 *   ha_media { folder }         carpeta de «Medios» de Home Assistant (solo lectura)
 *   urls     { urls: [] }       fotos sueltas por URL
 * Sin photoSources se usa el antiguo ambientPhotos (y se detectan los enlaces de Immich). */
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
    label: 'Immich',
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
      if (!m) throw new Error('no es un enlace de Immich');
      const key = src.apiKey || CFG.immichApiKey;
      if (!key) throw new Error('para un álbum privado hace falta la clave API, o usa un enlace compartido');
      const list = await immichAlbumPhotos(m[1], m[2], 'apiKey=' + encodeURIComponent(key), { 'x-api-key': key });
      return { photos: list, name: list.albumName };
    },
  },
  google: {
    label: 'Google Fotos',
    async load(src) {
      let r;
      try { r = await fetch(`${HELPER}/gphotos?url=${encodeURIComponent(src.url || '')}`, { cache: 'no-store' }); }
      catch (e) { throw new Error('Google Fotos necesita el ayudante de la Pi (panel-helper.py)'); }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      // =w1920-h1080: Google sirve la foto ya reducida al tamaño de pantalla
      return { photos: j.photos.map((u) => ({ url: u + '=w1920-h1080', caption: '' })), name: j.title };
    },
  },
  ha_media: {
    label: 'Home Assistant',
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
      return { photos: out, name: folder || 'Medios' };
    },
  },
  urls: {
    label: 'Fotos',
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
      const label = src.name || [c.label, name].filter(Boolean).join(' · ');
      photos.forEach((p) => { p.source = label; p.fit = src.fit || ''; });
      out.push(...photos);
      stats.push({ label, count: photos.length });
    } catch (e) {
      console.warn('Fotos', src, e);
      stats.push({ label: src.name || c.label, error: e.message });
      toast(`${c.label}: ` + (e.message === 'Failed to fetch' ? 'no se pudo conectar' : e.message), true);
    }
  }
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  PHOTOS = out; photoIdx = 0; PHOTO_STATS = stats;
  // Si no se pudo cargar (p. ej. el ayudante aún arrancando), se reintenta en 30 s en vez de en 1 h
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
// los mismos momentos del día, en claro (tema claro y sin fotos)
const GRADIENTS_LIGHT = [
  [0, 'linear-gradient(160deg,#e6e9f5,#d9def0 55%,#e3dbef)'], [6, 'linear-gradient(160deg,#fff1e4,#fcdcd6 60%,#efd9ee)'],
  [9, 'linear-gradient(160deg,#e7f3ff,#d6e8fb 60%,#e4eefa)'], [18, 'linear-gradient(160deg,#fff0dc,#fbd9cc 55%,#ead7ee)'],
  [21, 'linear-gradient(160deg,#e4e8f2,#d6dcea)'],
];
/** Una capa del fondo: foto (rellenando, entera con fondo difuminado o entera) o nada. */
function setPhotoLayer(el, url, fit) {
  const v = url ? `url("${url}")` : '';
  el.style.backgroundImage = '';
  el.querySelector('.amb-fg').style.backgroundImage = v;
  el.querySelector('.amb-blur').style.backgroundImage = v;
  el.dataset.srcfit = fit || '';                       // modo propio de la fuente (vacío = el general)
  el.dataset.fit = fit || SET.photos.fit || 'blur';
}
/** Al cambiar el modo general en Ajustes se aplica a la foto que ya se está viendo (si su fuente no tiene uno propio). */
function refitPhotos() { document.querySelectorAll('.amb-bg').forEach((el) => { el.dataset.fit = el.dataset.srcfit || SET.photos.fit || 'blur'; }); }

function nextBackground() {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(nextBackground, (photosOn() ? SET.photos.seconds : photoSources().length && !PHOTOS.length ? 30 : 600) * 1000);
  if (photoSources().length && Date.now() - photosAt > 3600e3) {   // los álbumes se refrescan cada hora
    const had = PHOTOS.length;
    loadPhotos().then(() => { if (!had && PHOTOS.length) nextBackground(); });
  }
  const back = bgFront === 'a' ? 'b' : 'a';
  const el = $('#amb-bg-' + back), front = $('#amb-bg-' + bgFront), caption = $('#amb-caption');
  $('#amb-next').classList.toggle('hidden', !photosOn());
  if (photosOn()) {
    if (!S.ambient && front.classList.contains('photo')) return;   // solo se descargan fotos mientras se ven
    let tries = 0;
    const show = () => {
      let p = PHOTOS[photoIdx++ % PHOTOS.length];
      // las que ya fallaron antes no se vuelven a pedir
      for (let k = 0; p.bad && k < PHOTOS.length; k++) p = PHOTOS[photoIdx++ % PHOTOS.length];
      if (p.bad) return;
      const img = new Image();
      img.onload = () => {
        setPhotoLayer(el, img.src, p.fit);
        el.classList.add('photo', 'visible'); front.classList.remove('visible'); bgFront = back;
        $('#ambient').classList.remove('lightbg');   // sobre una foto, siempre letras blancas
        caption.replaceChildren(...[p.caption ? h('div', { class: 'cap-date' }, p.caption) : null,
          p.source ? h('div', { class: 'cap-src' }, p.source) : null].filter(Boolean));
      };
      // Foto sin versión grande en el servidor (o caída): se salta, hasta 50 seguidas
      img.onerror = () => { p.bad = true; if (++tries < 50) show(); };
      if (p.ha) {   // Medios de Home Assistant: URL firmada en el momento (solo lectura)
        conn.send({ type: 'media_source/resolve_media', media_content_id: p.ha, expires: 3600 })
          .then((r) => { img.src = absUrl(r.url); }).catch(() => img.onerror());
      } else img.src = p.url;
    };
    show();
  } else {
    caption.replaceChildren();
    const hr = new Date().getHours();
    const g = (themeIsLight() ? GRADIENTS_LIGHT : GRADIENTS).filter(([from]) => hr >= from).pop()[1];
    $('#ambient').classList.toggle('lightbg', themeIsLight());   // sin foto: letras oscuras sobre fondo claro
    if (front.style.backgroundImage === g && !front.classList.contains('photo')) return;
    setPhotoLayer(el, null);
    el.style.backgroundImage = g;
    el.classList.remove('photo'); el.classList.add('visible'); front.classList.remove('visible'); bgFront = back;
  }
}

/* ====================== Reloj y modo noche ====================== */
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
  screenTick();   // brillo, modo noche y apagado (con un aviso abierto, pantalla encendida y a tope)
}

/* ====================== Web de configuración (ayudante de la Pi) ======================
 * La web http://<pi>.local:8080 guarda la configuración en el ayudante. El panel le pregunta cada 5 s:
 * si la versión cambia se recarga, y ejecuta las órdenes del «mando a distancia». */
const REMOTE = { version: window.PANEL_HELPER ? window.PANEL_HELPER.version : null, reload: window.PANEL_HELPER ? window.PANEL_HELPER.reload || 0 : 0,
  command: null, seeded: false };
const SEED_KEYS = ['haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
  'excludePlatforms', 'printerPlugs'];
async function seedHelper() {
  if (!window.PANEL_HELPER || REMOTE.seeded || NEEDS_SETUP) return;
  REMOTE.seeded = true;
  const h = window.PANEL_HELPER;
  if (h.panel && h.panel.haUrl && h.ajustes && Object.keys(h.ajustes).length) return;   // ya tiene todo
  const panel = {};
  for (const k of SEED_KEYS) if (CFG[k] !== undefined && CFG[k] !== '') panel[k] = CFG[k];
  try {
    const r = await fetch(HELPER + '/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panel, ajustes: SET }) });
    REMOTE.version = (await r.json()).version;
  } catch (e) { /* sin ayudante */ }
}
/** Ajustes nuevos guardados desde la web: se aplican y se repinta lo que se ve, sin recargar el panel. */
async function applyRemoteSettings() {
  let j;
  try { j = await (await fetch(HELPER + '/config', { cache: 'no-store' })).json(); } catch (e) { return; }
  if (j.altavoz && !SPK) { location.reload(); return; }        // el altavoz se acaba de activar: hay que arrancar con él
  if (SPK && j.altavoz) Object.assign(SPK, j.altavoz);
  const oldPhotos = JSON.stringify(SET.photos);
  SET = mergeSettings(j.ajustes || {});
  applySettings();
  if (JSON.stringify(SET.photos) !== oldPhotos) { refitPhotos(); nextBackground(); }
  renderRail();
  if (!S.sheetId) render();
  renderAmbientChips();
  if (SH.open) { SH.open = false; shade(true); }   // el panel de acceso rápido, con los accesos y colores nuevos
}
/* Estado del panel para Home Assistant (por MQTT, en el ayudante): se manda al ayudante cuando cambia.
 * El último toque, como mucho cada 30 s (para no estar mandándolo con cada dedo). */
let LAST_TOUCH = 0;
const PSTATE = { sent: '', touch: 0 };
function reportState() {
  if (!window.PANEL_HELPER) return;
  if (LAST_TOUCH - PSTATE.touch > 30000) PSTATE.touch = LAST_TOUCH;
  const body = JSON.stringify({ screen_on: !SCREEN.off, brightness: SET.brightness, ambient: !!S.ambient,
    last_touch: PSTATE.touch ? new Date(PSTATE.touch).toISOString() : null });
  if (body === PSTATE.sent) return;
  PSTATE.sent = body;
  fetch(HELPER + '/estado', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => { PSTATE.sent = ''; });
}
function runRemote(type, value) {
  if (type === 'recargar') location.reload();
  else if (type === 'brillo' && value) { SET.brightness = value; saveSettings(true); wakeScreen(); }
  else if (type === 'ambiente') showAmbient();
  else if (type === 'inicio') { hideAmbient('home'); wakeScreen(); }
  else if (type === 'pantalla_off') { screenOffNow(); }
  else if (type === 'pantalla_on') { wakeScreen(); }
}
async function pollHelper() {
  if (!window.PANEL_HELPER) {
    // En la Pi: si el ayudante arrancó después que el panel, recargar para usar su configuración
    if (location.protocol === 'file:') fetch(HELPER + '/status', { cache: 'no-store' }).then(() => location.reload()).catch(() => {});
    return;
  }
  if (!SCREEN.helper) helperInit();     // por si al arrancar no respondió a tiempo
  try {
    const r = await (await fetch(HELPER + '/poll', { cache: 'no-store' })).json();
    if (REMOTE.command === null) REMOTE.command = r.command.id;          // al arrancar no se repiten órdenes viejas
    else if (r.command.id !== REMOTE.command) { REMOTE.command = r.command.id; runRemote(r.command.type, r.command.value); }
    // Cambiaron algo desde la web: si fue la conexión, las entidades, las fotos o el código, se recarga;
    // si solo fueron ajustes (brillo, tema, sonido, burbujas, pestañas…), se aplican al momento sin recargar
    if (REMOTE.version !== null && r.version !== REMOTE.version) {
      if ((r.reload || 0) !== REMOTE.reload) { location.reload(); return; }
      applyRemoteSettings();
    }
    REMOTE.version = r.version; REMOTE.reload = r.reload || 0;
    showPin(r.pin || null);
    if (r.update && r.update !== UPDATE_SEEN) toast(`Hay una actualización del panel: web de configuración → Actualizaciones`);
    UPDATE_SEEN = r.update || 0;
  } catch (e) { /* ayudante reiniciándose */ }
}
let UPDATE_SEEN = 0;

/* Código para emparejar el altavoz: Music Assistant lo pide al añadirlo; sale en grande hasta que se empareja.
 * Con la ✕ se esconde (vuelve a salir si cambia el código). */
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
      h('div', { class: 'pin-title' }, 'Emparejar con Music Assistant'),
      h('div', { class: 'pin-hint' }, 'Escribe este código en Music Assistant para añadir el altavoz'),
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
  if (haConf && haConf.language) { HA_LANG = haConf.language; setLanguage(); }   // «Automático» = el idioma de Home Assistant
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
  // El puntero solo se oculta en el kiosko de la Pi (abierto como file://) o con ?kiosk en la URL
  if (CFG.hideCursor && (location.protocol === 'file:' || PARAMS.has('kiosk'))) document.body.classList.add('no-cursor');
  conn.onstatus = (ok, msg) => {
    S.connected = ok;
    $('#conn').classList.toggle('ok', ok);
    if (msg) toast(msg, true);
  };
  conn.onready = () => loadAll().catch((e) => toast('Error cargando datos: ' + e.message, true));
  if (NEEDS_SETUP) showSetup(); else conn.connect();

  $('#view').replaceChildren(empty('mdi-home-assistant', 'Conectando con Home Assistant…'));
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#bell').addEventListener('click', () => shade(true, 0));   // el panel de acceso rápido, en los avisos
  shadeGestures();
  // Tocar el fondo vuelve a Inicio; tocar una burbuja abre su vista (patinete, impresoras, música…)
  $('#ambient').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.clientY <= shadeEdge) return;   // ahí empieza el panel de acceso rápido: no se sale del modo ambiente
    if (e.target.closest('#amb-next')) { e.stopPropagation(); nextBackground(); resetIdle(); return; }
    const act = e.target.closest('[data-act]');
    if (act) { e.stopPropagation(); ambientPlayerAction(act.dataset.act); resetIdle(); return; }
    if (e.target.closest('#amb-player.own .amb-pinfo')) { e.stopPropagation(); swallowTouch(); showNowPlaying(ambientSpeaker()); return; }
    if (e.target.closest('#amb-player')) { resetIdle(); return; }
    const chip = e.target.closest('.amb-chip');
    if (chip && chip.bubble && (chip.bubble.action || chip.bubble.onTap)) { e.stopPropagation(); swallowTouch(); runBubble(chip.bubble); resetIdle(); return; }
    swallowTouch();
    hideAmbient(chip && chip.bubble && chip.bubble.go ? chip.bubble.go : 'home');
  });
  document.addEventListener('pointerdown', () => { SCREEN.lastTouch = LAST_TOUCH = Date.now(); resetIdle(); }, true);
  $('#blackout').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); swallowTouch(); wakeScreen(); });
  helperInit();
  setInterval(pollHelper, 1000);   // órdenes del mando y de Home Assistant, al momento

  tick(); setInterval(tick, 5000);
  if (photoSources().length) loadPhotos().then(nextBackground); else nextBackground();
  // Refresca textos relativos ("hace 5 min") y el saludo de vez en cuando
  setInterval(() => !S.sheetId && !S.ambient && render(), 5 * 60e3);
  if (PARAMS.has('ambient')) showAmbient(); else resetIdle();
}
start();
