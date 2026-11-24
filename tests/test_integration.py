"""Home Assistant tests for custom_components/panel_hogar (needs pytest-homeassistant-custom-component)."""
import asyncio
from ipaddress import ip_address
from unittest.mock import AsyncMock, patch

import pytest

pytest.importorskip("pytest_homeassistant_custom_component")

from homeassistant import config_entries  # noqa: E402
from homeassistant.const import CONF_HOST, CONF_PORT  # noqa: E402
from homeassistant.data_entry_flow import FlowResultType  # noqa: E402
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo  # noqa: E402
from pytest_homeassistant_custom_component.common import MockConfigEntry  # noqa: E402

from custom_components.panel_hogar.api import PanelCodeError, PanelCodeExpired, PanelError  # noqa: E402

DOMAIN = "panel_hogar"
API = "custom_components.panel_hogar.api.PanelApi"
EXPOSE = ["screen", "ambient", "last_touch", "reload"]
INFO = {"id": "abc123", "name": "Panel salon", "version": "1234567", "expose": EXPOSE}
STATE = {"rev": 1, "screen_on": True, "brightness": 80, "ambient": False, "last_touch": "2026-11-24T10:00:00+00:00", "expose": EXPOSE}
PAIRED = {"key": "K", "id": "abc123", "name": "Panel salon"}


@pytest.fixture(autouse=True)
def auto_enable(enable_custom_integrations):
    yield


async def test_user_flow_with_code(hass):
    with patch(f"{API}.pair_start", AsyncMock(return_value={"id": "abc123", "name": "Panel salon"})), \
         patch(f"{API}.pair_finish", AsyncMock(side_effect=[PanelCodeError("x"), PAIRED])), \
         patch("custom_components.panel_hogar.async_setup_entry", AsyncMock(return_value=True)):
        r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        assert r["type"] is FlowResultType.FORM and r["step_id"] == "user"
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOST: "panel.local", CONF_PORT: 8080})
        assert r["step_id"] == "pair"
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"code": "000000"})
        assert r["errors"] == {"code": "invalid_code"}
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"code": "123456"})
        assert r["type"] is FlowResultType.CREATE_ENTRY
        assert r["title"] == "Panel salon"
        assert r["data"] == {CONF_HOST: "panel.local", CONF_PORT: 8080, "key": "K"}
        assert r["result"].unique_id == "abc123"


async def test_user_flow_cannot_connect(hass):
    with patch(f"{API}.pair_start", AsyncMock(side_effect=PanelError("down"))):
        r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOST: "1.2.3.4", CONF_PORT: 8080})
        assert r["errors"] == {"base": "cannot_connect"}


async def test_expired_code_shows_a_new_one(hass):
    start = AsyncMock(return_value={"id": "abc123", "name": "Panel salon"})
    with patch(f"{API}.pair_start", start), patch(f"{API}.pair_finish", AsyncMock(side_effect=PanelCodeExpired("x"))):
        r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOST: "panel.local", CONF_PORT: 8080})
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"code": "123456"})
        assert r["errors"] == {"code": "code_expired"}
        assert start.await_count == 2


async def test_zeroconf_flow(hass):
    info = ZeroconfServiceInfo(ip_address=ip_address("192.168.1.50"), ip_addresses=[ip_address("192.168.1.50")], port=8080,
                               hostname="panel.local.", type="_panel-hogar._tcp.local.",
                               name="Panel salon._panel-hogar._tcp.local.", properties={"id": "abc123"})
    with patch(f"{API}.pair_start", AsyncMock(return_value={"id": "abc123", "name": "Panel salon"})), \
         patch(f"{API}.pair_finish", AsyncMock(return_value=PAIRED)), \
         patch("custom_components.panel_hogar.async_setup_entry", AsyncMock(return_value=True)):
        r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=info)
        assert r["step_id"] == "discovery_confirm"
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
        assert r["step_id"] == "pair"
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"code": "123456"})
        assert r["type"] is FlowResultType.CREATE_ENTRY
        assert r["data"][CONF_HOST] == "192.168.1.50"


async def _state(state, rev=None):
    if rev is None:
        return state
    await asyncio.Event().wait()      # the long poll never answers in tests


async def _setup(hass, expose=None):
    expose = expose or EXPOSE
    state = dict(STATE, expose=expose)
    entry = MockConfigEntry(domain=DOMAIN, unique_id="abc123", title="Panel salon",
                            data={CONF_HOST: "panel.local", CONF_PORT: 8080, "key": "K"})
    entry.add_to_hass(hass)
    command = AsyncMock()
    patches = [patch(f"{API}.info", AsyncMock(return_value=dict(INFO, expose=expose))),
               patch(f"{API}.state", side_effect=lambda rev=None: _state(state, rev)),
               patch(f"{API}.command", command)]
    for p in patches:
        p.start()
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry, command, patches


async def _teardown(hass, entry, patches):
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    for p in patches:
        p.stop()


async def test_entities_and_commands(hass):
    entry, command, patches = await _setup(hass)
    try:
        light = hass.states.get("light.panel_salon_screen")
        assert light.state == "on" and light.attributes["brightness"] == 204
        assert hass.states.get("switch.panel_salon_ambient_mode").state == "off"
        assert hass.states.get("sensor.panel_salon_last_touched").state == "2026-11-24T10:00:00+00:00"
        assert hass.states.get("button.panel_salon_reload") is not None

        await hass.services.async_call("light", "turn_on", {"entity_id": "light.panel_salon_screen", "brightness": 128}, blocking=True)
        command.assert_awaited_with("brightness", 50)
        await hass.services.async_call("light", "turn_off", {"entity_id": "light.panel_salon_screen"}, blocking=True)
        command.assert_awaited_with("screen_off")
        await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.panel_salon_ambient_mode"}, blocking=True)
        command.assert_awaited_with("ambient_on")
        await hass.services.async_call("button", "press", {"entity_id": "button.panel_salon_reload"}, blocking=True)
        command.assert_awaited_with("reload")
    finally:
        await _teardown(hass, entry, patches)


async def test_only_exposed_entities(hass):
    entry, _command, patches = await _setup(hass, expose=["screen"])
    try:
        assert hass.states.get("light.panel_salon_screen") is not None
        assert hass.states.get("switch.panel_salon_ambient_mode") is None
        assert hass.states.get("button.panel_salon_reload") is None
    finally:
        await _teardown(hass, entry, patches)
