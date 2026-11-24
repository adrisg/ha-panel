"""Pairing and state of panel-helper.py (plain Python, no Home Assistant needed)."""
import importlib.util
import os
import tempfile
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def helper(monkeypatch):
    monkeypatch.setenv('PANEL_DATA', tempfile.mkdtemp())
    monkeypatch.setenv('PANEL_SIMULATE', '1')
    spec = importlib.util.spec_from_file_location('panel_helper', ROOT / 'panel-helper.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pairing_gives_the_key(helper):
    info = helper.pair_start()
    assert info['id'] and info['name']
    code = helper.pair_code()
    assert len(code) == 6 and code.isdigit()
    with pytest.raises(PermissionError):
        helper.pair_finish('000000' if code != '000000' else '111111')
    data = helper.pair_finish(code[:3] + ' ' + code[3:])          # spaces are fine
    assert data['key'] == helper.ha_api_key()
    assert helper.pair_code() is None                              # used: gone from the screen
    with pytest.raises(ValueError):
        helper.pair_finish(code)                                   # can't be reused


def test_code_dies_after_five_wrong_tries(helper):
    helper.pair_start()
    code = helper.pair_code()
    wrong = '000000' if code != '000000' else '111111'
    for _ in range(5):
        with pytest.raises(PermissionError):
            helper.pair_finish(wrong)
    with pytest.raises(ValueError):
        helper.pair_finish(code)


def test_code_expires(helper):
    helper.pair_start()
    helper.PAIR['until'] = time.time() - 1
    assert helper.pair_code() is None
    with pytest.raises(ValueError):
        helper.pair_finish(helper.PAIR['code'] or '123456')


def test_start_is_rate_limited(helper):
    helper.pair_start()
    with pytest.raises(ValueError):
        helper.pair_start()


def test_unlinking_changes_the_key(helper):
    old = helper.ha_api_key()
    assert helper.ha_api_key() == old
    assert helper.ha_api_key(regenerate=True) != old


def test_long_poll_wakes_up_on_change(helper):
    rev = helper.set_panel_state({'screen_on': True, 'brightness': 80, 'ambient': False})
    got = {}
    t = threading.Thread(target=lambda: got.update(helper.wait_panel_state(rev, 5)))
    t.start()
    time.sleep(0.2)
    helper.set_panel_state({'ambient': True})
    t.join(2)
    assert got['ambient'] is True and got['rev'] == rev + 1
    assert helper.set_panel_state({'ambient': True}) == rev + 1   # no change, same rev


def test_commands_for_the_panel(helper):
    helper.send_command('brightness', 250)
    assert helper.COMMAND['type'] == 'brillo' and helper.COMMAND['value'] == 100
    helper.send_command('ambient_off')
    assert helper.COMMAND['type'] == 'inicio'
    with pytest.raises(ValueError):
        helper.send_command('format_disk')


def test_expose_defaults_to_everything(helper):
    assert helper.ha_expose() == ['screen', 'ambient', 'last_touch', 'reload']
    cfg = helper.load_config()
    cfg['ajustes']['haExpose'] = {'reload': False, 'ambient': False}
    helper.save_config(cfg)
    assert helper.ha_expose() == ['screen', 'last_touch']
