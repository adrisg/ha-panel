"""Base entity: one device per panel."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import PanelCoordinator


class PanelEntity(CoordinatorEntity[PanelCoordinator]):
    _attr_has_entity_name = True

    def __init__(self, coordinator: PanelCoordinator, key: str) -> None:
        super().__init__(coordinator)
        info = coordinator.info
        self._attr_translation_key = key
        self._attr_unique_id = f"{info['id']}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, info["id"])},
            name=info.get("name") or "Panel Hogar",
            manufacturer="Panel Hogar",
            model="Raspberry Pi",
            sw_version=info.get("version") or None,
            configuration_url=f"http://{coordinator.api.host}:{coordinator.api.port}",
        )

    @property
    def state_data(self) -> dict:
        return self.coordinator.data or {}


def exposed(coordinator: PanelCoordinator, key: str) -> bool:
    """Chosen in the panel web (General → Home Assistant integration)."""
    expose = (coordinator.data or {}).get("expose")
    return expose is None or key in expose
