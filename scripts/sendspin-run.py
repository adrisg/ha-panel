"""Arranca el altavoz Sendspin (sendspin daemon) para el Panel Hogar.

Igual que «sendspin daemon …», pero además guarda en un archivo el código para emparejar con
Music Assistant (el PIN que pide al añadir el altavoz), para que el panel lo enseñe en pantalla.
El archivo se borra cuando termina el emparejamiento.

Lo lanza «panel-helper.py --sendspin» con el Python del entorno de sendspin (ver setup-sendspin.sh).
"""
import json
import os
import sys
import time
from pathlib import Path

PIN_FILE = Path(os.environ.get('PANEL_SENDSPIN_PIN') or Path.home() / '.config' / 'panel-hogar' / 'sendspin-pin.json')


def _save_pin(grouped):
    try:
        if grouped:
            tmp = PIN_FILE.with_suffix('.tmp')
            tmp.write_text(json.dumps({'code': str(grouped), 'at': time.time()}), encoding='utf-8')
            os.replace(tmp, PIN_FILE)
        else:
            PIN_FILE.unlink(missing_ok=True)
    except OSError as e:
        print(f'No se pudo guardar el código de emparejamiento: {e}', flush=True)


def main():
    _save_pin(None)
    try:
        from sendspin.daemon.daemon import SendspinDaemon
        original = SendspinDaemon._show_pairing_code

        async def show_pairing_code(self, pairing_code, *, grouped):
            _save_pin(grouped)
            await original(self, pairing_code, grouped=grouped)

        SendspinDaemon._show_pairing_code = show_pairing_code
    except (ImportError, AttributeError) as e:   # otra versión de sendspin: suena igual, pero el código solo sale en el registro
        print(f'El código de emparejamiento no saldrá en la pantalla: {e}', flush=True)
    from sendspin.cli import main as cli
    sys.argv = ['sendspin'] + sys.argv[1:]
    sys.exit(cli())


if __name__ == '__main__':
    main()
