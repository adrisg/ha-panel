// Copy this file as config.js and fill in your data.
// On the Raspberry Pi the normal thing is to set everything up from the web (http://<pi>.local:8080): what you put there
// wins over this file. With no address or no token, the panel shows how to connect it (with a QR).
window.PANEL_CONFIG = {
  // Your Home Assistant address (no slash at the end)
  haUrl: "http://homeassistant.local:8123",

  // Long-lived token: in HA → your profile → Security → "Long-lived access tokens"
  token: "PEGA_AQUI_TU_TOKEN",

  // Initial values: then they are changed from the panel Settings or the web (saved on the Pi, never in HA).
  // Seconds without touching the screen before going to ambient mode (clock/photos). 0 = never.
  idleSeconds: 90,

  // Entities shown on "Home". Empty = chosen by themselves (scenes, lights, climate).
  favorites: [
    // "light.salon", "scene.cine", "climate.salon",
  ],

  // Entities you never want to see on the panel
  hiddenEntities: [],

  // Hides whatever is "Unavailable" or has no data
  hideUnavailable: true,

  // Technical integrations you do not want on the panel (their cameras do show).
  // The name is the integration's, e.g. "bambu_lab", "moonraker", "mobile_app"
  excludePlatforms: [],

  // Sensor kinds shown in "Sensors" (favourites always show).
  // Remove or add: temperature, humidity, power, energy, battery, door, window, motion…
  // sensorClasses: ["temperature", "humidity", "power", "door", "window", "motion"],

  // Weather entity. Empty = the first weather.* it finds
  weatherEntity: "",

  // Ambient mode photos: better from the configuration web → Photo sources
  // (Immich, Google Photos, Home Assistant Media folder or URLs). Format:
  // photoSources: [
  //   { id: "s1", type: "immich", url: "https://immich.casa/share/XXXX", enabled: true },
  //   { id: "s2", type: "google", url: "https://photos.app.goo.gl/XXXX", enabled: true, fit: "blur" },
  //   { id: "s3", type: "ha_media", folder: "fotos", enabled: true },
  //   { id: "s4", type: "urls", urls: ["http://homeassistant.local:8123/local/fotos/1.jpg"], enabled: true },
  // ],
  // Old format (still works): ambientPhotos with Immich links or URLs, and immichApiKey.
  ambientPhotos: [],
  photoSeconds: 30,

  // Night mode: darkens the screen between these times (dim = 0 no effect, 0.9 almost black)
  night: { start: "23:00", end: "07:00", dim: 0.6 },

  // Camera refresh in the Media view (seconds)
  cameraRefreshSeconds: 10,

  // Scooter integration (custom_components/mi_scooter_ble)
  scooterPlatform: "mi_scooter_ble",

  // Plug of each 3D printer. It is detected by itself if the switch ends like the name
  // of the printer (e.g. switch.ikea_plug_bambu_p1s). Otherwise, put it here by hand:
  // printerPlugs: { "Bambu P1S": "switch.enchufe_bambu_p1s" },

  // Hides the mouse pointer on the Pi (only in the kiosk; on the PC over http:// it still shows)
  hideCursor: true,
};
