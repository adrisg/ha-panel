#!/usr/bin/env bash
# Asistente de voz: la Pi escucha «Okay Nabu» con su micro USB y habla con Assist de Home Assistant (opcional).
# Instala wyoming-satellite y un detector de palabra de activación (microWakeWord), como servicio de tu usuario.
# Después, en Home Assistant: Ajustes → Dispositivos → Wyoming (suele aparecer solo) y en el panel:
# Ajustes → Asistente de voz.
# Uso (como tu usuario, no con sudo delante):  bash ~/ha-panel/setup-voz.sh
# Opcional: MICRO=plughw:CARD=Device,DEV=0  SALIDA=default  PALABRA=okay_nabu|hey_jarvis|hey_mycroft|alexa
set -euo pipefail

VENV="$HOME/.local/share/panel-hogar/voz"
PALABRA="${PALABRA:-okay_nabu}"
SALIDA="${SALIDA:-default}"

echo "==> Programas de audio..."
if ! command -v arecord >/dev/null || ! python3 -c 'import ensurepip' 2>/dev/null; then
  sudo apt-get install -y --no-install-recommends alsa-utils python3-venv
fi

# Micro: el primero que pueda grabar (los micros USB salen como tarjeta aparte)
if [ -z "${MICRO:-}" ]; then
  CARD="$(arecord -l 2>/dev/null | sed -n 's/^card [0-9]*: \([^ ]*\) .*/\1/p' | head -1)"
  [ -n "$CARD" ] || { echo "No veo ningún micro. Conéctalo y vuelve a lanzarlo."; exit 1; }
  MICRO="plughw:CARD=$CARD,DEV=0"
fi
echo "    Micro: $MICRO  ·  Salida: $SALIDA  ·  Palabra: $PALABRA"

echo "==> Instalando en $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q --upgrade wyoming-satellite pymicro-wakeword

echo "==> Servicio panel-voz (de tu usuario)..."
NOMBRE="Panel $(hostname)"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/panel-voz.service" <<EOF
[Unit]
Description=Panel Hogar - asistente de voz (satélite Wyoming)
After=network-online.target sound.target

[Service]
ExecStart=$VENV/bin/python -m wyoming_satellite --name "$NOMBRE" --uri tcp://0.0.0.0:10700 \\
  --mic-command "arecord -q -D $MICRO -r 16000 -c 1 -f S16_LE -t raw" \\
  --snd-command "aplay -q -D $SALIDA -r 22050 -c 1 -f S16_LE -t raw" \\
  --wake-command "$VENV/bin/python -m pymicro_wakeword --model $PALABRA"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
# Que siga funcionando sin sesión abierta (ya lo deja así el altavoz)
[ -f "/var/lib/systemd/linger/$USER" ] || sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now panel-voz.service

echo "==> Hecho. Di «${PALABRA//_/ }» cerca del micro."
echo "    En Home Assistant: Ajustes → Dispositivos y servicios → Wyoming «$NOMBRE» (o añádelo a mano: $(hostname -I | cut -d' ' -f1), puerto 10700)."
echo "    Ver qué hace:  journalctl --user -u panel-voz -f"
