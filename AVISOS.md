# Avisos en el panel desde Home Assistant

Cualquier automatización de Home Assistant puede mostrar un aviso en el panel lanzando el evento `panel_notificacion`. El aviso puede llevar **botones que ejecutan acciones** de Home Assistant, por ejemplo abrir la puerta del telefonillo.

## Cómo se ve cada nivel

| `nivel` | En el panel | Sonido | Se cierra solo |
|---|---|---|---|
| `info` | Banner arriba; no interrumpe | Un pitido corto | A los 10 s |
| `aviso` | Ventana en el centro. Saca el panel del modo ambiente y quita el modo noche | "Ding-dong" cada 6 s durante 30 s | A los 120 s |
| `critico` | Pantalla en rojo parpadeando | Pitido continuo hasta cerrarlo | No: hay que tocarlo |

Mientras hay un aviso abierto, el panel no pasa al modo ambiente y la pantalla no se oscurece. Los últimos 30 avisos quedan en la **campana** de la barra superior.

## Datos del evento

```yaml
- event: panel_notificacion
  event_data:
    id: telefonillo            # opcional. Si llega otro con el mismo id, sustituye al anterior
    titulo: Llaman al telefonillo
    mensaje: Entrada principal  # opcional
    nivel: aviso               # info | aviso | critico
    icono: mdi:doorbell        # cualquier icono mdi:
    imagen: camera.entrada     # opcional: una cámara (se refresca cada 2 s), una entidad image.* o una URL
    duracion: 60               # opcional: segundos hasta cerrarse solo (0 = hasta que lo toques)
    sonido: true               # opcional
    acciones:                  # opcional: botones (si no pones ninguno sale "Entendido")
      - texto: Abrir puerta
        icono: mdi:door-open
        servicio: button.press              # cualquier acción de HA: dominio.servicio
        entidad: button.entrada_principal_abrir_puerta
        datos: {}                           # opcional: datos del servicio
        confirmar: false                    # true = pide un segundo toque
        estilo: primario                    # primario | peligro (el primero es primario por defecto)
      - texto: Ignorar                      # sin servicio: solo cierra el aviso
```

- **Cerrar un aviso desde Home Assistant:** `event: panel_notificacion_cerrar` con `event_data: { id: telefonillo }`.
- **Saber qué botón se pulsó:** el panel lanza `panel_notificacion_accion` con `{ id, accion }`. Puedes usarlo como disparador o con `wait_for_trigger` en tus automatizaciones.

## Telefonillo Ring: abrir la puerta desde el panel

Pega esto en **Ajustes → Automatizaciones → Crear → ⋮ → Editar en YAML**:

```yaml
alias: "Panel: llaman al telefonillo"
description: Aviso en el panel con botón para abrir la puerta del portal
triggers:
  - trigger: state
    entity_id: event.entrada_principal_timbre
    not_from: unavailable
actions:
  - event: panel_notificacion
    event_data:
      id: telefonillo
      titulo: Llaman al telefonillo
      mensaje: Entrada principal
      nivel: aviso
      icono: mdi:doorbell
      duracion: 60
      acciones:
        - texto: Abrir puerta
          icono: mdi:door-open
          servicio: button.press
          entidad: button.entrada_principal_abrir_puerta
        - texto: Ignorar
          icono: mdi:close
mode: single
```

Para que el aviso desaparezca si abres desde la app de Ring o desde el propio telefonillo:

```yaml
alias: "Panel: cerrar aviso del telefonillo"
triggers:
  - trigger: state
    entity_id: event.entrada_principal_desbloqueo_del_intercomunicador
    not_from: unavailable
actions:
  - event: panel_notificacion_cerrar
    event_data:
      id: telefonillo
mode: single
```

## Más ideas

**Patinete cargado** (aviso informativo):

```yaml
triggers:
  - trigger: state
    entity_id: binary_sensor.mi_patinete_cargado
    to: "on"
actions:
  - event: panel_notificacion
    event_data:
      titulo: Patinete cargado
      mensaje: "{{ states('sensor.mi_patinete_bateria') }} % de batería"
      nivel: info
      icono: mdi:scooter
```

**Puerta abierta más de 10 minutos**, con un botón que te avisa al móvil si no estás en casa:

```yaml
triggers:
  - trigger: state
    entity_id: binary_sensor.ikea_door_sensor_kitchen_contact
    to: "on"
    for: "00:10:00"
actions:
  - event: panel_notificacion
    event_data:
      id: puerta_cocina
      titulo: La puerta de la cocina lleva 10 min abierta
      nivel: aviso
      icono: mdi:door-open
      acciones:
        - texto: Avisar al móvil
          icono: mdi:cellphone-message
          servicio: notify.mobile_app_mi_movil
          datos:
            message: La puerta de la cocina sigue abierta
        - texto: Vale
```

**Algo grave** (crítico: pantalla en rojo y pitido hasta que lo cierres):

```yaml
actions:
  - event: panel_notificacion
    event_data:
      titulo: ¡Fuga de agua!
      mensaje: Sensor bajo el fregadero
      nivel: critico
      icono: mdi:water-alert
```

## Notas

- En la Pi el sonido suena sin tocar antes la pantalla, gracias a una opción que pone `setup-kiosk.sh` en Chromium. La Pi necesita un altavoz, ya sea por el jack o por HDMI si tu pantalla tiene.
- Los botones ejecutan lo que diga la automatización con el token del panel. Pon solo acciones que te parezca bien que cualquiera delante de la pantalla pueda pulsar. Para las delicadas usa `confirmar: true`.
