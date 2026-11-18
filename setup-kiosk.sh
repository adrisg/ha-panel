#!/usr/bin/env bash
# Instala el panel en modo kiosko en una Raspberry Pi con Raspberry Pi OS Lite.
# Usa Chromium: hace falta una Pi 3, 4 o 5 (recomendada la Pi 4). En Pi 1 / Zero Chromium no funciona.
# Uso: copia esta carpeta a la Pi (p. ej. ~/ha-panel) y ejecuta:  bash ~/ha-panel/setup-kiosk.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> Panel en: $PANEL_DIR"

sudo apt-get update
sudo apt-get install -y --no-install-recommends cage curl fonts-noto-core wlr-randr
# 64 bits (aarch64) siempre tiene NEON, aunque /proc/cpuinfo lo llame «asimd»
if [ "$(uname -m)" != aarch64 ] && ! grep -qwE "neon|asimd" /proc/cpuinfo; then
  echo "!!  Esta Raspberry no puede ejecutar Chromium (Pi 1 / Zero). Usa una Pi 3, 4 o 5."
  exit 1
fi
echo "==> Instalando Chromium..."
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

echo "==> Permiso para cambiar la red desde la web de configuración (solo nmcli y hostnamectl)..."
echo "$USER ALL=(root) NOPASSWD: /usr/bin/nmcli, /usr/bin/hostnamectl" | sudo tee /etc/sudoers.d/panel-hogar >/dev/null
sudo chmod 440 /etc/sudoers.d/panel-hogar
sudo visudo -c -f /etc/sudoers.d/panel-hogar >/dev/null || sudo rm -f /etc/sudoers.d/panel-hogar

echo "==> Puntero del ratón invisible en la pantalla (tema de cursores transparente)..."
python3 - <<'PY'
import os, struct
# Xcursor de 1x1 píxel transparente
img = struct.pack('<9I', 36, 0xfffd0002, 1, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
data = b'Xcur' + struct.pack('<3I', 16, 0x10000, 1) + struct.pack('<3I', 0xfffd0002, 1, 28) + img
names = ('default left_ptr arrow top_left_arrow pointer hand hand1 hand2 text xterm ibeam grab grabbing move fleur '
         'crosshair cross wait watch progress left_ptr_watch not-allowed no-drop help question_arrow context-menu cell '
         'copy alias all-scroll col-resize row-resize ew-resize ns-resize nesw-resize nwse-resize n-resize s-resize '
         'e-resize w-resize ne-resize nw-resize se-resize sw-resize sb_h_double_arrow sb_v_double_arrow zoom-in zoom-out '
         'vertical-text dnd-move dnd-copy dnd-none pirate X_cursor').split()
# cage carga el tema «default» (no hace caso de XCURSOR_THEME): se pone en los dos
for theme in ('default', 'invisible'):
    d = os.path.expanduser('~/.icons/%s/cursors' % theme)
    os.makedirs(d, exist_ok=True)
    for n in names:
        with open(os.path.join(d, n), 'wb') as f:
            f.write(data)
    with open(os.path.expanduser('~/.icons/%s/index.theme' % theme), 'w') as f:
        f.write('[Icon Theme]\nName=%s\n' % theme)
PY

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
URL="file://$PANEL_DIR/index.html"
BROWSER="\$(command -v chromium || command -v chromium-browser)"
exec "\$BROWSER" --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run \
  --ozone-platform=wayland \
  --lang=es-ES --accept-lang=es-ES,es \
  --disable-features=Translate,TranslateUI,TouchpadOverscrollHistoryNavigation,MediaRouter,CastMediaRouteProvider,GlobalMediaControls \
  --overscroll-history-navigation=0 --disable-pinch --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 --disable-session-crashed-bubble \
  "\$URL"
EOF
cat > "$HOME/kiosk.sh" <<'EOF'
#!/usr/bin/env bash
# Lanzado al iniciar sesión en tty1. Si Chromium se cierra o falla, se vuelve a abrir.
while true; do
  XCURSOR_THEME=invisible cage -s -- "$HOME/kiosk-browser.sh"   # sin puntero visible
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
