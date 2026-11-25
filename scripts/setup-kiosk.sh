#!/usr/bin/env bash
# Installs the panel in kiosk mode on a Raspberry Pi with Raspberry Pi OS Lite.
# It uses Chromium: a Pi 3, 4 or 5 is needed (Pi 4 recommended). Chromium does not work on Pi 1 / Zero.
# Usage: copy this folder to the Pi (e.g. ~/ha-panel) and run:  bash ~/ha-panel/scripts/setup-kiosk.sh
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # the panel folder (these scripts live in scripts/)
echo "==> Panel in: $PANEL_DIR"

sudo apt-get update
sudo apt-get install -y --no-install-recommends cage curl fonts-noto-core wlr-randr grim python3-cryptography
# 64 bits (aarch64) always has NEON, even if /proc/cpuinfo calls it "asimd"
if [ "$(uname -m)" != aarch64 ] && ! grep -qwE "neon|asimd" /proc/cpuinfo; then
  echo "!!  This Raspberry cannot run Chromium (Pi 1 / Zero). Use a Pi 3, 4 or 5."
  exit 1
fi
echo "==> Installing Chromium..."
sudo apt-get install -y --no-install-recommends chromium || sudo apt-get install -y --no-install-recommends chromium-browser

echo "==> Downloading icons to work without internet..."
if [ ! -f "$PANEL_DIR/vendor/mdi/css/materialdesignicons.min.css" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL https://registry.npmjs.org/@mdi/font/-/font-7.4.47.tgz | tar xz -C "$tmp"
  mkdir -p "$PANEL_DIR/vendor/mdi"
  cp -r "$tmp/package/css" "$tmp/package/fonts" "$PANEL_DIR/vendor/mdi/"
  rm -rf "$tmp"
fi

if [ ! -f "$PANEL_DIR/config.js" ]; then
  cp "$PANEL_DIR/config.example.js" "$PANEL_DIR/config.js"
  echo "!!  config.js created: edit it with your Home Assistant URL and token (nano $PANEL_DIR/config.js)"
fi

echo "==> Permission to change the screen brightness (if it has a controllable backlight)..."
echo 'SUBSYSTEM=="backlight", RUN+="/bin/chmod 666 /sys/class/backlight/%k/brightness /sys/class/backlight/%k/bl_power"' \
  | sudo tee /etc/udev/rules.d/99-panel-backlight.rules >/dev/null
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=backlight || true

echo "==> Password-less permissions: network from the web (nmcli, hostnamectl) and packages on updates (apt-get)..."
echo "$USER ALL=(root) NOPASSWD: /usr/bin/nmcli, /usr/bin/hostnamectl, /usr/bin/apt-get" | sudo tee /etc/sudoers.d/panel-hogar >/dev/null
sudo chmod 440 /etc/sudoers.d/panel-hogar
sudo visudo -c -f /etc/sudoers.d/panel-hogar >/dev/null || sudo rm -f /etc/sudoers.d/panel-hogar

echo "==> Invisible mouse pointer on the screen (transparent cursor theme)..."
python3 - <<'PY'
import os, struct
# transparent 1x1 pixel Xcursor
img = struct.pack('<9I', 36, 0xfffd0002, 1, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
data = b'Xcur' + struct.pack('<3I', 16, 0x10000, 1) + struct.pack('<3I', 0xfffd0002, 1, 28) + img
names = ('default left_ptr arrow top_left_arrow pointer hand hand1 hand2 text xterm ibeam grab grabbing move fleur '
         'crosshair cross wait watch progress left_ptr_watch not-allowed no-drop help question_arrow context-menu cell '
         'copy alias all-scroll col-resize row-resize ew-resize ns-resize nesw-resize nwse-resize n-resize s-resize '
         'e-resize w-resize ne-resize nw-resize se-resize sw-resize sb_h_double_arrow sb_v_double_arrow zoom-in zoom-out '
         'vertical-text dnd-move dnd-copy dnd-none pirate X_cursor').split()
# cage loads the "default" theme (it ignores XCURSOR_THEME): set it in both
for theme in ('default', 'invisible'):
    d = os.path.expanduser('~/.icons/%s/cursors' % theme)
    os.makedirs(d, exist_ok=True)
    for n in names:
        with open(os.path.join(d, n), 'wb') as f:
            f.write(data)
    with open(os.path.expanduser('~/.icons/%s/index.theme' % theme), 'w') as f:
        f.write('[Icon Theme]\nName=%s\n' % theme)
PY

echo "==> Creating ~/kiosk-browser.sh and ~/kiosk.sh..."
cat > "$HOME/kiosk-browser.sh" <<EOF
#!/usr/bin/env bash
# Runs inside cage: opens the panel full screen.
ROTATE=""   # set 90, 180 or 270 if your screen is rotated
if [ -n "\$ROTATE" ]; then
  wlr-randr --output "\$(wlr-randr | head -n1 | cut -d' ' -f1)" --transform "\$ROTATE" || true
fi
# Helper: real brightness and screen off, Immich albums and configuration web (port 8080).
# It runs inside cage so it can use wlr-randr.
pkill -f panel-helper.py 2>/dev/null
python3 "$PANEL_DIR/panel-helper.py" &
# Wait (max. 10 s) for the helper to answer, so the panel reads its configuration at start
for i in \$(seq 20); do curl -s -o /dev/null http://127.0.0.1:8766/status && break; sleep 0.5; done
URL="file://$PANEL_DIR/index.html"
BROWSER="\$(command -v chromium || command -v chromium-browser)"
exec "\$BROWSER" --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run \
  --ozone-platform=wayland \
  --lang=es-ES --accept-lang=es-ES,es \
  --disable-features=Translate,TranslateUI,TouchpadOverscrollHistoryNavigation,MediaRouter,CastMediaRouteProvider,GlobalMediaControls \
  --disable-blink-features=RemotePlayback,MediaCastOverlayButton \
  --overscroll-history-navigation=0 --disable-pinch --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 --disable-session-crashed-bubble \
  "\$URL"
EOF
cat > "$HOME/kiosk.sh" <<'EOF'
#!/usr/bin/env bash
# Started on login on tty1. If Chromium closes or fails, it opens again.
while true; do
  XCURSOR_THEME=invisible cage -s -- "$HOME/kiosk-browser.sh"   # no visible pointer
  sleep 3
done
EOF
chmod +x "$HOME/kiosk-browser.sh" "$HOME/kiosk.sh"

if [ ! -f "$HOME/.config/panel-hogar/admin.json" ]; then
  echo "==> Password for the configuration web (http://$(hostname).local:8080)"
  python3 "$PANEL_DIR/panel-helper.py" --set-password
fi

echo "==> Automatic start on tty1..."
sudo raspi-config nonint do_boot_behaviour B2   # console with auto-login
if ! grep -q "kiosk.sh" "$HOME/.bash_profile" 2>/dev/null; then
  cat >> "$HOME/.bash_profile" <<'EOF'

# Panel Hogar: start the kiosk only on the physical screen
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec "$HOME/kiosk.sh"
fi
EOF
fi

echo
echo "Done. Edit $PANEL_DIR/config.js and restart with:  sudo reboot"
