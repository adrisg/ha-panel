#!/usr/bin/env python3
"""Ayudante del Panel Hogar (se ejecuta en la Raspberry Pi).

Dos servidores en un mismo programa, sin dependencias (solo Python 3):

1. 127.0.0.1:8766 — solo la propia Pi. Lo usa el panel para:
   - brillo y apagado real de la pantalla (retroiluminación o wlr-randr)
   - leer álbumes de Immich cuando su servidor no permite CORS
   - leer la configuración (incluido el token) y guardar los Ajustes

2. 0.0.0.0:8080 — tu red de casa. Web de configuración protegida con contraseña:
   http://<nombre-de-la-pi>.local:8080
   El token de Home Assistant se puede cambiar, pero nunca se envía a la web.
   También permite ver y cambiar la red de la Pi (WiFi, IP fija o automática, nombre)
   con NetworkManager (nmcli); setup-kiosk.sh da permiso solo a nmcli y hostnamectl.
   Y el altavoz Sendspin (Music Assistant): activarlo, nombre y salida de audio (ver setup-sendspin.sh).

Fuera de la Pi (Windows, macOS) o con PANEL_SIMULATE=1 funciona en MODO SIMULACIÓN: la pantalla
y la red se simulan, para probar todo en el ordenador sin tocar nada de verdad (ver dev.py).

Uso:
  python3 panel-helper.py                  # arranca (lo hace ~/kiosk-browser.sh)
  python3 panel-helper.py --set-password   # pone o cambia la contraseña de la web
"""
import argparse
import getpass
import glob
import hashlib
import hmac
import json
import ipaddress
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('PANEL_DATA', Path.home() / '.config' / 'panel-hogar'))
CONFIG_FILE = DATA / 'config.json'
PASS_FILE = DATA / 'admin.json'
SCRIPTS_DIR = DATA / 'scripts'        # scripts del panel (burbujas y tarjetas): archivos .js
SCRIPT_NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,39}\.js$')
SCRIPT_MAX = 100 * 1024
PANEL_DATA = {}                       # lo último que mandó el panel: screen e info de entidades (solo en memoria)
LOCAL_PORT = 8766
WEB_PORT = int(os.environ.get('PANEL_WEB_PORT', '8080'))
BACKLIGHT = next(iter(sorted(glob.glob('/sys/class/backlight/*'))), None)
# Simulación: fuera de Linux siempre (no hay nmcli ni retroiluminación que tocar) o si se pide
SIMULATE = os.environ.get('PANEL_SIMULATE') == '1' or not sys.platform.startswith('linux')
SIM = {'power': True, 'brightness': 100, 'ssid': 'MiCasa_5G', 'hostname': None,
       'ipv4': {'method': 'auto', 'addresses': '', 'gateway': '', 'dns': ''}}
SIM_NETS = [('MiCasa_5G', 82, True), ('MiCasa', 64, True), ('Vecino_2.4', 41, True), ('Invitados', 37, False), ('MOVISTAR_8A3F', 22, True)]

# Rutas de Immich que el panel puede leer a través del ayudante (solo lectura)
IMMICH_PATHS = ('/api/shared-links/me', '/api/albums/', '/api/timeline/buckets', '/api/timeline/bucket')
# Opciones de config.js que se pueden cambiar desde la web
PANEL_KEYS = ('mqttEnabled', 'mqttHost', 'mqttPort', 'mqttUser', 'mqttPassword', 'haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
              'excludePlatforms', 'printerPlugs', 'sensorClasses', 'cameraRefreshSeconds', 'hideUnavailable', 'photoSources')
# Álbumes compartidos de Google Fotos: solo se leen enlaces de estos dominios
GOOGLE_HOSTS = ('photos.app.goo.gl', 'photos.google.com', 'goo.gl')

LOCK = threading.Lock()
SESSIONS = {}                        # cookie -> caducidad
COMMAND = {'id': 0, 'type': None, 'value': None}    # orden para el panel (recargar, apagar pantalla, brillo…)


# ---------------------------------------------------------------- configuration
# Names from older versions (in Spanish) → the current ones. load_config() and migrate_old_names() update them.
OLD_SCRIPTS = {
    'tarjeta.js': 'card.js',
    'boton.js': 'button.js',
    'tarjeta-vehiculo.js': 'vehicle-card.js',
    'informacion.js': 'info.js',
    'impresora.js': 'printer.js',
    'vehiculo.js': 'vehicle.js',
    'tiempo.js': 'weather.js',
    'tarjeta-tiempo.js': 'weather-card.js',
    'luces.js': 'lights.js',
    'alarma.js': 'alarm.js',
    'aberturas.js': 'openings.js',
    'saludo.js': 'greeting.js',
    'reproductor.js': 'player.js',
    'musica.js': 'music.js',
    'lista.js': 'list.js',
    'impresoras-klipper.js': 'printers-klipper.js',
    'impresoras-bambu.js': 'printers-bambu.js',
    'escenas.js': 'scenes.js',
    'deslizador.js': 'slider.js',
    'camara.js': 'camera.js',
    'avisos.js': 'notices.js',
    'resumen-ejemplo.js': 'summary-example.js',
}
OLD_VALUES = {'theme': {'oscuro': 'dark', 'claro': 'light'},
              'accent': {'azul': 'blue', 'turquesa': 'teal', 'verde': 'green', 'amarillo': 'yellow', 'naranja': 'orange',
                         'rosa': 'pink', 'morado': 'purple'},
              'voiceStyle': {'onda': 'wave', 'micro': 'mic', 'luz': 'light'}}
OLD_FILES = {'voz.json': 'voice.json', 'sonido.json': 'sound.json', 'actualizaciones.json': 'updates.json'}


def _rename_scripts(x):
    """Script names inside the saved settings (bubbles, tabs, cards…), at any depth."""
    if isinstance(x, list):
        return [_rename_scripts(v) for v in x]
    if isinstance(x, dict):
        return {k: (OLD_SCRIPTS.get(v, v) if k in ('script', 'component') and isinstance(v, str) else _rename_scripts(v))
                for k, v in x.items()}
    return x


def migrate_config(cfg):
    """Settings saved by an older version → current names. Returns True if something changed."""
    before = json.dumps(cfg, sort_keys=True)
    if 'ajustes' in cfg:
        cfg['settings'] = {**cfg.pop('ajustes'), **(cfg.get('settings') or {})}
    s = cfg.get('settings') or {}
    for key, values in OLD_VALUES.items():
        if s.get(key) in values:
            s[key] = values[s[key]]
    cfg['settings'] = _rename_scripts(s)
    return json.dumps(cfg, sort_keys=True) != before


def load_config():
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    migrate_config(cfg)
    cfg.setdefault('panel', {})
    cfg.setdefault('settings', {})
    cfg.setdefault('version', 0)
    return cfg


def migrate_old_names():
    """At start: files and settings with the names of older versions (in Spanish) get the current names."""
    for old, new in OLD_FILES.items():
        if (DATA / old).exists() and not (DATA / new).exists():
            (DATA / old).rename(DATA / new)
    share = Path.home() / '.local' / 'share' / 'panel-hogar'
    if (share / 'voz').is_dir() and not (share / 'voice').exists():
        (share / 'voz').rename(share / 'voice')
    for old, new in OLD_SCRIPTS.items():   # your own copies of the built-in scripts
        if (SCRIPTS_DIR / old).exists() and not (SCRIPTS_DIR / new).exists():
            (SCRIPTS_DIR / old).rename(SCRIPTS_DIR / new)
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return
    if migrate_config(cfg):
        save_config(cfg)
        print('Settings updated to the new names.', flush=True)


def save_config(cfg, reload=True):
    """Guarda y sube la versión. reload=False: solo cambiaron ajustes que el panel aplica sin recargarse."""
    cfg['version'] = int(time.time() * 1000)
    if reload:
        cfg['reload'] = cfg['version']
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)    # lleva el token: solo para tu usuario
    except OSError:
        pass
    return cfg['version']


# ---------------------------------------------------------------- scripts del panel
def list_scripts():
    """{nombre.js: código} de los scripts guardados en la Pi."""
    out = {}
    if SCRIPTS_DIR.is_dir():
        for p in sorted(SCRIPTS_DIR.glob('*.js')):
            if SCRIPT_NAME.match(p.name):
                try:
                    out[p.name] = p.read_text(encoding='utf-8')
                except OSError:
                    pass
    return out


def script_name(name):
    name = str(name or '').strip().lower()
    if not name.endswith('.js'):
        name += '.js'
    if not SCRIPT_NAME.match(name):
        raise ValueError('nombre no válido: letras minúsculas, números, - y _ (p. ej. temperatura-salon)')
    return name


def save_script(name, code):
    name = script_name(name)
    code = str(code or '')
    if len(code.encode()) > SCRIPT_MAX:
        raise ValueError('el script es demasiado grande (máx. 100 KB)')
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SCRIPTS_DIR / (name + '.tmp')
    tmp.write_text(code, encoding='utf-8')
    os.replace(tmp, SCRIPTS_DIR / name)
    return name


def bump_version(reload=True):
    """Algo cambió: el panel lo ve en /poll y se recarga (reload) o solo vuelve a leer sus ajustes."""
    with LOCK:
        cfg = load_config()
        return save_config(cfg, reload)


def download_script(url):
    """Importar un script desde una URL https (p. ej. un raw de GitHub). Solo se descarga, no se ejecuta aquí."""
    u = urlparse(str(url or ''))
    if u.scheme != 'https' or not u.hostname:
        raise ValueError('pon una dirección https://')
    req = urllib.request.Request(url, headers={'User-Agent': 'PanelHogar'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(SCRIPT_MAX + 1)
    if len(data) > SCRIPT_MAX:
        raise ValueError('el script es demasiado grande (máx. 100 KB)')
    return data.decode('utf-8', 'replace')


def merge_source_keys(sources, current):
    """Las claves API de las fuentes de fotos no viajan a la web: vacía = la que ya había (por id)."""
    old = {s.get('id'): s for s in (current or []) if isinstance(s, dict)}
    out = []
    for src in sources or []:
        if not isinstance(src, dict):
            continue
        src = dict(src)
        src.pop('hasApiKey', None)
        if not src.get('apiKey') and old.get(src.get('id'), {}).get('apiKey'):
            src['apiKey'] = old[src['id']]['apiKey']
        out.append(src)
    return out


def clean_panel(values, current=None, keep_secret_if_empty=True):
    """Solo las claves conocidas. Token o clave de Immich vacíos = «no cambiarlos»."""
    out = dict(current or {})
    for k in PANEL_KEYS:
        if k not in values:
            continue
        if k in ('token', 'immichApiKey', 'mqttPassword') and keep_secret_if_empty and not values[k]:
            continue
        if k == 'photoSources':
            out[k] = merge_source_keys(values[k], (current or {}).get('photoSources'))
            continue
        out[k] = values[k]
    return out


# ---------------------------------------------------------------- contraseña de la web
def set_password(pw):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, 200_000)
    DATA.mkdir(parents=True, exist_ok=True)
    with open(PASS_FILE, 'w', encoding='utf-8') as f:
        json.dump({'salt': salt.hex(), 'hash': digest.hex()}, f)
    try:
        os.chmod(PASS_FILE, 0o600)
    except OSError:
        pass


def check_password(pw):
    try:
        with open(PASS_FILE, encoding='utf-8') as f:
            p = json.load(f)
    except (OSError, ValueError):
        return False
    digest = hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(p['salt']), 200_000)
    return hmac.compare_digest(digest.hex(), p['hash'])


# ---------------------------------------------------------------- pantalla
def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def _write(path, value):
    try:
        with open(path, 'w') as f:
            f.write(str(value))
        return True
    except OSError:
        return False


def _outputs():
    """Salidas de vídeo según wlr-randr (necesita estar dentro de la sesión de cage)."""
    try:
        out = subprocess.run(['wlr-randr'], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.split()[0] for line in out.splitlines() if line and not line[0].isspace()]


def set_brightness(pct):
    if SIMULATE:
        SIM['brightness'] = pct
        return True
    if not BACKLIGHT:
        return False
    top = int(_read(f'{BACKLIGHT}/max_brightness') or 255)
    return _write(f'{BACKLIGHT}/brightness', max(1, round(top * max(5, min(100, pct)) / 100)))


def set_power(on):
    if SIMULATE:
        SIM['power'] = on
        print(f'[simulación] pantalla {"encendida" if on else "apagada"}', flush=True)
        return True
    if BACKLIGHT and _write(f'{BACKLIGHT}/bl_power', 0 if on else 4):
        return True
    ok = False
    for name in _outputs():
        try:
            r = subprocess.run(['wlr-randr', '--output', name, '--on' if on else '--off'], capture_output=True, timeout=5)
            ok = ok or r.returncode == 0
        except (OSError, subprocess.SubprocessError):
            pass
    return ok


# ---------------------------------------------------------------- Home Assistant (desde la Pi)
def ha_request(method, path, body=None, ha_url=None, token=None):
    panel = load_config()['panel']
    ha_url = (ha_url or panel.get('haUrl') or '').rstrip('/')
    token = token or panel.get('token')
    if not ha_url or not token:
        return 0, {'error': 'falta la URL o el token de Home Assistant'}
    req = urllib.request.Request(ha_url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, {'error': 'token no válido' if e.code == 401 else f'HTTP {e.code}'}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, {'error': f'no se pudo conectar: {getattr(e, "reason", e)}'}


# ---------------------------------------------------------------- altavoz (Sendspin)
# La Pi como altavoz de Music Assistant. setup-sendspin.sh instala «sendspin» y el servicio de usuario
# panel-sendspin, que arranca «panel-helper.py --sendspin» (lee sendspin.json y lanza sendspin).
SENDSPIN_FILE = DATA / 'sendspin.json'
SENDSPIN_BIN = Path.home() / '.local' / 'share' / 'panel-hogar' / 'sendspin' / 'bin' / 'sendspin'
SENDSPIN_UNIT = 'panel-sendspin.service'
SENDSPIN_PIN = DATA / 'sendspin-pin.json'      # código para emparejar con Music Assistant (lo escribe sendspin-run.py)
SIM_SPEAKER = {'active': False}
CARD_NAMES = {'Headphones': 'Jack 3,5 mm', 'vc4hdmi0': 'HDMI 1', 'vc4hdmi1': 'HDMI 2', 'vc4hdmi': 'HDMI'}


def speaker_settings():
    try:
        s = json.loads(SENDSPIN_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        s = {}
    try:
        delay = max(0, min(5000, int(s.get('delay') or 0)))
    except (TypeError, ValueError):
        delay = 0
    entity = str(s.get('entity') or '').strip()[:120]
    watch = [str(x)[:120] for x in (s.get('watch') or []) if str(x).startswith('media_player.')][:20]
    if isinstance(s.get('npSpeakers'), list):
        np_list = [str(x)[:120] for x in s['npSpeakers'] if str(x) == '@panel' or str(x).startswith('media_player.')][:20]
    else:   # de antes: el del panel (si abría «Sonando») y luego los otros
        np_list = (['@panel'] if s.get('open', True) is not False else []) + watch
    try:   # segundos que «Sonando» sigue abierta tras pausar/parar (-1 = nunca se cierra sola)
        close_after = max(-1, min(3600, int(s.get('closeAfter', 60))))
    except (TypeError, ValueError):
        close_after = 60
    return {'enabled': bool(s.get('enabled')), 'name': str(s.get('name') or '').strip()[:60],
            'device': str(s.get('device') or '').strip()[:120], 'delay': delay,
            'entity': entity if entity.startswith('media_player.') else '', 'open': s.get('open', True) is not False,
            'closeAfter': close_after,
            # otros altavoces que también abren «Sonando» al empezar a sonar (p. ej. el de la habitación)
            'watch': watch,
            # altavoces que abren «Sonando», por orden de prioridad ('@panel' = el de este panel)
            'npSpeakers': np_list}


def speaker_pin():
    """Código que pide Music Assistant para emparejar el altavoz, mientras se está emparejando (si no, None)."""
    if SIMULATE and SIM_SPEAKER.get('pin'):
        return SIM_SPEAKER['pin']
    try:
        p = json.loads(SENDSPIN_PIN.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(p, dict) or time.time() - float(p.get('at') or 0) > 600:   # uno viejo no vale
        return None
    return str(p.get('code') or '')[:20] or None


def speaker_panel():
    """Lo que necesita el panel: con qué nombre sale en Music Assistant y si abre el reproductor al sonar."""
    s = speaker_settings()
    return {'enabled': s['enabled'], 'name': s['name'] or speaker_default_name(), 'entity': s['entity'], 'open': s['open'],
            'closeAfter': s['closeAfter'], 'watch': s['watch'], 'npSpeakers': s['npSpeakers']}


def speaker_default_name():
    return 'Panel ' + socket.gethostname().split('.')[0]


def audio_outputs():
    """Salidas de audio: una por tarjeta (plughw convierte el formato si hace falta)."""
    outs = [{'id': '', 'name': 'La de por defecto del sistema'}]
    if SIMULATE:
        return outs + [{'id': 'plughw:CARD=Headphones,DEV=0', 'name': 'Jack 3,5 mm'},
                       {'id': 'plughw:CARD=vc4hdmi0,DEV=0', 'name': 'HDMI 1'},
                       {'id': 'plughw:CARD=vc4hdmi1,DEV=0', 'name': 'HDMI 2'}]
    code, out, _ = _run(['aplay', '-L'], timeout=5)
    lines = out.splitlines() if code == 0 else []
    for i, line in enumerate(lines):
        if not line.startswith('plughw:CARD='):
            continue
        card = line.split('=', 1)[1].split(',')[0]
        desc = lines[i + 1].strip().split(',')[0] if i + 1 < len(lines) else card
        outs.append({'id': line.strip(), 'name': CARD_NAMES.get(card, desc or card)})
    return outs


def _user_ctl(*args):
    env = dict(os.environ, XDG_RUNTIME_DIR=os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')
    try:
        r = subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, timeout=20, env=env)
        return r.returncode, (r.stdout or '').strip(), (r.stderr or '').strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, '', str(e)


def speaker_info():
    s = speaker_settings()
    info = {'settings': s, 'defaultName': speaker_default_name(), 'outputs': audio_outputs(), 'log': '', 'pin': speaker_pin()}
    if SIMULATE:
        return dict(info, installed=True, active=SIM_SPEAKER['active'])
    info['installed'] = SENDSPIN_BIN.exists()
    info['active'] = info['installed'] and _user_ctl('is-active', SENDSPIN_UNIT)[1] == 'active'
    if info['installed'] and s['enabled']:
        env = dict(os.environ, XDG_RUNTIME_DIR=os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')
        try:
            r = subprocess.run(['journalctl', '--user-unit', SENDSPIN_UNIT, '-n', '12', '-o', 'cat', '--no-pager'],
                               capture_output=True, text=True, timeout=10, env=env)
            info['log'] = (r.stdout or '').strip()[-3000:]
        except (OSError, subprocess.SubprocessError):
            pass
    return info


def set_speaker(body):
    cur = speaker_settings()
    new = {'enabled': bool(body.get('enabled', cur['enabled'])),
           'name': str(body.get('name', cur['name']) or '').strip()[:60],
           'device': str(body.get('device', cur['device']) or '').strip()[:120],
           'delay': body.get('delay', cur['delay']),
           'entity': str(body.get('entity', cur['entity']) or '').strip()[:120],
           'open': bool(body.get('open', cur['open'])),
           'closeAfter': body.get('closeAfter', cur['closeAfter']),
           'watch': body.get('watch', cur['watch']) if isinstance(body.get('watch', cur['watch']), list) else cur['watch'],
           'npSpeakers': body['npSpeakers'] if isinstance(body.get('npSpeakers'), list) else cur['npSpeakers']}
    if new['device'] and new['device'] not in {o['id'] for o in audio_outputs()}:
        raise ValueError('esa salida de audio no existe')
    DATA.mkdir(parents=True, exist_ok=True)
    SENDSPIN_FILE.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
    new = speaker_settings()
    bump_version(reload=False)   # el panel vuelve a leer el altavoz (reproductor, abrir al sonar) sin recargarse
    if not body.get('restart') and all(new[k] == cur[k] for k in ('enabled', 'name', 'device')):
        return 'Guardado.'   # solo opciones del panel («Sonando», reproductor): el altavoz sigue sonando sin reiniciarse
    if SIMULATE:
        SIM_SPEAKER['active'] = new['enabled']
        return '[Simulación] Guardado (no suena nada en el PC).'
    if not SENDSPIN_BIN.exists():
        return 'Guardado. Falta instalarlo en la Pi: bash ~/ha-panel/scripts/setup-sendspin.sh'
    if new['enabled']:
        _user_ctl('enable', SENDSPIN_UNIT)
        code, _, err = _user_ctl('restart', SENDSPIN_UNIT)
        if code != 0:
            raise RuntimeError(f'no arrancó: {err or "mira el registro"}')
        return 'Altavoz activado. Aparecerá en Music Assistant en unos segundos.'
    _user_ctl('disable', '--now', SENDSPIN_UNIT)
    return 'Altavoz desactivado.'


def run_speaker():
    """Lo arranca el servicio panel-sendspin: lanza sendspin con los ajustes de la web."""
    s = speaker_settings()
    if not s['enabled']:
        print('Altavoz desactivado en la web (Ajustes → Altavoz).', flush=True)
        return
    # sendspin-run.py = sendspin daemon + guarda el código de emparejamiento para enseñarlo en el panel
    args = [str(SENDSPIN_BIN.parent / 'python3'), str(HERE / 'scripts' / 'sendspin-run.py'), 'daemon', '--name', s['name'] or speaker_default_name(),
            '--settings-dir', str(DATA / 'sendspin'), '--hardware-volume', 'false', '--disable-mpris',
            '--product-name', 'Panel Hogar']
    if s['device']:
        args += ['--audio-device', s['device']]
    # El desfase NO se pasa: se ajusta en Music Assistant y sendspin lo guarda; si se pasara aquí,
    # al arrancar pisaría el de Music Assistant.
    os.environ['PANEL_SENDSPIN_PIN'] = str(SENDSPIN_PIN)
    os.execv(args[0], args)


# ---------------------------------------------------------------- asistente de voz (satélite Wyoming)
# setup-voice.sh instala wyoming-satellite + microWakeWord y el servicio de usuario panel-voice, que arranca
# «panel-helper.py --voz» (lee voz.json y lanza el satélite). Micro, salida y palabra se eligen en la web o el panel.
VOICE_FILE = DATA / 'voice.json'
VOICE_PY = Path.home() / '.local' / 'share' / 'panel-hogar' / 'voice' / 'bin' / 'python'
VOICE_UNIT = 'panel-voice.service'
VOICE_PORT = 10700
WAKE_WORDS = [('okay_nabu', 'Okay Nabu'), ('hey_jarvis', 'Hey Jarvis'), ('hey_mycroft', 'Hey Mycroft'), ('alexa', 'Alexa')]
SIM_VOICE = {'active': False}


def voice_settings():
    try:
        s = json.loads(VOICE_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        s = {}
    wake = str(s.get('wake') or 'okay_nabu')
    return {'enabled': s.get('enabled', True) is not False, 'name': str(s.get('name') or '').strip()[:60],
            'mic': str(s.get('mic') or '').strip()[:120], 'output': str(s.get('output') or '').strip()[:120],
            'wake': wake if wake in dict(WAKE_WORDS) else 'okay_nabu',
            'volume': _int(s.get('volume'), 10, 100, 100),     # volumen de las respuestas (%)
            'micGain': _int(s.get('micGain'), 20, 100, 100)}   # ganancia del micro (%; solo en la web, por defecto al máximo)


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def audio_inputs():
    # Micros: uno por tarjeta que pueda grabar ('' = el primero que haya)
    ins = [{'id': '', 'name': 'Automático (el primero que haya)'}]
    if SIMULATE:
        return ins + [{'id': 'plughw:CARD=Device,DEV=0', 'name': 'USB Audio Device'}]
    code, out, _ = _run(['arecord', '-L'], timeout=5)
    lines = out.splitlines() if code == 0 else []
    for i, line in enumerate(lines):
        if line.startswith('plughw:CARD='):
            card = line.split('=', 1)[1].split(',')[0]
            desc = lines[i + 1].strip().split(',')[0] if i + 1 < len(lines) else card
            ins.append({'id': line.strip(), 'name': CARD_NAMES.get(card, desc or card)})
    return ins


def voice_info():
    s = voice_settings()
    info = {'settings': s, 'defaultName': speaker_default_name(), 'inputs': audio_inputs(), 'outputs': audio_outputs(),
            'wakeWords': [{'id': k, 'name': v} for k, v in WAKE_WORDS], 'port': VOICE_PORT, 'log': ''}
    if SIMULATE:
        return dict(info, installed=True, active=SIM_VOICE['active'])
    info['installed'] = VOICE_PY.exists()
    info['active'] = info['installed'] and _user_ctl('is-active', VOICE_UNIT)[1] == 'active'
    if info['installed']:
        env = dict(os.environ, XDG_RUNTIME_DIR=os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')
        try:
            r = subprocess.run(['journalctl', '--user-unit', VOICE_UNIT, '-n', '12', '-o', 'cat', '--no-pager'],
                               capture_output=True, text=True, timeout=10, env=env)
            info['log'] = (r.stdout or '').strip()[-3000:]
        except (OSError, subprocess.SubprocessError):
            pass
    return info


def set_voice(body):
    cur = voice_settings()
    new = {k: body.get(k, cur[k]) for k in cur}
    new['enabled'] = bool(new['enabled'])
    for k in ('name', 'mic', 'output', 'wake'):
        new[k] = str(new[k] or '').strip()[:120]
    new['volume'] = _int(new['volume'], 10, 100, 100)
    new['micGain'] = _int(new['micGain'], 20, 100, 100)
    # Solo se comprueban si cambian: cambiar el volumen no debe fallar porque el micro esté desenchufado
    if new['mic'] and new['mic'] != cur['mic'] and new['mic'] not in {o['id'] for o in audio_inputs()}:
        raise ValueError('ese micro no está conectado')
    if new['output'] and new['output'] != cur['output'] and new['output'] not in {o['id'] for o in audio_outputs()}:
        raise ValueError('esa salida de audio no existe')
    if new['wake'] not in dict(WAKE_WORDS):
        raise ValueError('palabra de activación desconocida')
    DATA.mkdir(parents=True, exist_ok=True)
    VOICE_FILE.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
    if SIMULATE:
        SIM_VOICE['active'] = new['enabled']
        return '[Simulación] Guardado (en el PC no se escucha nada).'
    if not VOICE_PY.exists():
        return 'Guardado. Falta instalarlo en la Pi: bash ~/ha-panel/scripts/setup-voice.sh'
    if new['enabled']:
        _user_ctl('enable', VOICE_UNIT)
        code, _, err = _user_ctl('restart', VOICE_UNIT)
        if code != 0:
            raise RuntimeError(f'no arrancó: {err or "mira el registro"}')
        return 'Asistente de voz activado.'
    _user_ctl('disable', '--now', VOICE_UNIT)
    return 'Asistente de voz desactivado.'


def run_voice():
    # Lo arranca el servicio panel-voice: lanza el satélite con los ajustes de la web
    s = voice_settings()
    if not s['enabled']:
        print('Asistente de voz desactivado (Ajustes → Asistente de voz).', flush=True)
        return
    mic = s['mic'] or next((o['id'] for o in audio_inputs()[1:]), '')
    if not mic:
        sys.exit('No hay ningún micro conectado.')
    out = s['output'] or 'default'
    # Muchos micros USB vienen muy bajos y no se oye la palabra: se sube la ganancia (por defecto al máximo)
    card = mic.split('CARD=', 1)[1].split(',')[0] if 'CARD=' in mic else ''
    if card:
        for ctl in ('Mic', 'Capture'):
            if _run(['amixer', '-q', '-c', card, 'sset', ctl, 'capture', f'{s["micGain"]}%', 'cap'], timeout=5)[0] == 0:
                break
    args = [str(VOICE_PY), '-m', 'wyoming_satellite', '--name', s['name'] or speaker_default_name(),
            '--uri', f'tcp://0.0.0.0:{VOICE_PORT}',
            '--mic-command', f'arecord -q -D {mic} -r 16000 -c 1 -f S16_LE -t raw',
            '--snd-command', f'aplay -q -D {out} -r 22050 -c 1 -f S16_LE -t raw',
            '--snd-volume-multiplier', str(s['volume'] / 100),
            '--wake-command', f'{VOICE_PY} -m pymicro_wakeword --model {s["wake"]}']
    print('Micro:', mic, '· Salida:', out, '· Palabra:', s['wake'], flush=True)
    os.execv(args[0], args)


# ---------------------------------------------------------------- sonido (volumen general)
# El volumen general es el de la salida de audio de la Pi (jack, USB…): afecta a todo lo que suena en ella.
# Se guarda en sonido.json y se vuelve a poner al arrancar (ALSA no lo recuerda sin sudo).
SOUND_FILE = DATA / 'sound.json'
MIXER_CTLS = ('Master', 'PCM', 'Speaker', 'Headphone', 'Digital')
SIM_SOUND = {'master': 70, 'music': 40}


def output_card():
    # La tarjeta por la que suena el panel: la del altavoz, la del asistente o la de por defecto (la 0)
    for dev in (speaker_settings()['device'], voice_settings()['output']):
        if 'CARD=' in dev:
            return dev.split('CARD=', 1)[1].split(',')[0]
    try:
        first = Path('/proc/asound/cards').read_text().splitlines()[0]
        return first.split('[', 1)[1].split(']', 1)[0].strip()
    except (OSError, IndexError):
        return ''


def master_control(card):
    code, out, _ = _run(['amixer', '-c', card, 'scontrols'], timeout=5)
    names = re.findall(r"'([^']+)'", out) if code == 0 else []
    return next((c for c in MIXER_CTLS if c in names), '')


def master_get():
    if SIMULATE:
        return {'available': True, 'value': SIM_SOUND['master'], 'card': 'Jack 3,5 mm'}
    card = output_card()
    ctl = master_control(card) if card else ''
    if not ctl:
        return {'available': False, 'value': None, 'card': CARD_NAMES.get(card, card)}
    code, out, _ = _run(['amixer', '-M', '-c', card, 'sget', ctl], timeout=5)
    m = re.search(r'\[(\d+)%\]', out) if code == 0 else None
    return {'available': True, 'value': int(m.group(1)) if m else None, 'card': CARD_NAMES.get(card, card)}


def master_set(v):
    v = _int(v, 0, 100, 70)
    DATA.mkdir(parents=True, exist_ok=True)
    SOUND_FILE.write_text(json.dumps({'master': v}), encoding='utf-8')
    if SIMULATE:
        SIM_SOUND['master'] = v
        mqtt_publish_volumes()
        return
    card = output_card()
    ctl = master_control(card) if card else ''
    if not ctl:
        raise RuntimeError('esta salida de audio no tiene volumen propio')
    _run(['amixer', '-q', '-M', '-c', card, 'sset', ctl, f'{v}%', 'unmute'], timeout=5)
    mqtt_publish_volumes()


def master_restore():
    try:
        v = json.loads(SOUND_FILE.read_text(encoding='utf-8')).get('master')
    except (OSError, ValueError):
        return
    if v is not None and not SIMULATE:
        try:
            master_set(v)
        except RuntimeError:
            pass


def sound_info():
    v = voice_settings()
    vi = voice_info() if (SIMULATE or VOICE_PY.exists()) else None
    return {'master': master_get(), 'voice': {'installed': bool(vi and vi['installed']), 'volume': v['volume'], 'micGain': v['micGain']}}


def music_entity():
    """El media_player de Home Assistant que es este altavoz: el elegido en la web o el que se llama como él."""
    s = speaker_settings()
    if s['entity']:
        return s['entity']
    name = (s['name'] or speaker_default_name()).strip()
    slug = re.sub(r'[^a-z0-9]+', '_', unicodedata.normalize('NFD', name.lower()).encode('ascii', 'ignore').decode()).strip('_')
    return 'media_player.' + slug if slug else ''


def music_get():
    """Volumen de la música (el del altavoz en Home Assistant / Music Assistant). En simulación no se toca Home Assistant."""
    ent = music_entity()
    if SIMULATE:
        return {'available': True, 'entity': ent, 'name': 'Altavoz de prueba', 'value': SIM_SOUND['music']}
    if not ent:
        return {'available': False}
    code, st = ha_request('GET', '/api/states/' + ent)
    if code != 200 or not isinstance(st, dict):
        return {'available': False, 'entity': ent}
    vol = (st.get('attributes') or {}).get('volume_level')
    return {'available': vol is not None, 'entity': ent, 'name': (st.get('attributes') or {}).get('friendly_name') or ent,
            'value': round(vol * 100) if vol is not None else None}


def music_set(v):
    v = _int(v, 0, 100, 40)
    if SIMULATE:
        SIM_SOUND['music'] = v
        mqtt_publish_volumes()
        return
    ent = music_entity()
    if not ent:
        raise RuntimeError('no se sabe qué altavoz es este panel en Home Assistant')
    code, res = ha_request('POST', '/api/services/media_player/volume_set', {'entity_id': ent, 'volume_level': v / 100})
    if code != 200:
        raise RuntimeError('Home Assistant no lo aceptó: ' + str((res or {}).get('error', code)))
    mqtt_publish_volumes()


def set_sound(body):
    if 'master' in body:
        master_set(body['master'])
    voice = {k: body[k] for k in ('voiceVolume', 'micGain') if k in body}
    if voice:
        set_voice({'volume': voice.get('voiceVolume', voice_settings()['volume']), 'micGain': voice.get('micGain', voice_settings()['micGain'])})
    return sound_info()


# ---------------------------------------------------------------- actualizaciones (git)
# Se comprueba cada 3 h si hay versión nueva en GitHub (misma rama). Según la web (Ajustes → Actualizaciones):
# solo avisar (botón «Actualizar») o actualizar sola cada día a una hora. Tras actualizar se lanza update-hook.sh
# (paquetes nuevos del sistema, etc.) y se reinician el kiosko (panel + este ayudante) y el altavoz.
UPDATES_FILE = DATA / 'updates.json'
UPDATE_HOOK = HERE / 'scripts' / 'update-hook.sh'
UPDATE_EVERY = 3 * 3600
UPD = {'checking': False, 'applying': False, 'lastCheck': 0, 'available': [], 'error': '', 'log': '', 'lastAuto': ''}
UPD_LOCK = threading.Lock()


def update_settings():
    try:
        s = json.loads(UPDATES_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        s = {}
    if not isinstance(s, dict):
        s = {}
    try:
        hour = max(0, min(23, int(s.get('hour', 4))))
    except (TypeError, ValueError):
        hour = 4
    mode = {'avisar': 'notify'}.get(s.get('mode'), s.get('mode'))   # «avisar»: the old name
    return {'mode': mode if mode in ('notify', 'auto') else 'notify', 'hour': hour}


def set_update_settings(body):
    cur = update_settings()
    new = {'mode': body.get('mode', cur['mode']), 'hour': body.get('hour', cur['hour'])}
    if new['mode'] not in ('notify', 'auto'):
        raise ValueError('modo desconocido')
    DATA.mkdir(parents=True, exist_ok=True)
    UPDATES_FILE.write_text(json.dumps(new), encoding='utf-8')
    return update_settings()


def _git(*args, timeout=60):
    try:
        r = subprocess.run(['git', '-C', str(HERE), *args], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
        return r.returncode, (r.stdout or '').strip(), (r.stderr or '').strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, '', str(e)


def git_branch():
    code, out, _ = _git('rev-parse', '--abbrev-ref', 'HEAD')
    return out if code == 0 and out != 'HEAD' else ''


def current_version():
    code, out, _ = _git('log', '-1', '--format=%h%x1f%cI%x1f%s')
    if code != 0 or not out:
        return None
    h, date, subject = (out.split('\x1f') + ['', ''])[:3]
    return {'hash': h, 'date': date, 'subject': subject}


def check_updates():
    """Mira en GitHub si hay versión nueva de la rama actual (solo descarga la información, no cambia nada)."""
    with UPD_LOCK:
        if UPD['checking']:
            return
        UPD['checking'] = True
    try:
        branch = git_branch()
        if not branch:
            UPD['error'] = 'No es una copia de git con rama (¿se instaló sin git clone?).'
            return
        code, _, err = _git('fetch', '-q', 'origin', branch, timeout=90)
        if code != 0:
            UPD['error'] = 'No se pudo comprobar: ' + (err.splitlines() or ['sin conexión'])[-1][:200]
            return
        code, out, err = _git('log', '--format=%h%x1f%s', f'HEAD..origin/{branch}')
        UPD['available'] = [dict(zip(('hash', 'subject'), line.split('\x1f', 1))) for line in out.splitlines() if line][:50]
        UPD['error'] = '' if code == 0 else err[:200]
    finally:
        UPD['lastCheck'] = time.time()
        UPD['checking'] = False


def _restart_after_update(before):
    """Sin reiniciar todo el kiosko: el panel se recarga solo (cambia la versión) y este ayudante se relanza a sí mismo.
    El altavoz solo se reinicia si ha cambiado lo suyo (para no cortar la música sin necesidad)."""
    changed = _git('diff', '--name-only', before, 'HEAD')[1].splitlines()
    hunks = _git('diff', '-U0', before, 'HEAD', '--', 'panel-helper.py')[1]
    speaker = 'scripts/sendspin-run.py' in changed or 'def run_speaker' in hunks or 'SENDSPIN' in hunks
    bump_version()                 # el panel ve la versión nueva en /poll y recarga la página
    if SIMULATE:
        return
    if speaker and SENDSPIN_BIN.exists() and _user_ctl('is-active', SENDSPIN_UNIT)[1] == 'active':
        _user_ctl('restart', SENDSPIN_UNIT)
    if ('def run_voice' in hunks or 'VOICE' in hunks) and VOICE_PY.exists() and _user_ctl('is-active', VOICE_UNIT)[1] == 'active':
        _user_ctl('restart', VOICE_UNIT)
    if 'panel-helper.py' in changed:
        sys.stdout.flush()
        os.execv(sys.executable, [sys.executable, str(HERE / 'panel-helper.py')])   # mismo proceso, código nuevo


def apply_update():
    """Actualiza a la última versión de GitHub. Se ejecuta en segundo plano; el resultado queda en UPD."""
    with UPD_LOCK:
        if UPD['applying']:
            return
        UPD['applying'] = True
    UPD['log'] = ''
    try:
        check_updates()
        if UPD['error']:
            return
        if not UPD['available']:
            UPD['log'] = 'Ya estaba al día.'
            return
        if SIMULATE:
            time.sleep(2)
            UPD['available'] = []
            UPD['log'] = '[Simulación] Actualizado (en el ordenador no se cambia nada).'
            return
        code, out, _ = _git('status', '--porcelain', '--untracked-files=no')
        if out:
            UPD['error'] = 'Hay archivos cambiados a mano en la Pi; no se actualiza para no perderlos: ' + ', '.join(
                line.split(maxsplit=1)[-1] for line in out.splitlines()[:5])
            return
        before = _git('rev-parse', 'HEAD')[1]
        code, _, err = _git('merge', '--ff-only', f'origin/{git_branch()}')
        if code != 0:
            UPD['error'] = 'No se pudo actualizar: ' + err[-200:]
            return
        log = [f'Actualizado: {before[:7]} → {_git("rev-parse", "--short", "HEAD")[1]}']
        if UPDATE_HOOK.exists():   # pasos de la versión nueva (paquetes del sistema…)
            try:
                r = subprocess.run(['bash', str(UPDATE_HOOK), before], capture_output=True, text=True, timeout=1200)
                log.append(((r.stdout or '') + (r.stderr or '')).strip())
            except (OSError, subprocess.SubprocessError) as e:
                log.append(f'update-hook.sh falló: {e}')
        UPD['log'] = '\n'.join(x for x in log if x)[-4000:]
        UPD['available'] = []
        _later(lambda: _restart_after_update(before), 3)
    finally:
        UPD['applying'] = False


# ---------------------------------------------------------------- Home Assistant por MQTT
# El panel aparece en Home Assistant como un dispositivo, por el descubrimiento de MQTT (Mosquitto): no hay que
# instalar nada en Home Assistant. Entidades (las que se elijan en la web → General): Pantalla (encendida y brillo),
# Brillo, Volumen de salida, Volumen de la música, Modo ambiente, Último toque y Recargar. Temas: panel_hogar/<id>/… y homeassistant/<tipo>/panel_hogar_<id>/<cosa>/config
HA_EXPOSE = ('screen', 'brightness', 'volume', 'music_volume', 'ambient', 'last_touch', 'reload')
PANEL_STATE = {'screen_on': None, 'brightness': None, 'ambient': None, 'last_touch': None}
HA_COMMANDS = {'screen_on': 'screen_on', 'screen_off': 'screen_off', 'ambient_on': 'ambient', 'ambient_off': 'home',
               'reload': 'reload', 'brightness': 'brightness'}
MQTT = {'client': None, 'status': 'off', 'error': ''}
MQTT_LOG = []          # lo último que ha pasado (web → General → MQTT → Registro)


def mqtt_log(text):
    line = time.strftime('%H:%M:%S ') + text
    with LOCK:
        MQTT_LOG.append(line)
        del MQTT_LOG[:-300]
    try:
        print('mqtt:', text, flush=True)
    except (OSError, UnicodeError):   # una consola rara no tumba la conexión
        pass


def panel_id():
    """Identificador estable de este panel (no cambia aunque le cambies el nombre)."""
    try:
        seed = Path('/etc/machine-id').read_text().strip()
    except OSError:
        seed = socket.gethostname()
    return hashlib.sha256(('panel-hogar:' + seed).encode()).hexdigest()[:12]


def ha_expose():
    """Lo que se ve en Home Assistant (web → General); por defecto, todo."""
    chosen = load_config()['settings'].get('haExpose') or {}
    return [k for k in HA_EXPOSE if chosen.get(k) is not False]


def set_panel_state(body):
    """El panel cuenta cómo está (pantalla, brillo, modo ambiente, último toque); si cambia, se manda por MQTT."""
    changed = {}
    with LOCK:
        for k in PANEL_STATE:
            if k in body and body[k] != PANEL_STATE[k]:
                PANEL_STATE[k] = changed[k] = body[k]
    if changed:
        mqtt_publish_state(changed)
    return True


def send_command(command, value=None):
    """Una orden de Home Assistant para el panel (le llega en su próxima consulta, como mucho en 1 s)."""
    if command not in HA_COMMANDS:
        raise ValueError('unknown command')
    if command == 'brightness':
        value = _int(value, 5, 100, 100)
    with LOCK:
        COMMAND['id'] += 1
        COMMAND['type'] = HA_COMMANDS[command]
        COMMAND['value'] = value


class MqttClient:
    """Cliente MQTT 3.1.1 mínimo (sin dependencias): conecta, publica, se suscribe y se reconecta solo."""

    def __init__(self, host, port, user, password, client_id, will, on_connect, on_message):
        self.host, self.port, self.user, self.password = host, int(port or 1883), user, password
        self.client_id, self.will, self.on_connect, self.on_message = client_id, will, on_connect, on_message
        self.sock, self.stopped, self.wlock = None, False, threading.Lock()

    @staticmethod
    def _str(s):
        b = s.encode() if isinstance(s, str) else s
        return len(b).to_bytes(2, 'big') + b

    @staticmethod
    def _packet(kind, body):
        n, rem = len(body), b''
        while True:
            byte, n = n % 128, n // 128
            rem += bytes([byte | (0x80 if n else 0)])
            if not n:
                return bytes([kind]) + rem + body

    def _send(self, data):
        with self.wlock:
            if self.sock:
                self.sock.sendall(data)

    def _recv(self, n):
        out = b''
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise ConnectionError('cerrada')
            out += chunk
        return out

    def _read_packet(self):
        head = self._recv(1)[0]
        mult, length = 1, 0
        while True:
            b = self._recv(1)[0]
            length += (b & 127) * mult
            mult *= 128
            if not b & 128:
                break
        return head, self._recv(length) if length else b''

    def publish(self, topic, payload, retain=False):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload, ensure_ascii=False)
        shown = payload if isinstance(payload, str) else (payload or b'').decode(errors='replace')
        mqtt_log(f'→ {topic}: ' + (shown[:120] + '…' if len(shown) > 120 else shown or '(vacío: se quita)'))
        body = self._str(topic) + (payload.encode() if isinstance(payload, str) else payload or b'')
        try:
            self._send(self._packet(0x30 | (1 if retain else 0), body))
        except OSError:
            pass

    def subscribe(self, topics):
        mqtt_log('Escuchando: ' + ', '.join(topics))
        body = (1).to_bytes(2, 'big') + b''.join(self._str(t) + b'\x00' for t in topics)
        self._send(self._packet(0x82, body))

    def stop(self):
        self.stopped = True
        try:
            self._send(b'\xe0\x00')          # DISCONNECT
            self.sock.close()
        except (OSError, AttributeError):
            pass

    def run(self):
        while not self.stopped:
            try:
                mqtt_log(f'Conectando a {self.host}:{self.port}' + (f' como «{self.user}»' if self.user else ' sin usuario') + '…')
                self.sock = socket.create_connection((self.host, self.port), timeout=10)
                flags = 0x02 | 0x04 | 0x20          # sesión limpia, testamento (retenido)
                body = self._str('MQTT') + bytes([4])
                payload = self._str(self.client_id) + self._str(self.will[0]) + self._str(self.will[1])
                if self.user:
                    flags |= 0x80
                    payload += self._str(self.user)
                    if self.password:
                        flags |= 0x40
                        payload += self._str(self.password)
                self._send(self._packet(0x10, body + bytes([flags]) + (60).to_bytes(2, 'big') + payload))
                head, data = self._read_packet()
                if head >> 4 != 2 or len(data) < 2 or data[1] != 0:
                    reason = {4: 'usuario o contraseña incorrectos', 5: 'sin permiso'}.get(data[1] if len(data) > 1 else 0, 'rechazado')
                    raise ConnectionError(reason)
                MQTT.update(status='connected', error='')
                mqtt_log('Conectado')
                self.on_connect(self)
                self.sock.settimeout(1)
                last_ping = time.time()
                while not self.stopped:
                    if time.time() - last_ping > 30:
                        self._send(b'\xc0\x00')     # PINGREQ
                        last_ping = time.time()
                    try:
                        head, data = self._read_packet()
                    except socket.timeout:
                        continue
                    if head >> 4 == 3:              # PUBLISH
                        tlen = int.from_bytes(data[:2], 'big')
                        topic = data[2:2 + tlen].decode(errors='replace')
                        rest = data[2 + tlen:]
                        qos = (head >> 1) & 3
                        if qos:
                            self._send(self._packet(0x40, rest[:2]))   # PUBACK
                            rest = rest[2:]
                        mqtt_log(f'← {topic}: {rest.decode(errors="replace")[:200]}')
                        try:
                            self.on_message(topic, rest.decode(errors='replace'))
                        except Exception as e:   # noqa: BLE001 — una orden rara no tumba la conexión
                            mqtt_log(f'Orden con error: {e}')
            except (OSError, ConnectionError, ValueError) as e:
                MQTT.update(status='error', error=str(e) or type(e).__name__)
                if not self.stopped:
                    mqtt_log(f'Error: {MQTT["error"]}. Se reintenta en 10 s')
            finally:
                try:
                    self.sock.close()
                except (OSError, AttributeError):
                    pass
                self.sock = None
            if not self.stopped:
                time.sleep(10)


def _mqtt_base():
    return f'panel_hogar/{panel_id()}'


def _lan_ip():
    """La IP de la Pi en la red de casa (para el enlace «Visitar» de Home Assistant)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
            u.connect(('192.0.2.1', 9))      # no se envía nada: solo elige la interfaz de salida
            return u.getsockname()[0]
    except OSError:
        return socket.gethostname().split('.')[0] + '.local'


def _mqtt_device():
    code, out, _ = _git('rev-parse', '--short', 'HEAD', timeout=5)
    host = socket.gethostname().split('.')[0]
    return {'identifiers': [f'panel_hogar_{panel_id()}'], 'name': f'Panel {host}', 'manufacturer': 'Panel Hogar',
            'model': 'Raspberry Pi', 'sw_version': out.strip() if code == 0 else '', 'configuration_url': f'http://{_lan_ip()}:{WEB_PORT}'}


def _mqtt_names():
    """Nombres de las entidades en el idioma del panel (translations/<idioma>.json → panel.mqtt)."""
    lang = load_config()['settings'].get('language') or 'es'
    names = {}
    for code in ('es', lang):
        data = read_translation(f'/translations/{code}.json') if re.fullmatch(r'[a-z]{2,3}', code) else None
        names.update(((data or {}).get('texts') or {}).get('panel', {}).get('mqtt', {}))
    return {k: names.get(k, k) for k in HA_EXPOSE}


def mqtt_discovery(client=None):
    """Anuncia (o quita) cada entidad en Home Assistant según lo elegido en la web."""
    client = client or MQTT['client']
    if not client or MQTT['status'] != 'connected':
        return
    base, pid, dev, names, expose = _mqtt_base(), panel_id(), _mqtt_device(), _mqtt_names(), ha_expose()
    common = {'availability_topic': base + '/status', 'device': dev}
    configs = {
        'screen': ('light', dict(common, name=names['screen'], unique_id=f'{pid}_screen', icon='mdi:monitor',
                                 command_topic=base + '/screen/set', state_topic=base + '/screen/state',
                                 brightness_command_topic=base + '/brightness/set', brightness_state_topic=base + '/brightness/state',
                                 brightness_scale=100, payload_on='ON', payload_off='OFF')),
        'brightness': ('number', dict(common, name=names['brightness'], unique_id=f'{pid}_brightness', icon='mdi:brightness-6',
                                      command_topic=base + '/brightness/set', state_topic=base + '/brightness/state',
                                      min=5, max=100, step=1, unit_of_measurement='%', mode='slider')),
        'volume': ('number', dict(common, name=names['volume'], unique_id=f'{pid}_volume', icon='mdi:volume-high',
                                  command_topic=base + '/volume/set', state_topic=base + '/volume/state',
                                  min=0, max=100, step=1, unit_of_measurement='%', mode='slider')),
        'music_volume': ('number', dict(common, name=names['music_volume'], unique_id=f'{pid}_music_volume', icon='mdi:music',
                                        command_topic=base + '/music_volume/set', state_topic=base + '/music_volume/state',
                                        min=0, max=100, step=1, unit_of_measurement='%', mode='slider')),
        'ambient': ('switch', dict(common, name=names['ambient'], unique_id=f'{pid}_ambient', icon='mdi:image-filter-hdr',
                                   command_topic=base + '/ambient/set', state_topic=base + '/ambient/state', payload_on='ON', payload_off='OFF')),
        'last_touch': ('sensor', dict(common, name=names['last_touch'], unique_id=f'{pid}_last_touch', device_class='timestamp',
                                      state_topic=base + '/last_touch')),
        'reload': ('button', dict(common, name=names['reload'], unique_id=f'{pid}_reload', device_class='restart',
                                  command_topic=base + '/reload/press', payload_press='PRESS')),
    }
    for key, (kind, cfg) in configs.items():
        topic = f'homeassistant/{kind}/panel_hogar_{pid}/{key}/config'
        client.publish(topic, cfg if key in expose else b'', retain=True)


def mqtt_publish_state(changed=None):
    client = MQTT['client']
    if not client or MQTT['status'] != 'connected':
        return
    base, st = _mqtt_base(), dict(PANEL_STATE)
    keys = changed.keys() if changed else st.keys()
    for k in keys:
        v = st[k]
        if v is None:
            continue
        if k == 'screen_on':
            client.publish(base + '/screen/state', 'ON' if v else 'OFF', retain=True)
        elif k == 'brightness':
            client.publish(base + '/brightness/state', str(v), retain=True)
        elif k == 'ambient':
            client.publish(base + '/ambient/state', 'ON' if v else 'OFF', retain=True)
        elif k == 'last_touch':
            client.publish(base + '/last_touch', v, retain=True)


VOLUMES = {'volume': None, 'music_volume': None}   # lo último enviado (para no repetir)


def mqtt_publish_volumes(force=False):
    """Volumen de salida (el de la Pi) y de la música (el altavoz en Home Assistant), si cambian."""
    client = MQTT['client']
    if not client or MQTT['status'] != 'connected':
        return
    expose, base = ha_expose(), _mqtt_base()
    now = {}
    if 'volume' in expose:
        m = master_get()
        now['volume'] = m['value'] if m['available'] else None
    if 'music_volume' in expose:
        try:
            m = music_get()
        except Exception:   # Home Assistant no responde: ya se mirará en la próxima vuelta
            m = {}
        now['music_volume'] = m.get('value') if m.get('available') else None
    for k, v in now.items():
        if v is not None and (force or v != VOLUMES[k]):
            VOLUMES[k] = v
            client.publish(f'{base}/{k}/state', str(v), retain=True)


def _mqtt_volume_loop(client):
    """Los volúmenes también cambian fuera del panel (Music Assistant, amixer…): se miran cada 30 s."""
    while MQTT['client'] is client and not client.stopped:
        time.sleep(30)
        if MQTT['client'] is client:
            mqtt_publish_volumes()


def _set_volume(key, payload):
    try:
        (master_set if key == 'volume' else music_set)(round(float(payload)))
    except (ValueError, RuntimeError) as e:
        mqtt_log(f'Error: no se pudo cambiar el volumen ({e})')


def _mqtt_connected(client):
    base = _mqtt_base()
    client.publish(base + '/status', 'online', retain=True)
    client.subscribe([base + '/screen/set', base + '/brightness/set', base + '/volume/set', base + '/music_volume/set',
                      base + '/ambient/set', base + '/reload/press', 'homeassistant/status'])
    mqtt_discovery(client)
    mqtt_publish_state()
    threading.Thread(target=mqtt_publish_volumes, args=(True,), daemon=True).start()


def _mqtt_message(topic, payload):
    base = _mqtt_base()
    if topic == 'homeassistant/status':
        if payload == 'online':          # Home Assistant se ha reiniciado: se vuelve a anunciar
            mqtt_discovery()
            mqtt_publish_state()
            threading.Thread(target=mqtt_publish_volumes, args=(True,), daemon=True).start()
        return
    if topic == base + '/screen/set':
        send_command('screen_on' if payload.upper() == 'ON' else 'screen_off')
    elif topic == base + '/brightness/set':
        send_command('brightness', payload)
    elif topic in (base + '/volume/set', base + '/music_volume/set'):
        threading.Thread(target=_set_volume, args=(topic.split('/')[-2], payload), daemon=True).start()
    elif topic == base + '/ambient/set':
        send_command('ambient_on' if payload.upper() == 'ON' else 'ambient_off')
    elif topic == base + '/reload/press':
        send_command('reload')


def mqtt_restart():
    """Arranca (o vuelve a arrancar) la conexión con los datos de la web → General → Home Assistant (MQTT)."""
    old = MQTT['client']
    if old:
        old.stop()
        mqtt_log('Desconectado')
    MQTT.update(client=None, status='off', error='')
    p = load_config()['panel']
    if not p.get('mqttEnabled') or not p.get('mqttHost'):
        if old or p.get('mqttEnabled'):
            mqtt_log('Desactivado' if not p.get('mqttEnabled') else 'Falta el servidor MQTT')
        return
    base = _mqtt_base()
    client = MqttClient(p['mqttHost'], p.get('mqttPort') or 1883, p.get('mqttUser') or '', p.get('mqttPassword') or '',
                        f'panel-hogar-{panel_id()}', (base + '/status', 'offline'), _mqtt_connected, _mqtt_message)
    MQTT.update(client=client, status='connecting')
    VOLUMES.update(volume=None, music_volume=None)
    threading.Thread(target=client.run, daemon=True).start()
    threading.Thread(target=_mqtt_volume_loop, args=(client,), daemon=True).start()


# Pantalla en directo (web → General): una captura de lo que se ve en la pantalla de la Pi (grim, dentro de cage).
SCREEN_CAP = {'at': 0.0, 'png': None}


def screen_capture():
    """PNG de la pantalla ahora mismo (como mucho una captura cada medio segundo), o None si no se puede."""
    if SIMULATE or not shutil.which('grim'):
        return None
    with LOCK:
        if time.time() - SCREEN_CAP['at'] < 0.5 and SCREEN_CAP['png']:
            return SCREEN_CAP['png']
    code, out = 1, b''
    try:
        r = subprocess.run(['grim', '-l', '3', '-'], capture_output=True, timeout=5)
        code, out = r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        pass
    with LOCK:
        SCREEN_CAP.update(at=time.time(), png=out if code == 0 and out else None)
        return SCREEN_CAP['png']


def update_info():
    # ¿puede instalar paquetes sin contraseña? (permiso que da setup-kiosk.sh)
    # («sudo -l apt-get» no vale: también dice que sí cuando se puede con contraseña)
    can_sudo = True if SIMULATE else any('NOPASSWD' in line and '/usr/bin/apt-get' in line
                                         for line in _run(['-l'], sudo=True)[1].splitlines())
    return {'settings': update_settings(), 'branch': git_branch(), 'current': current_version(),
            'available': UPD['available'], 'lastCheck': UPD['lastCheck'], 'checking': UPD['checking'],
            'applying': UPD['applying'], 'error': UPD['error'], 'log': UPD['log'], 'sudo': can_sudo, 'simulated': SIMULATE}


def update_action(body):
    """Web y panel: comprobar, actualizar ya, o modo (avisar / automático) y hora. Devuelve (código, respuesta)."""
    action = body.get('action')
    try:
        if action == 'settings':
            set_update_settings(body)
            return 200, {'ok': True, 'message': 'Guardado.', 'info': update_info()}
        if action == 'check':
            check_updates()
            return 200, {'ok': not UPD['error'], 'info': update_info()}
        if action == 'update':
            threading.Thread(target=apply_update, daemon=True).start()
            time.sleep(0.2)
            return 200, {'ok': True, 'message': 'Actualizando… el panel se reiniciará solo.', 'info': update_info()}
    except ValueError as e:
        return 400, {'error': str(e)}
    return 400, {'error': 'acción desconocida'}


def update_loop():
    """Comprueba cada 3 h; en modo automático actualiza una vez al día a la hora elegida."""
    time.sleep(60)
    while True:
        try:
            s = update_settings()
            if time.time() - UPD['lastCheck'] > UPDATE_EVERY:
                check_updates()
            today = time.strftime('%Y-%m-%d')
            if s['mode'] == 'auto' and time.localtime().tm_hour == s['hour'] and UPD['lastAuto'] != today:
                UPD['lastAuto'] = today
                apply_update()
        except Exception as e:   # que un fallo no pare las comprobaciones
            UPD['error'] = str(e)[:200]
        time.sleep(300)


# ---------------------------------------------------------------- red (NetworkManager)
def _run(cmd, sudo=False, timeout=20):
    """Ejecuta un comando; con sudo usa «sudo -n» (sin pedir contraseña: permiso de setup-kiosk.sh)."""
    try:
        r = subprocess.run((['sudo', '-n'] if sudo else []) + cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or '').strip(), (r.stderr or '').strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, '', str(e)


def _nm_fields(line):
    """Separa una línea de «nmcli -t» por los «:» no escapados."""
    return [p.replace('\\:', ':') for p in re.split(r'(?<!\\):', line)]


def _primary_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))      # no envía nada: solo elige la interfaz de salida
            return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'


def _active_connection():
    code, out, _ = _run(['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'])
    if code != 0:
        return None
    for line in out.splitlines():
        name, ctype, dev = (_nm_fields(line) + ['', '', ''])[:3]
        if dev and dev != 'lo' and ctype in ('802-11-wireless', '802-3-ethernet', 'wifi', 'ethernet'):
            return {'name': name, 'type': 'wifi' if 'wireless' in ctype or ctype == 'wifi' else 'ethernet', 'device': dev}
    return None


def _sim_net_info(host, ip):
    host = SIM['hostname'] or host
    v4 = SIM['ipv4']
    net = dict(SIM_NETS_BY_SSID.get(SIM['ssid'], {'signal': 70}))
    return {'hostname': host, 'ip': ip, 'webPort': WEB_PORT, 'simulated': True, 'nmcli': True,
            'urls': [f'http://{ip}:{WEB_PORT}', f'http://{socket.gethostname()}.local:{WEB_PORT}'],
            'connection': {'name': SIM['ssid'], 'type': 'wifi', 'device': 'wlan0'},
            'ipv4': dict(v4), 'gateway': v4['gateway'] or '192.168.1.1', 'dns': v4['dns'] or '192.168.1.1',
            'wifi': {'ssid': SIM['ssid'], 'signal': net.get('signal', 70)}}


SIM_NETS_BY_SSID = {n[0]: {'signal': n[1], 'secure': n[2]} for n in SIM_NETS}


def net_info():
    host = socket.gethostname()
    ip = _primary_ip()
    if SIMULATE:
        return _sim_net_info(host, ip)
    info = {'hostname': host, 'ip': ip, 'webPort': WEB_PORT,
            'urls': [f'http://{ip}:{WEB_PORT}', f'http://{host}.local:{WEB_PORT}'],
            'nmcli': _run(['nmcli', '--version'])[0] == 0}
    con = _active_connection() if info['nmcli'] else None
    if con:
        info['connection'] = con
        code, out, _ = _run(['nmcli', '-g', 'ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns', 'connection', 'show', con['name']])
        if code == 0:
            vals = (out.splitlines() + ['', '', '', ''])[:4]
            info['ipv4'] = {'method': 'manual' if vals[0] == 'manual' else 'auto', 'addresses': vals[1],
                            'gateway': vals[2], 'dns': vals[3]}
        code, out, _ = _run(['nmcli', '-g', 'IP4.GATEWAY,IP4.DNS', 'device', 'show', con['device']])
        if code == 0:
            vals = (out.splitlines() + ['', ''])[:2]
            info['gateway'] = vals[0]
            info['dns'] = vals[1].replace(' | ', ', ')
        if con['type'] == 'wifi':
            code, out, _ = _run(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no'])
            for line in out.splitlines():
                f = _nm_fields(line)
                if len(f) >= 3 and f[0] == 'yes':
                    info['wifi'] = {'ssid': f[1], 'signal': int(f[2] or 0)}
    return info


def wifi_scan():
    if SIMULATE:
        time.sleep(1)
        return [{'ssid': n, 'signal': sig, 'secure': sec, 'inUse': n == SIM['ssid']} for n, sig, sec in SIM_NETS]
    code, out, err = _run(['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], timeout=30)
    if code != 0:
        raise RuntimeError(err or 'no se pudo buscar redes WiFi')
    nets = {}
    for line in out.splitlines():
        f = _nm_fields(line)
        if len(f) < 4 or not f[1]:
            continue
        sig = int(f[2] or 0)
        if f[1] not in nets or sig > nets[f[1]]['signal']:
            nets[f[1]] = {'ssid': f[1], 'signal': sig, 'secure': bool(f[3] and f[3] != '--'), 'inUse': f[0] == '*'}
    return sorted(nets.values(), key=lambda n: -n['signal'])


def _later(fn, delay=1.5):
    """Los cambios de red cortan la conexión: se aplican un poco después de contestar a la web."""
    threading.Timer(delay, fn).start()


def wifi_connect(ssid, password):
    if SIMULATE:
        def sim():
            SIM['ssid'] = ssid
            print(f'[simulación] conectado a la WiFi «{ssid}»', flush=True)
        return _later(sim)
    cmd = ['nmcli', 'device', 'wifi', 'connect', ssid] + (['password', password] if password else [])
    _later(lambda: _run(cmd, sudo=True, timeout=60))


def set_ipv4(method, address='', prefix=24, gateway='', dns=''):
    con = {'name': SIM['ssid']} if SIMULATE else _active_connection()
    if not con:
        raise RuntimeError('no hay ninguna conexión de red activa')
    if method == 'manual':
        def check(value, label):                       # valida antes de tocar nada
            try:
                ipaddress.IPv4Address(value)
            except ValueError:
                raise ValueError(f'{label} «{value}» no es una dirección IPv4 válida') from None
        check(address, 'La IP')
        if gateway:
            check(gateway, 'La puerta de enlace')
        for d in [x.strip() for x in dns.replace(';', ',').split(',') if x.strip()]:
            check(d, 'El DNS')
        prefix = int(prefix)
        if not 8 <= prefix <= 32:
            raise ValueError('máscara no válida')
        args = ['ipv4.method', 'manual', 'ipv4.addresses', f'{address}/{prefix}', 'ipv4.gateway', gateway,
                'ipv4.dns', dns.replace(';', ',').replace(' ', '')]
    else:
        args = ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']
    if SIMULATE:
        SIM['ipv4'] = {'method': method if method == 'manual' else 'auto',
                       'addresses': f'{address}/{prefix}' if method == 'manual' else '',
                       'gateway': gateway if method == 'manual' else '', 'dns': dns if method == 'manual' else ''}
        print(f'[simulación] IP {"fija " + address if method == "manual" else "automática"}', flush=True)
        return
    code, _, err = _run(['nmcli', 'connection', 'modify', con['name']] + args, sudo=True)
    if code != 0:
        raise RuntimeError(err or 'no se pudo cambiar la IP (¿permiso de sudo para nmcli?)')
    _later(lambda: _run(['nmcli', 'connection', 'up', con['name']], sudo=True, timeout=60))


def set_hostname(name):
    if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', name or ''):
        raise ValueError('solo letras, números y guiones (sin espacios)')
    if SIMULATE:
        SIM['hostname'] = name
        print(f'[simulación] nombre del equipo: {name}', flush=True)
        return
    code, _, err = _run(['hostnamectl', 'set-hostname', name], sudo=True)
    if code != 0:
        raise RuntimeError(err or 'no se pudo cambiar el nombre (¿permiso de sudo para hostnamectl?)')


# ---------------------------------------------------------------- Google Fotos
def google_album(url):
    """Lee las fotos de un álbum compartido de Google Fotos (la página pública del enlace)."""
    u = urlparse(url)
    if u.scheme != 'https' or u.hostname not in GOOGLE_HOSTS:
        raise ValueError('pon el enlace de un álbum compartido de Google Fotos (https://photos.app.goo.gl/…)')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                                               'Accept-Language': 'es-ES,es;q=0.9'})
    with urllib.request.urlopen(req, timeout=25) as r:
        if urlparse(r.geturl()).hostname not in GOOGLE_HOSTS:
            raise ValueError('el enlace no lleva a Google Fotos')
        html = r.read(8 * 1024 * 1024).decode('utf-8', 'replace')
    photos = list(dict.fromkeys(re.findall(r'https://lh3\.googleusercontent\.com/pw/[A-Za-z0-9_\-]{40,}', html)))
    m = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    title = (m.group(1) if m else '').split(' - ')[0].strip()
    if not photos:
        raise ValueError('no se han encontrado fotos (¿el álbum está compartido con enlace?)')
    return {'title': title, 'photos': photos}


# ---------------------------------------------------------------- servidores
class Base(BaseHTTPRequestHandler):
    server_version = 'PanelHogar'

    def log_message(self, *args):
        pass

    def _cors(self):
        pass

    def _json(self, code, body=None, extra=None):
        data = json.dumps(body if body is not None else {}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _translations(self, path):
        data = read_translation(path)
        return self._json(200, data) if data is not None else self._json(404, {'error': 'no existe'})

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 256 * 1024:
            raise ValueError('demasiado grande')
        return json.loads(self.rfile.read(n) or b'{}') if n else {}


def read_translation(path):
    """translations/xx.json (los idiomas del panel y de la web), o None si no existe o está mal escrito."""
    try:
        return json.loads((HERE / path.lstrip('/')).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        print('translations:', path, e, flush=True)
        return None


class LocalHandler(Base):
    """127.0.0.1:8766 — solo para el panel que corre en la propia Pi."""

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'x-api-key, content-type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self._json(200)

    def _proxy(self, target):
        u = urlparse(target)
        if u.scheme not in ('http', 'https') or not u.path.startswith(IMMICH_PATHS):
            return self._json(403, {'error': 'solo se permiten rutas de álbumes de Immich'})
        req = urllib.request.Request(target, headers={'Accept': 'application/json'})
        if self.headers.get('x-api-key'):
            req.add_header('x-api-key', self.headers['x-api-key'])
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return self._json(r.status, json.loads(r.read() or b'null'))
        except urllib.error.HTTPError as e:
            return self._json(e.code, {'error': e.reason})
        except (urllib.error.URLError, OSError, ValueError) as e:
            return self._json(502, {'error': str(e)})

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/status':
            outs = _outputs()
            if SIMULATE:   # sin retroiluminación real: el panel oscurece por software y «apaga» con la capa negra
                return self._json(200, {'backlight': False, 'power': True, 'outputs': [], 'simulated': True,
                                        'web': WEB_PORT, 'password': PASS_FILE.exists()})
            return self._json(200, {'backlight': bool(BACKLIGHT), 'power': bool(BACKLIGHT or outs), 'outputs': outs,
                                    'web': WEB_PORT, 'password': PASS_FILE.exists()})
        if re.fullmatch(r'/translations/[a-z0-9_-]+\.json', u.path):
            return self._translations(u.path)
        if u.path == '/config':
            return self._json(200, dict(load_config(), scripts=list_scripts(), speaker=speaker_panel()))
        if u.path == '/network':
            return self._json(200, net_info())
        if u.path == '/voice':
            return self._json(200, voice_info())
        if u.path == '/sound':
            return self._json(200, sound_info())
        if u.path == '/updates':
            return self._json(200, update_info())
        if u.path == '/poll':
            cfg = load_config()
            return self._json(200, {'version': cfg['version'], 'reload': cfg.get('reload', 0), 'command': COMMAND, 'pin': speaker_pin(),
                                    'update': len(UPD['available']) if update_settings()['mode'] == 'notify' else 0})
        if u.path == '/proxy':
            return self._proxy(parse_qs(u.query).get('url', [''])[0])
        if u.path == '/gphotos':
            try:
                return self._json(200, google_album(parse_qs(u.query).get('url', [''])[0]))
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {'error': f'no se pudo leer el álbum: {getattr(e, "reason", e)}'})
        self._json(404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == '/state':     # el panel cuenta cómo está (para Home Assistant por MQTT)
                return self._json(200, {'rev': set_panel_state(self._body())})
            if u.path == '/brightness':
                return self._json(200, {'ok': set_brightness(int(q.get('value', ['100'])[0]))})
            if u.path == '/power':
                return self._json(200, {'ok': set_power(q.get('on', ['1'])[0] == '1')})
            if u.path == '/updates':
                return self._json(*update_action(self._body()))
            if u.path == '/voice':
                try:
                    return self._json(200, {'ok': True, 'message': set_voice(self._body()), 'info': voice_info()})
                except (ValueError, RuntimeError) as e:
                    return self._json(400, {'error': str(e)})
            if u.path == '/sound':
                try:
                    return self._json(200, set_sound(self._body()))
                except (ValueError, RuntimeError) as e:
                    return self._json(400, {'error': str(e)})
            if u.path == '/data':  # el panel manda screen e info de entidades para probar burbujas en la web
                body = self._body()
                PANEL_DATA.update(body if isinstance(body, dict) else {})
                PANEL_DATA['t'] = time.time()
                return self._json(200, {'ok': True, 'hasInfo': bool(PANEL_DATA.get('info'))})
            if u.path == '/seed':   # el panel copia aquí su config.js y sus Ajustes la primera vez
                body = self._body()
                with LOCK:
                    cfg = load_config()
                    changed = False
                    if not cfg['panel'].get('haUrl') and body.get('panel'):
                        cfg['panel'] = clean_panel(body['panel'], keep_secret_if_empty=False)
                        changed = True
                    if not cfg['settings'] and body.get('settings'):
                        cfg['settings'] = body['settings']
                        changed = True
                    return self._json(200, {'version': save_config(cfg) if changed else cfg['version']})
        except ValueError:
            return self._json(400)
        self._json(404)

    def do_PUT(self):
        if urlparse(self.path).path == '/settings':   # el panel guarda sus Ajustes
            try:
                body = self._body()
            except ValueError:
                return self._json(400)
            with LOCK:
                cfg = load_config()
                cfg['settings'] = body
                return self._json(200, {'version': save_config(cfg, reload=False)})
        self._json(404)


class WebHandler(Base):
    """0.0.0.0:8080 — web de configuración para tu red de casa, con contraseña."""

    def _session(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'panel_sesion' and SESSIONS.get(v, 0) > time.time():
                return v
        return None

    def _guard(self, mutating=False):
        if not self._session():
            self._json(401, {'error': 'inicia sesión'})
            return False
        if mutating and self.headers.get('X-Panel') != '1':     # protección CSRF
            self._json(403, {'error': 'petición no válida'})
            return False
        return True

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/api/screen.png':   # la pantalla de la Pi en directo
            if not self._guard():
                return
            png = screen_capture()
            if not png:
                return self._json(503, {'error': 'solo en la Pi (hace falta grim)'})
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(png)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(png)
            return
        if u.path == '/api/mqtt':        # estado de la conexión con Home Assistant por MQTT
            if not self._guard():
                return
            return self._json(200, {'status': MQTT['status'], 'error': MQTT['error'], 'log': MQTT_LOG[-200:]})
        if u.path in ('/', '/index.html'):
            try:
                data = (HERE / 'config.html').read_bytes()
            except OSError:
                return self._json(500, {'error': 'falta config.html'})
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        # mismo código que usa el panel, para probar burbujas y componentes en la web
        if re.fullmatch(r'/translations/[a-z0-9_-]+\.json', u.path):
            return self._translations(u.path)
        if u.path in ('/lib/modules.js', '/lib/components.js', '/translations/i18n.js'):
            data = (HERE / u.path.lstrip('/')).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', ('text/css' if u.path.endswith('.css') else 'text/javascript') + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == '/api/state':
            return self._json(200, {'password': PASS_FILE.exists(), 'session': bool(self._session()), 'simulated': SIMULATE})
        if u.path == '/api/scripts':
            if not self._guard():
                return
            return self._json(200, list_scripts())
        if u.path == '/api/states':        # estados actuales (solo lectura) para probar scripts en la web
            if not self._guard():
                return
            code, states = ha_request('GET', '/api/states')
            if code != 200:
                return self._json(502, states)
            return self._json(200, {st['entity_id']: st for st in states})
        if u.path == '/api/panel-data':    # screen e info de entidades del panel, para probar burbujas en la web
            if not self._guard():
                return
            return self._json(200, PANEL_DATA)
        if u.path == '/api/config':
            if not self._guard():
                return
            cfg = load_config()
            panel = dict(cfg['panel'])
            panel['hasToken'] = bool(panel.pop('token', None))          # el token nunca sale de la Pi
            panel['hasImmichApiKey'] = bool(panel.pop('immichApiKey', None))
            panel['hasMqttPassword'] = bool(panel.pop('mqttPassword', None))
            if isinstance(panel.get('photoSources'), list):   # sin configurar: la web las crea desde ambientPhotos
                panel['photoSources'] = [dict({k: v for k, v in src.items() if k != 'apiKey'}, hasApiKey=bool(src.get('apiKey')))
                                         for src in panel['photoSources'] if isinstance(src, dict)]
            return self._json(200, {'panel': panel, 'settings': cfg['settings'], 'version': cfg['version']})
        if u.path == '/api/network':
            if not self._guard():
                return
            return self._json(200, net_info())
        if u.path == '/api/speaker':
            if not self._guard():
                return
            return self._json(200, speaker_info())
        if u.path == '/api/voice':
            if not self._guard():
                return
            return self._json(200, voice_info())
        if u.path == '/api/sound':
            if not self._guard():
                return
            return self._json(200, dict(sound_info(), music=music_get()))
        if u.path == '/api/updates':
            if not self._guard():
                return
            return self._json(200, update_info())
        if u.path == '/api/entities':
            if not self._guard():
                return
            code, states = ha_request('GET', '/api/states')
            if code != 200:
                return self._json(502, states)
            ents = sorted(({'id': s['entity_id'], 'name': s['attributes'].get('friendly_name', s['entity_id'])}
                           for s in states), key=lambda e: e['id'])
            return self._json(200, ents)
        self._json(404)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body()
        except ValueError:
            return self._json(400)
        if u.path == '/api/login':
            if not PASS_FILE.exists():
                return self._json(409, {'error': 'Aún no hay contraseña. En la Pi ejecuta: python3 ~/ha-panel/panel-helper.py --set-password'})
            if not check_password(str(body.get('password', ''))):
                time.sleep(1.5)     # frena los intentos a lo loco
                return self._json(401, {'error': 'Contraseña incorrecta'})
            sid = secrets.token_urlsafe(32)
            SESSIONS[sid] = time.time() + 30 * 86400
            return self._json(200, {'ok': True},
                              {'Set-Cookie': f'panel_sesion={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'})
        if u.path == '/api/logout':
            SESSIONS.pop(self._session() or '', None)
            return self._json(200, {'ok': True}, {'Set-Cookie': 'panel_sesion=; Path=/; Max-Age=0'})
        if not self._guard(mutating=True):
            return
        if u.path == '/api/scripts/import':
            try:
                code = download_script(body.get('url'))
                name = save_script(body.get('name') or os.path.basename(urlparse(body.get('url')).path), code)
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {'error': f'no se pudo descargar: {getattr(e, "reason", e)}'})
            return self._json(200, {'ok': True, 'name': name, 'code': code, 'version': bump_version()})
        if u.path == '/api/test':        # probar la conexión con lo escrito en el formulario (o lo guardado)
            code, res = ha_request('GET', '/api/', ha_url=body.get('haUrl') or None, token=body.get('token') or None)
            return self._json(200, {'ok': code == 200, 'message': 'Conectado con Home Assistant' if code == 200 else res.get('error')})
        if u.path == '/api/notify':
            code, res = ha_request('POST', '/api/events/panel_notification', {
                'id': 'prueba_web', 'title': 'Aviso de prueba', 'message': 'Enviado desde la web de configuración',
                'level': 'warning', 'icon': 'mdi:bell-ring', 'timeout': 20})
            return self._json(200, {'ok': code == 200, 'message': 'Aviso enviado al panel' if code == 200 else res.get('error')})
        if u.path.startswith('/api/network/'):
            try:
                if u.path == '/api/network/scan':
                    return self._json(200, wifi_scan())
                if u.path == '/api/network/wifi':
                    ssid = str(body.get('ssid', '')).strip()
                    if not ssid:
                        return self._json(400, {'error': 'elige una red'})
                    wifi_connect(ssid, str(body.get('password', '')))
                    return self._json(200, {'ok': True, 'message': (f'[Simulación] Conectado a «{ssid}» (la red del PC no cambia).' if SIMULATE else
                                                                     f'Conectando a «{ssid}»… Si cambia la IP, entra con la nueva (la verás en la pantalla del panel).')})
                if u.path == '/api/network/ip':
                    set_ipv4(body.get('method', 'auto'), str(body.get('address', '')).strip(), body.get('prefix', 24),
                             str(body.get('gateway', '')).strip(), str(body.get('dns', '')).strip())
                    return self._json(200, {'ok': True, 'message': '[Simulación] IP cambiada (la del PC no cambia).' if SIMULATE else 'Aplicando la nueva IP… vuelve a entrar con la dirección nueva.'})
                if u.path == '/api/network/hostname':
                    set_hostname(str(body.get('hostname', '')).strip())
                    return self._json(200, {'ok': True, 'message': '[Simulación] Nombre cambiado (el del PC no cambia).' if SIMULATE else 'Nombre cambiado. La dirección .local nueva funciona tras reiniciar la Pi.'})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
            return self._json(404)
        if u.path == '/api/speaker':       # activar / desactivar, nombre y salida del altavoz Sendspin
            try:
                return self._json(200, {'ok': True, 'message': set_speaker(body), 'info': speaker_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/sound':        # música, límite de salida, respuestas y ganancia del micro
            try:
                if 'music' in body:
                    music_set(body['music'])
                return self._json(200, dict(set_sound(body), music=music_get()))
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/voice':           # micro, salida y palabra del asistente de voz
            try:
                return self._json(200, {'ok': True, 'message': set_voice(body), 'info': voice_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/updates':   # comprobar, actualizar ya, o modo (avisar / automático) y hora
            return self._json(*update_action(body))
        if u.path == '/api/command':         # recargar, apagar/encender pantalla, modo ambiente, inicio
            kind = body.get('type')
            if kind not in ('reload', 'screen_off', 'screen_on', 'ambient', 'home'):
                return self._json(400, {'error': 'orden desconocida'})
            with LOCK:
                COMMAND['id'] += 1
                COMMAND['type'] = kind
            return self._json(200, {'ok': True})
        self._json(404)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != '/api/scripts':
            return self._json(404)
        if not self._guard(mutating=True):
            return
        try:
            name = script_name(parse_qs(u.query).get('name', [''])[0])
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        try:
            (SCRIPTS_DIR / name).unlink()
        except FileNotFoundError:
            return self._json(404, {'error': 'no existe'})
        return self._json(200, {'ok': True, 'version': bump_version()})

    def do_PUT(self):
        if urlparse(self.path).path == '/api/scripts':
            if not self._guard(mutating=True):
                return
            try:
                body = self._body()
                name = save_script(body.get('name'), body.get('code'))
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            return self._json(200, {'ok': True, 'name': name, 'version': bump_version()})
        if urlparse(self.path).path != '/api/config':
            return self._json(404)
        if not self._guard(mutating=True):
            return
        try:
            body = self._body()
        except ValueError:
            return self._json(400)
        with LOCK:
            cfg = load_config()
            old_panel = json.dumps(cfg['panel'], sort_keys=True)
            if isinstance(body.get('panel'), dict):
                cfg['panel'] = clean_panel(body['panel'], current=cfg['panel'])
            if isinstance(body.get('settings'), dict):
                cfg['settings'] = body['settings']
            # Conexión, entidades, fotos…: el panel tiene que arrancar de nuevo. Solo ajustes: los aplica al momento.
            reload = json.dumps(cfg['panel'], sort_keys=True) != old_panel
            version = save_config(cfg, reload)
        # MQTT: con datos nuevos se vuelve a conectar; si no, se vuelven a anunciar las entidades (lo elegido o el idioma)
        threading.Thread(target=mqtt_restart if reload else mqtt_discovery, daemon=True).start()
        return self._json(200, {'ok': True, 'version': version, 'reload': reload})


def serve(port, handler, host):
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description='Ayudante del Panel Hogar')
    ap.add_argument('--set-password', action='store_true', help='poner o cambiar la contraseña de la web')
    ap.add_argument('--sendspin', action='store_true', help='arrancar el altavoz Sendspin (lo usa el servicio panel-sendspin)')
    ap.add_argument('--voice', '--voz', dest='voice', action='store_true', help='start the voice assistant (used by the panel-voice service)')
    args = ap.parse_args()
    try:
        migrate_old_names()
    except OSError as e:
        print('Could not rename old files:', e, flush=True)
    if args.sendspin:
        return run_speaker()
    if args.voice:
        return run_voice()
    if args.set_password:
        if sys.stdin.isatty():
            pw = getpass.getpass('Nueva contraseña para la web del panel: ')
            if pw != getpass.getpass('Repítela: '):
                sys.exit('No coinciden.')
        else:
            pw = sys.stdin.readline().strip()
        if len(pw) < 4:
            sys.exit('Demasiado corta (mínimo 4 caracteres).')
        set_password(pw)
        print('Contraseña guardada.')
        return
    if SIMULATE:
        print('Panel Hogar · ayudante en MODO SIMULACIÓN (pantalla y red simuladas; no se cambia nada del equipo)', flush=True)
    threading.Thread(target=serve, args=(WEB_PORT, WebHandler, '0.0.0.0'), daemon=True).start()
    threading.Thread(target=update_loop, daemon=True).start()
    mqtt_restart()   # Home Assistant por MQTT (si está activado en la web)
    master_restore()
    serve(LOCAL_PORT, LocalHandler, '127.0.0.1')


if __name__ == '__main__':
    main()
