#!/usr/bin/env python3
"""Arranca el Panel Hogar completo en el ordenador para probarlo, sin Raspberry Pi.

    python dev.py

- Panel:                 http://127.0.0.1:8765        (solo este ordenador: lleva el token)
  con --lan también desde otros equipos: http://<IP-del-PC>:8765 (¡cualquiera de tu red verá el token!)
- Web de configuración:  http://127.0.0.1:8080        contraseña de pruebas: «panel»
  y desde el móvil, en la misma WiFi: http://<IP-del-PC>:8080 (si el cortafuegos lo deja)

El ayudante va en MODO SIMULACIÓN: brillo, apagado de pantalla, WiFi, IP y nombre del equipo
funcionan pero no cambian nada del ordenador. Los datos de prueba se guardan en .dev-data/
(no se sube a git). Para empezar de cero: python dev.py --reset
Ctrl+C lo para todo.
"""
import argparse
import functools
import http.server
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / '.dev-data'
PANEL_PORT = 8765
DEV_PASSWORD = 'panel'


class NoCache(http.server.SimpleHTTPRequestHandler):
    """Sirve el panel sin caché, para ver siempre los últimos cambios al recargar."""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    # --lan: el panel abierto desde otro equipo llega al ayudante (solo escucha en 127.0.0.1) por /_helper/…
    def _proxy(self):
        if not self.path.startswith('/_helper/'):
            return False
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request('http://127.0.0.1:8766' + self.path[len('/_helper'):], data=body, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() in ('content-type', 'x-api-key')})
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            r = e
        except OSError:
            self.send_error(502)
            return True
        data = r.read()
        self.send_response(r.status if hasattr(r, 'status') else r.code)
        self.send_header('Content-Type', r.headers.get('Content-Type', 'application/octet-stream'))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    def do_GET(self):
        if not self._proxy():
            super().do_GET()

    def do_POST(self):
        if not self._proxy():
            self.send_error(405)

    def do_PUT(self):
        if not self._proxy():
            self.send_error(405)


def port_free(port):
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', port)) != 0


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'


def main():
    ap = argparse.ArgumentParser(description='Panel Hogar en el ordenador (modo pruebas)')
    ap.add_argument('--reset', action='store_true', help='borra los datos de prueba (.dev-data) y empieza de cero')
    ap.add_argument('--no-browser', action='store_true', help='no abrir el navegador')
    ap.add_argument('--lan', action='store_true', help='abrir también el panel a otros equipos de tu red (ven el token de HA)')
    args = ap.parse_args()

    for port in (PANEL_PORT, 8766, 8080):
        if not port_free(port):
            sys.exit(f'El puerto {port} ya está en uso. ¿Tienes otra copia abierta? Ciérrala e inténtalo otra vez.')

    if args.reset and DATA.exists():
        shutil.rmtree(DATA)
    DATA.mkdir(exist_ok=True)

    env = dict(os.environ, PANEL_DATA=str(DATA), PANEL_SIMULATE='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
    helper = [sys.executable, '-B', str(HERE / 'panel-helper.py')]
    if not (DATA / 'admin.json').exists():
        subprocess.run(helper + ['--set-password'], input=DEV_PASSWORD + '\n', text=True, env=env, check=True,
                       stdout=subprocess.DEVNULL)

    proc = subprocess.Popen(helper, env=env)
    srv = http.server.ThreadingHTTPServer(('0.0.0.0' if args.lan else '127.0.0.1', PANEL_PORT), functools.partial(NoCache, directory=str(HERE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.8)

    if not (HERE / 'config.js').exists():
        print('Aviso: no hay config.js → el panel te pedirá conectarlo con Home Assistant.')
        print('       Pon la dirección y el token desde la web de configuración, o copia config.example.js a config.js.\n')
    ip = lan_ip()
    print(f'''
  Panel Hogar en marcha (modo pruebas)

  Panel ............... http://127.0.0.1:{PANEL_PORT}
  Configuración ....... http://127.0.0.1:8080     contraseña: {DEV_PASSWORD}
  Desde el móvil ...... http://{ip}:8080   (misma WiFi; quizá tengas que permitirlo en el cortafuegos)
''' + (f'''  Panel en tu red ..... http://{ip}:{PANEL_PORT}   (--lan: cualquiera de tu red ve el token de HA)
''' if args.lan else '') + f'''
  Pantalla y red simuladas: no se cambia nada del ordenador.
  Ctrl+C para parar.
''', flush=True)
    if not args.no_browser:
        webbrowser.open(f'http://127.0.0.1:{PANEL_PORT}')
        webbrowser.open('http://127.0.0.1:8080')
    try:
        while proc.poll() is None:
            time.sleep(0.5)
        print('El ayudante se ha parado.')
    except KeyboardInterrupt:
        print('\nParando…')
    finally:
        proc.terminate()
        srv.shutdown()


if __name__ == '__main__':
    main()
