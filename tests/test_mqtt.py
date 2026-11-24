"""Home Assistant over MQTT (panel-helper.py), against a tiny fake broker. Plain Python, no Home Assistant needed."""
import importlib.util
import json
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


class FakeBroker:
    """Just enough MQTT 3.1.1 to test the panel: CONNECT, SUBSCRIBE, PUBLISH, PINGREQ."""

    def __init__(self, accept_password=None):
        self.srv = socket.socket()
        self.srv.bind(('127.0.0.1', 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.accept_password = accept_password
        self.published, self.subscribed, self.connect = {}, [], None
        self.conn = None
        threading.Thread(target=self._serve, daemon=True).start()

    def _read(self, c):
        head = c.recv(1)
        if not head:
            raise ConnectionError
        mult, n = 1, 0
        while True:
            b = c.recv(1)[0]
            n += (b & 127) * mult
            mult *= 128
            if not b & 128:
                break
        data = b''
        while len(data) < n:
            data += c.recv(n - len(data))
        return head[0], data

    def _serve(self):
        while True:
            c, _ = self.srv.accept()
            self.conn = c
            try:
                while True:
                    head, data = self._read(c)
                    kind = head >> 4
                    if kind == 1:                       # CONNECT
                        self.connect = data
                        ok = self.accept_password is None or self.accept_password.encode() in data
                        c.sendall(bytes([0x20, 2, 0, 0 if ok else 4]))
                        if not ok:
                            c.close()
                            break
                    elif kind == 8:                     # SUBSCRIBE
                        pos, topics = 2, []
                        while pos < len(data):
                            n = int.from_bytes(data[pos:pos + 2], 'big')
                            topics.append(data[pos + 2:pos + 2 + n].decode())
                            pos += 3 + n
                        self.subscribed += topics
                        c.sendall(bytes([0x90, 2 + len(topics)]) + data[:2] + b'\x00' * len(topics))
                    elif kind == 3:                     # PUBLISH
                        n = int.from_bytes(data[:2], 'big')
                        self.published[data[2:2 + n].decode()] = data[2 + n:].decode()
                    elif kind == 12:                    # PINGREQ
                        c.sendall(b'\xd0\x00')
                    elif kind == 14:                    # DISCONNECT
                        break
            except (ConnectionError, OSError, IndexError):
                pass

    def send(self, topic, payload):
        body = len(topic).to_bytes(2, 'big') + topic.encode() + payload.encode()
        self.conn.sendall(bytes([0x30, len(body)]) + body)


def wait(cond, secs=3):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture()
def helper(monkeypatch):
    monkeypatch.setenv('PANEL_DATA', tempfile.mkdtemp())
    monkeypatch.setenv('PANEL_SIMULATE', '1')
    spec = importlib.util.spec_from_file_location('panel_helper', ROOT / 'panel-helper.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _start(helper, broker, password='secret', expose=None):
    cfg = helper.load_config()
    cfg['panel'].update(mqttEnabled=True, mqttHost='127.0.0.1', mqttPort=broker.port, mqttUser='panel', mqttPassword=password)
    if expose is not None:
        cfg['ajustes']['haExpose'] = expose
    helper.save_config(cfg)
    helper.mqtt_restart()
    assert wait(lambda: helper.MQTT['status'] in ('connected', 'error')), helper.MQTT


def test_discovery_states_and_commands(helper):
    broker = FakeBroker(accept_password='secret')
    _start(helper, broker)
    pid, base = helper.panel_id(), f'panel_hogar/{helper.panel_id()}'
    assert helper.MQTT['status'] == 'connected'
    assert wait(lambda: f'homeassistant/button/panel_hogar_{pid}/reload/config' in broker.published)
    light = json.loads(broker.published[f'homeassistant/light/panel_hogar_{pid}/screen/config'])
    assert light['command_topic'] == base + '/screen/set' and light['brightness_scale'] == 100
    assert light['device']['identifiers'] == [f'panel_hogar_{pid}'] and light['unique_id'] == f'{pid}_screen'
    assert json.loads(broker.published[f'homeassistant/sensor/panel_hogar_{pid}/last_touch/config'])['device_class'] == 'timestamp'
    assert broker.published[base + '/status'] == 'online'
    assert base + '/screen/set' in broker.subscribed and 'homeassistant/status' in broker.subscribed

    helper.set_panel_state({'screen_on': True, 'brightness': 70, 'ambient': False, 'last_touch': '2026-11-24T10:00:00Z'})
    assert wait(lambda: broker.published.get(base + '/last_touch') == '2026-11-24T10:00:00Z')
    assert broker.published[base + '/brightness/state'] == '70'
    assert broker.published[base + '/screen/state'] == 'ON' and broker.published[base + '/ambient/state'] == 'OFF'
    assert broker.published[base + '/last_touch'] == '2026-11-24T10:00:00Z'

    broker.send(base + '/brightness/set', '40')
    assert wait(lambda: helper.COMMAND['type'] == 'brillo' and helper.COMMAND['value'] == 40)
    broker.send(base + '/screen/set', 'OFF')
    assert wait(lambda: helper.COMMAND['type'] == 'pantalla_off')
    broker.send(base + '/ambient/set', 'ON')
    assert wait(lambda: helper.COMMAND['type'] == 'ambiente')
    broker.send(base + '/reload/press', 'PRESS')
    assert wait(lambda: helper.COMMAND['type'] == 'recargar')
    helper.MQTT['client'].stop()


def test_only_chosen_entities(helper):
    broker = FakeBroker()
    _start(helper, broker, expose={'ambient': False, 'reload': False})
    pid = helper.panel_id()
    assert wait(lambda: f'homeassistant/button/panel_hogar_{pid}/reload/config' in broker.published)
    assert broker.published[f'homeassistant/button/panel_hogar_{pid}/reload/config'] == ''      # removed from HA
    assert broker.published[f'homeassistant/switch/panel_hogar_{pid}/ambient/config'] == ''
    assert broker.published[f'homeassistant/light/panel_hogar_{pid}/screen/config'] != ''
    helper.MQTT['client'].stop()


def test_wrong_password(helper):
    broker = FakeBroker(accept_password='right')
    _start(helper, broker, password='wrong')
    assert helper.MQTT['status'] == 'error' and 'contraseña' in helper.MQTT['error']
    helper.MQTT['client'].stop()


def test_off_when_disabled(helper):
    helper.mqtt_restart()
    assert helper.MQTT['status'] == 'off' and helper.MQTT['client'] is None


def test_commands_for_the_panel(helper):
    helper.send_command('brightness', 250)
    assert helper.COMMAND['type'] == 'brillo' and helper.COMMAND['value'] == 100
    with pytest.raises(ValueError):
        helper.send_command('format_disk')
