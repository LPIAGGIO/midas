# fci-sweep — barrido overnight del cash de IOL a un FCI money market

**PLATA REAL. No desplegar sin leer el plan de rollout.**

Dos patas sobre el mismo `worker.js`:

- `barrer` (tarde): cancela las órdenes pendientes del bot niveles-auto
  (libera su escrow), espera verlo en el disponible y suscribe
  `disponible − colchón` a `PRCPPEB`.
- `rescatar` (mañana): rescata todas las cuotapartes y **mide** a qué hora
  IOL acredita el rescate.

La DB no se toca nunca: el bot reconcilia solo sus órdenes canceladas y las
re-apoya al día siguiente.

## PM2

```bash
pm2 start worker.js --name fci-sweep-tarde   --cron-restart "50 16 * * 1-5" --no-autorestart -- barrer
pm2 start worker.js --name fci-sweep-maniana --cron-restart "30 9 * * 1-5"  --no-autorestart -- rescatar
pm2 save
```

El cron de PM2 usa la hora del VPS (que está en ART). Igual el worker tiene
ventana horaria propia (`barrer` 16:45–17:30, `rescatar` 09:00–11:00): un
reboot fuera de hora no opera. Corrida manual fuera de ventana: `--force`.

Dry-run (no cancela nada, corre solo el `soloValidar` de la suscripción;
en rescate valida y no manda):

```bash
node worker.js barrer --dry-run
node worker.js rescatar --dry-run
```

## Env (mismo `.env` compartido del VPS)

| Variable | Default | Qué es |
|---|---|---|
| `FCI_SWEEP_FONDO` | `PRCPPEB` | Símbolo del FCI (Premier Renta Corto Plazo ARS, el money market de IOL) |
| `FCI_SWEEP_BUFFER_ARS` | `200000` | Colchón que nunca se barre (débitos nocturnos: derechos, ajustes, comisiones) |
| `FCI_SWEEP_MAX_ARS` | *(sin tope)* | Tope duro del monto a suscribir — **obligatorio durante el rollout** |
| `FCI_SWEEP_SKIP_DOM` | `14` | Días del mes (coma-separados) en que NO se barre: víspera de la rotación momentum del 15 |
| `FCI_SWEEP_DRY` | — | `1` = dry-run sin flag |

Además usa los compartidos: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`TELEGRAM_BOT_TOKEN`, `IOL_BOT_USER`.

Mínimo hardcodeado: si `disponible − colchón < $100.000` no se barre
(el overnight de menos que eso no paga el riesgo operativo de dos patas).

## Rollout

1. **Dry-run de las dos patas** un día hábil cualquiera: confirma que el
   `soloValidar` de suscripción y rescate pasan (shape de la respuesta,
   DDJJ, cutoff) sin mover un peso.
2. **Primera semana con `FCI_SWEEP_MAX_ARS=200000`**: barrido chico real.
   El objetivo no es el rendimiento, es **medir la hora de acreditación
   del rescate** (la pata `rescatar` la loguea y la manda por Telegram).
3. Si el rescate acredita consistentemente **antes de las 10:30**, subir o
   quitar el cap. Si acredita más tarde, el ciclo entero se replantea (el
   bot niveles-auto fallaría por saldo todas las mañanas; se reintenta solo
   cada 15 min, pero perdería los primeros niveles del día).

## Lo que NO sabemos todavía (por eso el cap)

- **Hora de acreditación del rescate**: pedido 09:30, no está medido cuándo
  el disponible lo refleja. Es EL dato que decide la viabilidad; la pata
  `rescatar` existe en parte para medirlo.
- **Cutoff de suscripción del fondo**: no está medido hasta qué hora IOL
  acepta suscribir PRCPPEB con valor de cuotaparte del día. Si 16:50 está
  después del cutoff, el `soloValidar` debería rechazar — el dry-run lo
  muestra sin costo.
- **Shape de la respuesta de `/operar/suscripcion|rescate/fci`**: a
  diferencia de Comprar/Vender no lo tenemos medido; el worker loguea el
  JSON crudo en cada llamada para fijar el contrato en la primera corrida.

## Convivencia

- **Víspera de momentum** (`FCI_SWEEP_SKIP_DOM`, default 14): no se barre ni
  se cancela nada — la rotación del 15 calcula la reserva del bot con las
  pendientes vivas y necesita la caja tal cual quedó.
- Las órdenes **ejecutadas** del bot jamás se tocan; solo se cancelan las
  que IOL reporta en estado pendiente/proceso/iniciada.
