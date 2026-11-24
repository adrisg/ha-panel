"""The screen as a light: on/off and brightness."""
from __future__ import annotations

from typing import Any

from homeassistant.components.light import ATTR_BRIGHTNESS, ColorMode, LightEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PanelConfigEntry
from .const import EXPOSE_SCREEN
from .entity import PanelEntity, exposed


async def async_setup_entry(hass: HomeAssistant, entry: PanelConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if exposed(entry.runtime_data, EXPOSE_SCREEN):
        async_add_entities([PanelScreen(entry.runtime_data, "screen")])


class PanelScreen(PanelEntity, LightEntity):
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}

    @property
    def is_on(self) -> bool | None:
        return self.state_data.get("screen_on")

    @property
    def brightness(self) -> int | None:
        pct = self.state_data.get("brightness")
        return None if pct is None else round(pct * 255 / 100)

    async def async_turn_on(self, **kwargs: Any) -> None:
        if ATTR_BRIGHTNESS in kwargs:
            pct = max(5, min(100, round(kwargs[ATTR_BRIGHTNESS] * 100 / 255)))
            await self.coordinator.api.command("brightness", pct)   # also wakes the screen
        else:
            await self.coordinator.api.command("screen_on")

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.api.command("screen_off")
