"""Add a panel: found on the network (zeroconf) or by address; linked with a code shown on its screen."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import SOURCE_REAUTH, ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .api import PanelApi, PanelCodeError, PanelCodeExpired, PanelError
from .const import CONF_KEY, DEFAULT_PORT, DOMAIN

CONF_CODE = "code"


class PanelConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._host: str | None = None
        self._port: int = DEFAULT_PORT
        self._name: str | None = None
        self._api: PanelApi | None = None
        self._code_shown = False

    def _make_api(self) -> PanelApi:
        self._api = PanelApi(async_get_clientsession(self.hass), self._host, self._port)
        return self._api

    async def _start_pairing(self) -> None:
        """Ask the panel to show its code (raises PanelError if it can't be reached)."""
        data = await (self._api or self._make_api()).pair_start()
        self._name = data.get("name") or self._name
        self._code_shown = True
        if self.source != SOURCE_REAUTH:
            await self.async_set_unique_id(data["id"])
            self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        panel_id = discovery_info.properties.get("id")
        if not panel_id:
            return self.async_abort(reason="not_panel")
        self._host, self._port = str(discovery_info.ip_address), discovery_info.port or DEFAULT_PORT
        await self.async_set_unique_id(panel_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self._name = discovery_info.name.split("._panel-hogar")[0]
        self.context["title_placeholders"] = {"name": self._name}
        return await self.async_step_discovery_confirm()

    async def async_step_discovery_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Found on the network: confirm before the code appears on the panel."""
        if user_input is not None:
            return await self.async_step_pair()
        return self.async_show_form(step_id="discovery_confirm", description_placeholders={"name": self._name or ""})

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """By address (if it was not found automatically)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            self._host, self._port = user_input[CONF_HOST].strip(), user_input[CONF_PORT]
            self._make_api()
            try:
                await self._start_pairing()
            except PanelError:
                errors["base"] = "cannot_connect"
            else:
                return await self.async_step_pair()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=self._host or ""): str,
                                    vol.Required(CONF_PORT, default=self._port): int}),
            errors=errors,
        )

    async def async_step_pair(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The panel shows a 6-digit code: type it here."""
        errors: dict[str, str] = {}
        if user_input is None:
            if not self._code_shown:
                try:
                    await self._start_pairing()
                except PanelError:
                    return self.async_abort(reason="cannot_connect")
        else:
            try:
                data = await self._api.pair_finish(user_input[CONF_CODE])
            except PanelCodeError:
                errors[CONF_CODE] = "invalid_code"
            except PanelCodeExpired:
                errors[CONF_CODE] = "code_expired"
                self._code_shown = False
                try:
                    await self._start_pairing()       # a new code appears on the panel
                except PanelError:
                    return self.async_abort(reason="cannot_connect")
            except PanelError:
                errors["base"] = "cannot_connect"
            else:
                entry_data = {CONF_HOST: self._host, CONF_PORT: self._port, CONF_KEY: data["key"]}
                if self.source == SOURCE_REAUTH:
                    return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=entry_data)
                await self.async_set_unique_id(data["id"])
                self._abort_if_unique_id_configured(updates=entry_data)
                return self.async_create_entry(title=data.get("name") or self._name or "Panel Hogar", data=entry_data)
        return self.async_show_form(
            step_id="pair",
            data_schema=vol.Schema({vol.Required(CONF_CODE): str}),
            description_placeholders={"name": self._name or self._host or ""},
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The panel was unlinked (its web → General): link it again with a new code."""
        self._host, self._port = entry_data[CONF_HOST], entry_data[CONF_PORT]
        self._name = self._get_reauth_entry().title
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self.async_step_pair()
        return self.async_show_form(step_id="reauth_confirm", description_placeholders={"name": self._name or ""})
