"""Bridge mode: the panel talks to Home Assistant through this integration, without a token.

The panel sends the same messages it would send over Home Assistant's websocket (get_states, subscribe_events,
call_service, registries…). They reach us through the panel helper; we answer only about the entities chosen in the
integration options, and only run actions on those entities. Everything else is refused.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import timedelta
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.network import NoURLAvailableError, get_url
from homeassistant.util import dt as dt_util

from .api import PanelApi, PanelAuthError, PanelError
from .const import RETRY_DELAY

_LOGGER = logging.getLogger(__name__)

# Events the panel may listen to (besides state changes of the chosen entities)
PANEL_EVENTS = ("panel_notification", "panel_notification_close")
# Events the panel may fire
PANEL_FIRE = ("panel_notification_action",)


class NotAllowed(Exception):
    """The panel asked for something outside what it was given."""


class PanelBridge:
    def __init__(self, hass: HomeAssistant, api: PanelApi, entities: list[str]) -> None:
        self.hass = hass
        self.api = api
        self.allowed = set(entities)
        self.session = secrets.token_hex(6)
        self._subs: dict[int, Any] = {}
        self._out: list[dict] = []
        self._flush: asyncio.Task | None = None

    # ------------------------------------------------------------------ loop
    async def run(self) -> None:
        self._push(self._welcome())
        while True:
            try:
                for msg in await self.api.bridge_requests():
                    await self._handle(msg)
            except PanelAuthError:
                return
            except PanelError as err:
                _LOGGER.debug("Bridge: panel unreachable (%s)", err)
                await asyncio.sleep(RETRY_DELAY)
                self._push(self._welcome())      # when it comes back, the panel starts over

    def stop(self) -> None:
        for unsub in self._subs.values():
            unsub()
        self._subs.clear()

    def _push(self, msg: dict) -> None:
        self._out.append(msg)
        if not self._flush or self._flush.done():
            self._flush = self.hass.async_create_task(self._send())

    async def _send(self) -> None:
        await asyncio.sleep(0.05)                # group what arrives together
        while self._out:
            batch, self._out = self._out, []
            try:
                await self.api.bridge_messages(batch)
            except PanelError as err:
                _LOGGER.debug("Bridge: could not send to the panel (%s)", err)
                return

    def _welcome(self) -> dict:
        try:
            url = get_url(self.hass, prefer_external=False)
        except NoURLAvailableError:
            url = ""
        return {"type": "bridge_welcome", "session": self.session, "ha_url": url, "language": self.hass.config.language}

    # ------------------------------------------------------------------ messages
    async def _handle(self, msg: dict) -> None:
        kind, mid = msg.get("type"), msg.get("id")
        if kind == "bridge_hello":
            self._push(self._welcome())
            return
        if kind == "ping":
            self._push({"type": "pong", "id": mid})
            return
        try:
            result = await self._result(kind, msg)
        except NotAllowed as err:
            self._push({"type": "result", "id": mid, "success": False, "error": {"code": "not_allowed", "message": str(err)}})
        except Exception as err:  # noqa: BLE001 — any failure goes back to the panel as an error
            self._push({"type": "result", "id": mid, "success": False, "error": {"code": "error", "message": str(err)}})
        else:
            self._push({"type": "result", "id": mid, "success": True, "result": result})

    async def _result(self, kind: str, msg: dict) -> Any:
        hass = self.hass
        if kind == "get_states":
            return [s.as_dict() for s in hass.states.async_all() if s.entity_id in self.allowed]
        if kind == "get_config":
            c = hass.config
            return {"language": c.language, "time_zone": c.time_zone, "location_name": c.location_name,
                    "unit_system": c.units.as_dict(), "currency": c.currency, "country": c.country}
        if kind == "subscribe_events":
            return self._subscribe(msg["id"], msg.get("event_type"))
        if kind == "unsubscribe_events":
            unsub = self._subs.pop(msg.get("subscription"), None)
            if unsub:
                unsub()
            return None
        if kind == "call_service":
            return await self._call(msg)
        if kind == "fire_event":
            if msg.get("event_type") not in PANEL_FIRE:
                raise NotAllowed("event not allowed")
            hass.bus.async_fire(msg["event_type"], msg.get("event_data") or {})
            return None
        if kind == "config/entity_registry/list":
            reg = er.async_get(hass)
            return [_entity_entry(e) for e in reg.entities.values() if e.entity_id in self.allowed]
        if kind == "config/device_registry/list":
            return [_device_entry(d) for d in self._devices()]
        if kind == "config/area_registry/list":
            areas = ar.async_get(hass)
            ids = {d.area_id for d in self._devices()} | {e.area_id for e in self._entities()}
            return [{"area_id": a.id, "name": a.name, "icon": a.icon} for a in areas.async_list_areas() if a.id in ids]
        if kind == "history/history_during_period":
            return await self._history(msg)
        if kind == "frontend/get_user_data":
            return {"value": None}
        raise NotAllowed(f"{kind} is not available in integration mode")

    def _entities(self) -> list:
        reg = er.async_get(self.hass)
        return [e for e in reg.entities.values() if e.entity_id in self.allowed]

    def _devices(self) -> list:
        devs = dr.async_get(self.hass)
        ids = {e.device_id for e in self._entities() if e.device_id}
        return [d for d in (devs.async_get(i) for i in ids) if d]

    def _subscribe(self, sub_id: int, event_type: str | None) -> None:
        if event_type == "state_changed":
            @callback
            def changed(event: Event) -> None:
                d = event.data
                self._push({"type": "event", "id": sub_id, "event": {"event_type": "state_changed", "data": {
                    "entity_id": d["entity_id"],
                    "new_state": d["new_state"].as_dict() if d.get("new_state") else None,
                    "old_state": d["old_state"].as_dict() if d.get("old_state") else None}}})
            self._subs[sub_id] = async_track_state_change_event(self.hass, list(self.allowed), changed)
            return None
        if event_type in PANEL_EVENTS:
            @callback
            def fired(event: Event) -> None:
                self._push({"type": "event", "id": sub_id, "event": {"event_type": event.event_type, "data": dict(event.data)}})
            self._subs[sub_id] = self.hass.bus.async_listen(event_type, fired)
            return None
        raise NotAllowed(f"event {event_type} not allowed")

    async def _call(self, msg: dict) -> Any:
        data = dict(msg.get("service_data") or {})
        target = msg.get("target") or {}
        ids: list[str] = []
        for source in (target.get("entity_id"), data.get("entity_id")):
            if source:
                ids += [source] if isinstance(source, str) else list(source)
        if not ids or not set(ids) <= self.allowed:
            raise NotAllowed("only the entities shared with the panel")
        if target.get("device_id") or target.get("area_id") or target.get("floor_id") or target.get("label_id"):
            raise NotAllowed("only entities, not devices or areas")
        data.pop("entity_id", None)
        want = bool(msg.get("return_response"))
        response = await self.hass.services.async_call(msg["domain"], msg["service"], data, blocking=True,
                                                       target={"entity_id": ids}, return_response=want)
        return {"context": None, "response": response} if want else {"context": None}

    async def _history(self, msg: dict) -> dict:
        ids = [i for i in msg.get("entity_ids") or [] if i in self.allowed]
        if not ids:
            return {}
        try:
            from homeassistant.components.recorder import get_instance, history
        except ImportError:
            return {}
        start = dt_util.parse_datetime(msg.get("start_time") or "") or dt_util.utcnow() - timedelta(hours=24)

        def load() -> dict:
            states = history.get_significant_states(self.hass, start, None, ids, significant_changes_only=False,
                                                    minimal_response=True, no_attributes=True)
            out = {}
            for eid, rows in states.items():
                out[eid] = [{"s": r.state if hasattr(r, "state") else r["state"],
                             "lu": (r.last_updated if hasattr(r, "last_updated") else dt_util.parse_datetime(r["last_changed"])).timestamp()}
                            for r in rows]
            return out

        return await get_instance(self.hass).async_add_executor_job(load)


def _entity_entry(e) -> dict:
    return {"entity_id": e.entity_id, "platform": e.platform, "device_id": e.device_id, "area_id": e.area_id,
            "translation_key": e.translation_key, "entity_category": e.entity_category, "hidden_by": e.hidden_by,
            "disabled_by": e.disabled_by, "name": e.name, "original_name": e.original_name, "icon": e.icon}


def _device_entry(d) -> dict:
    return {"id": d.id, "name": d.name, "name_by_user": d.name_by_user, "area_id": d.area_id,
            "manufacturer": d.manufacturer, "model": d.model}
