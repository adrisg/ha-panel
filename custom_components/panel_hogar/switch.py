"""Ambient mode (clock and photos) as a switch."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PanelConfigEntry
from .const import EXPOSE_AMBIENT
from .entity import PanelEntity, exposed


async def async_setup_entry(hass: HomeAssistant, entry: PanelConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if exposed(entry.runtime_data, EXPOSE_AMBIENT):
        async_add_entities([PanelAmbient(entry.runtime_data, "ambient")])


class PanelAmbient(PanelEntity, SwitchEntity):
    @property
    def is_on(self) -> bool | None:
        return self.state_data.get("ambient")

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.api.command("ambient_on")

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.api.command("ambient_off")
