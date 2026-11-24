"""Constants for the Panel Hogar integration."""

DOMAIN = "panel_hogar"
DEFAULT_PORT = 8080
ZEROCONF_TYPE = "_panel-hogar._tcp.local."

CONF_KEY = "key"
CONF_PANEL_ID = "panel_id"
CONF_ENTITIES = "entities"   # options: what the panel may see and control (integration mode)

# How long the panel keeps a state request open waiting for a change (long polling)
LONG_POLL_TIMEOUT = 25
RETRY_DELAY = 10

EXPOSE_SCREEN = "screen"
EXPOSE_AMBIENT = "ambient"
EXPOSE_LAST_TOUCH = "last_touch"
EXPOSE_RELOAD = "reload"
