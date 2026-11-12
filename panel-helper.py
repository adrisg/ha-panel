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
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('PANEL_DATA', Path.home() / '.config' / 'panel-hogar'))
CONFIG_FILE = DATA / 'config.json'
PASS_FILE = DATA / 'admin.json'
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


def save_config(cfg):
    cfg['version'] = int(time.time() * 1000)
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
            return self._json(200, load_config())
        if u.path == '/red':
            return self._json(200, net_info())
        if u.path == '/poll':
            return self._json(200, {'version': load_config()['version'], 'command': COMMAND})
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
                return self._json(200, {'version': save_config(cfg)})
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
        if u.path == '/api/estado':
            return self._json(200, {'password': PASS_FILE.exists(), 'session': bool(self._session()), 'simulated': SIMULATE})
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
        if u.path == '/api/orden':         # recargar, apagar/encender pantalla, modo ambiente, inicio
            tipo = body.get('tipo')
            if tipo not in ('recargar', 'pantalla_off', 'pantalla_on', 'ambiente', 'inicio'):
                return self._json(400, {'error': 'orden desconocida'})
            with LOCK:
                COMMAND['id'] += 1
                COMMAND['type'] = tipo
            return self._json(200, {'ok': True})
        self._json(404)

    def do_PUT(self):
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
            if isinstance(body.get('panel'), dict):
                cfg['panel'] = clean_panel(body['panel'], current=cfg['panel'])
            if isinstance(body.get('ajustes'), dict):
                cfg['ajustes'] = body['ajustes']
            return self._json(200, {'ok': True, 'version': save_config(cfg)})


def serve(port, handler, host):
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description='Ayudante del Panel Hogar')
    ap.add_argument('--set-password', action='store_true', help='poner o cambiar la contraseña de la web')
    args = ap.parse_args()
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
    serve(LOCAL_PORT, LocalHandler, '127.0.0.1')


if __name__ == '__main__':
    main()
