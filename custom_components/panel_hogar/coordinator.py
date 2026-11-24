"""Keeps the panel state up to date with long polling (changes arrive in about a second)."""
from __future__ import annotations

import asyncio
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import PanelApi, PanelAuthError, PanelError
from .const import DOMAIN, RETRY_DELAY

_LOGGER = logging.getLogger(__name__)


class PanelCoordinator(DataUpdateCoordinator[dict]):
    """State of one panel: {rev, screen_on, brightness, ambient, last_touch, expose}."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, api: PanelApi, info: dict) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN)
        self.api = api
        self.info = info
        self._task: asyncio.Task | None = None
        self.bridge = None

    async def _async_update_data(self) -> dict:
        try:
            return await self.api.state()
        except PanelAuthError as err:
            raise ConfigEntryAuthFailed from err
        except PanelError as err:
            raise UpdateFailed(str(err)) from err

    def start(self) -> None:
        """Start listening for changes in the background."""
        self._task = self.config_entry.async_create_background_task(self.hass, self._listen(), f"{DOMAIN} long poll")

    async def _listen(self) -> None:
        while True:
            rev = (self.data or {}).get("rev")
            try:
                data = await self.api.state(rev)
            except PanelAuthError:
                self.config_entry.async_start_reauth(self.hass)
                return
            except PanelError as err:
                if self.last_update_success:
                    _LOGGER.info("Panel unreachable: %s", err)
                self.async_set_update_error(UpdateFailed(str(err)))
                await asyncio.sleep(RETRY_DELAY)
                continue
            if data.get("expose") != (self.data or {}).get("expose") and self.data is not None:
                # what is exposed changed (panel web → General): reload to create/remove entities
                self.hass.config_entries.async_schedule_reload(self.config_entry.entry_id)
                return
            if data.get("rev") != rev or not self.last_update_success:
                self.async_set_updated_data(data)
