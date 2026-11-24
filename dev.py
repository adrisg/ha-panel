#!/usr/bin/env python3
"""Runs the whole Panel Hogar on the computer to try it, without a Raspberry Pi.

    python dev.py

- Panel:                 http://127.0.0.1:8765        (only this computer: it carries the token)
  with --lan also from other devices: http://<PC-IP>:8765 (anyone on your network will see the token!)
- Configuration web:     http://127.0.0.1:8080        test password: "panel"
  and from the phone, on the same WiFi: http://<PC-IP>:8080 (if the firewall allows it)

The helper runs in SIMULATION MODE: brightness, screen off, WiFi, IP and device name
work but change nothing on the computer. The test data is saved in .dev-data/
(not pushed to git). To start from scratch: python dev.py --reset
Ctrl+C stops everything.
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
    """Serves the panel without cache, to always see the latest changes on reload."""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    # --lan: the panel opened from another device reaches the helper (it only listens on 127.0.0.1) through /_helper/…
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
    ap = argparse.ArgumentParser(description='Panel Hogar on the computer (test mode)')
    ap.add_argument('--reset', action='store_true', help='deletes the test data (.dev-data) and starts from scratch')
    ap.add_argument('--no-browser', action='store_true', help='do not open the browser')
    ap.add_argument('--lan', action='store_true', help='also open the panel to other devices on your network (they see the HA token)')
    args = ap.parse_args()

    for port in (PANEL_PORT, 8766, 8080):
        if not port_free(port):
            sys.exit(f'Port {port} is already in use. Do you have another copy open? Close it and try again.')

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
        print('Note: there is no config.js → the panel will ask you to connect it to Home Assistant.')
        print('      Enter the address and the token from the configuration web, or copy config.example.js to config.js.\n')
    ip = lan_ip()
    print(f'''
  Panel Hogar running (test mode)

  Panel ............... http://127.0.0.1:{PANEL_PORT}
  Configuration ....... http://127.0.0.1:8080     password: {DEV_PASSWORD}
  From the phone ...... http://{ip}:8080   (same WiFi; you may have to allow it in the firewall)
''' + (f'''  Panel on your LAN ... http://{ip}:{PANEL_PORT}    (--lan: anyone on your network sees the HA token)
''' if args.lan else '') + f'''
  Simulated screen and network: nothing on the computer changes.
  Ctrl+C to stop.
''', flush=True)
    if not args.no_browser:
        webbrowser.open(f'http://127.0.0.1:{PANEL_PORT}')
        webbrowser.open('http://127.0.0.1:8080')
    try:
        while proc.poll() is None:
            time.sleep(0.5)
        print('The helper has stopped.')
    except KeyboardInterrupt:
        print('\nParando…')
    finally:
        proc.terminate()
        srv.shutdown()


if __name__ == '__main__':
    main()
