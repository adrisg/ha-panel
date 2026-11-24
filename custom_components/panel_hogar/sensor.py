"""When the screen was last touched."""
from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import PanelConfigEntry
from .const import EXPOSE_LAST_TOUCH
from .entity import PanelEntity, exposed


async def async_setup_entry(hass: HomeAssistant, entry: PanelConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if exposed(entry.runtime_data, EXPOSE_LAST_TOUCH):
        async_add_entities([PanelLastTouch(entry.runtime_data, "last_touch")])


class PanelLastTouch(PanelEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    @property
    def native_value(self) -> datetime | None:
        value = self.state_data.get("last_touch")
        return dt_util.parse_datetime(value) if value else None
