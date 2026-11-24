#!/usr/bin/env bash
# Full Panel Hogar installer: installs the panel (setup-kiosk.sh) and asks whether you want the Music Assistant
# speaker (setup-sendspin.sh) and the voice assistant (setup-voice.sh). At the end it offers to restart.
# Usage (as your user, without sudo in front):  bash ~/ha-panel/install.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"

# Yes/no question. $2 = default answer (y/n) if only Enter is pressed.
ask() {
  local def="$2" hint r
  [ "$def" = y ] && hint="[Y/n]" || hint="[y/N]"
  read -r -p "$1 $hint " r || r=""
  r="${r:-$def}"
  [[ "$r" =~ ^[sSyY] ]]
}

echo "=================== Panel Hogar ==================="
bash "$PANEL_DIR/scripts/setup-kiosk.sh"

echo
echo "=================== Speaker (optional) ==================="
echo "The Pi can play as one more Music Assistant speaker (Sendspin), through the jack, HDMI or USB."
if ask "Install the speaker?" y; then
  bash "$PANEL_DIR/scripts/setup-sendspin.sh"
  # If it was never set up, it is left on with the default audio output
  # (name and output are changed in the web: Settings → Speaker)
  SETTINGS="$HOME/.config/panel-hogar/sendspin.json"
  if [ ! -f "$SETTINGS" ]; then
    mkdir -p "$(dirname "$SETTINGS")"
    echo '{"enabled": true}' > "$SETTINGS"
  fi
  systemctl --user enable panel-sendspin.service >/dev/null 2>&1 || true
  echo "==> Speaker installed and on. It shows up in Music Assistant after restarting."
else
  echo "==> No speaker. If you want it later:  bash $PANEL_DIR/scripts/setup-sendspin.sh"
fi

echo
echo "=============== Voice assistant (optional, in BETA) ==============="
echo "With a USB mic, the Pi listens for \"Okay Nabu\" and talks to Home Assistant's Assist."
echo "It is being tested: it works, but it may fail or change in future versions."
if arecord -l 2>/dev/null | grep -q '^card' && ask "Install the voice assistant (beta)?" n; then
  bash "$PANEL_DIR/scripts/setup-voice.sh"
else
  echo "==> No voice assistant. If you want it later:  bash $PANEL_DIR/scripts/setup-voice.sh"
fi

echo
echo "Done. If you have not set up Home Assistant yet, a QR shows at start to set it up from your phone."
if ask "Restart now?" y; then
  sudo reboot
fi
