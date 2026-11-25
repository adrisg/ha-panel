# Ideas

List of things to do. 🚧 = in progress · ✅ = done.

## On the screen

1. **Calendar**: bubble with what is next ("Dentist at 17:00") and a card with the week (Home Assistant `calendar.*`).
2. **Kitchen timers**: create them with two taps, see them in ambient mode and have them ring when they end.
3. ✅ **Shopping list** (`todo.*`): the **To-do list** component shows a list in a tab and a tap ticks items off.
4. **Energy**: card with the home's consumption, a graph of the day and solar production if there is any.
5. **Video intercom**: the camera full screen when someone rings, with "Open the door" on top.

## A panel that adapts by itself

6. **Wake up when someone comes close**: turn the screen on with a Home Assistant motion sensor or an mmWave radar on the Pi.
7. **Automatic brightness**: I²C light sensor (BH1750); `screen.light` is already prepared.
8. **Screen by the time of day**: weather and calendar in the morning; a dim red clock at night.

## Home Assistant integration

9. ✅ **The panel as a device in Home Assistant**, over MQTT (automatic discovery): screen and brightness, volumes, ambient mode, last touch and reload.
10. **PIN for sensitive actions**: ask for a code to open the door or disarm the alarm.

## So more people use it

11. ✅ **International**: English and Spanish (`translations/` folder, in JSON; another language = another file).
12. ✅ **Everything in English by default**: code, comments, file names and base texts; Spanish comes from `translations/es.json`.
13. ✅ **Settings backup**: download and upload them from the web.
14. **Ready-to-flash image**: Raspberry Pi OS with everything installed.
