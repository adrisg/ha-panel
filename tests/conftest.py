"""Make the Home Assistant test harness find this repository's integration (only for the HA tests)."""
import os

try:
    import custom_components
except ImportError:      # the plain Python tests (helper) don't need Home Assistant
    custom_components = None

if custom_components is not None:
    OURS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "custom_components"))
    if OURS not in list(custom_components.__path__):
        custom_components.__path__.insert(0, OURS)
