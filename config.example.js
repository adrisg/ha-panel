// Copia este archivo como config.js y rellena tus datos.
// Sin config.js (o sin token) el panel arranca en MODO DEMO con datos falsos.
window.PANEL_CONFIG = {
  // Dirección de tu Home Assistant (sin barra al final)
  haUrl: "http://homeassistant.local:8123",

  // Token de larga duración: en HA → tu perfil → Seguridad → "Tokens de acceso de larga duración"
  token: "PEGA_AQUI_TU_TOKEN",

  // Segundos sin tocar la pantalla antes de pasar al modo ambiente (reloj/fotos). 0 = nunca.
  idleSeconds: 90,

  // Entidades que aparecen en "Inicio". Vacío = se eligen solas (escenas, luces, clima).
  favorites: [
    // "light.salon", "scene.cine", "climate.salon",
  ],

  // Entidades que no quieres ver nunca en el panel
  hiddenEntities: [],

  // Oculta lo que esté "No disponible" o sin datos
  hideUnavailable: true,

  // Integraciones técnicas que no quieres en el panel (sus cámaras sí se muestran).
  // El nombre es el de la integración, p. ej. "bambu_lab", "moonraker", "mobile_app"
  excludePlatforms: [],

  // Tipos de sensor que salen en "Sensores" (los favoritos salen siempre).
  // Quita o añade: temperature, humidity, power, energy, battery, door, window, motion…
  // sensorClasses: ["temperature", "humidity", "power", "door", "window", "motion"],

  // Entidad de tiempo. Vacío = la primera weather.* que encuentre
  weatherEntity: "",

  // Fotos para el modo ambiente (como un marco digital). Puedes ponerlas en
  // /config/www/fotos de HA y usar "http://homeassistant.local:8123/local/fotos/1.jpg"
  ambientPhotos: [],
  photoSeconds: 30,

  // Modo noche: oscurece la pantalla entre estas horas (dim = 0 sin efecto, 0.9 casi negro)
  night: { start: "23:00", end: "07:00", dim: 0.6 },

  // Refresco de las cámaras en la vista Multimedia (segundos)
  cameraRefreshSeconds: 10,

  // Integración del patinete (custom_components/mi_scooter_ble)
  scooterPlatform: "mi_scooter_ble",

  // Enchufe de cada impresora 3D. Se detecta solo si el switch acaba igual que el nombre
  // de la impresora (p. ej. switch.ikea_plug_bambu_p1s). Si no, ponlo aquí a mano:
  // printerPlugs: { "Bambu P1S": "switch.enchufe_bambu_p1s" },

  // Oculta el puntero del ratón en la Pi (solo en el kiosko; en el PC por http:// se sigue viendo)
  hideCursor: true,
};
