#!/usr/bin/env bash
# deploy-6pos.sh — aplica la config de 6 posiciones al bot real niveles-auto.
#
# Aprobado por LP el 23/09/2026 ("prefiero que sean mas ordenes pero mismo
# monto. osea seguimos manejando 1.4MM"). Correr SOLO con el mercado cerrado
# (despues de las 17:00 ART): el reinicio deja un minuto sin vigilancia de stops.
#
# Que hace: 3 variables del .env del VPS + pm2 restart + verificacion. El
# worker.js con los topes leyendo del env YA esta subido (24/09, md5
# 7cc6efc75a23c841418b5fd2bb689a93; backup worker.js.bak-24sep). El codigo es
# identico al anterior salvo esas dos lineas, por eso subirlo antes fue inocuo.
#
# Capital 9.000.000 x 15,56% = $1.400.400 por posicion x 6 = $8.402.400;
# colchon $597.600. IOL_BOT_MAX_DIA no se toca (queda 5).
set -u
VPS="midas@149.50.148.172"
SSH="ssh -p 5008 -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=20 $VPS"

hora=$(TZ=America/Argentina/Buenos_Aires date +%H%M)
echo "hora ART: ${hora:0:2}:${hora:2:2}"
if [ "$hora" -lt 1705 ] && [ "${FORZAR:-0}" != "1" ]; then
  echo "FALLO: mercado abierto (cierra 17:00). No se reinicia el bot. FORZAR=1 para saltear."
  exit 1
fi

echo "== 1. estado previo =="
$SSH 'cd ~/workers/niveles-auto && md5sum worker.js | cut -c1-32 && grep -E "^IOL_BOT_(CAP_REAL|MAX_POS|MAX_POS_PCT)=" .env' || { echo "FALLO: no llego al VPS"; exit 1; }

echo "== 2. .env =="
$SSH 'cd ~/workers/niveles-auto && cp .env .env.bak-24sep-pre && \
  sed -i "s/^IOL_BOT_CAP_REAL=.*/IOL_BOT_CAP_REAL=9000000/" .env && \
  grep -q "^IOL_BOT_MAX_POS=" .env || printf "IOL_BOT_MAX_POS=6\n" >> .env; \
  grep -q "^IOL_BOT_MAX_POS_PCT=" .env || printf "IOL_BOT_MAX_POS_PCT=0.1556\n" >> .env; \
  sed -i "s/^IOL_BOT_MAX_POS=.*/IOL_BOT_MAX_POS=6/; s/^IOL_BOT_MAX_POS_PCT=.*/IOL_BOT_MAX_POS_PCT=0.1556/" .env && \
  echo "--- queda:" && grep -E "^IOL_BOT_(CAP_REAL|MAX_POS|MAX_POS_PCT|MAX_DIA)=" .env' || { echo "FALLO editando .env"; exit 1; }

echo "== 3. restart =="
$SSH 'pm2 restart niveles-auto --update-env >/dev/null && echo "reiniciado"' || { echo "FALLO en pm2 restart"; exit 1; }
sleep 90

echo "== 4. verificacion =="
salida=$($SSH 'pm2 jlist | node -e "const a=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const p=a.find(p=>p.name===\"niveles-auto\");console.log(\"pm2:\",p.pm2_env.status,\"restarts\",p.pm2_env.restart_time)"; \
  f=$(ls -t ~/.pm2/logs/niveles-auto-out-*.log | head -1); grep -E "MODO REAL ACTIVO" "$f" | tail -1 | sed -E "s/papeles [A-Z0-9, ]+ · /papeles (lista) · /"')
# (la lista de papeles se colapsa: el 24/09 un cut -c1-400 dejaba "max 6
#  posiciones" afuera de la linea y la verificacion fallaba en falso)
echo "$salida"
if echo "$salida" | grep -q "pm2: online" && echo "$salida" | grep -q 'capital REAL \$9\.000\.000' && echo "$salida" | grep -q "max 6 posiciones"; then
  echo "OK: bot online con capital \$9.000.000 y 6 posiciones. Las pendientes se recolocan solas a las 10:29."
  exit 0
fi

echo "FALLO en la verificacion: restauro el .env anterior y reinicio"
$SSH 'cd ~/workers/niveles-auto && cp .env.bak-24sep-pre .env && pm2 restart niveles-auto --update-env >/dev/null && sleep 20 && pm2 jlist | node -e "const a=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const p=a.find(p=>p.name===\"niveles-auto\");console.log(\"restaurado, pm2:\",p.pm2_env.status)"'
exit 1
