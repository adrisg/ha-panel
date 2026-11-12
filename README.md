# Panel Hogar

Un panel propio para Home Assistant, al estilo Google Nest Hub, para una Raspberry Pi 2 (v1.2) con pantalla táctil.
No usa los dashboards de Home Assistant: es una página web propia (HTML + JS puro, sin frameworks) que se conecta a la **API WebSocket** de Home Assistant y se abre a pantalla completa en Chromium.

## Qué hace

| Vista | Contenido |
|---|---|
| **Inicio** | Saludo, tiempo con previsión de 5 días, tarjeta del patinete, escenas, favoritos y un botón para apagar todas las luces encendidas |
| **Casa** | Todo lo que se puede controlar (luces, enchufes, ventiladores, persianas, clima, cerraduras, aspirador, altavoces), agrupado por habitación |
| **Sensores** | Temperaturas, humedad, consumo, puertas y ventanas… por habitación. Al tocar uno ves su gráfica de las últimas 24 h |
| **Multimedia** | Reproductores con carátula, controles y volumen; cámaras que se refrescan solas |
| **Patinete** | Batería, autonomía, estado de carga, estadísticas, límite de carga y ajustes (integración `mi_scooter_ble`) |
| **Impresoras** | Bambu y Snapmaker (Moonraker): cámara con miniatura, progreso, tiempo, boquillas, enchufe y botones. Si imprimen, salen en Inicio y en el modo ambiente |
| **Avisos** | Lanzados desde automatizaciones de Home Assistant, con botones (p. ej. abrir la puerta del telefonillo). Ver [AVISOS.md](AVISOS.md) |
| **Ajustes** | Brillo, tiempo hasta el modo ambiente, apagado de pantalla, modo noche (horario, brillo, apagar de noche) y sonido de los avisos. Se guardan en Home Assistant |
| **Ambiente** | Tras 90 s sin tocar la pantalla: reloj grande, fecha, tiempo y avisos, sobre un degradado según la hora o tus fotos |

- **Toque corto** en una ficha: enciende o apaga.
- **Pulsación larga**: abre el detalle (brillo, tono y color de la luz, temperatura del termostato, posición de la persiana…).
- Todo aparece solo: el panel lee las entidades, habitaciones y dispositivos de Home Assistant. Lo que tengas oculto o marcado como configuración o diagnóstico no aparece.
- Modo noche: oscurece la pantalla entre las horas que elijas.
- Se reconecta solo si se reinicia Home Assistant o se cae la WiFi.

## Probarlo en el ordenador

Todo funciona en el PC, sin Raspberry Pi. Desde esta carpeta:

```bash
python dev.py
```

Arranca el panel, el ayudante y la web de configuración, y abre el navegador:

| | Dirección |
|---|---|
| Panel | http://127.0.0.1:8765 (a 800x480 se ve como en la pantalla de la Pi) |
| Web de configuración | http://127.0.0.1:8080 · contraseña de pruebas: **`panel`** |
| Web desde el móvil | `http://<IP-del-PC>:8080`, en la misma WiFi (puede que tengas que permitirlo en el cortafuegos de Windows) |

- **Modo simulación:** el ayudante simula el brillo, el apagado de la pantalla, las redes WiFi, la IP fija y el nombre del equipo. Puedes probar todo **sin que cambie nada del ordenador**.
- **Datos de prueba:** se guardan en `.dev-data/`, que no se sube a git. `python dev.py --reset` empieza de cero.
- **Sin `config.js`:** el panel arranca con datos falsos. Pon tu Home Assistant desde la web de configuración.

## Instalarlo en la Raspberry Pi 2

1. Graba **Raspberry Pi OS Lite** (Bookworm, 32 bits) con Raspberry Pi Imager. En la configuración avanzada activa SSH, la WiFi y el usuario.
2. Copia esta carpeta a la Pi:
   ```bash
   scp -r ha-panel pi@raspberrypi.local:~/
   ```
3. En la Pi:
   ```bash
   bash ~/ha-panel/setup-kiosk.sh
   ```
   El script instala `cage` (un compositor mínimo que solo muestra una app) y Chromium, descarga los iconos para que funcione sin internet, configura el inicio de sesión automático y crea `config.js`.
4. Crea un token en Home Assistant: **tu perfil → Seguridad → Tokens de acceso de larga duración → Crear token**.
5. Edita la configuración:
   ```bash
   nano ~/ha-panel/config.js
   ```
   Pon `haUrl` (por ejemplo `http://192.168.1.50:8123`) y `token`.
6. Reinicia con `sudo reboot`. El panel se abre solo al arrancar.

### Pantalla

- **Táctil por HDMI** (táctil por USB): suele funcionar sin hacer nada más.
- **Táctil SPI** (por ejemplo Waveshare de 3,5" sobre los pines GPIO): necesita el overlay del fabricante en `/boot/firmware/config.txt`. Sigue la guía de tu modelo y comprueba que la consola se ve en la pantalla antes de ejecutar el script. El panel se adapta a 480x320.
- Si la imagen sale girada, edita `ROTATE` en `~/kiosk-browser.sh`.
- **Brillo y apagado:** `panel-helper.py` (lo arranca el kiosko) controla la retroiluminación de verdad si la pantalla lo permite (la oficial DSI y algunas SPI) y apaga la salida HDMI con `wlr-randr`. Si tu pantalla no se deja, el panel oscurece la imagen por software. En **Ajustes → Panel** ves qué método está usando.

## Configurar desde el móvil o el PC (sin tocar la Pi)

Con el panel instalado, abre **`http://<nombre-de-la-pi>.local:8080`** (por ejemplo `http://raspberrypi.local:8080`) desde cualquier dispositivo de tu red y entra con la contraseña que pusiste al instalar.

Desde ahí cambias todo y el panel se actualiza solo en unos segundos:
- **Home Assistant:** dirección y token, con botón para probar la conexión. El token guardado nunca se muestra.
- **Pantalla:** brillo, modo ambiente, apagado y modo noche.
- **Avisos y fotos:** sonido de los avisos, álbumes de Immich y cada cuánto cambian las fotos.
- **Inicio y entidades:** favoritos (con buscador de entidades), entidad del tiempo, entidades e integraciones ocultas y enchufes de las impresoras.
- **Mando a distancia:** recargar el panel, ir a Inicio o al modo ambiente, apagar o encender la pantalla y enviar un aviso de prueba.
- **Red de la Pi:** ver la IP, la WiFi y la señal; cambiar de WiFi, poner IP fija o automática y cambiar el nombre del equipo.

Para no tener que recordar la dirección: en el panel ve a **Ajustes → Red y configuración desde el móvil → Configurar desde el móvil**. Sale un **código QR** con la dirección escrita debajo; escanéalo con la cámara del móvil.

La primera vez se importa sola la configuración de `config.js`. Para cambiar la contraseña, en la Pi ejecuta `python3 ~/ha-panel/panel-helper.py --set-password`.

## Configuración (`config.js`)

| Opción | Para qué sirve |
|---|---|
| `favorites` | Entidades que aparecen en Inicio, por ejemplo `["light.salon", "climate.salon"]` |
| `hiddenEntities` | Entidades que no quieres ver nunca |
| `idleSeconds` | Segundos sin tocar la pantalla antes de pasar al modo ambiente (0 = nunca) |
| `ambientPhotos` | Fotos del modo ambiente: pega el **enlace compartido de un álbum de Immich** (`https://immich…/share/…`) y se cargan todas sus fotos con fecha y ciudad. También vale un álbum privado con `immichApiKey`, o URLs de fotos sueltas |
| `night` | Horario y nivel del oscurecimiento nocturno |
| `weatherEntity` | Qué entidad `weather.*` usar (si no, la primera que haya) |

## Fotos del modo ambiente (conectores)

En la web de configuración, en **Fuentes de fotos**, puedes añadir varias fuentes, que se mezclan entre sí. Cada una tiene su configuración y se puede activar o desactivar:

| Fuente | Qué pide | Notas |
|---|---|---|
| **Immich** | Enlace compartido del álbum (`https://immich…/share/…`), o álbum privado `…/albums/<id>` con clave API | Funciona con Immich 1.x, 2.x y 3.x. Si tu proxy no permite CORS, la lista la lee `panel-helper.py` |
| **Google Fotos** | Enlace de un álbum compartido (`https://photos.app.goo.gl/…`) | Lo lee `panel-helper.py`, que mira la página pública del álbum |
| **Carpeta de Home Assistant** | Carpeta dentro de *Medios → My media* (vacío = todo) | Solo lectura |
| **Fotos por URL** | Una URL por línea | |

Debajo de la fecha de cada foto sale, en pequeño, de dónde es (por ejemplo «Immich · Londres»). En **Ajustes → Fotos** del panel ves cuántas fotos ha cargado cada fuente o el error que ha dado.

- Si las fotos de Immich no salen, puede que falten sus versiones grandes: en Immich, ve a **Administración → Trabajos → Generar miniaturas → Faltantes**.

## Seguridad

- `config.js` contiene un token con acceso a tu Home Assistant. Déjalo solo en la Pi: **no lo pongas** en la carpeta `/config/www` de Home Assistant, porque todo lo que hay en `/local/` es público. Tampoco lo subas a git (ya está en `.gitignore`).
- Lo mejor es crear en Home Assistant un usuario solo para el panel y generar el token con él. Si con ese usuario no aparecen las habitaciones, hazlo administrador.

## Archivos

```
index.html          estructura de la página
styles.css          diseño (sin desenfoques ni sombras pesadas, para que vaya fluido en la Pi 2)
app.js              conexión con HA, vistas y controles
config.example.js   plantilla de config.js
setup-kiosk.sh      instalación del kiosko en la Pi
panel-helper.py     ayudante en la Pi: brillo y apagado reales, álbumes de Immich y web de configuración
dev.py              arranca todo en el ordenador para probarlo (pantalla y red simuladas)
config.html         la web de configuración (la sirve panel-helper.py en el puerto 8080)
lib/qrcode.js       generador de códigos QR (qrcode-generator, de Kazuhiko Arase, licencia MIT)
boot.js             carga en el panel la configuración guardada desde la web
```
