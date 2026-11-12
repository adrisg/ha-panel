# Panel Hogar

Panel táctil propio para Home Assistant, estilo Google Nest Hub, para una Raspberry Pi con pantalla.

## Cómo funciona

- **Panel** (`index.html` + `app.js`): web en Chromium a pantalla completa que habla con Home Assistant por WebSocket. Solo lee estados y llama a lo que pulses; no cambia la configuración de HA.
- **Ayudante** (`panel-helper.py`): en la Pi. Brillo y apagado de pantalla, red, álbumes de fotos y la **web de configuración** (`http://<pi>.local:8080`, con contraseña).
- La configuración se guarda en la Pi (`~/.config/panel-hogar/config.json`); el panel se recarga solo al cambiarla.

## Qué puedes hacer

- **Inicio**: tiempo, resumen, patinete, impresoras activas, escenas y favoritos.
- **Casa**: controlar luces (con su color), enchufes, persianas, clima, cerraduras, aspirador (por habitaciones) y altavoces.
- **Sensores**: valores por habitación e historial de 24 h.
- **Multimedia**: reproductores y cámaras.
- **Impresoras** (Bambu, Moonraker): cámara, progreso, boquillas, enchufe y controles.
- **Patinete** (`mi_scooter_ble`): batería, carga y ajustes.
- **Modo ambiente**: reloj, fotos, burbujas configurables y mini reproductor.
- **Alarmas**, **avisos desde HA** con botones ([AVISOS.md](AVISOS.md)) y **mando a distancia** desde la web.

## Parámetros

Se cambian en **Ajustes** del panel o en la **web de configuración**:

| Grupo | Parámetros |
|---|---|
| Home Assistant | dirección, token |
| Pantalla | brillo, modo ambiente tras, apagar tras |
| Modo noche | activado, desde, hasta, brillo, apagar de noche |
| Avisos | sonido, volumen |
| Fotos | mostrar, cómo se ven (rellenar / entera + difuminado / entera), cada cuánto, fuentes (Immich, Google Fotos, Medios de HA, URLs) |
| Modo ambiente | burbujas y su orden, altavoz por defecto |
| Alarmas | hora, días, nombre |
| Entidades | favoritos, tiempo, ocultas, integraciones excluidas, enchufes de impresoras |
| Red de la Pi | WiFi, IP fija/automática, nombre |

`config.js` (copia de `config.example.js`) sirve como configuración inicial.

## Instalar

```bash
git clone https://github.com/adrisg/ha-panel ~/ha-panel
bash ~/ha-panel/setup-kiosk.sh
sudo reboot
```

Al arrancar, escanea el QR de la pantalla para configurarlo desde el móvil.

**Probar en el PC:** `python dev.py` → panel en `127.0.0.1:8765`, web en `127.0.0.1:8080` (contraseña `panel`, pantalla y red simuladas).
