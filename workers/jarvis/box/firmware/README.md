# La caja de Jarvis — compilar y flashear

Waveshare ESP32-S3-Touch-LCD-1.85C-BOX, **revision V2** (dice V2 en la etiqueta
de abajo). El firmware es [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)
(MIT), que hace de driver: microfono, parlante, pantalla, cara y wake word.
El cerebro NO esta aca — vive en `Projects/Midas/workers/jarvis/box/server.js`.

## Que hay en esta carpeta

| | |
|---|---|
| `xiaozhi-esp32/` | El firmware, clonado sin historial (`--depth 1`) |
| `esp-idf/` | El toolchain de Espressif, rama v5.5 |
| `jarvis.defaults` | Nuestra configuracion. Es lo unico propio |

## Antes de flashear: reservar la IP

La direccion del servidor **se graba adentro de la caja**. Hoy la notebook es
`192.168.110.11`, pero esa IP se la presta el router por DHCP.

**Reservarla en el Ruijie por MAC antes de compilar.** Si el router se la da a
otro equipo, la caja queda hablandole a una direccion que ya no es de nadie y
la unica forma de arreglarlo es volver a flashear.

Si cambia la IP igual, se edita `CONFIG_OTA_URL` en `jarvis.defaults` y se
vuelve a flashear.

## Compilar

Desde PowerShell, una vez por consola:

```powershell
. C:\Users\slider\Documents\Claude\esp\esp-idf\export.ps1
cd C:\Users\slider\Documents\Claude\esp\xiaozhi-esp32
idf.py set-target esp32s3
idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;../jarvis.defaults" build
```

La primera compilacion tarda bastante: baja los componentes gestionados
(esp-sr con el modelo de wake word, LVGL) y compila todo de cero.

## Flashear

La caja se conecta por USB-C. Si no aparece ningun puerto COM:

1. **El cable.** Es la causa mas comun: muchos cables USB-C son solo de carga y
   no llevan datos. Probar con otro.
2. **Modo descarga.** Mantener apretado un boton lateral, pulsar y soltar el
   otro, soltar el primero. No esta documentado cual es BOOT y cual RESET; si
   no entra, probar al reves. No hay riesgo de romper nada.

```powershell
idf.py -p COM<N> flash monitor
```

`monitor` deja la consola de la caja a la vista. Se sale con `Ctrl+]`.

## Que tiene que pasar cuando arranca

1. La caja pide su configuracion a `http://192.168.110.11:8098/xiaozhi/ota/`
2. El servidor le contesta la hora (por eso el reloj de fabrica esta en 1970) y
   a que websocket ir
3. Se conecta al websocket y manda `hello`
4. El servidor contesta `hello` y dice "Good morning, sir."
5. Decis "Jarvis" y la caja se despierta

Si algo de eso no pasa, `box/simulador.js` repite el mismo handshake desde la
notebook: si el simulador anda y la caja no, el problema es de la caja o de la
red, no del servidor.

## Configuracion elegida y por que

Todo en `jarvis.defaults`, con el motivo de cada linea. Los cuatro que importan:

- **`VERSION_2_0`** — la config de V1 usa otros pines de audio y no tiene el
  codec ES8311. Flashear la equivocada deja el microfono o el parlante mudos
  **sin dar ningun error**.
- **`LANGUAGE_ES_ES`** — el firmware viene en chino.
- **`SR_WN_WN9_JARVIS_TTS`** — el wake word "Jarvis" existe pre-entrenado y es
  gratis. Entrenar uno propio pide +500 personas grabando 15 veces cada una, y
  es servicio pago. Se apaga el chino explicitamente.
- **`OTA_URL`** — nuestro servidor. Es lo unico que hay que tener bien de
  entrada; lo demas se cambia sin reflashear.
