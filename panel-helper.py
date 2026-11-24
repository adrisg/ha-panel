#!/usr/bin/env python3
"""Panel Hogar helper (it runs on the Raspberry Pi).

Two servers in one program, with no dependencies (just Python 3):

1. 127.0.0.1:8766 — only the Pi itself. The panel uses it to:
   - set the real brightness and turn the screen off (backlight or wlr-randr)
   - read Immich albums when their server does not allow CORS
   - read the configuration (token included) and save the Settings

2. 0.0.0.0:8080 — your home network. Configuration web protected with a password:
   http://<pi-name>.local:8080
   The Home Assistant token can be changed, but it is never sent to the web.
   It also shows and changes the Pi's network (WiFi, static or automatic IP, name)
   with NetworkManager (nmcli); setup-kiosk.sh only allows nmcli and hostnamectl.
   And the Sendspin speaker (Music Assistant): on/off, name and audio output (see setup-sendspin.sh).

Off the Pi (Windows, macOS) or with PANEL_SIMULATE=1 it runs in SIMULATION MODE: the screen
and the network are simulated, to try everything on the computer without touching anything (see dev.py).

Usage:
  python3 panel-helper.py                  # start (~/kiosk-browser.sh does it)
  python3 panel-helper.py --set-password   # set or change the web password
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
SCRIPTS_DIR = DATA / 'scripts'        # panel scripts (bubbles and cards): .js files
SCRIPT_NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,39}\.js$')
SCRIPT_MAX = 100 * 1024
PANEL_DATA = {}                       # the last thing the panel sent: screen and entity info (only in memory)
LOCAL_PORT = 8766
WEB_PORT = int(os.environ.get('PANEL_WEB_PORT', '8080'))
BACKLIGHT = next(iter(sorted(glob.glob('/sys/class/backlight/*'))), None)
# Simulation: always off Linux (there is no nmcli or backlight to touch) or when asked for
SIMULATE = os.environ.get('PANEL_SIMULATE') == '1' or not sys.platform.startswith('linux')
SIM = {'power': True, 'brightness': 100, 'ssid': 'MiCasa_5G', 'hostname': None,
       'ipv4': {'method': 'auto', 'addresses': '', 'gateway': '', 'dns': ''}}
SIM_NETS = [('MiCasa_5G', 82, True), ('MiCasa', 64, True), ('Vecino_2.4', 41, True), ('Invitados', 37, False), ('MOVISTAR_8A3F', 22, True)]

# Immich paths the panel can read through the helper (read only)
IMMICH_PATHS = ('/api/shared-links/me', '/api/albums/', '/api/timeline/buckets', '/api/timeline/bucket')
# config.js options that can be changed from the web
PANEL_KEYS = ('mqttEnabled', 'mqttHost', 'mqttPort', 'mqttUser', 'mqttPassword', 'haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
              'excludePlatforms', 'printerPlugs', 'sensorClasses', 'cameraRefreshSeconds', 'hideUnavailable', 'photoSources')
# Google Photos shared albums: only links from these domains are read
GOOGLE_HOSTS = ('photos.app.goo.gl', 'photos.google.com', 'goo.gl')

LOCK = threading.Lock()
SESSIONS = {}                        # cookie -> expiry
COMMAND = {'id': 0, 'type': None, 'value': None}    # command for the panel (reload, turn the screen off, brightness…)


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
    """Saves and bumps the version. reload=False: only settings the panel applies without reloading changed."""
    cfg['version'] = int(time.time() * 1000)
    if reload:
        cfg['reload'] = cfg['version']
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)    # it holds the token: only for your user
    except OSError:
        pass
    return cfg['version']


# ---------------------------------------------------------------- panel scripts
def list_scripts():
    """{name.js: code} of the scripts saved on the Pi."""
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
        raise ValueError('invalid name: lowercase letters, numbers, - and _ (e.g. living-room-temperature)')
    return name


def save_script(name, code):
    name = script_name(name)
    code = str(code or '')
    if len(code.encode()) > SCRIPT_MAX:
        raise ValueError('the script is too big (max. 100 KB)')
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SCRIPTS_DIR / (name + '.tmp')
    tmp.write_text(code, encoding='utf-8')
    os.replace(tmp, SCRIPTS_DIR / name)
    return name


def bump_version(reload=True):
    """Something changed: the panel sees it in /poll and reloads (reload) or just reads its settings again."""
    with LOCK:
        cfg = load_config()
        return save_config(cfg, reload)


def download_script(url):
    """Import a script from an https URL (e.g. a GitHub raw). It is only downloaded, not run here."""
    u = urlparse(str(url or ''))
    if u.scheme != 'https' or not u.hostname:
        raise ValueError('enter an https:// address')
    req = urllib.request.Request(url, headers={'User-Agent': 'PanelHogar'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(SCRIPT_MAX + 1)
    if len(data) > SCRIPT_MAX:
        raise ValueError('the script is too big (max. 100 KB)')
    return data.decode('utf-8', 'replace')


def merge_source_keys(sources, current):
    """The API keys of the photo sources do not travel to the web: empty = the one there was (by id)."""
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
    """Only the known keys. Empty token or Immich key = “do not change them”."""
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


# ---------------------------------------------------------------- web password
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


# ---------------------------------------------------------------- screen
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
    """Video outputs according to wlr-randr (it needs to be inside the cage session)."""
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
        print(f'[simulation] screen {"encendida" if on else "apagada"}', flush=True)
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


# ---------------------------------------------------------------- Home Assistant (from the Pi)
def ha_request(method, path, body=None, ha_url=None, token=None):
    panel = load_config()['panel']
    ha_url = (ha_url or panel.get('haUrl') or '').rstrip('/')
    token = token or panel.get('token')
    if not ha_url or not token:
        return 0, {'error': 'the Home Assistant URL or token is missing'}
    req = urllib.request.Request(ha_url + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, {'error': 'invalid token' if e.code == 401 else f'HTTP {e.code}'}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, {'error': f'could not connect: {getattr(e, "reason", e)}'}


# ---------------------------------------------------------------- speaker (Sendspin)
# The Pi as a Music Assistant speaker. setup-sendspin.sh installs “sendspin” and the user service
# panel-sendspin, which starts “panel-helper.py --sendspin” (reads sendspin.json and starts sendspin).
SENDSPIN_FILE = DATA / 'sendspin.json'
SENDSPIN_BIN = Path.home() / '.local' / 'share' / 'panel-hogar' / 'sendspin' / 'bin' / 'sendspin'
SENDSPIN_UNIT = 'panel-sendspin.service'
SENDSPIN_PIN = DATA / 'sendspin-pin.json'      # code to pair with Music Assistant (sendspin-run.py writes it)
SIM_SPEAKER = {'active': False}
CARD_NAMES = {'Headphones': 'Jack 3.5 mm', 'vc4hdmi0': 'HDMI 1', 'vc4hdmi1': 'HDMI 2', 'vc4hdmi': 'HDMI'}


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
    else:   # from before: the panel one (if it opened “Now playing”) and then the others
        np_list = (['@panel'] if s.get('open', True) is not False else []) + watch
    try:   # seconds “Now playing” stays open after pausing/stopping (-1 = it never closes by itself)
        close_after = max(-1, min(3600, int(s.get('closeAfter', 60))))
    except (TypeError, ValueError):
        close_after = 60
    return {'enabled': bool(s.get('enabled')), 'name': str(s.get('name') or '').strip()[:60],
            'device': str(s.get('device') or '').strip()[:120], 'delay': delay,
            'entity': entity if entity.startswith('media_player.') else '', 'open': s.get('open', True) is not False,
            'closeAfter': close_after,
            # other speakers that also open “Now playing” when they start playing (e.g. the bedroom one)
            'watch': watch,
            # speakers that open “Now playing”, by priority ('@panel' = this panel's)
            'npSpeakers': np_list}


def speaker_pin():
    """Code Music Assistant asks for to pair the speaker, while pairing (otherwise None)."""
    if SIMULATE and SIM_SPEAKER.get('pin'):
        return SIM_SPEAKER['pin']
    try:
        p = json.loads(SENDSPIN_PIN.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(p, dict) or time.time() - float(p.get('at') or 0) > 600:   # an old one is no good
        return None
    return str(p.get('code') or '')[:20] or None


def speaker_panel():
    """What the panel needs: the name it has in Music Assistant and whether it opens the player when it plays."""
    s = speaker_settings()
    return {'enabled': s['enabled'], 'name': s['name'] or speaker_default_name(), 'entity': s['entity'], 'open': s['open'],
            'closeAfter': s['closeAfter'], 'watch': s['watch'], 'npSpeakers': s['npSpeakers']}


def speaker_default_name():
    return 'Panel ' + socket.gethostname().split('.')[0]


def audio_outputs():
    """Audio outputs: one per card (plughw converts the format if needed)."""
    outs = [{'id': '', 'name': 'The system default'}]
    if SIMULATE:
        return outs + [{'id': 'plughw:CARD=Headphones,DEV=0', 'name': 'Jack 3.5 mm'},
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
        raise ValueError('that audio output does not exist')
    DATA.mkdir(parents=True, exist_ok=True)
    SENDSPIN_FILE.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
    new = speaker_settings()
    bump_version(reload=False)   # the panel reads the speaker again (player, open when playing) without reloading
    if not body.get('restart') and all(new[k] == cur[k] for k in ('enabled', 'name', 'device')):
        return 'Saved.'   # only panel options (“Now playing”, player): the speaker keeps playing without restarting
    if SIMULATE:
        SIM_SPEAKER['active'] = new['enabled']
        return '[Simulation] Saved (nothing plays on the PC).'
    if not SENDSPIN_BIN.exists():
        return 'Saved. It still has to be installed on the Pi: bash ~/ha-panel/scripts/setup-sendspin.sh'
    if new['enabled']:
        _user_ctl('enable', SENDSPIN_UNIT)
        code, _, err = _user_ctl('restart', SENDSPIN_UNIT)
        if code != 0:
            raise RuntimeError(f'it did not start: {err or "see the log"}')
        return 'Speaker on. It will show up in Music Assistant in a few seconds.'
    _user_ctl('disable', '--now', SENDSPIN_UNIT)
    return 'Speaker off.'


def run_speaker():
    """Started by the panel-sendspin service: runs sendspin with the web settings."""
    s = speaker_settings()
    if not s['enabled']:
        print('Speaker turned off in the web (Settings → Speaker).', flush=True)
        return
    # sendspin-run.py = sendspin daemon + saves the pairing code to show it on the panel
    args = [str(SENDSPIN_BIN.parent / 'python3'), str(HERE / 'scripts' / 'sendspin-run.py'), 'daemon', '--name', s['name'] or speaker_default_name(),
            '--settings-dir', str(DATA / 'sendspin'), '--hardware-volume', 'false', '--disable-mpris',
            '--product-name', 'Panel Hogar']
    if s['device']:
        args += ['--audio-device', s['device']]
    # The offset is NOT passed: it is set in Music Assistant and sendspin saves it; if it were passed here,
    # it would overwrite Music Assistant's at start.
    os.environ['PANEL_SENDSPIN_PIN'] = str(SENDSPIN_PIN)
    os.execv(args[0], args)


# ---------------------------------------------------------------- voice assistant (Wyoming satellite)
# setup-voice.sh installs wyoming-satellite + microWakeWord and the user service panel-voice, which starts
# “panel-helper.py --voice” (reads voice.json and starts the satellite). Mic, output and word are chosen in the web or the panel.
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
            'volume': _int(s.get('volume'), 10, 100, 100),     # volume of the answers (%)
            'micGain': _int(s.get('micGain'), 20, 100, 100)}   # mic gain (%; only in the web, at the maximum by default)


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def audio_inputs():
    # Mics: one per card that can record ('' = the first one there is)
    ins = [{'id': '', 'name': 'Automatic (the first one there is)'}]
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
    # Only checked if they change: changing the volume must not fail because the mic is unplugged
    if new['mic'] and new['mic'] != cur['mic'] and new['mic'] not in {o['id'] for o in audio_inputs()}:
        raise ValueError('that mic is not connected')
    if new['output'] and new['output'] != cur['output'] and new['output'] not in {o['id'] for o in audio_outputs()}:
        raise ValueError('that audio output does not exist')
    if new['wake'] not in dict(WAKE_WORDS):
        raise ValueError('unknown wake word')
    DATA.mkdir(parents=True, exist_ok=True)
    VOICE_FILE.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
    if SIMULATE:
        SIM_VOICE['active'] = new['enabled']
        return '[Simulation] Saved (nothing is heard on the PC).'
    if not VOICE_PY.exists():
        return 'Saved. It still has to be installed on the Pi: bash ~/ha-panel/scripts/setup-voice.sh'
    if new['enabled']:
        _user_ctl('enable', VOICE_UNIT)
        code, _, err = _user_ctl('restart', VOICE_UNIT)
        if code != 0:
            raise RuntimeError(f'it did not start: {err or "see the log"}')
        return 'Voice assistant on.'
    _user_ctl('disable', '--now', VOICE_UNIT)
    return 'Voice assistant off.'


def run_voice():
    # Started by the panel-voice service: runs the satellite with the web settings
    s = voice_settings()
    if not s['enabled']:
        print('Voice assistant turned off (Settings → Voice assistant).', flush=True)
        return
    mic = s['mic'] or next((o['id'] for o in audio_inputs()[1:]), '')
    if not mic:
        sys.exit('No mic is connected.')
    out = s['output'] or 'default'
    # Many USB mics come very low and the wake word is not heard: the gain goes up (at the maximum by default)
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
    print('Mic:', mic, '· Output:', out, '· Wake word:', s['wake'], flush=True)
    os.execv(args[0], args)


# ---------------------------------------------------------------- sound (general volume)
# The general volume is the one of the Pi's audio output (jack, USB…): it affects everything playing on it.
# It is saved in sound.json and set again at start (ALSA does not remember it without sudo).
SOUND_FILE = DATA / 'sound.json'
MIXER_CTLS = ('Master', 'PCM', 'Speaker', 'Headphone', 'Digital')
SIM_SOUND = {'master': 70, 'music': 40}


def output_card():
    # The card the panel plays on: the speaker's, the assistant's or the default one (0)
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
        return {'available': True, 'value': SIM_SOUND['master'], 'card': 'Jack 3.5 mm'}
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
        raise RuntimeError('this audio output has no volume of its own')
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
    """The Home Assistant media_player that is this speaker: the one chosen in the web or the one named like it."""
    s = speaker_settings()
    if s['entity']:
        return s['entity']
    name = (s['name'] or speaker_default_name()).strip()
    slug = re.sub(r'[^a-z0-9]+', '_', unicodedata.normalize('NFD', name.lower()).encode('ascii', 'ignore').decode()).strip('_')
    return 'media_player.' + slug if slug else ''


def music_get():
    """Music volume (the speaker's in Home Assistant / Music Assistant). In simulation Home Assistant is not touched."""
    ent = music_entity()
    if SIMULATE:
        return {'available': True, 'entity': ent, 'name': 'Test speaker', 'value': SIM_SOUND['music']}
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
        raise RuntimeError('it is not known which speaker this panel is in Home Assistant')
    code, res = ha_request('POST', '/api/services/media_player/volume_set', {'entity_id': ent, 'volume_level': v / 100})
    if code != 200:
        raise RuntimeError('Home Assistant did not accept it: ' + str((res or {}).get('error', code)))
    mqtt_publish_volumes()


def set_sound(body):
    if 'master' in body:
        master_set(body['master'])
    voice = {k: body[k] for k in ('voiceVolume', 'micGain') if k in body}
    if voice:
        set_voice({'volume': voice.get('voiceVolume', voice_settings()['volume']), 'micGain': voice.get('micGain', voice_settings()['micGain'])})
    return sound_info()


# ---------------------------------------------------------------- updates (git)
# Every 3 h it checks GitHub for a new version (same branch). Depending on the web (Settings → Updates):
# just notify (the “Update” button) or update by itself every day at a time. After updating, update-hook.sh runs
# (new system packages, etc.) and the kiosk (panel + this helper) and the speaker restart.
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
    mode = {'avisar': 'notify'}.get(s.get('mode'), s.get('mode'))   # “avisar”: the old name
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
    """Checks GitHub for a new version of the current branch (it only downloads the information, it changes nothing)."""
    with UPD_LOCK:
        if UPD['checking']:
            return
        UPD['checking'] = True
    try:
        branch = git_branch()
        if not branch:
            UPD['error'] = 'It is not a git copy with a branch (was it installed without git clone?).'
            return
        code, _, err = _git('fetch', '-q', 'origin', branch, timeout=90)
        if code != 0:
            UPD['error'] = 'Could not check: ' + (err.splitlines() or ['offline'])[-1][:200]
            return
        code, out, err = _git('log', '--format=%h%x1f%s', f'HEAD..origin/{branch}')
        UPD['available'] = [dict(zip(('hash', 'subject'), line.split('\x1f', 1))) for line in out.splitlines() if line][:50]
        UPD['error'] = '' if code == 0 else err[:200]
    finally:
        UPD['lastCheck'] = time.time()
        UPD['checking'] = False


def _restart_after_update(before):
    """Without restarting the whole kiosk: the panel reloads by itself (the version changes) and this helper restarts itself.
    The speaker only restarts if its part changed (so the music is not cut for no reason)."""
    changed = _git('diff', '--name-only', before, 'HEAD')[1].splitlines()
    hunks = _git('diff', '-U0', before, 'HEAD', '--', 'panel-helper.py')[1]
    speaker = 'scripts/sendspin-run.py' in changed or 'def run_speaker' in hunks or 'SENDSPIN' in hunks
    bump_version()                 # the panel sees the new version in /poll and reloads the page
    if SIMULATE:
        return
    if speaker and SENDSPIN_BIN.exists() and _user_ctl('is-active', SENDSPIN_UNIT)[1] == 'active':
        _user_ctl('restart', SENDSPIN_UNIT)
    if ('def run_voice' in hunks or 'VOICE' in hunks) and VOICE_PY.exists() and _user_ctl('is-active', VOICE_UNIT)[1] == 'active':
        _user_ctl('restart', VOICE_UNIT)
    if 'panel-helper.py' in changed:
        sys.stdout.flush()
        os.execv(sys.executable, [sys.executable, str(HERE / 'panel-helper.py')])   # same process, new code


def apply_update():
    """Updates to the latest version from GitHub. It runs in the background; the result stays in UPD."""
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
            UPD['log'] = 'It was already up to date.'
            return
        if SIMULATE:
            time.sleep(2)
            UPD['available'] = []
            UPD['log'] = '[Simulation] Updated (nothing changes on the computer).'
            return
        code, out, _ = _git('status', '--porcelain', '--untracked-files=no')
        if out:
            UPD['error'] = 'There are files changed by hand on the Pi; it does not update so they are not lost: ' + ', '.join(
                line.split(maxsplit=1)[-1] for line in out.splitlines()[:5])
            return
        before = _git('rev-parse', 'HEAD')[1]
        code, _, err = _git('merge', '--ff-only', f'origin/{git_branch()}')
        if code != 0:
            UPD['error'] = 'Could not update: ' + err[-200:]
            return
        log = [f'Updated: {before[:7]} → {_git("rev-parse", "--short", "HEAD")[1]}']
        if UPDATE_HOOK.exists():   # steps of the new version (system packages…)
            try:
                r = subprocess.run(['bash', str(UPDATE_HOOK), before], capture_output=True, text=True, timeout=1200)
                log.append(((r.stdout or '') + (r.stderr or '')).strip())
            except (OSError, subprocess.SubprocessError) as e:
                log.append(f'update-hook.sh failed: {e}')
        UPD['log'] = '\n'.join(x for x in log if x)[-4000:]
        UPD['available'] = []
        _later(lambda: _restart_after_update(before), 3)
    finally:
        UPD['applying'] = False


# ---------------------------------------------------------------- Home Assistant over MQTT
# The panel shows up in Home Assistant as a device, through MQTT discovery (Mosquitto): nothing has to be
# installed in Home Assistant. Entities (the ones chosen in the web → General): Screen (on and brightness),
# Brightness, Output volume, Music volume, Ambient mode, Last touched and Reload. Topics: panel_hogar/<id>/… and homeassistant/<kind>/panel_hogar_<id>/<thing>/config
HA_EXPOSE = ('screen', 'brightness', 'volume', 'music_volume', 'ambient', 'last_touch', 'reload')
PANEL_STATE = {'screen_on': None, 'brightness': None, 'ambient': None, 'last_touch': None}
HA_COMMANDS = {'screen_on': 'screen_on', 'screen_off': 'screen_off', 'ambient_on': 'ambient', 'ambient_off': 'home',
               'reload': 'reload', 'brightness': 'brightness'}
MQTT = {'client': None, 'status': 'off', 'error': ''}
MQTT_LOG = []          # the last things that happened (web → General → MQTT → Log)


def mqtt_log(text):
    line = time.strftime('%H:%M:%S ') + text
    with LOCK:
        MQTT_LOG.append(line)
        del MQTT_LOG[:-300]
    try:
        print('mqtt:', text, flush=True)
    except (OSError, UnicodeError):   # a strange console does not bring the connection down
        pass


def panel_id():
    """Stable id of this panel (it does not change even if you rename it)."""
    try:
        seed = Path('/etc/machine-id').read_text().strip()
    except OSError:
        seed = socket.gethostname()
    return hashlib.sha256(('panel-hogar:' + seed).encode()).hexdigest()[:12]


def ha_expose():
    """What Home Assistant sees (web → General); everything by default."""
    chosen = load_config()['settings'].get('haExpose') or {}
    return [k for k in HA_EXPOSE if chosen.get(k) is not False]


def set_panel_state(body):
    """The panel says how it is (screen, brightness, ambient mode, last touch); if it changes, it is sent over MQTT."""
    changed = {}
    with LOCK:
        for k in PANEL_STATE:
            if k in body and body[k] != PANEL_STATE[k]:
                PANEL_STATE[k] = changed[k] = body[k]
    if changed:
        mqtt_publish_state(changed)
    return True


def send_command(command, value=None):
    """A command from Home Assistant for the panel (it gets it in its next poll, within 1 s)."""
    if command not in HA_COMMANDS:
        raise ValueError('unknown command')
    if command == 'brightness':
        value = _int(value, 5, 100, 100)
    with LOCK:
        COMMAND['id'] += 1
        COMMAND['type'] = HA_COMMANDS[command]
        COMMAND['value'] = value


class MqttClient:
    """Minimal MQTT 3.1.1 client (no dependencies): connects, publishes, subscribes and reconnects by itself."""

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
        mqtt_log(f'→ {topic}: ' + (shown[:120] + '…' if len(shown) > 120 else shown or '(empty: removed)'))
        body = self._str(topic) + (payload.encode() if isinstance(payload, str) else payload or b'')
        try:
            self._send(self._packet(0x30 | (1 if retain else 0), body))
        except OSError:
            pass

    def subscribe(self, topics):
        mqtt_log('Listening: ' + ', '.join(topics))
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
                mqtt_log(f'Connecting to {self.host}:{self.port}' + (f' as “{self.user}”' if self.user else ' without a user') + '…')
                self.sock = socket.create_connection((self.host, self.port), timeout=10)
                flags = 0x02 | 0x04 | 0x20          # clean session, will (retained)
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
                    reason = {4: 'wrong user or password', 5: 'not allowed'}.get(data[1] if len(data) > 1 else 0, 'rechazado')
                    raise ConnectionError(reason)
                MQTT.update(status='connected', error='')
                mqtt_log('Connected')
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
                        except Exception as e:   # noqa: BLE001 — a strange command does not bring the connection down
                            mqtt_log(f'Command with an error: {e}')
            except (OSError, ConnectionError, ValueError) as e:
                MQTT.update(status='error', error=str(e) or type(e).__name__)
                if not self.stopped:
                    mqtt_log(f'Error: {MQTT["error"]}. Retrying in 10 s')
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
    """The Pi's IP on the home network (for the “Visit” link in Home Assistant)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
            u.connect(('192.0.2.1', 9))      # nothing is sent: it only picks the outgoing interface
            return u.getsockname()[0]
    except OSError:
        return socket.gethostname().split('.')[0] + '.local'


def _mqtt_device():
    code, out, _ = _git('rev-parse', '--short', 'HEAD', timeout=5)
    host = socket.gethostname().split('.')[0]
    return {'identifiers': [f'panel_hogar_{panel_id()}'], 'name': f'Panel {host}', 'manufacturer': 'Panel Hogar',
            'model': 'Raspberry Pi', 'sw_version': out.strip() if code == 0 else '', 'configuration_url': f'http://{_lan_ip()}:{WEB_PORT}'}


def _mqtt_names():
    """Entity names in the panel language (translations/<language>.json → panel.mqtt)."""
    lang = load_config()['settings'].get('language') or 'es'
    names = {}
    for code in ('es', lang):
        data = read_translation(f'/translations/{code}.json') if re.fullmatch(r'[a-z]{2,3}', code) else None
        names.update(((data or {}).get('texts') or {}).get('panel', {}).get('mqtt', {}))
    return {k: names.get(k, k) for k in HA_EXPOSE}


def mqtt_discovery(client=None):
    """Announces (or removes) each entity in Home Assistant according to what was chosen in the web."""
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


VOLUMES = {'volume': None, 'music_volume': None}   # the last thing sent (so it is not repeated)


def mqtt_publish_volumes(force=False):
    """Output volume (the Pi's) and music volume (the speaker in Home Assistant), if they change."""
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
        except Exception:   # Home Assistant does not answer: it will be checked on the next round
            m = {}
        now['music_volume'] = m.get('value') if m.get('available') else None
    for k, v in now.items():
        if v is not None and (force or v != VOLUMES[k]):
            VOLUMES[k] = v
            client.publish(f'{base}/{k}/state', str(v), retain=True)


def _mqtt_volume_loop(client):
    """The volumes also change outside the panel (Music Assistant, amixer…): they are checked every 30 s."""
    while MQTT['client'] is client and not client.stopped:
        time.sleep(30)
        if MQTT['client'] is client:
            mqtt_publish_volumes()


def _set_volume(key, payload):
    try:
        (master_set if key == 'volume' else music_set)(round(float(payload)))
    except (ValueError, RuntimeError) as e:
        mqtt_log(f'Error: could not change the volume ({e})')


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
        if payload == 'online':          # Home Assistant restarted: announce again
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
    """Starts (or restarts) the connection with the data from the web → General → Home Assistant (MQTT)."""
    old = MQTT['client']
    if old:
        old.stop()
        mqtt_log('Disconnected')
    MQTT.update(client=None, status='off', error='')
    p = load_config()['panel']
    if not p.get('mqttEnabled') or not p.get('mqttHost'):
        if old or p.get('mqttEnabled'):
            mqtt_log('Off' if not p.get('mqttEnabled') else 'The MQTT server is missing')
        return
    base = _mqtt_base()
    client = MqttClient(p['mqttHost'], p.get('mqttPort') or 1883, p.get('mqttUser') or '', p.get('mqttPassword') or '',
                        f'panel-hogar-{panel_id()}', (base + '/status', 'offline'), _mqtt_connected, _mqtt_message)
    MQTT.update(client=client, status='connecting')
    VOLUMES.update(volume=None, music_volume=None)
    threading.Thread(target=client.run, daemon=True).start()
    threading.Thread(target=_mqtt_volume_loop, args=(client,), daemon=True).start()


# Live screen (web → General): a capture of what the Pi's screen shows (grim, inside cage).
SCREEN_CAP = {'at': 0.0, 'png': None}


def screen_capture():
    """PNG of the screen right now (at most one capture every half second), or None if it is not possible."""
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
    # can it install packages without a password? (permission given by setup-kiosk.sh)
    # (“sudo -l apt-get” is no good: it also says yes when it can with a password)
    can_sudo = True if SIMULATE else any('NOPASSWD' in line and '/usr/bin/apt-get' in line
                                         for line in _run(['-l'], sudo=True)[1].splitlines())
    return {'settings': update_settings(), 'branch': git_branch(), 'current': current_version(),
            'available': UPD['available'], 'lastCheck': UPD['lastCheck'], 'checking': UPD['checking'],
            'applying': UPD['applying'], 'error': UPD['error'], 'log': UPD['log'], 'sudo': can_sudo, 'simulated': SIMULATE}


def update_action(body):
    """Web and panel: check, update now, or mode (notify / automatic) and time. Returns (code, answer)."""
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
            return 200, {'ok': True, 'message': 'Updating… the panel will restart by itself.', 'info': update_info()}
    except ValueError as e:
        return 400, {'error': str(e)}
    return 400, {'error': 'unknown action'}


def update_loop():
    """Checks every 3 h; in automatic mode it updates once a day at the chosen time."""
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
        except Exception as e:   # so a failure does not stop the checks
            UPD['error'] = str(e)[:200]
        time.sleep(300)


# ---------------------------------------------------------------- network (NetworkManager)
def _run(cmd, sudo=False, timeout=20):
    """Runs a command; with sudo it uses “sudo -n” (without asking for a password: permission from setup-kiosk.sh)."""
    try:
        r = subprocess.run((['sudo', '-n'] if sudo else []) + cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or '').strip(), (r.stderr or '').strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, '', str(e)


def _nm_fields(line):
    """Splits a “nmcli -t” line by the unescaped “:”."""
    return [p.replace('\\:', ':') for p in re.split(r'(?<!\\):', line)]


def _primary_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))      # nothing is sent: it only picks the outgoing interface
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
        raise RuntimeError(err or 'could not look for WiFi networks')
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
    """Network changes cut the connection: they are applied a bit after answering the web."""
    threading.Timer(delay, fn).start()


def wifi_connect(ssid, password):
    if SIMULATE:
        def sim():
            SIM['ssid'] = ssid
            print(f'[simulation] connected to the WiFi “{ssid}”', flush=True)
        return _later(sim)
    cmd = ['nmcli', 'device', 'wifi', 'connect', ssid] + (['password', password] if password else [])
    _later(lambda: _run(cmd, sudo=True, timeout=60))


def set_ipv4(method, address='', prefix=24, gateway='', dns=''):
    con = {'name': SIM['ssid']} if SIMULATE else _active_connection()
    if not con:
        raise RuntimeError('there is no active network connection')
    if method == 'manual':
        def check(value, label):                       # validate before touching anything
            try:
                ipaddress.IPv4Address(value)
            except ValueError:
                raise ValueError(f'{label} “{value}” is not a valid IPv4 address') from None
        check(address, 'The IP')
        if gateway:
            check(gateway, 'The gateway')
        for d in [x.strip() for x in dns.replace(';', ',').split(',') if x.strip()]:
            check(d, 'The DNS')
        prefix = int(prefix)
        if not 8 <= prefix <= 32:
            raise ValueError('invalid netmask')
        args = ['ipv4.method', 'manual', 'ipv4.addresses', f'{address}/{prefix}', 'ipv4.gateway', gateway,
                'ipv4.dns', dns.replace(';', ',').replace(' ', '')]
    else:
        args = ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']
    if SIMULATE:
        SIM['ipv4'] = {'method': method if method == 'manual' else 'auto',
                       'addresses': f'{address}/{prefix}' if method == 'manual' else '',
                       'gateway': gateway if method == 'manual' else '', 'dns': dns if method == 'manual' else ''}
        print(f'[simulation] IP {"fija " + address if method == "manual" else "automatic"}', flush=True)
        return
    code, _, err = _run(['nmcli', 'connection', 'modify', con['name']] + args, sudo=True)
    if code != 0:
        raise RuntimeError(err or 'could not change the IP (sudo permission for nmcli?)')
    _later(lambda: _run(['nmcli', 'connection', 'up', con['name']], sudo=True, timeout=60))


def set_hostname(name):
    if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', name or ''):
        raise ValueError('only letters, numbers and hyphens (no spaces)')
    if SIMULATE:
        SIM['hostname'] = name
        print(f'[simulation] device name: {name}', flush=True)
        return
    code, _, err = _run(['hostnamectl', 'set-hostname', name], sudo=True)
    if code != 0:
        raise RuntimeError(err or 'could not change the name (sudo permission for hostnamectl?)')


# ---------------------------------------------------------------- Google Photos
def google_album(url):
    """Reads the photos of a Google Photos shared album (the public page of the link)."""
    u = urlparse(url)
    if u.scheme != 'https' or u.hostname not in GOOGLE_HOSTS:
        raise ValueError('enter the link of a Google Photos shared album (https://photos.app.goo.gl/…)')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                                               'Accept-Language': 'es-ES,es;q=0.9'})
    with urllib.request.urlopen(req, timeout=25) as r:
        if urlparse(r.geturl()).hostname not in GOOGLE_HOSTS:
            raise ValueError('the link does not lead to Google Photos')
        html = r.read(8 * 1024 * 1024).decode('utf-8', 'replace')
    photos = list(dict.fromkeys(re.findall(r'https://lh3\.googleusercontent\.com/pw/[A-Za-z0-9_\-]{40,}', html)))
    m = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    title = (m.group(1) if m else '').split(' - ')[0].strip()
    if not photos:
        raise ValueError('no photos found (is the album shared with a link?)')
    return {'title': title, 'photos': photos}


# ---------------------------------------------------------------- servers
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
        return self._json(200, data) if data is not None else self._json(404, {'error': 'does not exist'})

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 256 * 1024:
            raise ValueError('demasiado grande')
        return json.loads(self.rfile.read(n) or b'{}') if n else {}


def read_translation(path):
    """translations/xx.json (the panel and web languages), or None if it does not exist or is malformed."""
    try:
        return json.loads((HERE / path.lstrip('/')).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        print('translations:', path, e, flush=True)
        return None


class LocalHandler(Base):
    """127.0.0.1:8766 — only for the panel running on the Pi itself."""

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
            return self._json(403, {'error': 'only Immich album paths are allowed'})
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
            if SIMULATE:   # no real backlight: the panel dims by software and “turns off” with the black layer
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
                return self._json(502, {'error': f'could not read the album: {getattr(e, "reason", e)}'})
        self._json(404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == '/state':     # the panel says how it is (for Home Assistant over MQTT)
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
            if u.path == '/data':  # the panel sends screen and entity info to try bubbles in the web
                body = self._body()
                PANEL_DATA.update(body if isinstance(body, dict) else {})
                PANEL_DATA['t'] = time.time()
                return self._json(200, {'ok': True, 'hasInfo': bool(PANEL_DATA.get('info'))})
            if u.path == '/seed':   # the panel copies its config.js and its Settings here the first time
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
        if urlparse(self.path).path == '/settings':   # the panel saves its Settings
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
    """0.0.0.0:8080 — configuration web for your home network, with a password."""

    def _session(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'panel_session' and SESSIONS.get(v, 0) > time.time():
                return v
        return None

    def _guard(self, mutating=False):
        if not self._session():
            self._json(401, {'error': 'log in'})
            return False
        if mutating and self.headers.get('X-Panel') != '1':     # CSRF protection
            self._json(403, {'error': 'invalid request'})
            return False
        return True

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/api/screen.png':   # the Pi's screen, live
            if not self._guard():
                return
            png = screen_capture()
            if not png:
                return self._json(503, {'error': 'only on the Pi (grim is needed)'})
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(png)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(png)
            return
        if u.path == '/api/mqtt':        # state of the connection with Home Assistant over MQTT
            if not self._guard():
                return
            return self._json(200, {'status': MQTT['status'], 'error': MQTT['error'], 'log': MQTT_LOG[-200:]})
        if u.path in ('/', '/index.html'):
            try:
                data = (HERE / 'config.html').read_bytes()
            except OSError:
                return self._json(500, {'error': 'config.html is missing'})
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        # the same code the panel uses, to try bubbles and components in the web
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
        if u.path == '/api/states':        # current states (read only) to try scripts in the web
            if not self._guard():
                return
            code, states = ha_request('GET', '/api/states')
            if code != 200:
                return self._json(502, states)
            return self._json(200, {st['entity_id']: st for st in states})
        if u.path == '/api/panel-data':    # the panel's screen and entity info, to try bubbles in the web
            if not self._guard():
                return
            return self._json(200, PANEL_DATA)
        if u.path == '/api/config':
            if not self._guard():
                return
            cfg = load_config()
            panel = dict(cfg['panel'])
            panel['hasToken'] = bool(panel.pop('token', None))          # the token never leaves the Pi
            panel['hasImmichApiKey'] = bool(panel.pop('immichApiKey', None))
            panel['hasMqttPassword'] = bool(panel.pop('mqttPassword', None))
            if isinstance(panel.get('photoSources'), list):   # not set up yet: the web creates them from ambientPhotos
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
                return self._json(409, {'error': 'There is no password yet. On the Pi run: python3 ~/ha-panel/panel-helper.py --set-password'})
            if not check_password(str(body.get('password', ''))):
                time.sleep(1.5)     # slows down wild attempts
                return self._json(401, {'error': 'Wrong password'})
            sid = secrets.token_urlsafe(32)
            SESSIONS[sid] = time.time() + 30 * 86400
            return self._json(200, {'ok': True},
                              {'Set-Cookie': f'panel_session={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'})
        if u.path == '/api/logout':
            SESSIONS.pop(self._session() or '', None)
            return self._json(200, {'ok': True}, {'Set-Cookie': 'panel_session=; Path=/; Max-Age=0'})
        if not self._guard(mutating=True):
            return
        if u.path == '/api/scripts/import':
            try:
                code = download_script(body.get('url'))
                name = save_script(body.get('name') or os.path.basename(urlparse(body.get('url')).path), code)
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {'error': f'could not download: {getattr(e, "reason", e)}'})
            return self._json(200, {'ok': True, 'name': name, 'code': code, 'version': bump_version()})
        if u.path == '/api/test':        # test the connection with what is typed in the form (or what is saved)
            code, res = ha_request('GET', '/api/', ha_url=body.get('haUrl') or None, token=body.get('token') or None)
            return self._json(200, {'ok': code == 200, 'message': 'Connected to Home Assistant' if code == 200 else res.get('error')})
        if u.path == '/api/notify':
            code, res = ha_request('POST', '/api/events/panel_notification', {
                'id': 'prueba_web', 'title': 'Test notification', 'message': 'Sent from the configuration web',
                'level': 'warning', 'icon': 'mdi:bell-ring', 'timeout': 20})
            return self._json(200, {'ok': code == 200, 'message': 'Notification sent to the panel' if code == 200 else res.get('error')})
        if u.path.startswith('/api/network/'):
            try:
                if u.path == '/api/network/scan':
                    return self._json(200, wifi_scan())
                if u.path == '/api/network/wifi':
                    ssid = str(body.get('ssid', '')).strip()
                    if not ssid:
                        return self._json(400, {'error': 'choose a network'})
                    wifi_connect(ssid, str(body.get('password', '')))
                    return self._json(200, {'ok': True, 'message': (f'[Simulation] Connected to “{ssid}” (the PC network does not change).' if SIMULATE else
                                                                     f'Connecting to “{ssid}”… If the IP changes, log in with the new one (you will see it on the panel screen).')})
                if u.path == '/api/network/ip':
                    set_ipv4(body.get('method', 'auto'), str(body.get('address', '')).strip(), body.get('prefix', 24),
                             str(body.get('gateway', '')).strip(), str(body.get('dns', '')).strip())
                    return self._json(200, {'ok': True, 'message': '[Simulation] IP changed (the PC one does not change).' if SIMULATE else 'Applying the new IP… log in again with the new address.'})
                if u.path == '/api/network/hostname':
                    set_hostname(str(body.get('hostname', '')).strip())
                    return self._json(200, {'ok': True, 'message': '[Simulation] Name changed (the PC one does not change).' if SIMULATE else 'Name changed. The new .local address works after restarting the Pi.'})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
            return self._json(404)
        if u.path == '/api/speaker':       # turn the Sendspin speaker on / off, its name and output
            try:
                return self._json(200, {'ok': True, 'message': set_speaker(body), 'info': speaker_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/sound':        # music, output limit, answers and mic gain
            try:
                if 'music' in body:
                    music_set(body['music'])
                return self._json(200, dict(set_sound(body), music=music_get()))
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/voice':           # mic, output and wake word of the voice assistant
            try:
                return self._json(200, {'ok': True, 'message': set_voice(body), 'info': voice_info()})
            except (ValueError, RuntimeError) as e:
                return self._json(400, {'error': str(e)})
        if u.path == '/api/updates':   # check, update now, or mode (notify / automatic) and time
            return self._json(*update_action(body))
        if u.path == '/api/command':         # reload, turn the screen off/on, ambient mode, home
            kind = body.get('type')
            if kind not in ('reload', 'screen_off', 'screen_on', 'ambient', 'home'):
                return self._json(400, {'error': 'unknown command'})
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
            return self._json(404, {'error': 'does not exist'})
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
            # Connection, entities, photos…: the panel has to start again. Only settings: it applies them right away.
            reload = json.dumps(cfg['panel'], sort_keys=True) != old_panel
            version = save_config(cfg, reload)
        # MQTT: with new data it reconnects; otherwise the entities are announced again (what was chosen or the language)
        threading.Thread(target=mqtt_restart if reload else mqtt_discovery, daemon=True).start()
        return self._json(200, {'ok': True, 'version': version, 'reload': reload})


def serve(port, handler, host):
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description='Panel Hogar helper')
    ap.add_argument('--set-password', action='store_true', help='set or change the web password')
    ap.add_argument('--sendspin', action='store_true', help='start the Sendspin speaker (used by the panel-sendspin service)')
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
            pw = getpass.getpass('New password for the panel web: ')
            if pw != getpass.getpass('Repeat it: '):
                sys.exit('They do not match.')
        else:
            pw = sys.stdin.readline().strip()
        if len(pw) < 4:
            sys.exit('Too short (at least 4 characters).')
        set_password(pw)
        print('Password saved.')
        return
    if SIMULATE:
        print('Panel Hogar · helper in SIMULATION MODE (simulated screen and network; nothing on this device changes)', flush=True)
    threading.Thread(target=serve, args=(WEB_PORT, WebHandler, '0.0.0.0'), daemon=True).start()
    threading.Thread(target=update_loop, daemon=True).start()
    mqtt_restart()   # Home Assistant over MQTT (if it is on in the web)
    master_restore()
    serve(LOCAL_PORT, LocalHandler, '127.0.0.1')


if __name__ == '__main__':
    main()
