# Ideas

Lista de cosas por hacer. 🚧 = en marcha · ✅ = hecho.

## En la pantalla

1. **Calendario**: burbuja con lo próximo («Dentista a las 17:00») y tarjeta con la semana (`calendar.*` de Home Assistant).
2. **Temporizadores de cocina**: crearlos con dos toques, verlos en el modo ambiente y que suenen al acabar.
3. **Lista de la compra** (`todo.*`): cuarta ventana del panel de acceso rápido para ver, tachar y añadir.
4. **Energía**: tarjeta con el consumo de la casa, gráfica del día y producción solar si la hay.
5. **Telefonillo con vídeo**: la cámara a pantalla completa al llamar, con «Abrir puerta» encima.

## Que el panel se adapte solo

6. **Despertar al acercarse**: encender la pantalla con un sensor de movimiento de Home Assistant o un radar mmWave en la Pi.
7. **Brillo automático**: sensor de luz por I²C (BH1750); `screen.light` ya está preparado.
8. **Pantalla según la hora**: por la mañana tiempo y calendario; por la noche un reloj tenue en rojo.

## Integración con Home Assistant

9. ✅ **El panel como dispositivo en Home Assistant** (integración `panel_hogar`; falta probarla en un Home Assistant de verdad): entidades propias (pantalla, brillo, modo ambiente, volumen…) para usarlas en automatizaciones.
10. **PIN para acciones delicadas**: pedir un código para abrir la puerta o desarmar la alarma.

## Para que lo use más gente

11. 🚧 **Internacional**: la interfaz en varios idiomas (empezando por inglés y español).
12. **Copia de seguridad de los ajustes**: descargarlos y subirlos desde la web.
13. **Imagen lista para grabar**: Raspberry Pi OS con todo instalado.
