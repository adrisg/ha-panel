#!/usr/bin/env bash
# Instalador completo del Panel Hogar: instala el panel (setup-kiosk.sh) y pregunta si quieres el altavoz
# de Music Assistant (setup-sendspin.sh) y el asistente de voz (setup-voz.sh). Al final ofrece reiniciar.
# Uso (como tu usuario, no con sudo delante):  bash ~/ha-panel/install.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"

# Pregunta sí/no. $2 = respuesta por defecto (s/n) si solo se pulsa Enter.
ask() {
  local def="$2" hint r
  [ "$def" = s ] && hint="[S/n]" || hint="[s/N]"
  read -r -p "$1 $hint " r || r=""
  r="${r:-$def}"
  [[ "$r" =~ ^[sSyY] ]]
}

echo "=================== Panel Hogar ==================="
bash "$PANEL_DIR/scripts/setup-kiosk.sh"

echo
echo "=================== Altavoz (opcional) ==================="
echo "La Pi puede sonar como un altavoz más de Music Assistant (Sendspin), por el jack, HDMI o USB."
if ask "¿Instalar el altavoz?" s; then
  bash "$PANEL_DIR/scripts/setup-sendspin.sh"
  # Si nunca se ha configurado, se deja activado con la salida de audio por defecto
  # (nombre y salida se cambian en la web: Ajustes → Altavoz)
  SETTINGS="$HOME/.config/panel-hogar/sendspin.json"
  if [ ! -f "$SETTINGS" ]; then
    mkdir -p "$(dirname "$SETTINGS")"
    echo '{"enabled": true}' > "$SETTINGS"
  fi
  systemctl --user enable panel-sendspin.service >/dev/null 2>&1 || true
  echo "==> Altavoz instalado y activado. Sale en Music Assistant al reiniciar."
else
  echo "==> Sin altavoz. Si lo quieres más adelante:  bash $PANEL_DIR/scripts/setup-sendspin.sh"
fi

echo
echo "=============== Asistente de voz (opcional, en BETA) ==============="
echo "Con un micro USB, la Pi escucha «Okay Nabu» y habla con Assist de Home Assistant."
echo "Está en pruebas: funciona, pero puede fallar o cambiar en próximas versiones."
if arecord -l 2>/dev/null | grep -q '^card' && ask "¿Instalar el asistente de voz (beta)?" n; then
  bash "$PANEL_DIR/scripts/setup-voz.sh"
else
  echo "==> Sin asistente de voz. Si lo quieres más adelante:  bash $PANEL_DIR/scripts/setup-voz.sh"
fi

echo
echo "Listo. Si aún no has puesto Home Assistant, al arrancar sale un QR para configurarlo desde el móvil."
if ask "¿Reiniciar ahora?" s; then
  sudo reboot
fi
