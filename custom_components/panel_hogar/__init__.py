"""Panel Hogar: the Raspberry Pi panel as a device in Home Assistant."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PanelApi, PanelAuthError, PanelError
from .const import CONF_KEY
from .coordinator import PanelCoordinator

PLATFORMS = [Platform.BUTTON, Platform.LIGHT, Platform.SENSOR, Platform.SWITCH]

type PanelConfigEntry = ConfigEntry[PanelCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: PanelConfigEntry) -> bool:
    api = PanelApi(async_get_clientsession(hass), entry.data[CONF_HOST], entry.data[CONF_PORT], entry.data[CONF_KEY])
    try:
        info = await api.info()
    except PanelAuthError as err:
        raise ConfigEntryAuthFailed("The panel was unlinked") from err
    except PanelError as err:
        raise ConfigEntryNotReady(f"Panel not reachable: {err}") from err

    coordinator = PanelCoordinator(hass, entry, api, info)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    coordinator.start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PanelConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
