#!/usr/bin/env bash
# Sendspin speaker: the Pi plays as one more Music Assistant speaker (optional).
# Installs the "sendspin" program and a service of your user that starts with the Pi.
# It is turned on, named and its output (jack, HDMI, USB…) chosen in the web: Settings → Speaker.
# Usage (as your user, without sudo in front):  bash ~/ha-panel/scripts/setup-sendspin.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # the panel folder (these scripts live in scripts/)
VENV="$HOME/.local/share/panel-hogar/sendspin"

echo "==> Audio library (PortAudio)..."
sudo apt-get install -y --no-install-recommends libportaudio2 alsa-utils python3-venv

echo "==> Installing sendspin in $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade sendspin
"$VENV/bin/sendspin" --version

echo "==> panel-sendspin service (of your user)..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/panel-sendspin.service" <<EOF
[Unit]
Description=Panel Hogar - Sendspin speaker
After=network-online.target sound.target

[Service]
# Reads name and output from ~/.config/panel-hogar/sendspin.json (the web sets them)
ExecStart=/usr/bin/python3 $PANEL_DIR/panel-helper.py --sendspin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
# Keep the service running even if the kiosk restarts (with no session open)
sudo loginctl enable-linger "$USER"
sudo usermod -aG audio "$USER" || true
systemctl --user daemon-reload

echo "==> Done. Turn it on in the panel web: Settings → Speaker."
echo "    It will show up in Music Assistant as a Sendspin player with the name you give it."
