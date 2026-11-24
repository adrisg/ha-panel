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
PANEL_KEYS = ('haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
              'excludePlatforms', 'printerPlugs', 'sensorClasses', 'cameraRefreshSeconds', 'hideUnavailable', 'photoSources')
# Álbumes compartidos de Google Fotos: solo se leen enlaces de estos dominios
GOOGLE_HOSTS = ('photos.app.goo.gl', 'photos.google.com', 'goo.gl')

LOCK = threading.Lock()
SESSIONS = {}                        # cookie -> caducidad
COMMAND = {'id': 0, 'type': None}    # orden para el panel (recargar, apagar pantalla…)


# ---------------------------------------------------------------- configuración
def load_config():
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    cfg.setdefault('panel', {})
    cfg.setdefault('ajustes', {})
    cfg.setdefault('version', 0)
    return cfg


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
        if k in ('token', 'immichApiKey') and keep_secret_if_empty and not values[k]:
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
        return 'Guardado. Falta instalarlo en la Pi: bash ~/ha-panel/setup-sendspin.sh'
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
    args = [str(SENDSPIN_BIN.parent / 'python3'), str(HERE / 'sendspin-run.py'), 'daemon', '--name', s['name'] or speaker_default_name(),
            '--settings-dir', str(DATA / 'sendspin'), '--hardware-volume', 'false', '--disable-mpris',
            '--product-name', 'Panel Hogar']
    if s['device']:
        args += ['--audio-device', s['device']]
    # El desfase NO se pasa: se ajusta en Music Assistant y sendspin lo guarda; si se pasara aquí,
    # al arrancar pisaría el de Music Assistant.
    os.environ['PANEL_SENDSPIN_PIN'] = str(SENDSPIN_PIN)
    os.execv(args[0], args)


# ---------------------------------------------------------------- asistente de voz (satélite Wyoming)
# setup-voz.sh instala wyoming-satellite + microWakeWord y el servicio de usuario panel-voz, que arranca
# «panel-helper.py --voz» (lee voz.json y lanza el satélite). Micro, salida y palabra se eligen en la web o el panel.
VOICE_FILE = DATA / 'voz.json'
VOICE_PY = Path.home() / '.local' / 'share' / 'panel-hogar' / 'voz' / 'bin' / 'python'
VOICE_UNIT = 'panel-voz.service'
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
        return 'Guardado. Falta instalarlo en la Pi: bash ~/ha-panel/setup-voz.sh'
    if new['enabled']:
        _user_ctl('enable', VOICE_UNIT)
        code, _, err = _user_ctl('restart', VOICE_UNIT)
        if code != 0:
            raise RuntimeError(f'no arrancó: {err or "mira el registro"}')
        return 'Asistente de voz activado.'
    _user_ctl('disable', '--now', VOICE_UNIT)
    return 'Asistente de voz desactivado.'


def run_voice():
    # Lo arranca el servicio panel-voz: lanza el satélite con los ajustes de la web
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
SOUND_FILE = DATA / 'sonido.json'
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
        return
    card = output_card()
    ctl = master_control(card) if card else ''
    if not ctl:
        raise RuntimeError('esta salida de audio no tiene volumen propio')
    _run(['amixer', '-q', '-M', '-c', card, 'sset', ctl, f'{v}%', 'unmute'], timeout=5)


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
        return
    ent = music_entity()
    if not ent:
        raise RuntimeError('no se sabe qué altavoz es este panel en Home Assistant')
    code, res = ha_request('POST', '/api/services/media_player/volume_set', {'entity_id': ent, 'volume_level': v / 100})
    if code != 200:
        raise RuntimeError('Home Assistant no lo aceptó: ' + str((res or {}).get('error', code)))


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
UPDATES_FILE = DATA / 'actualizaciones.json'
UPDATE_HOOK = HERE / 'update-hook.sh'
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
    return {'mode': s.get('mode') if s.get('mode') in ('avisar', 'auto') else 'avisar', 'hour': hour}


def set_update_settings(body):
    cur = update_settings()
    new = {'mode': body.get('mode', cur['mode']), 'hour': body.get('hour', cur['hour'])}
    if new['mode'] not in ('avisar', 'auto'):
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
    speaker = 'sendspin-run.py' in changed or 'def run_speaker' in hunks or 'SENDSPIN' in hunks
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
    accion = body.get('accion')
    try:
        if accion == 'ajustes':
            set_update_settings(body)
            return 200, {'ok': True, 'mensaje': 'Guardado.', 'info': update_info()}
        if accion == 'comprobar':
            check_updates()
            return 200, {'ok': not UPD['error'], 'info': update_info()}
        if accion == 'actualizar':
            threading.Thread(target=apply_update, daemon=True).start()
            time.sleep(0.2)
            return 200, {'ok': True, 'mensaje': 'Actualizando… el panel se reiniciará solo.', 'info': update_info()}
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

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 256 * 1024:
            raise ValueError('demasiado grande')
        return json.loads(self.rfile.read(n) or b'{}') if n else {}


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
        if u.path == '/config':
            return self._json(200, dict(load_config(), modulos=list_scripts(), altavoz=speaker_panel()))
        if u.path == '/red':
            return self._json(200, net_info())
        if u.path == '/voz':
            return self._json(200, voice_info())
        if u.path == '/sonido':
            return self._json(200, sound_info())
        if u.path == '/actualizaciones':
            return self._json(200, update_info())
        if u.path == '/poll':
            cfg = load_config()
            return self._json(200, {'version': cfg['version'], 'reload': cfg.get('reload', 0), 'command': COMMAND, 'pin': speaker_pin(),
                                    'update': len(UPD['available']) if update_settings()['mode'] == 'avisar' else 0})
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
            if u.path == '/brightness':
                return self._json(200, {'ok': set_brightness(int(q.get('value', ['100'])[0]))})
            if u.path == '/power':
                return self._json(200, {'ok': set_power(q.get('on', ['1'])[0] == '1')})
            if u.path == '/actualizaciones':
                return self._json(*update_action(self._body()))
            if u.path == '/voz':
                try:
                    return self._json(200, {'ok': True, 'mensaje': set_voice(self._body()), 'info': voice_info()})
                except (ValueError, RuntimeError) as e:
                    return self._json(400, {'error': str(e)})
            if u.path == '/sonido':
                try:
                    return self._json(200, set_sound(self._body()))
                except (ValueError, RuntimeError) as e:
                    return self._json(400, {'error': str(e)})
            if u.path == '/datos':  # el panel manda screen e info de entidades para probar burbujas en la web
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
                    if not cfg['ajustes'] and body.get('ajustes'):
                        cfg['ajustes'] = body['ajustes']
                        changed = True
                    return self._json(200, {'version': save_config(cfg) if changed else cfg['version']})
        except ValueError:
            return self._json(400)
        self._json(404)

    def do_PUT(self):
        if urlparse(self.path).path == '/ajustes':   # el panel guarda sus Ajustes
            try:
                body = self._body()
            except ValueError:
                return self._json(400)
            with LOCK:
                cfg = load_config()
                cfg['ajustes'] = body
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
        if u.path in ('/lib/modulos.js', '/lib/componentes.js'):
            data = (HERE / 'lib' / u.path.rsplit('/', 1)[1]).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', ('text/css' if u.path.endswith('.css') else 'text/javascript') + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == '/api/estado':
            return self._json(200, {'password': PASS_FILE.exists(), 'session': bool(self._session()), 'simulated': SIMULATE})
        if u.path == '/api/scripts':
            if not self._guard():
                return
            return self._json(200, list_scripts())
        if u.path == '/api/estados':        # estados actuales (solo lectura) para probar scripts en la web
            if not self._guard():
                return
            code, states = ha_request('GET', '/api/states')
            if code != 200:
                return self._json(502, states)
            return self._json(200, {st['entity_id']: st for st in states})
        if u.path == '/api/datos-panel':    # screen e info de entidades del panel, para probar burbujas en la web
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
            if isinstance(panel.get('photoSources'), list):   # sin configurar: la web las crea desde ambientPhotos
                panel['photoSources'] = [dict({k: v for k, v in src.items() if k != 'apiKey'}, hasApiKey=bool(src.get('apiKey')))
                                         for src in panel['photoSources'] if isinstance(src, dict)]
            return self._json(200, {'panel': panel, 'ajustes': cfg['ajustes'], 'version': cfg['version']})
        if u.path == '/api/red':
            if not self._guard():
                return
            return self._json(200, net_info())
        if u.path == '/api/altavoz':
            if not self._guard():
                return
            return self._json(200, speaker_info())
        if u.path == '/api/voz':
            if not self._guard():
                return
            return self._json(200, voice_info())
        if u.path == '/api/sonido':
            if not self._guard():
                return
            return self._json(200, dict(sound_info(), music=music_get()))
        if u.path == '/api/actualizaciones':
            if not self._guard():
                return
            return self._json(200, update_info())
        if u.path == '/api/entidades':
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
        if u.path == '/api/scripts/importar':
            try:
                code = download_script(body.get('url'))
                name = save_script(body.get('name') or os.path.basename(urlparse(body.get('url')).path), code)
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {'error': f'no se pudo descargar: {getattr(e, "reason", e)}'})
            return self._json(200, {'ok': True, 'name': name, 'code': code, 'version': bump_version()})
        if u.path == '/api/probar':        # probar la conexión con lo escrito en el formulario (o lo guardado)
            code, res = ha_request('GET', '/api/', ha_url=body.get('haUrl') or None, token=body.get('token') or None)
            return self._json(200, {'ok': code == 200, 'mensaje': 'Conectado con Home Assistant' if code == 200 else res.get('error')})
        if u.path == '/api/aviso':
            code, res = ha_request('POST', '/api/events/panel_notificacion', {
                'id': 'prueba_web', 'titulo': 'Aviso de prueba', 'mensaje': 'Enviado desde la web de configuración',
                'nivel': 'aviso', 'icono': 'mdi:bell-ring', 'duracion': 20})
            return self._json(200, {'ok': code == 200, 'mensaje': 'Aviso enviado al panel' if code == 200 else res.get('error')})
        if u.path.startswith('/api/red/'):
            try:
                if u.path == '/api/red/escanear':
                    return self._json(200, wifi_scan())
                if u.path == '/api/red/wifi':
                    ssid = str(body.get('ssid', '')).strip()
                    if not ssid:
                        return self._json(400, {'error': 'elige una red'})
                    wifi_connect(ssid, str(body.get('password', '')))
                    return self._json(200, {'ok': True, 'mensaje': (f'[Simulación] Conectado a «{ssid}» (la red del PC no cambia).' if SIMULATE else
                                                                     f'Conectando a «{ssid}»… Si cambia la IP, entra con la nueva (la verás en la pantalla del panel).')})
                if u.path == '/api/red/ip':
                    set_ipv4(body.get('method', 'auto'), str(body.get('address', '')).strip(), body.get('prefix', 24),
                             str(body.get('gateway', '')).strip(), str(body.get('dns', '')).strip())
                    return self._json(200, {'ok': True, 'mensaje': '[Simulación] IP cambiada (la del PC no cambia).' if SIMULATE else 'Aplicando la nueva IP… vuelve a entrar con la dirección nueva.'})
                if u.path == '/api/red/nombre':
                    set_hostname(str(body.get('hostname', '')).strip())
                    return self._json(200, {'ok': True, 'mensaje': '[Simulación] Nombre cambiado (el del PC no cambia).' if SIMULATE else 'Nombre cambiado. La dirección .local nueva funciona tras reiniciar la Pi.'})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
            return self._json(404)
        if u.path == '/api/altavoz':       # activar / desactivar, nombre y salida del altavoz Sendspin
            try:
                return self._json(200, {'ok': True, 'mensaje': set_speaker(body), 'info': speaker_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/sonido':        # música, límite de salida, respuestas y ganancia del micro
            try:
                if 'music' in body:
                    music_set(body['music'])
                return self._json(200, dict(set_sound(body), music=music_get()))
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/voz':           # micro, salida y palabra del asistente de voz
            try:
                return self._json(200, {'ok': True, 'mensaje': set_voice(body), 'info': voice_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/actualizaciones':   # comprobar, actualizar ya, o modo (avisar / automático) y hora
            return self._json(*update_action(body))
        if u.path == '/api/orden':         # recargar, apagar/encender pantalla, modo ambiente, inicio
            tipo = body.get('tipo')
            if tipo not in ('recargar', 'pantalla_off', 'pantalla_on', 'ambiente', 'inicio'):
                return self._json(400, {'error': 'orden desconocida'})
            with LOCK:
                COMMAND['id'] += 1
                COMMAND['type'] = tipo
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
            if isinstance(body.get('ajustes'), dict):
                cfg['ajustes'] = body['ajustes']
            # Conexión, entidades, fotos…: el panel tiene que arrancar de nuevo. Solo ajustes: los aplica al momento.
            reload = json.dumps(cfg['panel'], sort_keys=True) != old_panel
            return self._json(200, {'ok': True, 'version': save_config(cfg, reload), 'reload': reload})


def serve(port, handler, host):
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description='Ayudante del Panel Hogar')
    ap.add_argument('--set-password', action='store_true', help='poner o cambiar la contraseña de la web')
    ap.add_argument('--sendspin', action='store_true', help='arrancar el altavoz Sendspin (lo usa el servicio panel-sendspin)')
    ap.add_argument('--voz', action='store_true', help='arrancar el asistente de voz (lo usa el servicio panel-voz)')
    args = ap.parse_args()
    if args.sendspin:
        return run_speaker()
    if args.voz:
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
    master_restore()
    serve(LOCAL_PORT, LocalHandler, '127.0.0.1')


if __name__ == '__main__':
    main()
