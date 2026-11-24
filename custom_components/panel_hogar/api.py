"""Small client for the panel's HTTP API (panel-helper.py, port 8080)."""
from __future__ import annotations

from typing import Any

import aiohttp

from .const import LONG_POLL_TIMEOUT


class PanelError(Exception):
    """The panel could not be reached or answered with an error."""


class PanelAuthError(PanelError):
    """The key is no longer valid (the panel was unlinked)."""


class PanelCodeError(PanelError):
    """Wrong pairing code."""


class PanelCodeExpired(PanelError):
    """The pairing code expired or was used too many times."""


class PanelApi:
    """Talks to one panel."""

    def __init__(self, session: aiohttp.ClientSession, host: str, port: int, key: str | None = None) -> None:
        self._session = session
        self.host = host
        self.port = port
        self.key = key

    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}/api/v1"

    async def _request(self, method: str, path: str, *, json: Any = None, auth: bool = True, timeout: float = 10) -> dict:
        headers = {"Authorization": f"Bearer {self.key}"} if auth and self.key else {}
        try:
            async with self._session.request(method, self.base + path, json=json, headers=headers,
                                             timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                data = await resp.json(content_type=None) if resp.content_length != 0 else {}
                if resp.status == 401:
                    raise PanelAuthError("invalid key")
                if resp.status == 403:
                    raise PanelCodeError("wrong code")
                if resp.status == 410:
                    raise PanelCodeExpired("code expired")
                if resp.status >= 400:
                    raise PanelError((data or {}).get("error") or f"HTTP {resp.status}")
                return data or {}
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise PanelError(str(err) or type(err).__name__) from err

    async def pair_start(self) -> dict:
        """Ask the panel to show a pairing code on its screen. Returns {id, name}."""
        return await self._request("POST", "/pair/start", json={}, auth=False)

    async def pair_finish(self, code: str) -> dict:
        """Send the code shown on the panel. Returns {key, id, name}."""
        data = await self._request("POST", "/pair/finish", json={"code": code}, auth=False)
        self.key = data["key"]
        return data

    async def info(self) -> dict:
        """{id, name, version, expose}."""
        return await self._request("GET", "/info")

    async def state(self, rev: int | None = None) -> dict:
        """Current state; with rev, waits until something changes (long polling)."""
        if rev is None:
            return await self._request("GET", "/state")
        return await self._request("GET", f"/state?rev={rev}&timeout={LONG_POLL_TIMEOUT}", timeout=LONG_POLL_TIMEOUT + 10)

    async def command(self, command: str, value: Any = None) -> None:
        """screen_on, screen_off, brightness (5–100), ambient_on, ambient_off, reload."""
        await self._request("POST", "/command", json={"command": command, "value": value})
