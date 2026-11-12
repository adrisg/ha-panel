#!/usr/bin/env python3
"""Ayudante de pantalla del Panel Hogar.

La página del panel no puede tocar el hardware, así que este pequeño servidor
(solo en 127.0.0.1:8766, nada de fuera puede llegar a él) le deja:
  GET  /status                -> qué se puede controlar en esta pantalla
  POST /brightness?value=5..100
  POST /power?on=0|1          -> apagar / encender la pantalla
  GET  /proxy?url=...         -> lee la lista de un álbum de Immich cuando su servidor no
                                 permite CORS (solo rutas de álbumes, solo lectura)

- Pantallas con retroiluminación controlable (la oficial DSI de 7", algunas SPI):
  usa /sys/class/backlight/* (brillo real y apagado real).
- Pantallas HDMI: apaga y enciende la salida con wlr-randr (el brillo se hace en el panel).
Lo arranca ~/kiosk-browser.sh dentro de cage. Sin dependencias: solo Python 3.
"""
import glob
import json
import subprocess
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

# Rutas de Immich que el panel puede leer a través del ayudante
IMMICH_PATHS = ('/api/shared-links/me', '/api/albums/', '/api/timeline/buckets', '/api/timeline/bucket')

BACKLIGHT = next(iter(sorted(glob.glob('/sys/class/backlight/*'))), None)


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
        r = subprocess.run(['wlr-randr', '--output', name, '--on' if on else '--off'], capture_output=True, timeout=5)
        ok = ok or r.returncode == 0
    return ok


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=None):
        data = json.dumps(body or {}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'x-api-key')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(200)

    def _proxy(self, target):
        u = urlparse(target)
        if u.scheme not in ('http', 'https') or not u.path.startswith(IMMICH_PATHS):
            return self._send(403, {'error': 'solo se permiten rutas de álbumes de Immich'})
        req = urllib.request.Request(target, headers={'Accept': 'application/json'})
        if self.headers.get('x-api-key'):
            req.add_header('x-api-key', self.headers['x-api-key'])
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return self._send(r.status, json.loads(r.read() or b'null'))
        except urllib.error.HTTPError as e:
            return self._send(e.code, {'error': e.reason})
        except (urllib.error.URLError, OSError, ValueError) as e:
            return self._send(502, {'error': str(e)})

    def do_GET(self):
        if urlparse(self.path).path == '/proxy':
            return self._proxy(parse_qs(urlparse(self.path).query).get('url', [''])[0])
        if urlparse(self.path).path == '/status':
            outs = _outputs()
            return self._send(200, {'backlight': bool(BACKLIGHT), 'power': bool(BACKLIGHT or outs), 'outputs': outs})
        self._send(404)

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            if url.path == '/brightness':
                return self._send(200, {'ok': set_brightness(int(q.get('value', ['100'])[0]))})
            if url.path == '/power':
                return self._send(200, {'ok': set_power(q.get('on', ['1'])[0] == '1')})
        except ValueError:
            return self._send(400)
        self._send(404)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
