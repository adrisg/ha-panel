#!/usr/bin/env bash
# Se ejecuta después de cada actualización (lo lanza panel-helper.py, como tu usuario). $1 = versión anterior.
# Aquí van los pasos que necesite una versión nueva (paquetes del sistema, etc.).
# Tiene que poder repetirse sin problema: solo hace lo que falte.
set -uo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # la carpeta del panel (estos scripts van en scripts/)
SENDSPIN_VENV="$HOME/.local/share/panel-hogar/sendspin"

# Paquetes del sistema que necesita el panel (y el altavoz, si está instalado)
need=(cage curl fonts-noto-core wlr-randr)
[ -x "$SENDSPIN_VENV/bin/pip" ] && need+=(libportaudio2 alsa-utils python3-venv)

missing=()
for p in "${need[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Instalando paquetes: ${missing[*]}"
  # permiso sin contraseña solo para apt-get (lo da setup-kiosk.sh)
  if ! sudo -n /usr/bin/apt-get install -y --no-install-recommends "${missing[@]}"; then
    echo "!! No se pudieron instalar. Lanza una vez en la Pi: bash $PANEL_DIR/scripts/setup-kiosk.sh"
  fi
fi

echo "Listo."
