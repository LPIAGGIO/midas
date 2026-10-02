#!/usr/bin/env bash
# Enciende con ORDENES REALES los scalps de la segunda cuenta de Cocos (3893).
# Lo corre LP. Sin argumentos enciende los nueve; con argumentos, solo esos
# papeles (ej: encender-scalps.sh mu nvda).
set -u
PAPELES="${*:-mu sndk nvda googl amd intc meta aapl msft}"
for p in $PAPELES; do
  D="$HOME/workers/cocos2-scalp-$p"
  [ -d "$D" ] || { echo "no existe $D"; continue; }
  cd "$D"
  grep -q '^SCALP_REAL=1' .env || echo SCALP_REAL=1 >> .env
  pm2 start ecosystem.config.js >/dev/null && echo "encendido: $p"
done
pm2 save >/dev/null
