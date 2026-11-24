#!/usr/bin/env bash
# Voice assistant: the Pi listens for "Okay Nabu" with its USB mic and talks to Home Assistant's Assist (optional).
# Installs wyoming-satellite and a wake word detector (microWakeWord), as a service of your user.
# Then, in Home Assistant: Settings → Devices → Wyoming (it usually shows up by itself) and on the panel:
# Settings → Voice assistant.
# Usage (as your user, without sudo in front):  bash ~/ha-panel/scripts/setup-voice.sh
# Mic, where it answers and the wake word ("Okay Nabu", "Hey Jarvis"…) are changed in the web or on the panel: Settings → Voice assistant.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # the panel folder (these scripts live in scripts/)
VENV="$HOME/.local/share/panel-hogar/voice"

echo "!!  The voice assistant is in BETA: it works, but it may fail or change in future versions."
echo
echo "==> Audio programs..."
if ! command -v arecord >/dev/null || ! python3 -c 'import ensurepip' 2>/dev/null; then
  sudo apt-get install -y --no-install-recommends alsa-utils python3-venv
fi
arecord -l 2>/dev/null | grep -q '^card' || echo "    Note: I see no mic. Plug it in; the service will look for it at start."

echo "==> Installing in $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade wyoming-satellite pymicro-wakeword

echo "==> panel-voice service (of your user)..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/panel-voice.service" <<EOF
[Unit]
Description=Panel Hogar - voice assistant (Wyoming satellite)
After=network-online.target sound.target

[Service]
# Reads mic, output and wake word from ~/.config/panel-hogar/voice.json (the web or the panel sets them)
ExecStart=/usr/bin/python3 $PANEL_DIR/panel-helper.py --voice
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
# Keep it running with no session open (the speaker already leaves it like that)
[ -f "/var/lib/systemd/linger/$USER" ] || sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable panel-voice.service
systemctl --user restart panel-voice.service

echo "==> Done. Say \"Okay Nabu\" near the mic."
echo "    In Home Assistant: Settings → Devices & services → Wyoming (or add it by hand: $(hostname -I | cut -d' ' -f1), port 10700)."
echo "    Mic, output and wake word: panel web → Voice assistant.  See what it does:  journalctl --user -u panel-voice -f"
