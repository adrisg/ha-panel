/* Modo demo: imita la API WebSocket de Home Assistant con datos falsos,
 * para diseñar y probar el panel sin conectarlo a nada. */
'use strict';

window.createDemoConn = function () {
  const now = () => new Date().toISOString();
  const svg = (body, w = 640, hgt = 360) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">${body}</svg>`);
  const camImg = (label, c1, c2) => svg(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="640" height="360" fill="url(#g)"/><rect x="60" y="150" width="200" height="210" fill="#00000055"/>` +
    `<rect x="380" y="190" width="200" height="170" fill="#00000040"/><text x="20" y="34" fill="#fff" font-family="monospace" font-size="20">${label}</text>`);
  const art = (c1, c2) => svg(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="#ffffff30"/><circle cx="150" cy="150" r="14" fill="#ffffff90"/>`, 300, 300);

  const areas = [['salon', 'Salón'], ['cocina', 'Cocina'], ['dormitorio', 'Dormitorio'], ['entrada', 'Entrada'], ['exterior', 'Exterior']]
    .map(([area_id, name]) => ({ area_id, name }));
  const devices = [{ id: 'dev_scooter', name: 'Patinete', name_by_user: null, area_id: 'entrada' },
    { id: 'dev_bambu', name: 'Bambu P1S', name_by_user: null, area_id: null },
    { id: 'dev_snap', name: 'Snapmaker U1', name_by_user: null, area_id: null }];
  const ents = [];
  const states = {};

  function add(entity_id, state, attributes, reg = {}) {
    states[entity_id] = { entity_id, state: String(state), attributes, last_changed: now(), last_updated: now(), context: {} };
    ents.push(Object.assign({ entity_id, area_id: null, device_id: null, entity_category: null, hidden_by: null, disabled_by: null, platform: 'demo' }, reg));
  }

  // Luces y enchufes
  add('light.salon_techo', 'on', { friendly_name: 'Salón Techo', brightness: 190, color_temp_kelvin: 3200, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, supported_color_modes: ['color_temp', 'hs'], color_mode: 'color_temp' }, { area_id: 'salon' });
  add('light.salon_lampara', 'on', { friendly_name: 'Salón Lámpara', brightness: 120, rgb_color: [255, 147, 41], supported_color_modes: ['hs'], color_mode: 'hs' }, { area_id: 'salon' });
  add('light.cocina', 'off', { friendly_name: 'Cocina Encimera', supported_color_modes: ['brightness'] }, { area_id: 'cocina' });
  add('light.dormitorio', 'off', { friendly_name: 'Dormitorio Techo', supported_color_modes: ['color_temp', 'hs'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 }, { area_id: 'dormitorio' });
  add('light.entrada', 'off', { friendly_name: 'Entrada Luz', supported_color_modes: ['onoff'] }, { area_id: 'entrada' });
  add('light.jardin', 'off', { friendly_name: 'Luces jardín', supported_color_modes: ['onoff'] }, { area_id: 'exterior' });
  add('switch.cafetera', 'off', { friendly_name: 'Cafetera', icon: 'mdi:coffee-maker' }, { area_id: 'cocina' });
  add('fan.dormitorio', 'off', { friendly_name: 'Dormitorio Ventilador', percentage: 40 }, { area_id: 'dormitorio' });
  add('cover.salon_persiana', 'open', { friendly_name: 'Salón Persiana', current_position: 70 }, { area_id: 'salon' });
  add('climate.salon', 'heat', { friendly_name: 'Salón Termostato', current_temperature: 20.5, temperature: 21.5, current_humidity: 47, hvac_modes: ['off', 'heat', 'cool', 'auto'], min_temp: 7, max_temp: 30, target_temp_step: 0.5 }, { area_id: 'salon' });
  add('lock.puerta', 'locked', { friendly_name: 'Entrada Cerradura' }, { area_id: 'entrada' });
  add('vacuum.robot', 'docked', { friendly_name: 'Robot aspirador', battery: 76, charging: true, icon: 'mdi:sleep', selected_map: 'Mapa 1',
    rooms: { 'Mapa 1': [
      { id: 1, name: 'Pasillo', icon: 'mdi:foot-print' }, { id: 2, name: 'Cocina', icon: 'mdi:chef-hat' },
      { id: 3, name: 'Salón', icon: 'mdi:sofa-outline' }, { id: 4, name: 'Dormitorio', icon: 'mdi:bed-outline' },
      { id: 5, name: 'Baño', icon: 'mdi:shower' }] },
    shortcuts: { 7: { id: 7, name: 'Limpiar pasillo' }, 8: { id: 8, name: 'Cocina a fondo' } } }, { platform: 'dreame_vacuum' });

  // Multimedia y cámaras
  add('media_player.salon_tv', 'playing', { friendly_name: 'Salón TV', device_class: 'tv', media_title: 'Lo-fi para concentrarse', media_artist: 'Radio Chill', volume_level: 0.32, entity_picture: art('#ff7e5f', '#6a3093') }, { area_id: 'salon' });
  add('media_player.cocina_altavoz', 'paused', { friendly_name: 'Cocina Altavoz', media_title: 'Podcast de las mañanas', media_artist: 'Episodio 214', volume_level: 0.5, entity_picture: art('#43cea2', '#185a9d') }, { area_id: 'cocina' });
  add('camera.entrada', 'idle', { friendly_name: 'Cámara entrada', entity_picture: camImg('ENTRADA · demo', '#3a4a5c', '#1c232b') }, { area_id: 'entrada' });
  add('camera.jardin', 'idle', { friendly_name: 'Cámara jardín', entity_picture: camImg('JARDIN · demo', '#3f5f3a', '#1a2a18') }, { area_id: 'exterior' });

  // Escenas
  add('scene.cine', 'unknown', { friendly_name: 'Modo cine', icon: 'mdi:movie-open' });
  add('scene.cena', 'unknown', { friendly_name: 'Cena', icon: 'mdi:silverware-fork-knife' });
  add('scene.buenas_noches', 'unknown', { friendly_name: 'Buenas noches', icon: 'mdi:weather-night' });
  add('script.salir', 'off', { friendly_name: 'Salgo de casa', icon: 'mdi:exit-run' });

  // Sensores
  const sens = (id, v, name, dc, unit, area) => add(id, v, { friendly_name: name, device_class: dc, unit_of_measurement: unit, state_class: 'measurement' }, { area_id: area });
  sens('sensor.salon_temperatura', 21.3, 'Salón Temperatura', 'temperature', '°C', 'salon');
  sens('sensor.salon_humedad', 48, 'Salón Humedad', 'humidity', '%', 'salon');
  sens('sensor.cocina_temperatura', 23.1, 'Cocina Temperatura', 'temperature', '°C', 'cocina');
  sens('sensor.dormitorio_temperatura', 19.4, 'Dormitorio Temperatura', 'temperature', '°C', 'dormitorio');
  sens('sensor.exterior_temperatura', 14.2, 'Exterior Temperatura', 'temperature', '°C', 'exterior');
  sens('sensor.consumo', 412, 'Consumo de casa', 'power', 'W', null);
  add('binary_sensor.puerta_entrada', 'off', { friendly_name: 'Entrada Puerta', device_class: 'door' }, { area_id: 'entrada' });
  add('binary_sensor.ventana_dormitorio', 'on', { friendly_name: 'Dormitorio Ventana', device_class: 'window' }, { area_id: 'dormitorio' });
  add('binary_sensor.movimiento_salon', 'off', { friendly_name: 'Salón Movimiento', device_class: 'motion' }, { area_id: 'salon' });
  add('binary_sensor.fuga_cocina', 'off', { friendly_name: 'Cocina Fuga de agua', device_class: 'moisture' }, { area_id: 'cocina' });

  add('weather.casa', 'partlycloudy', { friendly_name: 'Casa', temperature: 16, humidity: 62, wind_speed: 12, wind_speed_unit: 'km/h' });

  // Patinete (misma estructura que crea custom_components/mi_scooter_ble)
  const sc = (key, id, v, attrs, cat = null) => add(id, v, Object.assign({ friendly_name: 'Patinete ' + attrs.n }, attrs, { n: undefined }),
    { platform: 'mi_scooter_ble', translation_key: key, device_id: 'dev_scooter', entity_category: cat });
  sc('battery_level', 'sensor.patinete_bateria', 78, { n: 'Batería', device_class: 'battery', unit_of_measurement: '%' });
  sc('voltage', 'sensor.patinete_voltaje', 39.8, { n: 'Voltaje', device_class: 'voltage', unit_of_measurement: 'V' });
  sc('power', 'sensor.patinete_potencia', 0, { n: 'Potencia', device_class: 'power', unit_of_measurement: 'W' });
  sc('remaining_range', 'sensor.patinete_autonomia', 21.4, { n: 'Autonomía', device_class: 'distance', unit_of_measurement: 'km' });
  sc('total_distance', 'sensor.patinete_total', 1534.2, { n: 'Distancia total', device_class: 'distance', unit_of_measurement: 'km' });
  sc('trip_distance', 'sensor.patinete_viaje', 6.8, { n: 'Viaje', device_class: 'distance', unit_of_measurement: 'km' });
  sc('average_speed', 'sensor.patinete_vel_media', 17.3, { n: 'Velocidad media', device_class: 'speed', unit_of_measurement: 'km/h' });
  sc('battery_temperature', 'sensor.patinete_temp_bateria', 22, { n: 'Temperatura batería', device_class: 'temperature', unit_of_measurement: '°C' });
  sc('scooter_temperature', 'sensor.patinete_temp', 24, { n: 'Temperatura', device_class: 'temperature', unit_of_measurement: '°C' });
  sc('charge_cycles', 'sensor.patinete_ciclos', 87, { n: 'Ciclos de carga' });
  sc('battery_health', 'sensor.patinete_salud', 96, { n: 'Salud batería', unit_of_measurement: '%' });
  sc('last_seen', 'sensor.patinete_visto', new Date(Date.now() - 4 * 60e3).toISOString(), { n: 'Visto', device_class: 'timestamp' }, 'diagnostic');
  sc('connected', 'binary_sensor.patinete_conectado', 'on', { n: 'Conectado', device_class: 'connectivity' });
  sc('in_range', 'binary_sensor.patinete_cerca', 'on', { n: 'Al alcance', device_class: 'presence' });
  sc('powered_on', 'binary_sensor.patinete_encendido', 'off', { n: 'Encendido', device_class: 'power' });
  sc('charging_any', 'binary_sensor.patinete_cargando', 'on', { n: 'Cargando', device_class: 'battery_charging' });
  sc('charged', 'binary_sensor.patinete_cargado', 'off', { n: 'Cargado' });
  sc('riding', 'binary_sensor.patinete_marcha', 'off', { n: 'En marcha', device_class: 'moving' });
  sc('locked', 'binary_sensor.patinete_bloqueado', 'off', { n: 'Bloqueado', device_class: 'lock' });
  for (const [key, on] of [['tail_light', 'on'], ['auto_light', 'off'], ['ambient_light', 'on'], ['cruise_control', 'off'], ['tcs', 'on'], ['intelligent_downhill', 'off'], ['hill_parking', 'on']])
    sc(key, 'switch.patinete_' + key, on, { n: key }, 'config');
  sc('charge_control', 'switch.patinete_corte_carga', 'on', { n: 'Corte de carga' }, 'config');
  sc('charge_limit', 'number.patinete_limite', 80, { n: 'Límite de carga', min: 50, max: 100, step: 5, unit_of_measurement: '%' }, 'config');
  sc('refresh', 'button.patinete_actualizar', 'unknown', { n: 'Actualizar' });

  // Impresoras 3D: una Bambu imprimiendo (bambu_lab) y una Snapmaker parada (moonraker)
  const bb = (key, id, v, attrs = {}) => add(id, v, Object.assign({ friendly_name: 'Bambu P1S ' + key }, attrs),
    { platform: 'bambu_lab', translation_key: key, device_id: 'dev_bambu' });
  const printImg = (label) => svg(
    `<rect width="640" height="480" fill="#20242c"/><rect x="120" y="330" width="400" height="40" fill="#3a404c"/>` +
    `<rect x="250" y="210" width="140" height="120" rx="8" fill="#ff8a3d"/><rect x="250" y="150" width="140" height="60" rx="8" fill="#ff8a3d" opacity=".35"/>` +
    `<rect x="290" y="40" width="60" height="70" fill="#555"/><text x="20" y="34" fill="#fff" font-family="monospace" font-size="20">${label}</text>`, 640, 480);
  bb('print_status', 'sensor.bambu_estado', 'running');
  bb('print_progress', 'sensor.bambu_progreso', 45, { unit_of_measurement: '%' });
  bb('remaining_time', 'sensor.bambu_restante', 1.35, { unit_of_measurement: 'h', device_class: 'duration' });
  bb('current_layer', 'sensor.bambu_capa', 121);
  bb('total_layers', 'sensor.bambu_capas', 268);
  bb('subtask_name', 'sensor.bambu_tarea', 'Soporte auriculares');
  bb('nozzle_temp', 'sensor.bambu_boquilla', 219.6, { unit_of_measurement: '°C' });
  bb('target_nozzle_temp', 'sensor.bambu_boquilla_obj', 220, { unit_of_measurement: '°C' });
  bb('bed_temp', 'sensor.bambu_cama', 64.8, { unit_of_measurement: '°C' });
  bb('target_bed_temp', 'sensor.bambu_cama_obj', 65, { unit_of_measurement: '°C' });
  bb('camera', 'camera.bambu_camara', 'streaming', { entity_picture: printImg('P1S · demo') });
  add('image.bambu_portada', 'now', { friendly_name: 'Bambu P1S Portada', entity_picture: svg(
    '<rect width="200" height="200" fill="#f4f4f4"/><path d="M40 150 L100 40 L160 150 Z" fill="#ff8a3d"/><rect x="60" y="150" width="80" height="14" fill="#c86a2c"/>', 200, 200) },
    { platform: 'bambu_lab', translation_key: 'cover_image', device_id: 'dev_bambu' });
  bb('pause', 'button.bambu_pausar', 'unknown');
  bb('resume', 'button.bambu_continuar', 'unknown');
  bb('stop', 'button.bambu_detener', 'unknown');
  bb('chamber_light', 'light.bambu_luz', 'on', { supported_color_modes: ['onoff'] });
  const sm = (id, v, attrs = {}) => add(id, v, Object.assign({ friendly_name: 'Snapmaker U1 ' + id.split('.')[1].replace('snapmaker_u1_', '') }, attrs),
    { platform: 'moonraker', device_id: 'dev_snap' });
  sm('sensor.snapmaker_u1_current_print_state', 'standby');
  sm('sensor.snapmaker_u1_progress', 0, { unit_of_measurement: '%' });
  sm('sensor.snapmaker_u1_print_time_left', 0, { unit_of_measurement: 'h' });
  sm('sensor.snapmaker_u1_filename', '');
  for (const [i, n] of [['', 0], ['1', 1], ['2', 2], ['3', 3]]) {
    sm(`sensor.snapmaker_u1_extruder${i}_temperature`, 26, { unit_of_measurement: '°C' });
    sm(`number.snapmaker_u1_extruder${i}_target`, 0, { unit_of_measurement: '°C' });
    sm(`binary_sensor.snapmaker_u1_e${n}_filament`, n === 3 ? 'off' : 'on', { device_class: 'occupancy' });
  }
  sm('sensor.snapmaker_u1_bed_temperature', 23, { unit_of_measurement: '°C' });
  sm('number.snapmaker_u1_bed_target', 0, { unit_of_measurement: '°C' });
  sm('sensor.snapmaker_u1_cavity_temp', 27, { unit_of_measurement: '°C' });
  sm('button.snapmaker_u1_pause_print', 'unknown');
  sm('button.snapmaker_u1_resume_print', 'unknown');
  sm('button.snapmaker_u1_cancel_print', 'unknown');
  sm('camera.lava_case', 'idle', { entity_picture: printImg('U1 · demo') });
  sm('light.snapmaker_u1_led_cavity_led', 'off', { supported_color_modes: ['onoff'] });
  add('image.snapmaker_u1_thumb', 'unknown', { friendly_name: 'Snapmaker U1 Thumb' });
  // Enchufes de las impresoras (otra integración, como tus Ikea por Zigbee2MQTT)
  add('switch.ikea_plug_bambu_p1s', 'on', { friendly_name: 'Ikea Plug - Bambu P1S' }, { platform: 'mqtt', device_id: 'dev_plug_bambu' });
  add('sensor.ikea_plug_bambu_p1s_power', 148, { friendly_name: 'Ikea Plug - Bambu P1S Potencia', device_class: 'power', unit_of_measurement: 'W' }, { platform: 'mqtt', device_id: 'dev_plug_bambu' });
  add('switch.ikea_plug_snapmaker_u1', 'off', { friendly_name: 'Ikea Plug - Snapmaker U1' }, { platform: 'mqtt', device_id: 'dev_plug_snap' });

  /* ---------- Simulación ---------- */
  const listeners = {};
  const conn = { onstatus() {}, onready() {} };
  function update(id, state, attrs) {
    const old = states[id];
    const st = { ...old, state: state == null ? old.state : String(state), attributes: { ...old.attributes, ...(attrs || {}) }, last_updated: now() };
    if (st.state !== old.state) st.last_changed = now();
    states[id] = st;
    const l = listeners.state_changed;
    if (l) setTimeout(() => l({ data: { entity_id: id, new_state: st, old_state: old } }), 120);
  }
  const ONOFF = ['light', 'switch', 'fan', 'input_boolean'];
  function service(dom, svc, data, ids) {
    for (const id of ids) {
      const s = states[id];
      if (!s) continue;
      if (ONOFF.includes(dom)) {
        const on = svc === 'toggle' ? s.state !== 'on' : svc === 'turn_on' ? true : svc === 'turn_off' ? false : s.state === 'on';
        const a = {};
        if (data.brightness_pct != null) a.brightness = Math.round(data.brightness_pct * 2.55);
        else if (on && dom === 'light' && s.attributes.brightness == null && (s.attributes.supported_color_modes || []).some((m) => m !== 'onoff')) a.brightness = 200;
        if (data.color_temp_kelvin) Object.assign(a, { color_temp_kelvin: data.color_temp_kelvin, rgb_color: null });
        if (data.rgb_color) a.rgb_color = data.rgb_color;
        if (data.percentage != null) a.percentage = data.percentage;
        update(id, svc === 'set_percentage' ? (data.percentage > 0 ? 'on' : 'off') : on ? 'on' : 'off', a);
      } else if (dom === 'cover') {
        let pos = s.attributes.current_position;
        if (svc === 'open_cover' || (svc === 'toggle' && s.state === 'closed')) pos = 100;
        else if (svc === 'close_cover' || svc === 'toggle') pos = 0;
        else if (svc === 'set_cover_position') pos = data.position;
        if (svc !== 'stop_cover') update(id, pos > 0 ? 'open' : 'closed', { current_position: pos });
      } else if (dom === 'climate') {
        if (svc === 'set_temperature') update(id, null, { temperature: data.temperature });
        if (svc === 'set_hvac_mode') update(id, data.hvac_mode);
      } else if (dom === 'media_player') {
        if (svc === 'media_play_pause') update(id, s.state === 'playing' ? 'paused' : 'playing');
        if (svc === 'volume_set') update(id, null, { volume_level: data.volume_level });
        if (svc === 'toggle') update(id, s.state === 'off' ? 'playing' : 'off');
        if (svc === 'media_next_track') update(id, 'playing', { media_title: 'Siguiente canción ' + Math.floor(Math.random() * 99) });
        if (svc === 'media_previous_track') update(id, 'playing', { media_title: 'Canción anterior' });
      } else if (dom === 'lock') update(id, svc === 'lock' ? 'locked' : 'unlocked');
      else if (dom === 'vacuum') update(id, { start: 'cleaning', pause: 'paused', return_to_base: 'returning' }[svc] || s.state, { charging: false });
      else if (dom === 'dreame_vacuum') update(id, 'cleaning', { charging: false });
      else if (dom === 'number') update(id, data.value);
      else if (dom === 'button' && id === 'button.bambu_pausar') update('sensor.bambu_estado', 'pause');
      else if (dom === 'button' && id === 'button.bambu_continuar') update('sensor.bambu_estado', 'running');
      else if (dom === 'button' && id === 'button.bambu_detener') { update('sensor.bambu_estado', 'idle'); update('sensor.bambu_progreso', 0); }
      else if (dom === 'button') update('sensor.patinete_visto', new Date().toISOString());
    }
  }
  function forecast() {
    const conds = ['sunny', 'partlycloudy', 'rainy', 'cloudy', 'sunny', 'windy'];
    return conds.map((c, i) => ({ datetime: new Date(Date.now() + i * 86400e3).toISOString(), condition: c, temperature: 15 + ((i * 3) % 7), templow: 7 + (i % 4) }));
  }
  function history(id) {
    const out = [], s = states[id], base = parseFloat(s.state), t1 = Date.now() / 1000;
    if (isNaN(base)) {
      for (let i = 6; i >= 0; i--) out.push({ s: i % 2 ? 'on' : 'off', lu: t1 - i * 3 * 3600 - Math.random() * 3000 });
    } else {
      for (let i = 96; i >= 0; i--) out.push({ s: String(+(base + Math.sin(i / 9) * base * 0.08 + (Math.random() - 0.5) * base * 0.02).toFixed(1)), lu: t1 - i * 900 });
    }
    return { [id]: out };
  }

  conn.connect = () => setTimeout(() => { conn.onstatus(true); conn.onready(); }, 300);
  conn.subscribe = (type, cb) => { listeners[type] = cb; return Promise.resolve(); };
  // Para probar avisos en demo:  createDemoConn().fire('panel_notificacion', {...})
  conn.fire = (type, data) => { const l = listeners[type]; if (l) setTimeout(() => l({ event_type: type, data }), 50); };
  conn.send = (m) => new Promise((resolve) => setTimeout(() => {
    switch (m.type) {
      case 'get_states': return resolve(Object.values(states));
      case 'config/area_registry/list': return resolve(areas);
      case 'config/device_registry/list': return resolve(devices);
      case 'config/entity_registry/list': return resolve(ents);
      case 'history/history_during_period': return resolve(history(m.entity_ids[0]));
      case 'fire_event': conn.fire(m.event_type, m.event_data || {}); return resolve({ context: {} });
      case 'call_service': {
        if (m.domain === 'weather') return resolve({ response: { [m.target.entity_id]: { forecast: forecast() } } });
        let ids = m.target ? m.target.entity_id : [];
        service(m.domain, m.service, m.service_data || {}, Array.isArray(ids) ? ids : [ids]);
        return resolve({ context: {} });
      }
      default: return resolve(null);
    }
  }, 60));

  // Pequeños cambios para que el panel "viva"
  setInterval(() => {
    update('sensor.consumo', Math.round(300 + Math.random() * 400));
    if (states['sensor.bambu_estado'].state === 'running') {
      const p = Math.min(100, parseFloat(states['sensor.bambu_progreso'].state) + 1);
      update('sensor.bambu_progreso', p);
      update('sensor.bambu_restante', +(1.35 * (100 - p) / 55).toFixed(2));
      update('sensor.bambu_capa', Math.round(268 * p / 100));
      update('sensor.bambu_boquilla', +(219 + Math.random()).toFixed(1));
      if (p >= 100) update('sensor.bambu_estado', 'finish');
    }
    const b = parseFloat(states['sensor.patinete_bateria'].state);
    if (states['binary_sensor.patinete_cargando'].state === 'on') {
      const nb = Math.min(100, b + 1);
      update('sensor.patinete_bateria', nb);
      update('sensor.patinete_potencia', nb >= 100 ? 0 : 140 + Math.round(Math.random() * 20));
      if (nb >= parseFloat(states['number.patinete_limite'].state)) {
        update('binary_sensor.patinete_cargando', 'off'); update('binary_sensor.patinete_cargado', 'on'); update('sensor.patinete_potencia', 0);
      }
    }
  }, 6000);

  return conn;
};
