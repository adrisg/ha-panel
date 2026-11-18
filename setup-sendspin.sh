#!/usr/bin/env bash
# Altavoz Sendspin: la Pi suena como un altavoz más de Music Assistant (opcional).
# Instala el programa «sendspin» y un servicio de tu usuario que arranca con la Pi.
# Se activa, se le pone nombre y se elige la salida (jack, HDMI, USB…) en la web: Ajustes → Altavoz.
# Uso (como tu usuario, no con sudo delante):  bash ~/ha-panel/setup-sendspin.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$HOME/.local/share/panel-hogar/sendspin"

echo "==> Librería de audio (PortAudio)..."
sudo apt-get install -y --no-install-recommends libportaudio2 alsa-utils python3-venv

echo "==> Instalando sendspin en $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade sendspin
"$VENV/bin/sendspin" --version

echo "==> Servicio panel-sendspin (de tu usuario)..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/panel-sendspin.service" <<EOF
[Unit]
Description=Panel Hogar - altavoz Sendspin
After=network-online.target sound.target

[Service]
# Lee nombre y salida de ~/.config/panel-hogar/sendspin.json (los pone la web)
ExecStart=/usr/bin/python3 $PANEL_DIR/panel-helper.py --sendspin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
# Que el servicio siga funcionando aunque se reinicie el kiosko (sin sesión abierta)
sudo loginctl enable-linger "$USER"
sudo usermod -aG audio "$USER" || true
systemctl --user daemon-reload

echo "==> Hecho. Actívalo en la web del panel: Ajustes → Altavoz."
echo "    Aparecerá en Music Assistant como un reproductor Sendspin con el nombre que le pongas."
