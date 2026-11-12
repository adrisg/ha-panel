# Panel Hogar

Panel propio para Home Assistant, al estilo Google Nest Hub, pensado para una **Raspberry Pi 2 (v1.2) con pantalla táctil**.

No usa los dashboards de Home Assistant: es una página web propia (HTML + JavaScript puro, sin frameworks, para que vaya fluida en una Pi 2) que habla con la **API WebSocket** de Home Assistant y se abre a pantalla completa en Chromium. Un pequeño **ayudante en Python** (`panel-helper.py`) añade lo que una página web no puede hacer sola: brillo y apagado real de la pantalla, red de la Pi, álbumes de fotos y una **web de configuración** para cambiarlo todo desde el móvil.

> El panel **no modifica nada** de tu Home Assistant: solo lee estados y llama a los servicios que tú pulses (encender una luz, pausar la música…).

---

## Índice

1. [Qué hace](#qué-hace)
2. [Cómo se usa](#cómo-se-usa)
3. [Probarlo en el ordenador](#probarlo-en-el-ordenador)
4. [Instalarlo en la Raspberry Pi](#instalarlo-en-la-raspberry-pi)
5. [Web de configuración (desde el móvil)](#web-de-configuración-desde-el-móvil)
6. [Modo ambiente](#modo-ambiente)
7. [Fotos: conectores](#fotos-conectores)
8. [Alarmas](#alarmas)
9. [Avisos desde Home Assistant](#avisos-desde-home-assistant)
10. [Ajustes del panel](#ajustes-del-panel)
11. [Cómo funciona por dentro](#cómo-funciona-por-dentro)
12. [config.js](#configjs)
13. [Seguridad](#seguridad)
14. [Solución de problemas](#solución-de-problemas)
15. [Archivos](#archivos)

---

## Qué hace

| Vista | Contenido |
|---|---|
| **Inicio** | Saludo y fecha; resumen (luces encendidas con botón para apagarlas, puertas y ventanas abiertas, próxima alarma); tiempo con previsión de 5 días y probabilidad de lluvia; tarjeta del patinete; impresoras que estén imprimiendo; escenas y favoritos |
| **Casa** | Todo lo que se puede controlar (luces, enchufes, ventiladores, persianas, clima, cerraduras, aspirador, altavoces) agrupado por habitación |
| **Sensores** | Temperatura, humedad, consumo, puertas, ventanas, movimiento… por habitación. Al tocar uno, su gráfica de las últimas 24 h |
| **Multimedia** | Reproductores (los que tienen algo puesto, primero) con carátula, controles y volumen, y cámaras que se refrescan solas |
| **Impresoras** | Bambu Lab y Moonraker/Klipper (Snapmaker): cámara en directo con la miniatura del trabajo, progreso, tiempo restante, capas, temperaturas de cada boquilla (con filamento cargado) y cama, enchufe con consumo, pausar/continuar/cancelar y luz |
| **Patinete** | Integración `mi_scooter_ble`: anillo de batería (azul cargando, verde cargado), autonomía, estado, estadísticas, límite de carga y ajustes |
| **Ajustes** | Engranaje flotante abajo a la derecha. Ver [Ajustes del panel](#ajustes-del-panel) |
| **Modo ambiente** | Tras un rato sin tocar la pantalla: reloj, fecha, fotos y burbujas de información. Ver [Modo ambiente](#modo-ambiente) |

Además:
- **Luces:** la ficha encendida toma el **color real de la luz** (RGB, blanco cálido o frío según su temperatura de color).
- **Aspirador:** al pulsarlo eliges **qué habitaciones limpiar** (Dreame), limpias toda la casa o lanzas los **atajos de la app**. Mientras carga, rayito en el icono.
- **Dispositivos sin conexión:** su detalle muestra un aviso y desactiva los botones hasta que vuelvan.
- **Todo aparece solo:** el panel lee entidades, habitaciones y dispositivos. Oculta lo no disponible, lo marcado como configuración o diagnóstico y las integraciones técnicas que elijas.
- **Se reconecta solo** si se reinicia Home Assistant o se cae la WiFi.

## Cómo se usa

- **Toque corto** en una ficha: enciende o apaga (o abre el detalle si no es un interruptor).
- **Pulsación larga**: abre el detalle (brillo, tono y color de la luz, termostato, persiana, reproductor, cámara, historial del sensor…).
- **Modo ambiente**: tocar el fondo vuelve a Inicio; tocar una burbuja lleva a su vista (patinete, impresoras, música…).
- **Engranaje** abajo a la derecha: Ajustes.

---

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

- **Modo simulación:** el ayudante simula el brillo, el apagado de pantalla, las redes WiFi, la IP fija y el nombre del equipo. Puedes probarlo todo **sin que cambie nada del ordenador**. La web y Ajustes lo indican.
- **Tu Home Assistant es real:** con `config.js` relleno (o configurado desde la web) se conecta de verdad.
- **Datos de prueba** en `.dev-data/` (no se sube a git). `python dev.py --reset` empieza de cero.
- El servidor del panel no usa caché: al recargar ves siempre la última versión.

---

## Instalarlo en la Raspberry Pi

1. Graba **Raspberry Pi OS Lite** (Bookworm, 32 bits) con Raspberry Pi Imager. En la configuración avanzada activa SSH, la WiFi y el usuario.
2. En la Pi, descarga el panel:
   ```bash
   git clone https://github.com/adrisg/ha-panel ~/ha-panel
   ```
3. Instala el kiosko:
   ```bash
   bash ~/ha-panel/setup-kiosk.sh
   ```
   El script:
   - instala `cage` (un compositor mínimo que solo muestra una app), Chromium y los iconos (para funcionar sin internet);
   - da permiso para cambiar el brillo (regla `udev`) y la red desde la web (`sudo` solo para `nmcli` y `hostnamectl`);
   - crea el inicio automático: al encender, se abre el panel y arranca el ayudante;
   - te pide la **contraseña de la web de configuración**.
4. Reinicia con `sudo reboot`. Si el panel aún no tiene Home Assistant configurado, verás **«Conecta el panel con Home Assistant»** con un **código QR**: escanéalo con el móvil, entra con la contraseña y pon la dirección y un token (Home Assistant → tu perfil → Seguridad → Tokens de acceso de larga duración).

**Actualizar:** `cd ~/ha-panel && git pull` y reinicia.

### Pantalla

- **Táctil por HDMI** (táctil por USB): suele funcionar sin hacer nada más.
- **Táctil SPI** (p. ej. Waveshare de 3,5" sobre los pines GPIO): necesita el overlay del fabricante en `/boot/firmware/config.txt`. Comprueba que la consola se ve en la pantalla antes de ejecutar el script. El panel se adapta a 480x320.
- **Imagen girada:** edita `ROTATE` en `~/kiosk-browser.sh`.
- **Brillo y apagado:** con retroiluminación controlable (pantalla oficial DSI, algunas SPI) se cambian de verdad; con HDMI se apaga la señal con `wlr-randr` y el brillo se hace oscureciendo la imagen. En **Ajustes → Panel** ves qué método usa.
- **Sonido** (avisos y alarmas): la Pi necesita un altavoz por el jack o por HDMI.

---

## Web de configuración (desde el móvil)

Con el panel instalado, abre **`http://<nombre-de-la-pi>.local:8080`** (o con la IP) desde el móvil o el PC y entra con tu contraseña. Para no recordarla: en el panel, **Ajustes → Red y configuración desde el móvil → Configurar desde el móvil** muestra un **QR** con la dirección escrita debajo.

Al pulsar **Guardar**, el panel se recarga solo en unos segundos.

| Apartado | Qué puedes hacer |
|---|---|
| **Mando a distancia** | Recargar el panel, ir a Inicio, modo ambiente, apagar o encender la pantalla y enviar un aviso de prueba |
| **Red de la Pi** | Ver IP, WiFi, señal, puerta de enlace y DNS; buscar y cambiar de WiFi; IP fija o automática; nombre del equipo. Cada cambio pide confirmación |
| **Home Assistant** | Dirección y token, con «Probar conexión». El token guardado nunca se muestra |
| **Pantalla y modo noche** | Brillo, tiempo hasta el modo ambiente, apagado, horario y brillo nocturno, apagar de noche |
| **Avisos** | Sonido y volumen |
| **Fotos del modo ambiente** | Mostrar fotos, cómo se ven (por defecto), cada cuánto cambian, fuentes de fotos, altavoz por defecto y burbujas |
| **Inicio y entidades** | Favoritos (con buscador de entidades), entidad del tiempo, entidades e integraciones ocultas y enchufes de las impresoras |

- La primera vez se importa sola la configuración de `config.js`.
- Cambiar la contraseña: en la Pi, `python3 ~/ha-panel/panel-helper.py --set-password`.

---

## Modo ambiente

Tras el tiempo configurado sin tocar la pantalla (1,5 min por defecto):

- **Reloj y fecha** en grande.
- **Fondo:** fotos de tus [fuentes](#fotos-conectores) o un degradado según la hora. Arriba a la derecha, la **fecha de la foto** y debajo, en gris, **de dónde es** (p. ej. «Immich · Londres»). Flecha **›** para pasar a la siguiente.
- **Cómo se ve la foto:** *rellenar* (ocupa toda la pantalla), *entera + fondo difuminado* (sin recortar, con la misma foto desenfocada detrás; ideal para fotos verticales) o *entera* (fondo negro). Hay uno por defecto y cada fuente puede tener el suyo.
- **Burbujas** debajo del reloj (tiempo, próxima alarma, impresoras, patinete, música, luces, puertas y ventanas): eliges **cuáles salen y en qué orden**. Al tocarlas vas a su vista.
- **Altavoz por defecto:** abajo a la derecha, mini reproductor con carátula, canción, anterior/play-pausa/siguiente y volumen. Tocarlo no sale del modo ambiente.
- **Modo noche:** baja el brillo (o apaga la pantalla) en el horario que elijas.

---

## Fotos: conectores

En la web de configuración, **Fuentes de fotos**. Se mezclan todas; cada una se puede activar, desactivar, renombrar y tener su propio modo de visualización.

| Conector | Qué pide | Notas |
|---|---|---|
| **Immich** | Enlace compartido del álbum (`https://immich…/share/…`), o álbum privado `…/albums/<id>` con clave API | Immich 1.x, 2.x y 3.x. Si el proxy de Immich no permite CORS, la lista la lee el ayudante. Las fotos sin versión grande se saltan |
| **Google Fotos** | Enlace de un álbum compartido (`https://photos.app.goo.gl/…`) | Lo lee el ayudante desde la página pública del álbum (Google no ofrece una forma oficial: puede dejar de funcionar si la cambian) |
| **Carpeta de Home Assistant** | Carpeta dentro de *Medios → My media* (vacío = todo) | Solo lectura |
| **Fotos por URL** | Una dirección por línea | |

En **Ajustes → Fotos** del panel ves cuántas fotos ha cargado cada fuente o el error que ha dado. Los álbumes se refrescan cada hora.

- **Immich sin fotos grandes:** en Immich, *Administración → Trabajos → Generar miniaturas → Faltantes*.
- Las claves API de las fuentes no se envían a la web: si dejas el campo vacío, se conserva la guardada.

---

## Alarmas

En **Ajustes → Alarmas**:
- **Añadir alarma:** hora (flechas: horas de una en una, minutos de cinco en cinco), días (L M X J V S D o *Diario / L a V / Finde / Una vez*) y nombre.
- **Cuando suena:** se enciende la pantalla aunque esté apagada o en modo noche, hora en grande y melodía que sube de volumen (suena aunque los avisos estén en silencio). **Posponer 9 min** o **Parar**; para sola a los 10 minutos. Las de *una vez* se desactivan solas.
- **Próxima alarma** (del panel o de los sensores `…_next_alarm` de la app de Home Assistant del móvil, si los tienes activados) en Inicio y en el modo ambiente.

---

## Avisos desde Home Assistant

Tus automatizaciones pueden mostrar avisos en el panel, con **botones que ejecutan acciones** (p. ej. abrir la puerta del telefonillo). Tres niveles (info, aviso, crítico), sonido, historial en la campana y respuesta a Home Assistant con el botón pulsado.

Todo explicado, con ejemplos listos para copiar: **[AVISOS.md](AVISOS.md)**.

---

## Ajustes del panel

| Apartado | Opciones |
|---|---|
| **Pantalla** | Brillo, tiempo hasta el modo ambiente, apagado de pantalla, «Modo ambiente» y «Apagar ahora» |
| **Fotos del modo ambiente** | Mostrar fotos, cómo se ven, cada cuánto cambian, fotos por fuente, recargar álbumes |
| **Alarmas** | Crear, editar, activar y borrar |
| **Burbujas del modo ambiente** | Cuáles salen y en qué orden |
| **Altavoz por defecto** | El que se controla desde el modo ambiente |
| **Modo noche** | Horario, brillo nocturno, apagar de noche |
| **Avisos** | Sonido, volumen y aviso de prueba |
| **Red y configuración desde el móvil** | IP, WiFi y QR de la web de configuración |
| **Panel** | Estado de la conexión, método de control de pantalla, recargar |

---

## Cómo funciona por dentro

```
 Raspberry Pi
 ┌──────────────────────────────────────────────────────────────┐
 │ Chromium (kiosko, cage)                                      │
 │   index.html + app.js ──WebSocket──────────► Home Assistant  │
 │        │ boot.js lee la config al arrancar                   │
 │        ▼                                                     │
 │ panel-helper.py                                              │
 │   127.0.0.1:8766  (solo la Pi)   pantalla, red, Immich,      │
 │                                  Google Fotos, config        │
 │   0.0.0.0:8080    (tu red)       web de configuración ◄──────┼── móvil / PC
 │   ~/.config/panel-hogar/config.json   (config + Ajustes)     │
 └──────────────────────────────────────────────────────────────┘
```

- **Configuración:** la web la guarda en `~/.config/panel-hogar/config.json` (permisos solo para tu usuario). Al arrancar, `boot.js` la carga y manda sobre `config.js`. El panel pregunta al ayudante cada 5 s: si la configuración cambia, se recarga; si hay una orden del mando a distancia, la ejecuta.
- **Ajustes** (brillo, alarmas, burbujas…): se guardan en el ayudante. Sin ayudante, en el navegador.
- **Sin ayudante** (p. ej. abriendo `index.html` en otro sitio) el panel funciona igual con `config.js`, oscureciendo la imagen por software y sin web de configuración.

---

## config.js

Es la configuración inicial (o la única, si no usas el ayudante). Copia `config.example.js` como `config.js`. Lo normal es rellenar solo `haUrl` y `token`, o ni eso, y hacerlo todo desde la web.

| Opción | Para qué sirve |
|---|---|
| `haUrl`, `token` | Dirección de Home Assistant y token de larga duración |
| `favorites` | Entidades de Inicio, p. ej. `["light.salon", "climate.salon"]` (vacío = se eligen solas) |
| `hiddenEntities` | Entidades que no quieres ver nunca |
| `hideUnavailable` | Ocultar lo no disponible (por defecto, sí) |
| `excludePlatforms` | Integraciones técnicas que no salen (sus cámaras sí), p. ej. `["bambu_lab", "mobile_app"]` |
| `sensorClasses` | Tipos de sensor de la vista Sensores |
| `weatherEntity` | Entidad `weather.*` (si no, la primera) |
| `photoSources` | Fuentes de fotos (mejor desde la web). `ambientPhotos` + `immichApiKey` es el formato antiguo, que sigue funcionando |
| `idleSeconds`, `photoSeconds`, `night` | Valores iniciales; luego se cambian en Ajustes |
| `printerPlugs` | Enchufe de cada impresora si no se detecta solo: `{ "Bambu P1S": "switch.enchufe_bambu" }` |
| `scooterPlatform` | Integración del patinete (`mi_scooter_ble`) |
| `cameraRefreshSeconds` | Refresco de las cámaras en Multimedia |
| `hideCursor` | Ocultar el puntero en el kiosko |

---

## Seguridad

- **El token** da acceso a tu Home Assistant: solo está en la Pi (`config.js` y `~/.config/panel-hogar/config.json`), nunca se envía a la web de configuración ni se sube a git (`.gitignore`). No pongas `config.js` en `/config/www` de Home Assistant: lo que hay en `/local/` es público.
- **Usuario propio:** lo mejor es crear en Home Assistant un usuario solo para el panel y generar el token con él (si no salen las habitaciones, hazlo administrador).
- **Web de configuración:** contraseña guardada con PBKDF2, sesión por cookie (30 días), protección CSRF y espera tras cada contraseña incorrecta. Pensada para tu red de casa: **no la expongas a internet**.
- **El puerto 8766** solo escucha en la propia Pi. El lector de álbumes solo acepta rutas de álbumes de Immich y enlaces de Google Fotos.
- **Permisos en la Pi:** `sudo` sin contraseña solo para `nmcli` y `hostnamectl`; escritura en el brillo de la pantalla.
- **Home Assistant:** el panel no cambia su configuración; los Ajustes no se guardan allí.

---

## Solución de problemas

| Problema | Qué hacer |
|---|---|
| «Conecta el panel con Home Assistant» | Falta la dirección o el token: escanea el QR y ponlos en la web |
| No se conecta (punto rojo arriba) | Revisa la dirección y prueba la conexión en la web; un token borrado en HA deja de valer |
| No salen las fotos de Immich | Mira el error en Ajustes → Fotos. Si faltan miniaturas, genera las «Faltantes» en Immich. Si es CORS, en la Pi lo resuelve el ayudante |
| Google Fotos da error | El álbum tiene que estar compartido con enlace. Si Google cambia su página, este conector puede fallar |
| La web `…local:8080` no abre | Usa la IP (la ves en Ajustes → Red o en el QR). Algunos Android no resuelven `.local` |
| No suena nada | La Pi necesita altavoz; comprueba el volumen en Ajustes → Avisos |
| El brillo no cambia de verdad | Tu pantalla no deja controlar la retroiluminación: el panel oscurece la imagen (Ajustes → Panel lo indica) |

---

## Archivos

```
index.html          estructura de la página
styles.css          diseño (ligero, para que vaya fluido en la Pi 2)
app.js              conexión con HA, vistas, controles, modo ambiente, alarmas, avisos y fotos
boot.js             carga en el panel la configuración guardada desde la web
config.example.js   plantilla de config.js
config.html         web de configuración (la sirve panel-helper.py en el puerto 8080)
panel-helper.py     ayudante: pantalla, red, Immich, Google Fotos y web de configuración
dev.py              arranca todo en el ordenador para probarlo (pantalla y red simuladas)
setup-kiosk.sh      instalación del kiosko en la Pi
AVISOS.md           avisos desde Home Assistant, con ejemplos
lib/qrcode.js       generador de códigos QR (qrcode-generator, de Kazuhiko Arase, licencia MIT)
```
