#!/usr/bin/env bash
# Runs after every update (panel-helper.py starts it, as your user). $1 = previous version.
# The steps a new version needs go here (system packages, etc.).
# It must be safe to run again: it only does what is missing.
set -uo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # the panel folder (these scripts live in scripts/)
SHARE="$HOME/.local/share/panel-hogar"
SENDSPIN_VENV="$SHARE/sendspin"
UNITS="$HOME/.config/systemd/user"

# System packages the panel needs (and the speaker, if it is installed)
need=(cage curl fonts-noto-core wlr-randr grim)
[ -x "$SENDSPIN_VENV/bin/pip" ] && need+=(libportaudio2 alsa-utils python3-venv)

missing=()
for p in "${need[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Installing packages: ${missing[*]}"
  # password-less permission only for apt-get (setup-kiosk.sh grants it)
  if ! sudo -n /usr/bin/apt-get install -y --no-install-recommends "${missing[@]}"; then
    echo "!! Could not install them. Run once on the Pi: bash $PANEL_DIR/scripts/setup-kiosk.sh"
  fi
fi

# Voice assistant from older versions: service «panel-voz» and folder «voz» → «panel-voice» and «voice»
if [ -f "$UNITS/panel-voz.service" ]; then
  echo "Renaming the voice assistant service to panel-voice..."
  systemctl --user disable --now panel-voz.service 2>/dev/null
  [ -d "$SHARE/voz" ] && [ ! -e "$SHARE/voice" ] && mv "$SHARE/voz" "$SHARE/voice"
  sed -e 's/--voz$/--voice/' -e 's/voz\.json/voice.json/' "$UNITS/panel-voz.service" > "$UNITS/panel-voice.service"
  rm -f "$UNITS/panel-voz.service"
  systemctl --user daemon-reload
  systemctl --user enable --now panel-voice.service
fi

echo "Done."
