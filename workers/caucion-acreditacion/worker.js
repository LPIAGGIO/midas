/**
 * Worker: liquidación automática de cauciones vencidas (ambos lados).
 *
 * Para cada caución cuyo plazo ya venció:
 *   - COLOCADORA (capital > 0): genera cash_movement DEPOSIT por
 *     capital × (1 + TNA × term_days / 365)  → te devuelven la plata.
 *   - TOMADORA (capital < 0): genera cash_movement WITHDRAWAL por
 *     |capital| × (1 + TNA × term_days / 365) → te debitan el término.
 *
 * Después del movimiento, BORRA la posición. Razón: el frontend valúa
 * toda caución viva (caucionValueDevengado) sin conocer ningún flag de
 * "ya procesada" — si la posición quedara, su valor se contaría DOS
 * veces (posición + cash). Borrarla espeja a Cocos: la caución vencida
 * desaparece de la tenencia y queda como movimiento monetario. El
 * rastro persiste en el cash_movement (visible en el Libro), cuya nota
 * incluye el id de la posición original.
 *
 * NOTA gastos broker: el monto es capital + interés TEÓRICO. El boleto
 * real suma comisiones/derechos/IVA (ej. ~1.500 sobre 13,7M en Cocos).
 * Si querés el match al peso, editá el movimiento con el neto del
 * boleto. La nota lo recuerda.
 *
 * Idempotencia: antes de insertar se busca un cash_movement existente
 * cuya nota contenga el tag [<position_id>]. Si existe, no se duplica
 * (cubre el caso "movimiento creado pero delete falló" de una corrida
 * anterior: se reintenta solo el delete).
 *
 * Logs estructurados para que PM2 los capture.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  }
);

function logInfo(msg, extra) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [INFO] ${msg}`, extra ? JSON.stringify(extra) : '');
}

function logError(msg, err) {
  const stamp = new Date().toISOString();
  console.error(`[${stamp}] [ERROR] ${msg}`, err ? JSON.stringify(err, null, 2) : '');
}

/**
 * Monto total al vencimiento, SIEMPRE positivo (el signo lo pone el
 * movement_type). Devuelve null si falta data para calcularlo.
 */
function caucionMontoAlVencer(p) {
  const capital = Math.abs(Number(p.quantity));
  const tna = Number(p.extra?.rate_tna);
  const termDays = Number(p.extra?.term_days);
  if (!Number.isFinite(capital) || capital === 0 || !Number.isFinite(tna) || !Number.isFinite(termDays)) {
    return null;
  }
  // TOMADORA: el debito real de Cocos no es la tasa pura — lleva 3% TNA de
  // comision + 0,365% TNA de derechos BYMA, todo +21% IVA = +4,0717 puntos
  // sobre la tasa (validado contra boleto real, ver memoria midas-cocos-costos;
  // en una caucion de 62,7M a 1 dia son ~$7.000 de gastos sobre ~$29.200 de
  // interes: no es despreciable y LP lo pidio explicito el 02/09/2026).
  // COLOCADORA: se mantiene tasa pura (los gastos del colocador son otros y
  // no estan medidos; el libro los trae exactos al dia siguiente).
  const side = caucionSide(p);
  const tnaEfectiva = side === 'tomadora' ? tna + (3 + 0.365) * 1.21 : tna;
  return capital * (1 + (tnaEfectiva / 100) * (termDays / 365));
}

/**
 * Lado de la caución. Manda extra.caucion_side si está (lo setea el
 * importador de Matriz); si no, el signo del capital: negativo = tomadora.
 */
function caucionSide(p) {
  const side = (p.extra?.caucion_side || '').toLowerCase();
  if (side === 'tomadora' || side === 'colocadora') return side;
  return Number(p.quantity) < 0 ? 'tomadora' : 'colocadora';
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  logInfo('Iniciando worker de liquidación de cauciones');

  const todayIso = new Date().toISOString().slice(0, 10);
  logInfo('Fecha de hoy', { todayIso });

  const { data: cauciones, error: e1 } = await supabase
    .from('positions')
    .select('id, ticker, quantity, entry_currency, entry_date, extra, user_id')
    .eq('instrument_type', 'caucion');

  if (e1) {
    logError('Error leyendo cauciones', e1);
    process.exit(1);
  }

  logInfo(`Cauciones encontradas: ${cauciones.length}`);

  let processedCount = 0;
  let skippedNotMatured = 0;
  let errorCount = 0;

  for (const c of cauciones) {
    if (!c.entry_date || !c.extra?.term_days) {
      logInfo(`Caución ${c.id} sin entry_date o term_days, skip`);
      continue;
    }

    const maturityDate = addDays(c.entry_date, Number(c.extra.term_days));
    if (maturityDate > todayIso) {
      skippedNotMatured++;
      continue;
    }

    const monto = caucionMontoAlVencer(c);
    if (monto == null || !Number.isFinite(monto) || monto <= 0) {
      logError(`No se pudo calcular monto al vencer para caución ${c.id}`, c);
      errorCount++;
      continue;
    }

    const side = caucionSide(c);
    const movementType = side === 'tomadora' ? 'withdrawal' : 'deposit';
    const idTag = `[${c.id}]`;

    logInfo(`Procesando caución vencida ${c.ticker || c.id}`, {
      id: c.id,
      side,
      entry_date: c.entry_date,
      term_days: c.extra.term_days,
      maturity: maturityDate,
      currency: c.entry_currency,
      capital: c.quantity,
      tna: c.extra.rate_tna,
      monto_total: monto.toFixed(2),
      movement_type: movementType,
    });

    // Idempotencia: ¿ya existe el movimiento de una corrida anterior?
    const { data: existing, error: eq } = await supabase
      .from('cash_movements')
      .select('id')
      .eq('user_id', c.user_id)
      .ilike('notes', `%${idTag}%`)
      .limit(1);

    if (eq) {
      logError(`Error chequeando movimiento existente para caución ${c.id}`, eq);
      errorCount++;
      continue;
    }

    if (!existing || existing.length === 0) {
      // Insertar cash_movement. related_position_id queda NULL por el
      // constraint cash_movements_related_position_logic (y porque
      // vamos a borrar la posición — un FK CASCADE borraría el cash).
      const { error: e2 } = await supabase
        .from('cash_movements')
        .insert({
          movement_type: movementType,
          movement_date: maturityDate,
          amount: monto,
          currency: c.entry_currency || 'ARS',
          notes:
            `Caución ${side} ${c.ticker || ''} término (vto ${maturityDate}) ${idTag} ` +
            `— capital+interés teórico, ajustar al boleto si difiere`,
          related_position_id: null,
          user_id: c.user_id,
        });

      if (e2) {
        logError(`Error insertando cash_movement para caución ${c.id}`, e2);
        errorCount++;
        continue;
      }
    } else {
      logInfo(`Movimiento ya existía para caución ${c.id} (corrida anterior), solo falta el delete`);
    }

    // Borrar la posición: la caución deja la tenencia y vive en la caja.
    const { error: e3 } = await supabase
      .from('positions')
      .delete()
      .eq('id', c.id);

    if (e3) {
      logError(`Error borrando posición de caución ${c.id} (cash_movement YA creado — la próxima corrida reintenta solo el delete)`, e3);
      errorCount++;
      continue;
    }

    processedCount++;
    logInfo(`Caución ${c.ticker || c.id} liquidada (${side} → ${movementType})`, {
      amount: monto.toFixed(2),
    });
  }

  logInfo('Worker finalizado', {
    total_cauciones: cauciones.length,
    procesadas: processedCount,
    no_vencidas_skip: skippedNotMatured,
    errores: errorCount,
  });

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  logError('Error inesperado en main()', { message: err.message, stack: err.stack });
  process.exit(1);
});
