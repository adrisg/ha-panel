#!/usr/bin/env bash
# Instala el panel en modo kiosko en una Raspberry Pi (probado para Pi 2 v1.2 con Raspberry Pi OS Lite).
# Uso: copia esta carpeta a la Pi (p. ej. ~/ha-panel) y ejecuta:  bash ~/ha-panel/setup-kiosk.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> Panel en: $PANEL_DIR"

echo "==> Instalando cage (compositor kiosko) y Chromium..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends cage curl fonts-noto-core wlr-randr
sudo apt-get install -y --no-install-recommends chromium || sudo apt-get install -y --no-install-recommends chromium-browser

echo "==> Descargando iconos para funcionar sin internet..."
if [ ! -f "$PANEL_DIR/vendor/mdi/css/materialdesignicons.min.css" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL https://registry.npmjs.org/@mdi/font/-/font-7.4.47.tgz | tar xz -C "$tmp"
  mkdir -p "$PANEL_DIR/vendor/mdi"
  cp -r "$tmp/package/css" "$tmp/package/fonts" "$PANEL_DIR/vendor/mdi/"
  rm -rf "$tmp"
fi

if [ ! -f "$PANEL_DIR/config.js" ]; then
  cp "$PANEL_DIR/config.example.js" "$PANEL_DIR/config.js"
  echo "!!  Creado config.js: edítalo con tu URL y token de Home Assistant (nano $PANEL_DIR/config.js)"
fi

echo "==> Permiso para cambiar el brillo de la pantalla (si tiene retroiluminación controlable)..."
echo 'SUBSYSTEM=="backlight", RUN+="/bin/chmod 666 /sys/class/backlight/%k/brightness /sys/class/backlight/%k/bl_power"' \
  | sudo tee /etc/udev/rules.d/99-panel-backlight.rules >/dev/null
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=backlight || true

echo "==> Creando ~/kiosk-browser.sh y ~/kiosk.sh..."
cat > "$HOME/kiosk-browser.sh" <<EOF
#!/usr/bin/env bash
# Se ejecuta dentro de cage: abre el panel a pantalla completa.
ROTATE=""   # pon 90, 180 o 270 si tu pantalla está girada
if [ -n "\$ROTATE" ]; then
  wlr-randr --output "\$(wlr-randr | head -n1 | cut -d' ' -f1)" --transform "\$ROTATE" || true
fi
# Ayudante: brillo y apagado reales, álbumes de Immich y web de configuración (puerto 8080).
# Va dentro de cage para poder usar wlr-randr.
pkill -f panel-helper.py 2>/dev/null
python3 "$PANEL_DIR/panel-helper.py" &
# Espera (máx. 10 s) a que el ayudante responda, para que el panel lea su configuración al arrancar
for i in \$(seq 20); do curl -s -o /dev/null http://127.0.0.1:8766/status && break; sleep 0.5; done
BROWSER="\$(command -v chromium || command -v chromium-browser)"
exec "\$BROWSER" --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run \
  --ozone-platform=wayland --enable-low-end-device-mode \
  --disable-features=Translate,TouchpadOverscrollHistoryNavigation \
  --overscroll-history-navigation=0 --disable-pinch --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 --disable-session-crashed-bubble \
  "file://$PANEL_DIR/index.html"
EOF
cat > "$HOME/kiosk.sh" <<'EOF'
#!/usr/bin/env bash
# Lanzado al iniciar sesión en tty1. Si Chromium se cierra o falla, se vuelve a abrir.
while true; do
  cage -s -- "$HOME/kiosk-browser.sh"
  sleep 3
done
EOF
chmod +x "$HOME/kiosk-browser.sh" "$HOME/kiosk.sh"

if [ ! -f "$HOME/.config/panel-hogar/admin.json" ]; then
  echo "==> Contraseña para la web de configuración (http://$(hostname).local:8080)"
  python3 "$PANEL_DIR/panel-helper.py" --set-password
fi

echo "==> Arranque automático en tty1..."
sudo raspi-config nonint do_boot_behaviour B2   # consola con auto-login
if ! grep -q "kiosk.sh" "$HOME/.bash_profile" 2>/dev/null; then
  cat >> "$HOME/.bash_profile" <<'EOF'

# Panel Hogar: arrancar el kiosko solo en la pantalla física
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec "$HOME/kiosk.sh"
fi
EOF
fi

echo
echo "Listo. Edita $PANEL_DIR/config.js y reinicia con:  sudo reboot"
