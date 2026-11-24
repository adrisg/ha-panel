"""Runs the Sendspin speaker (sendspin daemon) for Panel Hogar.

Like "sendspin daemon …", but it also saves in a file the code to pair with
Music Assistant (the PIN it asks for when adding the speaker), so the panel shows it on screen.
The file is deleted when pairing ends.

"panel-helper.py --sendspin" starts it with the Python of the sendspin environment (see setup-sendspin.sh).
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
        print(f'Could not save the pairing code: {e}', flush=True)


def main():
    _save_pin(None)
    try:
        from sendspin.daemon.daemon import SendspinDaemon
        original = SendspinDaemon._show_pairing_code

        async def show_pairing_code(self, pairing_code, *, grouped):
            _save_pin(grouped)
            await original(self, pairing_code, grouped=grouped)

        SendspinDaemon._show_pairing_code = show_pairing_code
    except (ImportError, AttributeError) as e:   # another sendspin version: it plays the same, but the code only shows in the log
        print(f'The pairing code will not show on the screen: {e}', flush=True)
    from sendspin.cli import main as cli
    sys.argv = ['sendspin'] + sys.argv[1:]
    sys.exit(cli())


if __name__ == '__main__':
    main()
