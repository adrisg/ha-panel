#!/usr/bin/env bash
# Asistente de voz: la Pi escucha «Okay Nabu» con su micro USB y habla con Assist de Home Assistant (opcional).
# Instala wyoming-satellite y un detector de palabra de activación (microWakeWord), como servicio de tu usuario.
# Después, en Home Assistant: Ajustes → Dispositivos → Wyoming (suele aparecer solo) y en el panel:
# Ajustes → Asistente de voz.
# Uso (como tu usuario, no con sudo delante):  bash ~/ha-panel/scripts/setup-voz.sh
# Micro, por dónde contesta y palabra («Okay Nabu», «Hey Jarvis»…) se cambian en la web o en el panel: Ajustes → Asistente de voz.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # la carpeta del panel (estos scripts van en scripts/)
VENV="$HOME/.local/share/panel-hogar/voz"

echo "!!  El asistente de voz está en BETA: funciona, pero puede fallar o cambiar en próximas versiones."
echo
echo "==> Programas de audio..."
if ! command -v arecord >/dev/null || ! python3 -c 'import ensurepip' 2>/dev/null; then
  sudo apt-get install -y --no-install-recommends alsa-utils python3-venv
fi
arecord -l 2>/dev/null | grep -q '^card' || echo "    Aviso: no veo ningún micro. Conéctalo; el servicio lo buscará al arrancar."

echo "==> Instalando en $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade wyoming-satellite pymicro-wakeword

echo "==> Servicio panel-voz (de tu usuario)..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/panel-voz.service" <<EOF
[Unit]
Description=Panel Hogar - asistente de voz (satélite Wyoming)
After=network-online.target sound.target

[Service]
# Lee micro, salida y palabra de ~/.config/panel-hogar/voz.json (los pone la web o el panel)
ExecStart=/usr/bin/python3 $PANEL_DIR/panel-helper.py --voz
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
# Que siga funcionando sin sesión abierta (ya lo deja así el altavoz)
[ -f "/var/lib/systemd/linger/$USER" ] || sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable panel-voz.service
systemctl --user restart panel-voz.service

echo "==> Hecho. Di «Okay Nabu» cerca del micro."
echo "    En Home Assistant: Ajustes → Dispositivos y servicios → Wyoming (o añádelo a mano: $(hostname -I | cut -d' ' -f1), puerto 10700)."
echo "    Micro, salida y palabra: web del panel → Asistente de voz.  Ver qué hace:  journalctl --user -u panel-voz -f"
