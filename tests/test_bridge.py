"""Integration mode (no token): the panel only sees and controls the chosen entities."""
from unittest.mock import AsyncMock

import pytest

pytest.importorskip("pytest_homeassistant_custom_component")

from homeassistant.core import ServiceCall  # noqa: E402

from custom_components.panel_hogar.bridge import NotAllowed, PanelBridge  # noqa: E402


@pytest.fixture
def bridge(hass):
    hass.states.async_set("light.allowed", "on", {"friendly_name": "Allowed"})
    hass.states.async_set("light.secret", "off", {"friendly_name": "Secret"})
    api = AsyncMock()
    b = PanelBridge(hass, api, ["light.allowed"])
    yield b
    b.stop()


async def test_only_chosen_states(hass, bridge):
    states = await bridge._result("get_states", {})
    assert [s["entity_id"] for s in states] == ["light.allowed"]


async def test_calls_only_on_chosen_entities(hass, bridge):
    calls = []

    async def handler(call: ServiceCall):
        calls.append(call.data["entity_id"])

    hass.services.async_register("light", "toggle", handler)
    await bridge._result("call_service", {"domain": "light", "service": "toggle", "target": {"entity_id": "light.allowed"}})
    assert calls == [["light.allowed"]]
    with pytest.raises(NotAllowed):
        await bridge._result("call_service", {"domain": "light", "service": "toggle", "target": {"entity_id": "light.secret"}})
    with pytest.raises(NotAllowed):
        await bridge._result("call_service", {"domain": "light", "service": "toggle", "service_data": {"entity_id": ["light.allowed", "light.secret"]}})
    with pytest.raises(NotAllowed):
        await bridge._result("call_service", {"domain": "light", "service": "turn_off", "target": {"area_id": "salon"}})
    with pytest.raises(NotAllowed):
        await bridge._result("call_service", {"domain": "homeassistant", "service": "restart"})


async def test_events(hass, bridge):
    out = []
    bridge._push = out.append
    await bridge._result("subscribe_events", {"id": 7, "event_type": "state_changed"})
    hass.states.async_set("light.secret", "on")
    hass.states.async_set("light.allowed", "off")
    await hass.async_block_till_done()
    assert [m["event"]["data"]["entity_id"] for m in out] == ["light.allowed"]
    assert out[0]["id"] == 7

    await bridge._result("subscribe_events", {"id": 8, "event_type": "panel_notification"})
    hass.bus.async_fire("panel_notification", {"title": "Hi"})
    await hass.async_block_till_done()
    assert out[-1]["event"]["data"] == {"title": "Hi"}
    with pytest.raises(NotAllowed):
        await bridge._result("subscribe_events", {"id": 9, "event_type": "call_service"})


async def test_other_requests_refused(hass, bridge):
    with pytest.raises(NotAllowed):
        await bridge._result("config/auth/list", {})
    with pytest.raises(NotAllowed):
        await bridge._result("fire_event", {"event_type": "homeassistant_stop"})
    assert (await bridge._result("get_config", {}))["language"]
