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
import os
import secrets
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

# Rutas de Immich que el panel puede leer a través del ayudante (solo lectura)
IMMICH_PATHS = ('/api/shared-links/me', '/api/albums/', '/api/timeline/buckets', '/api/timeline/bucket')
# Opciones de config.js que se pueden cambiar desde la web
PANEL_KEYS = ('haUrl', 'token', 'ambientPhotos', 'immichApiKey', 'favorites', 'hiddenEntities', 'weatherEntity',
              'excludePlatforms', 'printerPlugs', 'sensorClasses', 'cameraRefreshSeconds', 'hideUnavailable')

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


def clean_panel(values, current=None, keep_secret_if_empty=True):
    """Solo las claves conocidas. Token o clave de Immich vacíos = «no cambiarlos»."""
    out = dict(current or {})
    for k in PANEL_KEYS:
        if k not in values:
            continue
        if k in ('token', 'immichApiKey') and keep_secret_if_empty and not values[k]:
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
    if not BACKLIGHT:
        return False
    top = int(_read(f'{BACKLIGHT}/max_brightness') or 255)
    return _write(f'{BACKLIGHT}/brightness', max(1, round(top * max(5, min(100, pct)) / 100)))


def set_power(on):
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
            return self._json(200, {'backlight': bool(BACKLIGHT), 'power': bool(BACKLIGHT or outs), 'outputs': outs,
                                    'web': WEB_PORT, 'password': PASS_FILE.exists()})
        if u.path == '/config':
            return self._json(200, load_config())
        if u.path == '/poll':
            return self._json(200, {'version': load_config()['version'], 'command': COMMAND})
        if u.path == '/proxy':
            return self._proxy(parse_qs(u.query).get('url', [''])[0])
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
            return self._json(200, {'password': PASS_FILE.exists(), 'session': bool(self._session())})
        if u.path == '/api/config':
            if not self._guard():
                return
            cfg = load_config()
            panel = dict(cfg['panel'])
            panel['hasToken'] = bool(panel.pop('token', None))          # el token nunca sale de la Pi
            panel['hasImmichApiKey'] = bool(panel.pop('immichApiKey', None))
            return self._json(200, {'panel': panel, 'ajustes': cfg['ajustes'], 'version': cfg['version']})
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
    threading.Thread(target=serve, args=(WEB_PORT, WebHandler, '0.0.0.0'), daemon=True).start()
    serve(LOCAL_PORT, LocalHandler, '127.0.0.1')


if __name__ == '__main__':
    main()
