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
const DEMO = PARAMS.has('demo') || !CFG.token || CFG.token === 'PEGA_AQUI_TU_TOKEN';

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
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name, cls = '') => h('i', { class: `mdi ${name} ${cls}` });
const domain = (id) => id.split('.')[0];
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const fmtNum = (n) => {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('es-ES')
    : (Math.round(n * 10) / 10).toLocaleString('es-ES');
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
const hhmm = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
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

const conn = DEMO ? window.createDemoConn() : new HAConn(CFG.haUrl, CFG.token);

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
const B = { view: new Map(), sheet: new Map() };
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
  clearTimeout(ambTimer);
  ambTimer = setTimeout(renderAmbientChips, 500);
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
const T = {
  on: 'Encendido', off: 'Apagado', unavailable: 'No disponible', unknown: '—', open: 'Abierto',
  closed: 'Cerrado', opening: 'Abriendo', closing: 'Cerrando', locked: 'Cerrado con llave',
  unlocked: 'Abierto', locking: 'Cerrando…', unlocking: 'Abriendo…', jammed: 'Atascado',
  playing: 'Reproduciendo', paused: 'En pausa', idle: 'Inactivo', standby: 'En espera',
  buffering: 'Cargando', home: 'En casa', not_home: 'Fuera', heat: 'Calor', cool: 'Frío',
  auto: 'Auto', heat_cool: 'Calor/Frío', dry: 'Deshumidificar', fan_only: 'Ventilador',
  cleaning: 'Limpiando', docked: 'En la base', returning: 'Volviendo', error: 'Error',
};
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
  if (a.icon) return a.icon.replace('mdi:', 'mdi-');
  if (d === 'light') return s === 'on' ? 'mdi-lightbulb-on' : 'mdi-lightbulb-outline';
  if (d === 'lock') return s === 'locked' ? 'mdi-lock' : 'mdi-lock-open-variant';
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
  if (d === 'vacuum' && a.battery_level != null) return `${T[s] || cap(s)} · ${a.battery_level} %`;
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

async function getForecast() {
  const id = weatherId();
  if (!id) return [];
  if (S.forecast && Date.now() - S.forecastAt < 30 * 60e3) return S.forecast;
  try {
    const r = await api.callService('weather', 'get_forecasts', { type: 'daily' }, id, true);
    S.forecast = (r && r.response && r.response[id] && r.response[id].forecast) || [];
  } catch (e) {
    S.forecast = S.states[id].attributes.forecast || [];
  }
  S.forecastAt = Date.now();
  return S.forecast;
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
const HAS_SHEET = ['light', 'fan', 'cover', 'climate', 'media_player', 'lock', 'vacuum', 'camera', 'sensor', 'binary_sensor'];

function tap(id, el) {
  const d = domain(id);
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
    el.classList.remove('pending');
    const rgb = d === 'light' && st.attributes.rgb_color;
    if (rgb) el.style.setProperty('--tint', `rgb(${rgb.join(',')})`); else el.style.removeProperty('--tint');
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

function ring(sizeClass = '') {
  const C = 2 * Math.PI * 52;
  const wrap = h('div', { class: 'ring-wrap ' + sizeClass, html:
    `<svg class="ring" viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52"/>` +
    `<circle class="ring-fg" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 60 60)"/></svg>` });
  const center = h('div', { class: 'ring-center' });
  wrap.append(center);
  const fg = wrap.querySelector('.ring-fg');
  // bolt: rayo grande y semitransparente encima del porcentaje mientras carga
  // (las impresoras usan el color azul sin rayo)
  // charging: true | 'charging' (azul) | 'charged' (verde, carga completa)
  wrap.set = (pct, charging, centerNodes, bolt = !!charging) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const mode = charging === true ? 'charging' : charging;
    fg.setAttribute('stroke-dashoffset', C * (1 - p / 100));
    fg.setAttribute('class', 'ring-fg ' + (mode || (p < 20 ? 'low' : p < 45 ? 'mid' : '')));
    center.replaceChildren(h('div', null, ...centerNodes),
      bolt ? icon('mdi-lightning-bolt', 'ring-bolt' + (mode === 'charged' ? ' charged' : '')) : null);
  };
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
  bind('sheet', id, (st) => { b.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))); b.classList.toggle('on', isActive(st)); });
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
    bind('sheet', id, (st) => { status.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))); status.classList.toggle('on', st.state !== 'locked'); });
    status.dataset.kind = 'cover';
    return [status, h('div', { class: 'btn-row' },
      h('button', { class: 'big-action', onclick: () => call('lock', 'lock', {}, id) }, icon('mdi-lock'), 'Cerrar'),
      h('button', { class: 'big-action', onclick: () => call('lock', 'unlock', {}, id) }, icon('mdi-lock-open-variant'), 'Abrir'))];
  },
  vacuum(id) {
    const status = h('div', { class: 'big-toggle' });
    bind('sheet', id, (st) => status.replaceChildren(icon(iconOf(st)), h('span', null, fmtState(st))));
    const b = (ic, label, svc) => h('button', { class: 'big-action', onclick: () => call('vacuum', svc, {}, id) }, icon(ic), label);
    return [status, h('div', { class: 'btn-row' }, b('mdi-play', 'Limpiar', 'start'), b('mdi-pause', 'Pausa', 'pause'), b('mdi-home-import-outline', 'A la base', 'return_to_base'))];
  },
  camera(id) { return [cameraImg(id, 'sheet', 2)]; },
  sensor(id) { return [historyChart(id)]; },
  binary_sensor(id) { return [historyChart(id)]; },
};

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

function openSheet(id) {
  closeSheet();
  const st = S.states[id];
  if (!st) return;
  const builder = SHEETS[domain(id)];
  if (!builder) return;
  const head = h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }), h('div', { class: 'sheet-title' }, nameOf(id, false)),
    h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close')));
  bind('sheet', id, (s) => head.firstChild.replaceChildren(icon(iconOf(s))));
  $('#sheet-card').replaceChildren(head, h('div', { class: 'sheet-body' }, builder(id)));
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

/* ====================== Vistas ====================== */
const CONTROL = ['light', 'switch', 'fan', 'cover', 'climate', 'lock', 'vacuum', 'media_player', 'humidifier'];
const ORDER = ['climate', 'light', 'switch', 'fan', 'cover', 'lock', 'media_player', 'vacuum', 'input_boolean', 'humidifier', 'sensor', 'binary_sensor'];
const ids = (filter) => Object.keys(S.states).filter((id) => visible(id) && !isScooter(id) && filter(id));
function byArea(list) {
  const groups = new Map();
  for (const id of list) {
    const a = areaOf(id);
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(id);
  }
  const sortIds = (arr) => arr.sort((x, y) => (ORDER.indexOf(domain(x)) - ORDER.indexOf(domain(y))) || nameOf(x).localeCompare(nameOf(y), 'es'));
  return [...groups.entries()]
    .map(([a, arr]) => ({ name: a ? (S.areaById[a] || {}).name || a : 'Otros', last: !a, ids: sortIds(arr) }))
    .sort((x, y) => (x.last - y.last) || x.name.localeCompare(y.name, 'es'));
}
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

function scooterStatus(k) {
  if (isOn(k.charging_any)) {
    const p = num(k.power);
    return 'Cargando' + (!isNaN(p) && p > 0 ? ` · ${fmtNum(p)} W` : '');
  }
  if (isOn(k.charged)) return 'Carga completa';
  if (isOn(k.riding)) return 'En marcha';
  if (isOn(k.powered_on)) return 'Encendido';
  if (k.in_range && !isOn(k.in_range)) return 'Fuera de alcance';
  return 'Aparcado';
}

const VIEWS = {
  home: {
    title: 'Inicio', icon: 'mdi-home-variant',
    render() {
      const hr = new Date().getHours();
      const hello = hr < 6 ? 'Buenas noches' : hr < 13 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
      const out = [h('div', { class: 'greeting' }, hello),
        h('div', { class: 'greeting-sub' }, cap(new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })))];

      // Resumen rápido
      const summary = h('div', { class: 'chips' });
      const lights = ids((id) => domain(id) === 'light');
      const openings = ids((id) => domain(id) === 'binary_sensor' && ['door', 'window', 'garage_door', 'opening'].includes(S.states[id].attributes.device_class));
      bindMany('view', [...lights, ...openings], () => {
        const on = lights.filter((id) => S.states[id] && S.states[id].state === 'on');
        const open = openings.filter((id) => S.states[id] && S.states[id].state === 'on');
        const chips = [];
        if (on.length) chips.push(h('button', { class: 'chip', onclick: () => call('light', 'turn_off', {}, on) }, icon('mdi-lightbulb-off-outline'), on.length > 1 ? `Apagar ${on.length} luces` : `Apagar ${nameOf(on[0])}`));
        else if (lights.length) chips.push(h('div', { class: 'chip' }, icon('mdi-lightbulb-outline'), 'Todas las luces apagadas'));
        if (open.length) chips.push(h('div', { class: 'chip' }, icon('mdi-door-open'), open.length === 1 ? `${nameOf(open[0])} abierta` : `${open.length} puertas/ventanas abiertas`));
        summary.replaceChildren(...chips);
      });
      out.push(summary, h('div', { style: 'height:10px' }));

      // Tarjetas: tiempo + patinete
      const cards = h('div', { class: 'cards' });
      const wid = weatherId();
      if (wid) cards.append(weatherCard(wid));
      const k = scooterIds();
      if (k.battery_level) cards.append(scooterCard(k));
      printers().filter(pActive).reverse().forEach((p) => cards.prepend(printerMini(p)));
      if (cards.children.length) out.push(cards);

      // Favoritos
      let fav = CFG.favorites.filter((id) => S.states[id]);
      if (!fav.length) {
        const pick = (d, n) => ids((id) => domain(id) === d).slice(0, n);
        fav = [...pick('climate', 2), ...pick('light', 6), ...pick('media_player', 2)];
      }
      const scenes = ids((id) => ['scene', 'script'].includes(domain(id)));
      if (scenes.length) out.push(h('div', { class: 'section-title' }, 'Escenas'), sceneChips(scenes));
      if (fav.length) out.push(h('div', { class: 'section-title' }, 'Favoritos'), h('div', { class: 'grid' }, fav.map((id) => tile(id))));
      return out;
    },
  },
  rooms: {
    title: 'Casa', icon: 'mdi-sofa-outline',
    render() {
      const groups = byArea(dedupeMedia(ids((id) => CONTROL.includes(domain(id)))));
      if (!groups.length) return [empty('mdi-lightbulb-question-outline', 'No hay dispositivos controlables')];
      return groups.flatMap((g) => [h('div', { class: 'section-title' }, g.name), h('div', { class: 'grid' }, g.ids.map((id) => tile(id)))]);
    },
  },
  sensors: {
    title: 'Sensores', icon: 'mdi-thermometer',
    render() {
      const groups = byArea(ids((id) => {
        const d = domain(id), a = S.states[id].attributes;
        return (d === 'binary_sensor' || d === 'sensor') && (CFG.sensorClasses.includes(a.device_class) || CFG.favorites.includes(id));
      }));
      if (!groups.length) return [empty('mdi-thermometer-off', 'No hay sensores')];
      return groups.flatMap((g) => [h('div', { class: 'section-title' }, g.name), h('div', { class: 'grid' }, g.ids.map((id) => sensorTile(id)))]);
    },
  },
  media: {
    title: 'Multimedia', icon: 'mdi-play-circle-outline',
    visible: () => ids((id) => ['media_player', 'camera'].includes(domain(id))).length > 0,
    render() {
      // Primero los que tienen algo puesto (sonando, en pausa con contenido…), luego los parados
      const players = dedupeMedia(ids((id) => domain(id) === 'media_player'))
        .sort((a, b) => (mediaRank(S.states[a]) - mediaRank(S.states[b])) || nameOf(a).localeCompare(nameOf(b), 'es'));
      const cams = ids((id) => domain(id) === 'camera');
      const out = [];
      if (players.length) out.push(h('div', { class: 'section-title' }, 'Reproductores'), h('div', { class: 'cards' }, players.map((id) => mediaCard(id, 'view'))));
      if (cams.length) out.push(h('div', { class: 'section-title' }, 'Cámaras'), h('div', { class: 'cards' }, cams.map((id) => {
        const c = cameraImg(id, 'view', CFG.cameraRefreshSeconds);
        pressable(c, () => openSheet(id));
        return c;
      })));
      return out;
    },
  },
  printers: {
    title: 'Impresoras', icon: 'mdi-printer-3d',
    visible: () => printers().length > 0,
    render() {
      // Primero las que están trabajando
      const list = [...printers()].sort((a, b) => pActive(b) - pActive(a));
      return [h('div', { class: 'printers' }, list.map(printerPanel))];
    },
  },
  settings: { title: 'Ajustes', icon: 'mdi-cog', rail: 'bottom', render: () => renderSettings() },
  scooter: {
    title: 'Patinete', icon: 'mdi-scooter',
    visible: () => !!scooterIds().battery_level,
    render() {
      const k = scooterIds();
      const r = ring();
      const status = h('div', { class: 'sc-status' }), flags = h('div', { class: 'sc-flags' }), seen = h('div', { class: 'muted small' });
      bindMany('view', Object.values(k), () => {
        const charging = chargeMode(k);
        const range = num(k.remaining_range);
        r.set(num(k.battery_level), charging, [
          h('div', { class: 'ring-pct' }, isNaN(num(k.battery_level)) ? '—' : Math.round(num(k.battery_level)) + '%'),
          h('div', { class: 'ring-sub' }, isNaN(range) ? '' : `≈ ${fmtNum(range)} km`)]);
        status.textContent = scooterStatus(k);
        const flag = (key, ic, txt) => k[key] ? h('span', { class: 'flag' + (isOn(k[key]) ? ' on' : '') }, icon(ic), txt) : null;
        flags.replaceChildren(...[flag('connected', 'mdi-bluetooth', 'Conectado'), flag('in_range', 'mdi-map-marker-radius', 'Cerca'),
          flag('locked', 'mdi-lock', 'Bloqueado'), flag('charge_control', 'mdi-power-plug-battery', 'Corte auto')].filter(Boolean));
        seen.textContent = k.last_seen && S.states[k.last_seen] ? 'Visto ' + relTime(S.states[k.last_seen].state) : '';
      });
      const main = h('div', { class: 'card scooter-main' }, r, status, flags, seen);

      const STATS = [['remaining_range', 'mdi-map-marker-distance', 'Autonomía'], ['voltage', 'mdi-sine-wave', 'Voltaje'],
        ['power', 'mdi-flash', 'Potencia'], ['battery_temperature', 'mdi-thermometer', 'Temp. batería'],
        ['scooter_temperature', 'mdi-thermometer-lines', 'Temp. patinete'], ['total_distance', 'mdi-counter', 'Cuentakilómetros'],
        ['trip_distance', 'mdi-map-marker-path', 'Último viaje'], ['average_speed', 'mdi-speedometer-medium', 'Vel. media'],
        ['charge_cycles', 'mdi-battery-sync', 'Ciclos de carga'], ['battery_health', 'mdi-battery-heart-variant', 'Salud batería']];
      const stats = h('div', { class: 'stat-grid' }, STATS.filter(([key]) => k[key]).map(([key, ic, label]) => {
        const v = h('div', { class: 'stat-value' });
        bind('view', k[key], (st) => (v.textContent = fmtState(st)));
        return h('div', { class: 'stat' }, icon(ic), v, h('div', { class: 'stat-label' }, label));
      }));

      const SWITCHES = [['tail_light', 'Luz trasera'], ['auto_light', 'Luz automática'], ['ambient_light', 'Luz ambiente'],
        ['cruise_control', 'Control crucero'], ['tcs', 'Control tracción'], ['intelligent_downhill', 'Descenso inteligente'],
        ['hill_parking', 'Freno en cuesta'], ['charge_control', 'Cortar carga al límite']];
      const controls = h('div', { class: 'grid' }, SWITCHES.filter(([key]) => k[key]).map(([key, label]) => {
        const t = tile(k[key]);
        bind('view', k[key], () => (t.querySelector('.tile-name').textContent = label));
        return t;
      }));

      const out = [h('div', { class: 'scooter-hero' }, main, stats), h('div', { class: 'section-title' }, 'Carga')];
      const charge = h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' });
      if (k.charge_limit) {
        const a = S.states[k.charge_limit].attributes;
        const s = slider({ min: a.min || 50, max: a.max || 100, step: a.step || 5, label: 'Límite de carga', fmt: (v) => v + ' %',
          onchange: (v) => call('number', 'set_value', { value: v }, k.charge_limit) });
        bind('view', k.charge_limit, (st) => s.set(parseFloat(st.state)));
        charge.append(s);
      }
      if (k.refresh) charge.append(h('button', { class: 'big-action', onclick: () => call('button', 'press', {}, k.refresh).then((r) => r !== null && toast('Leyendo el patinete…')) }, icon('mdi-refresh'), 'Actualizar datos ahora'));
      if (charge.children.length) out.push(charge);
      if (controls.children.length) out.push(h('div', { class: 'section-title' }, 'Ajustes'), controls);
      return out;
    },
  },
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
const PLABEL = { printing: 'Imprimiendo', paused: 'En pausa', preparing: 'Preparando', finished: 'Terminada',
  error: 'Error', cancelled: 'Cancelada', idle: 'Lista', offline: 'Desconectada', off: 'Apagada' };
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
      e.camera = cams.find((id) => !/thumbnail|gui/.test(id)) || cams[0];
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
const pIds = (p) => [...Object.values(p.e), ...p.nozzles.flatMap((n) => [n.cur, n.tgt, n.fil])].filter(Boolean);
function pRemaining(p) {
  const st = S.states[p.e.remaining];
  if (!st) return NaN;
  const u = st.attributes.unit_of_measurement;
  return parseFloat(st.state) * (u === 'h' ? 3600 : u === 'min' ? 60 : u === 'd' ? 86400 : 1);
}
function pJob(p) {
  for (const k of ['job', 'file']) {
    const st = S.states[p.e[k]];
    if (st && st.state && !['unknown', 'unavailable'].includes(st.state)) return st.state.replace(/(\.gcode)?(\.3mf)?$/i, '');
  }
  return '';
}
function pTimeLine(p) {
  const r = pRemaining(p);
  if (!pActive(p) || isNaN(r) || r <= 0) return '';
  return `Quedan ${fmtDuration(r)} · termina a las ${hhmm(new Date(Date.now() + r * 1000))}`;
}

/** Cámara de la impresora (siempre) con la miniatura del trabajo en pequeño en una esquina. */
function printerImage(p, scope) {
  const img = h('img', { alt: '' }), thumb = h('img', { class: 'pr-thumb', alt: '' });
  const box = h('div', { class: 'pr-img' }, icon('mdi-printer-3d'), img, thumb);
  thumb.onerror = () => thumb.removeAttribute('src');
  img.onerror = () => img.removeAttribute('src');
  const pic = (id, width) => {
    const a = S.states[id] && S.states[id].attributes.entity_picture;
    if (!a) return null;
    const url = absUrl(a);
    if (url.startsWith('data:')) return url;
    // camera_proxy acepta width: imágenes más pequeñas = menos trabajo para la Pi 2
    return url + (url.includes('?') ? '&' : '?') + (width && domain(id) === 'camera' ? `width=${width}&` : '') + '_t=' + Date.now();
  };
  const load = () => {
    const off = pState(p) === 'off' || pState(p) === 'offline';
    const cam = !off && pic(p.e.camera, 640);
    const cover = pic(p.e.cover, 160);
    if (cam) {
      const next = new Image();
      next.onload = () => { img.src = next.src; };
      next.onerror = () => { if (cover && !img.getAttribute('src')) img.src = cover; };   // cámara caída: la miniatura en grande
      next.src = cam;
    } else if (cover) img.src = cover; else img.removeAttribute('src');
    if (cover && cam) thumb.src = cover; else thumb.removeAttribute('src');
  };
  load();
  (scope === 'sheet' ? S.sheetTimers : S.viewTimers).push(setInterval(load, (pActive(p) ? 5 : 30) * 1000));
  return box;
}

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

function printerPanel(p) {
  const status = h('span', { class: 'pr-status' }), job = h('div', { class: 'pr-job' }), pct = h('div', { class: 'pr-pct' });
  const bar = h('div', { class: 'pbar' }, h('div')), time = h('div', { class: 'muted' }), layer = h('div', { class: 'muted small' });
  const temps = h('div', { class: 'pr-temps' }), ctrls = h('div', { class: 'btn-row' });
  let ctrlSig = null;
  bindMany('view', pIds(p), () => {
    const s = pState(p), active = pActive(p);
    status.textContent = PLABEL[s];
    status.className = 'pr-status ' + s;
    job.textContent = pJob(p) || (active ? 'Trabajo sin nombre' : 'Sin trabajos en curso');
    const prog = num(p.e.progress), showProg = active || (s === 'finished' && prog > 0);
    pct.textContent = showProg && !isNaN(prog) ? Math.round(prog) + ' %' : '';
    bar.style.display = showProg ? '' : 'none';
    bar.firstChild.style.width = (isNaN(prog) ? 0 : prog) + '%';
    time.textContent = pTimeLine(p);
    const L = num(p.e.layer), LL = num(p.e.layers);
    layer.textContent = active && LL > 0 ? `Capa ${L} de ${LL}` : '';
    const t = (ic, label, cur, tgt) => {
      const c = num(cur), tg = num(tgt);
      if (isNaN(c)) return null;
      return h('div', { class: 'pr-temp' + (tg > 0 ? ' heating' : '') }, icon(ic),
        h('div', null, h('b', null, fmtNum(c) + '°' + (tg > 0 ? ` / ${fmtNum(tg)}°` : '')), h('small', null, label)));
    };
    const nozzles = p.nozzles.map((n) => {
      const el = t('mdi-printer-3d-nozzle', n.label, n.cur, n.tgt);
      if (el && n.fil) el.append(h('span', { class: 'fil' + (isOn(n.fil) ? ' on' : ''), title: isOn(n.fil) ? 'Con filamento' : 'Sin filamento' }));
      return el;
    });
    const pw = num(p.e.plugPower);
    temps.replaceChildren(...[...nozzles, t('mdi-radiator', 'Cama', p.e.bed, p.e.bedTarget), t('mdi-thermometer', 'Cámara', p.e.chamber),
      isNaN(pw) ? null : h('div', { class: 'pr-temp' }, icon('mdi-flash'), h('div', null, h('b', null, fmtNum(pw) + ' W'), h('small', null, 'Consumo')))].filter(Boolean));
    // Botones: solo se rehacen si cambia el estado (para no perder el "¿Seguro?")
    const lightOn = isOn(p.e.light), plugOn = isOn(p.e.plug), sig = s + lightOn + plugOn;
    if (sig === ctrlSig) return;
    ctrlSig = sig;
    const btns = [];
    const press = (id) => () => call('button', 'press', {}, id);
    if (s === 'printing' && p.e.pause) btns.push(h('button', { class: 'big-action', onclick: press(p.e.pause) }, icon('mdi-pause'), 'Pausar'));
    if (s === 'paused' && p.e.resume) btns.push(h('button', { class: 'big-action', onclick: press(p.e.resume) }, icon('mdi-play'), 'Continuar'));
    if (active && p.e.stop) btns.push(confirmBtn('mdi-stop', 'Cancelar', press(p.e.stop)));
    if (p.e.light && s !== 'off') btns.push(h('button', { class: 'big-action' + (lightOn ? ' active' : ''), onclick: () => call('light', 'toggle', {}, p.e.light) },
      icon(lightOn ? 'mdi-lightbulb-on' : 'mdi-lightbulb-outline'), 'Luz'));
    if (p.e.plug) {
      if (plugOn) btns.push(confirmBtn('mdi-power-plug-off', 'Apagar', () => call('switch', 'turn_off', {}, p.e.plug), active ? '¡Imprimiendo! ¿Apagar?' : '¿Seguro? Toca otra vez'));
      else btns.push(h('button', { class: 'big-action power-on', onclick: () => call('switch', 'turn_on', {}, p.e.plug) }, icon('mdi-power-plug'), 'Encender'));
    }
    ctrls.replaceChildren(...btns);
  });
  const img = printerImage(p, 'view');
  if (p.e.camera) pressable(img, () => openSheet(p.e.camera));
  return h('div', { class: 'card printer' }, img, h('div', { class: 'pr-info' },
    h('div', { class: 'pr-head' }, h('div', { class: 'pr-name' }, p.name), status),
    job, h('div', { class: 'pr-progress' }, bar, pct), time, layer, temps, ctrls));
}

/** Tarjeta pequeña para Inicio mientras una impresora trabaja. */
function printerMini(p) {
  const r = ring(), title = h('div', { class: 'sc-title' }), line = h('div', { class: 'sc-line' }), line2 = h('div', { class: 'sc-line' });
  bindMany('view', pIds(p), () => {
    const prog = num(p.e.progress);
    r.set(prog, true, [h('div', { class: 'ring-pct' }, isNaN(prog) ? '—' : Math.round(prog) + '%')], false);
    title.textContent = p.name;
    line.textContent = PLABEL[pState(p)] + (pJob(p) ? ' · ' + pJob(p) : '');
    line2.textContent = pTimeLine(p).replace(' · ', ' · ');
  });
  const el = h('button', { class: 'card scooter-card printer-mini' }, r, h('div', { style: 'min-width:0' }, title, line, line2));
  pressable(el, () => go('printers'));
  return el;
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

function sceneChips(list) {
  return h('div', { class: 'chips' }, list.map((id) => {
    const st = S.states[id];
    return h('button', { class: 'chip', onclick: () => tap(id) }, icon(iconOf(st)), nameOf(id));
  }));
}

function weatherCard(id) {
  const now = h('div', { class: 'w-now' }), fc = h('div', { class: 'w-fc' });
  bind('view', id, (st) => {
    if (!st) return;
    const a = st.attributes;
    const extra = [a.humidity != null ? `Humedad ${fmtNum(a.humidity)} %` : null,
      a.wind_speed != null ? `Viento ${fmtNum(a.wind_speed)} ${a.wind_speed_unit || ''}` : null].filter(Boolean).join(' · ');
    now.replaceChildren(icon(wIcon(st.state), 'w-icon'), h('div', null,
      h('div', { class: 'w-temp' }, fmtNum(a.temperature) + '°'), h('div', { class: 'w-cond' }, wText(st.state)), h('div', { class: 'muted small' }, extra)));
  });
  getForecast().then((f) => fc.replaceChildren(...f.slice(0, 5).map((d) => h('div', { class: 'fc-day' },
    h('div', { class: 'fc-name' }, new Date(d.datetime).toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '')),
    icon(wIcon(d.condition)), h('div', { class: 'fc-t' }, fmtNum(d.temperature) + '°'),
    // Probabilidad de lluvia siempre visible (también 0 %); vacía solo si la integración no la da
    d.precipitation_probability != null ? h('div', { class: 'fc-rain' }, icon('mdi-water'), d.precipitation_probability + '%')
      : h('div', { class: 'fc-rain empty' }, ' '),
    d.templow != null ? h('div', { class: 'fc-low' }, fmtNum(d.templow) + '°') : null))));
  return h('div', { class: 'card weather-card' }, now, fc);
}

function scooterCard(k) {
  const r = ring(), title = h('div', { class: 'sc-title' }), line = h('div', { class: 'sc-line' });
  bindMany('view', Object.values(k), () => {
    const b = num(k.battery_level), range = num(k.remaining_range);
    r.set(b, chargeMode(k), [h('div', { class: 'ring-pct' }, isNaN(b) ? '—' : Math.round(b) + '%')]);
    const dev = deviceOf(k.battery_level);
    title.textContent = (dev && (dev.name_by_user || dev.name)) || 'Patinete';
    line.textContent = scooterStatus(k) + (isNaN(range) ? '' : ` · ≈ ${fmtNum(range)} km`);
  });
  const el = h('button', { class: 'card scooter-card' }, r, h('div', null, title, line));
  pressable(el, () => go('scooter'));
  return el;
}

/* ====================== Avisos lanzados desde Home Assistant ======================
 * Una automatización hace:   event: panel_notificacion   con event_data:
 *   id, titulo, mensaje, nivel (info | aviso | critico), icono, imagen (cámara/imagen o URL),
 *   duracion (s, 0 = hasta tocar), sonido (true/false) y acciones: [{texto, icono, servicio, entidad, datos, confirmar, estilo}]
 * Para cerrarlo desde HA:    event: panel_notificacion_cerrar   con event_data: {id}
 * Al pulsar un botón el panel lanza:  panel_notificacion_accion  con {id, accion}
 */
const N = { queue: [], history: [], unread: 0, ctx: null, soundTimer: null, closeTimer: null, imgTimer: null };
const NIVEL = { info: 'info', aviso: 'aviso', warning: 'aviso', critico: 'critico', 'crítico': 'critico', critical: 'critico' };
const mdi = (s) => (s || '').replace('mdi:', 'mdi-');

function normNotif(d) {
  d = d || {};
  const nivel = NIVEL[String(d.nivel || d.level || 'aviso').toLowerCase()] || 'aviso';
  const def = { info: 10, aviso: 120, critico: 0 }[nivel];
  return {
    id: String(d.id || 'n' + Date.now()),
    titulo: d.titulo || d.title || 'Aviso',
    mensaje: d.mensaje || d.message || '',
    nivel,
    icono: mdi(d.icono || d.icon) || (nivel === 'critico' ? 'mdi-alert' : 'mdi-bell-ring'),
    imagen: d.imagen || d.image || null,
    duracion: Number(d.duracion ?? d.timeout ?? def) || 0,
    sonido: d.sonido ?? d.sound ?? nivel !== 'info',
    acciones: (d.acciones || d.actions || []).map((a) => ({
      texto: a.texto || a.title || 'OK', icono: mdi(a.icono || a.icon), servicio: a.servicio || a.action || a.service,
      entidad: a.entidad || a.entity_id, datos: a.datos || a.data || {}, confirmar: !!(a.confirmar || a.confirm),
      estilo: a.estilo || a.style || '',
    })),
    at: new Date(),
  };
}

const alertOpen = () => N.queue.some((n) => n.nivel !== 'info');

function onNotif(ev) {
  const n = normNotif(ev.data);
  N.queue = N.queue.filter((x) => x.id !== n.id);       // mismo id = lo sustituye (p. ej. vuelven a llamar)
  N.queue.unshift(n);
  N.history = [n, ...N.history.filter((x) => x.id !== n.id || x.at !== n.at)].slice(0, 30);
  N.unread++;
  renderBell();
  if (n.nivel !== 'info') {                            // despierta la pantalla
    if (S.ambient) { S.ambient = false; $('#ambient').classList.remove('show'); }
    closeSheet();
    tick();
  }
  if (n.sonido) playSound(n.nivel);
  showNotif();
}
function onNotifClose(ev) { closeNotif(String((ev.data || {}).id || ''), false); }

function closeNotif(id, byUser) {
  const was = N.queue.find((n) => n.id === id);
  if (!was) return;
  N.queue = N.queue.filter((n) => n.id !== id);
  if (!N.queue.some((n) => n.sonido && n.nivel !== 'info')) stopSound();
  showNotif();
  tick();
  if (byUser) resetIdle();
}

function showNotif() {
  clearTimeout(N.closeTimer); clearInterval(N.imgTimer);
  const banner = $('#banner'), modal = $('#alert');
  const top = N.queue[0];
  if (!top) { banner.classList.remove('show'); modal.classList.add('hidden'); return; }
  if (top.duracion > 0) {
    const left = top.duracion * 1000 - (Date.now() - top.at.getTime());
    N.closeTimer = setTimeout(() => closeNotif(top.id, false), Math.max(1000, left));
  }
  if (top.nivel === 'info') {
    modal.classList.add('hidden');
    banner.replaceChildren(icon(top.icono), h('div', null, h('b', null, top.titulo), top.mensaje ? h('div', { class: 'small' }, top.mensaje) : null));
    banner.onclick = () => closeNotif(top.id, true);
    banner.classList.add('show');
    return;
  }
  banner.classList.remove('show');
  const card = $('#alert-card');
  modal.className = 'alert ' + top.nivel;
  const parts = [h('div', { class: 'alert-head' },
    h('div', { class: 'alert-icon' }, icon(top.icono)),
    h('div', { class: 'alert-title' }, h('div', null, top.titulo), h('div', { class: 'alert-time' }, hhmm(top.at))),
    h('button', { class: 'icon-btn', onclick: () => closeNotif(top.id, true) }, icon('mdi-close')))];
  if (top.mensaje) parts.push(h('div', { class: 'alert-msg' }, top.mensaje));
  if (top.imagen) {
    const img = h('img', { class: 'alert-img', alt: '' });
    img.onerror = () => img.remove();
    const src = () => {
      const st = S.states[top.imagen];
      const u = st ? absUrl(st.attributes.entity_picture) : top.imagen;
      if (!u) return;
      img.src = u.startsWith('data:') ? u : u + (u.includes('?') ? '&' : '?') + (st && domain(top.imagen) === 'camera' ? 'width=640&' : '') + '_t=' + Date.now();
    };
    src();
    if (S.states[top.imagen] && domain(top.imagen) === 'camera') N.imgTimer = setInterval(src, 2000);
    parts.push(img);
  }
  const acts = top.acciones.length ? top.acciones : [{ texto: 'Entendido', icono: 'mdi-check' }];
  parts.push(h('div', { class: 'alert-actions' }, acts.map((a, i) => {
    const run = () => runNotifAction(top, a);
    const cls = 'big-action ' + (a.estilo === 'peligro' || a.estilo === 'danger' ? 'danger' : (a.estilo === 'primario' || i === 0) ? 'primary' : '');
    if (a.confirmar) { const b = confirmBtn(a.icono || 'mdi-check', a.texto, run); b.className = cls; return b; }
    return h('button', { class: cls, onclick: run }, a.icono ? icon(a.icono) : null, a.texto);
  })));
  const more = N.queue.filter((n) => n.nivel !== 'info').length - 1;
  if (more > 0) parts.push(h('div', { class: 'alert-more' }, `+${more} aviso${more > 1 ? 's' : ''} más`));
  card.replaceChildren(...parts);
  modal.classList.remove('hidden');
}

async function runNotifAction(n, a) {
  if (a.servicio) {
    const [dom, svc] = String(a.servicio).split('.');
    const r = await call(dom, svc, a.datos, a.entidad);
    if (r === null) return;                          // falló: el aviso sigue abierto para reintentar
    toast(`${a.texto} ✓`);
  }
  conn.send({ type: 'fire_event', event_type: 'panel_notificacion_accion', event_data: { id: n.id, accion: a.texto } }).catch(() => {});
  closeNotif(n.id, true);
}

/* Campana con el historial de avisos */
function renderBell() {
  const b = $('#bell');
  b.classList.toggle('hidden', !N.history.length);
  $('#bell-count').textContent = N.unread > 0 ? N.unread : '';
}
function openHistory() {
  N.unread = 0; renderBell();
  closeSheet();
  const rows = N.history.map((n) => h('div', { class: 'hist-row ' + n.nivel }, icon(n.icono),
    h('div', { class: 'hist-text' }, h('b', null, n.titulo), n.mensaje ? h('div', { class: 'muted small' }, n.mensaje) : null),
    h('span', { class: 'muted small' }, hhmm(n.at))));
  $('#sheet-card').replaceChildren(
    h('div', { class: 'sheet-head' }, h('div', { class: 'tile-icon' }, icon('mdi-bell')), h('div', { class: 'sheet-title' }, 'Avisos'),
      h('button', { class: 'icon-btn', onclick: closeSheet }, icon('mdi-close'))),
    h('div', { class: 'sheet-body' }, rows.length ? rows : h('div', { class: 'muted' }, 'No hay avisos'),
      rows.length ? h('button', { class: 'big-action', onclick: clearHistory }, icon('mdi-delete-sweep'), 'Borrar todos') : null));
  $('#sheet').classList.remove('hidden');
  S.sheetId = 'avisos';
}
/** Vacía el historial de la campana (los avisos que sigan abiertos en pantalla no se tocan). */
function clearHistory() {
  N.history = []; N.unread = 0;
  renderBell();
  closeSheet();
  toast('Avisos borrados');
}

/* Sonidos generados con Web Audio (no hacen falta archivos) */
function tone(freqs, dur) {
  try {
    const ctx = N.ctx || (N.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.02;
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.6 * SET.sound.volume / 100), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
      t += dur;
    }
  } catch (e) { /* sin audio */ }
}
function playSound(nivel) {
  stopSound();
  if (!SET.sound.enabled) return;
  if (nivel === 'critico') {                           // pitido insistente hasta que lo cierres
    const beep = () => tone([880, 660, 880, 660], 0.18);
    beep(); N.soundTimer = setInterval(beep, 1500);
  } else if (nivel === 'aviso') {                      // "ding-dong" cada 6 s durante 30 s
    const dd = () => tone([784, 622], 0.5);
    dd(); N.soundTimer = setInterval(dd, 6000);
    N.soundStop = setTimeout(stopSound, 30000);
  } else tone([988], 0.15);
}
function stopSound() { clearInterval(N.soundTimer); clearTimeout(N.soundStop); N.soundTimer = null; }

/* ====================== Ajustes (se guardan en Home Assistant) ======================
 * Se guardan con frontend/set_user_data en el usuario del token, así sobreviven a reinicios
 * de la Pi aunque Chromium vaya en modo incógnito. En modo demo van a localStorage. */
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
  sound: { enabled: true, volume: 70 },
  photos: { enabled: true, seconds: CFG.photoSeconds || 30 },
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
      if (DEMO) saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      else saved = (await conn.send({ type: 'frontend/get_user_data', key: SETTINGS_KEY }) || {}).value;
    } catch (e) { /* sin ajustes guardados: valores por defecto */ }
  }
  SET = mergeSettings(saved || {});
  applySettings();
}
let saveTimer;
function saveSettings() {
  applySettings();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (window.PANEL_HELPER) {        // en la Pi: se guardan en el ayudante (así la web los ve)
        const r = await fetch(HELPER + '/ajustes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SET) });
        const j = await r.json(); REMOTE.version = j.version;
      } else if (DEMO) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); } catch (e) { /* sin almacenamiento */ } }
      else await conn.send({ type: 'frontend/set_user_data', key: SETTINGS_KEY, value: SET });
      toast('Ajustes guardados');
    } catch (e) { toast('No se pudieron guardar: ' + e.message, true); }
  }, 600);
}
function applySettings() { resetIdle(); screenTick(); }

function isNight(now = new Date()) {
  const n = SET.night;
  if (!n.enabled) return false;
  const m = now.getHours() * 60 + now.getMinutes(), a = toMin(n.start), b = toMin(n.end);
  return a > b ? (m >= a || m < b) : (m >= a && m < b);
}

/* ---------- Brillo y apagado de pantalla ----------
 * Con el ayudante de la Pi (panel-helper.py en 127.0.0.1:8766) se cambia el brillo real y se apaga
 * la pantalla de verdad. Sin él, se oscurece con una capa negra (funciona en cualquier pantalla). */
const HELPER = 'http://127.0.0.1:8766';
const SCREEN = { off: false, lastTouch: Date.now(), helper: null, level: null };
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
}
/** Decide brillo y apagado: se llama cada 5 s, al tocar, al cambiar ajustes y al llegar un aviso. */
function screenTick() {
  const night = isNight(), alert = alertOpen();
  const idle = (Date.now() - SCREEN.lastTouch) / 1000;
  let off = false;
  if (!alert) {
    if (SET.screenOffMinutes > 0 && idle >= Math.max(0, SET.idleSeconds) + SET.screenOffMinutes * 60) off = true;
    if (night && SET.night.screenOff && idle >= Math.max(60, SET.idleSeconds)) off = true;
  }
  setScreenOff(off);
  setBrightness(alert ? 100 : night ? SET.night.brightness : SET.brightness);
}
function wakeScreen() { SCREEN.lastTouch = Date.now(); screenTick(); }

/* ---------- Controles de la vista Ajustes ---------- */
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

function renderSettings() {
  const pct = (v) => v + ' %';
  const bright = slider({ min: 5, max: 100, step: 5, label: 'Brillo', fmt: pct, onchange: (v) => { SET.brightness = v; saveSettings(); } });
  bright.set(SET.brightness);
  const nightBright = slider({ min: 5, max: 100, step: 5, label: 'Brillo de noche', fmt: pct, onchange: (v) => { SET.night.brightness = v; saveSettings(); } });
  nightBright.set(SET.night.brightness);
  const vol = slider({ min: 10, max: 100, step: 10, label: 'Volumen', fmt: pct, onchange: (v) => { SET.sound.volume = v; saveSettings(); tone([784, 622], 0.4); } });
  vol.set(SET.sound.volume);

  const hw = SCREEN.helper;
  const helperText = !hw ? 'No detectado: el brillo y el apagado se hacen oscureciendo la imagen'
    : hw.backlight ? 'Brillo real y apagado de la pantalla' : hw.power ? 'Apagado real de la pantalla; brillo por software' : 'Detectado, pero esta pantalla no se puede controlar';

  return [h('div', { class: 'settings' },
    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-monitor'), 'Pantalla'),
      bright,
      setBlock('Modo ambiente', 'Tiempo sin tocar la pantalla hasta mostrar el reloj',
        segmented([[0, 'Nunca'], [30, '30 s'], [60, '1 min'], [90, '1,5 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']],
          SET.idleSeconds, (v) => { SET.idleSeconds = v; saveSettings(); })),
      setBlock('Apagar la pantalla', 'Tiempo en modo ambiente hasta apagarla. Se enciende al tocarla o si llega un aviso',
        segmented([[0, 'Nunca'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h']],
          SET.screenOffMinutes, (v) => { SET.screenOffMinutes = v; saveSettings(); })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => showAmbient() }, icon('mdi-image-filter-hdr'), 'Modo ambiente'),
        h('button', { class: 'big-action', onclick: () => { SCREEN.lastTouch = 0; setScreenOff(true); } }, icon('mdi-monitor-off'), 'Apagar ahora'))),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-image-multiple'), 'Fotos del modo ambiente'),
      setRow('Mostrar fotos',
        PHOTOS.length ? `${PHOTOS.length} fotos cargadas` : CFG.ambientPhotos.length ? 'No se han podido cargar las fotos' : 'Pon un álbum de Immich en ambientPhotos (config.js)',
        switchBtn(SET.photos.enabled, (v) => { SET.photos.enabled = v; saveSettings(); nextBackground(); })),
      setBlock('Cambiar de foto cada', null,
        segmented([[15, '15 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min']],
          SET.photos.seconds, (v) => { SET.photos.seconds = v; saveSettings(); nextBackground(); })),
      CFG.ambientPhotos.length ? h('div', { class: 'btn-row' },
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
      setRow('Sonido', 'Ding-dong en los avisos y pitido en los críticos', switchBtn(SET.sound.enabled, (v) => { SET.sound.enabled = v; saveSettings(); })),
      vol,
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => onNotif({ data: { id: 'prueba_ajustes', titulo: 'Aviso de prueba', mensaje: 'Así se ven los avisos que lances desde Home Assistant', nivel: 'aviso', icono: 'mdi:bell-ring', duracion: 15 } }) },
          icon('mdi-bell-badge'), 'Probar aviso'))),

    h('div', { class: 'card set-card' }, h('div', { class: 'set-title' }, icon('mdi-information-outline'), 'Panel'),
      setRow('Home Assistant', DEMO ? 'Modo demo (sin conexión real)' : CFG.haUrl,
        h('span', { class: 'pill' + (S.connected ? ' ok' : '') }, S.connected ? 'Conectado' : 'Desconectado')),
      setRow('Control de pantalla', helperText, h('span', { class: 'pill' + (hw ? ' ok' : '') }, hw ? 'Ayudante' : 'Software')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'big-action', onclick: () => location.reload() }, icon('mdi-refresh'), 'Recargar panel'))))];
}

/* ====================== Navegación y renderizado ====================== */
function renderRail() {
  const rail = $('#rail');
  const items = Object.entries(VIEWS).filter(([, v]) => !v.rail && (!v.visible || v.visible()));
  rail.replaceChildren(...items.map(([key, v]) => {
    const btn = h('button', { class: 'rail-btn' + (S.view === key ? ' active' : ''), onclick: () => go(key) }, icon(v.icon), v.title);
    if (key === 'scooter') {          // mini rayo sobre el icono mientras el patinete carga
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
function render() {
  B.view.clear();
  S.viewTimers.forEach(clearInterval); S.viewTimers = [];
  let v = VIEWS[S.view];
  if (v.visible && !v.visible()) { S.view = 'home'; v = VIEWS.home; }
  $('#view-title').textContent = v.title;
  $('#settings-btn').classList.toggle('active', S.view === 'settings');
  const view = $('#view');
  const scroll = view.scrollTop;
  view.replaceChildren(...v.render());
  view.scrollTop = scroll;
  renderRail();
}
function go(view) {
  if (S.view !== view) { S.view = view; $('#view').scrollTop = 0; }
  render();
}

/* ====================== Modo ambiente ====================== */
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (SET.idleSeconds > 0) idleTimer = setTimeout(() => !S.sheetId && !alertOpen() && showAmbient(), SET.idleSeconds * 1000);
}
function showAmbient() {
  closeSheet();
  S.ambient = true;
  renderAmbientChips();
  if (photosOn()) nextBackground();
  $('#ambient').classList.add('show');
}
/** Sale del modo ambiente a Inicio, o a la vista de la burbuja que se haya tocado. */
function hideAmbient(view = 'home') {
  S.ambient = false;
  $('#ambient').classList.remove('show');
  if (!VIEWS[view] || (VIEWS[view].visible && !VIEWS[view].visible())) view = 'home';
  if (S.view !== view) go(view); else render();
  resetIdle();
}
function renderAmbientChips() {
  if (!S.ambient) return;
  const chips = [];
  const wid = weatherId();
  if (wid) {
    const w = S.states[wid];
    chips.push(h('div', { class: 'amb-chip', 'data-go': 'home' }, icon(wIcon(w.state)), `${fmtNum(w.attributes.temperature)}° ${wText(w.state)}`));
  }
  for (const p of printers().filter(pActive)) {
    const prog = num(p.e.progress), r = pRemaining(p);
    chips.push(h('div', { class: 'amb-chip amb-print', 'data-go': 'printers' }, icon('mdi-printer-3d-nozzle'),
      h('span', null, `${p.name} `, h('b', null, isNaN(prog) ? '—' : Math.round(prog) + ' %'),
        r > 0 ? ` · ${fmtDuration(r)}` : ''),
      h('span', { class: 'amb-bar' }, h('span', { style: `width:${isNaN(prog) ? 0 : prog}%` }))));
  }
  const k = scooterIds();
  if (k.battery_level) {
    const b = num(k.battery_level);
    const m = chargeMode(k);
    // Siempre el patinete; si carga, un rayito a la derecha (amarillo cargando, verde cargado)
    chips.push(h('div', { class: 'amb-chip' + (m === 'charged' ? ' charged' : ''), 'data-go': 'scooter' },
      icon('mdi-scooter'), `${isNaN(b) ? '—' : Math.round(b)} %`, m ? icon('mdi-lightning-bolt', 'amb-bolt') : null));
  }
  const playing = ids((id) => domain(id) === 'media_player' && S.states[id].state === 'playing');
  if (playing.length) chips.push(h('div', { class: 'amb-chip', 'data-go': 'media' }, icon('mdi-music'), S.states[playing[0]].attributes.media_title || nameOf(playing[0])));
  const lightsOn = ids((id) => domain(id) === 'light' && S.states[id].state === 'on').length;
  if (lightsOn) chips.push(h('div', { class: 'amb-chip', 'data-go': 'rooms' }, icon('mdi-lightbulb-on'), `${lightsOn} encendida${lightsOn > 1 ? 's' : ''}`));
  $('#amb-chips').replaceChildren(...chips);
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
const monthYear = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : cap(d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })); };
// size=preview: ~1440 px, suficiente para la pantalla y ligero para la Pi. c = thumbhash (como la web de Immich, para la caché)
const immichUrl = (base, id, thumbhash, auth) =>
  `${base}/api/assets/${id}/thumbnail?size=preview&edited=true${thumbhash ? '&c=' + encodeURIComponent(thumbhash) : ''}&${auth}`;

/** Fotos de un álbum. Immich 1.x/2.x las trae en /albums/<id>; Immich 3 las da por la línea de tiempo (por meses). */
async function immichAlbumPhotos(base, albumId, auth, headers) {
  const album = await getJSON(`${base}/api/albums/${albumId}?${auth}`, headers);
  if (album.assets && album.assets.length) {
    return album.assets.filter((a) => a.type === 'IMAGE' && !a.isTrashed).map((a) => {
      const ex = a.exifInfo || {};
      return { url: immichUrl(base, a.id, a.thumbhash, auth), caption: [monthYear(ex.dateTimeOriginal || a.localDateTime || a.fileCreatedAt), ex.city].filter(Boolean).join(' · ') };
    });
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
  return out;
}
/** Devuelve las fotos si la URL es de Immich, o null si es una foto normal. */
async function loadImmich(src) {
  for (const [re, param] of IMMICH_SHARED) {
    const m = src.match(re);
    if (!m) continue;
    const base = m[1], auth = `${param}=${encodeURIComponent(m[2])}`;
    const link = await getJSON(`${base}/api/shared-links/me?${auth}`);
    if (link.album) return immichAlbumPhotos(base, link.album.id, auth);
    return (link.assets || []).filter((a) => a.type === 'IMAGE').map((a) => ({ url: immichUrl(base, a.id, a.thumbhash, auth), caption: monthYear(a.localDateTime || a.fileCreatedAt) }));
  }
  const m = src.match(IMMICH_ALBUM);
  if (m) {
    if (!CFG.immichApiKey) throw new Error('para un álbum privado pon immichApiKey en config.js, o usa un enlace compartido');
    return immichAlbumPhotos(m[1], m[2], 'apiKey=' + encodeURIComponent(CFG.immichApiKey), { 'x-api-key': CFG.immichApiKey });
  }
  return null;
}
async function loadPhotos() {
  photosAt = Date.now();
  const out = [];
  for (const src of CFG.ambientPhotos) {
    try {
      const im = await loadImmich(String(src).trim());
      out.push(...(im || [{ url: src, caption: '' }]));
    } catch (e) {
      console.warn('Fotos', src, e);
      toast('Immich: ' + (e.message === 'Failed to fetch' ? 'no se pudo conectar (¿URL o CORS?)' : e.message), true);
    }
  }
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  PHOTOS = out; photoIdx = 0;
  // Si no se pudo cargar (p. ej. el ayudante aún arrancando), se reintenta en 30 s en vez de en 1 h
  if (!out.length && CFG.ambientPhotos.length) photosAt = Date.now() - 3600e3 + 30e3;
  $('#amb-next').classList.toggle('hidden', !photosOn());
}
const photosOn = () => SET.photos.enabled && PHOTOS.length > 0;

let bgFront = 'a', bgTimer;
const GRADIENTS = [
  [0, 'linear-gradient(160deg,#0b1026,#1b1f3b 55%,#2a1f3d)'], [6, 'linear-gradient(160deg,#ffb88c,#de6262 60%,#5b2a5c)'],
  [9, 'linear-gradient(160deg,#4facfe,#2b5876 70%,#1a2a44)'], [18, 'linear-gradient(160deg,#f7971e,#c0392b 50%,#3a1c4a)'],
  [21, 'linear-gradient(160deg,#141e30,#243b55)'],
];
function nextBackground() {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(nextBackground, (photosOn() ? SET.photos.seconds : CFG.ambientPhotos.length && !PHOTOS.length ? 30 : 600) * 1000);
  if (CFG.ambientPhotos.length && Date.now() - photosAt > 3600e3) {   // el álbum se refresca cada hora
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
        el.style.backgroundImage = `url("${p.url}")`;
        el.classList.add('photo', 'visible'); front.classList.remove('visible'); bgFront = back;
        caption.textContent = p.caption;
      };
      // Foto sin versión grande en el servidor (o caída): se salta, hasta 50 seguidas
      img.onerror = () => { p.bad = true; if (++tries < 50) show(); };
      img.src = p.url;
    };
    show();
  } else {
    caption.textContent = '';
    const hr = new Date().getHours();
    const g = GRADIENTS.filter(([from]) => hr >= from).pop()[1];
    if (front.style.backgroundImage === g && !front.classList.contains('photo')) return;
    el.style.backgroundImage = g;
    el.classList.remove('photo'); el.classList.add('visible'); front.classList.remove('visible'); bgFront = back;
  }
}

/* ====================== Reloj y modo noche ====================== */
const toMin = (s) => { const [hh, mm] = s.split(':').map(Number); return hh * 60 + mm; };
function tick() {
  const now = new Date();
  const hm = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  $('#clock-mini').textContent = hm;
  $('#amb-clock').textContent = hm;
  $('#amb-date').textContent = cap(now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }));
  const wid = weatherId();
  $('#weather-mini').replaceChildren(...(wid ? [icon(wIcon(S.states[wid].state)), ' ' + fmtNum(S.states[wid].attributes.temperature) + '°'] : []));
  screenTick();   // brillo, modo noche y apagado (con un aviso abierto, pantalla encendida y a tope)
}

/* ====================== Web de configuración (ayudante de la Pi) ======================
 * La web http://<pi>.local:8080 guarda la configuración en el ayudante. El panel le pregunta cada 5 s:
 * si la versión cambia se recarga, y ejecuta las órdenes del «mando a distancia». */
const REMOTE = { version: window.PANEL_HELPER ? window.PANEL_HELPER.version : null, command: null, seeded: false };
const SEED_KEYS = ['haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
  'excludePlatforms', 'printerPlugs'];
async function seedHelper() {
  if (!window.PANEL_HELPER || REMOTE.seeded || DEMO) return;
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
function runRemote(type) {
  if (type === 'recargar') location.reload();
  else if (type === 'ambiente') showAmbient();
  else if (type === 'inicio') { hideAmbient('home'); wakeScreen(); }
  else if (type === 'pantalla_off') { SCREEN.lastTouch = 0; setScreenOff(true); }
  else if (type === 'pantalla_on') { wakeScreen(); }
}
async function pollHelper() {
  if (!window.PANEL_HELPER) {
    // En la Pi: si el ayudante arrancó después que el panel, recargar para usar su configuración
    if (location.protocol === 'file:') fetch(HELPER + '/status', { cache: 'no-store' }).then(() => location.reload()).catch(() => {});
    return;
  }
  try {
    const r = await (await fetch(HELPER + '/poll', { cache: 'no-store' })).json();
    if (REMOTE.command === null) REMOTE.command = r.command.id;          // al arrancar no se repiten órdenes viejas
    else if (r.command.id !== REMOTE.command) { REMOTE.command = r.command.id; runRemote(r.command.type); }
    if (REMOTE.version !== null && r.version !== REMOTE.version) location.reload();   // cambiaron la config desde la web
    REMOTE.version = r.version;
  } catch (e) { /* ayudante reiniciándose */ }
}

/* ====================== Arranque ====================== */
async function loadAll() {
  const safe = (p) => p.catch(() => []);
  const [states, areas, devs, ents] = await Promise.all([
    conn.send({ type: 'get_states' }),
    safe(conn.send({ type: 'config/area_registry/list' })),
    safe(conn.send({ type: 'config/device_registry/list' })),
    safe(conn.send({ type: 'config/entity_registry/list' })),
  ]);
  S.states = {}; S.ents = {}; S.devs = {};
  states.forEach((s) => (S.states[s.entity_id] = s));
  S.areas = areas; S.areaById = Object.fromEntries(areas.map((a) => [a.area_id, a]));
  devs.forEach((d) => (S.devs[d.id] = d));
  ents.forEach((e) => (S.ents[e.entity_id] = e));
  printersCache = null;
  S.vacuumDevs = new Set(ents.filter((e) => domain(e.entity_id) === 'vacuum' && e.device_id).map((e) => e.device_id));
  await conn.subscribe('state_changed', (ev) => setState(ev.data.entity_id, ev.data.new_state));
  await conn.subscribe('panel_notificacion', onNotif);
  await conn.subscribe('panel_notificacion_cerrar', onNotifClose);
  S.forecastAt = 0;
  await loadSettings();
  seedHelper();
  if (!S.sheetId) render();
  tick();
}

function start() {
  // El puntero solo se oculta en el kiosko de la Pi (abierto como file://) o con ?kiosk en la URL
  if (CFG.hideCursor && (location.protocol === 'file:' || PARAMS.has('kiosk'))) document.body.classList.add('no-cursor');
  if (DEMO) $('#demo-badge').classList.remove('hidden');
  conn.onstatus = (ok, msg) => {
    S.connected = ok;
    $('#conn').classList.toggle('ok', ok);
    if (msg) toast(msg, true);
  };
  conn.onready = () => loadAll().catch((e) => toast('Error cargando datos: ' + e.message, true));
  conn.connect();

  $('#view').replaceChildren(empty('mdi-home-assistant', 'Conectando con Home Assistant…'));
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#bell').addEventListener('click', openHistory);
  $('#settings-btn').addEventListener('click', () => go('settings'));
  // Tocar el fondo vuelve a Inicio; tocar una burbuja abre su vista (patinete, impresoras, música…)
  $('#ambient').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.target.closest('#amb-next')) { e.stopPropagation(); nextBackground(); resetIdle(); return; }
    const chip = e.target.closest('.amb-chip[data-go]');
    hideAmbient(chip ? chip.dataset.go : 'home');
  });
  document.addEventListener('pointerdown', () => { SCREEN.lastTouch = Date.now(); resetIdle(); }, true);
  $('#blackout').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); wakeScreen(); });
  helperInit();
  setInterval(pollHelper, 5000);

  tick(); setInterval(tick, 5000);
  if (CFG.ambientPhotos.length) loadPhotos().then(nextBackground); else nextBackground();
  // Refresca textos relativos ("hace 5 min") y el saludo de vez en cuando
  setInterval(() => !S.sheetId && !S.ambient && render(), 5 * 60e3);
  if (PARAMS.has('ambient')) showAmbient(); else resetIdle();
}
start();
