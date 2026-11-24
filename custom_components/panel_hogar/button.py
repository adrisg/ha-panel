"""Reload the panel."""
from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PanelConfigEntry
from .const import EXPOSE_RELOAD
from .entity import PanelEntity, exposed


async def async_setup_entry(hass: HomeAssistant, entry: PanelConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if exposed(entry.runtime_data, EXPOSE_RELOAD):
        async_add_entities([PanelReload(entry.runtime_data, "reload")])


class PanelReload(PanelEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.RESTART

    async def async_press(self) -> None:
        await self.coordinator.api.command("reload")
