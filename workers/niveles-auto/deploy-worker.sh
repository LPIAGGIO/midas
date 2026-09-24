#!/usr/bin/env bash
# deploy-worker.sh — sube worker-deploy.js al VPS como worker.js, reinicia
# niveles-auto y verifica el arranque. SOLO con el mercado cerrado (>= 17:05
# ART): el reinicio deja un minuto sin vigilancia de stops.
#
# La hora se toma con TZ POSIX ('ART3'): Git Bash NO resuelve nombres Olson y
# TZ=America/Argentina/Buenos_Aires devuelve GMT sin avisar (24/09/2026: tres
# reinicios en plena rueda por eso). Ademas se cruza contra la hora del VPS.
set -u
VPS="midas@149.50.148.172"
SSH="ssh -p 5008 -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=20 $VPS"
SCP="scp -q -P 5008 -i $HOME/.ssh/id_ed25519"
DIR="$(cd "$(dirname "$0")" && pwd)"
ART="$DIR/worker-deploy.js"
TAG="$(date +%d%b | tr 'A-Z' 'a-z')"

hl=$(TZ='ART3' date +%H%M)
hv=$($SSH 'TZ=America/Argentina/Buenos_Aires date +%H%M') || { echo "FALLO: no llego al VPS"; exit 1; }
echo "hora ART local $hl · VPS $hv"
if [ "$hl" != "$hv" ] && [ $(( ${hl#0} - ${hv#0} )) -gt 2 -o $(( ${hv#0} - ${hl#0} )) -gt 2 ]; then
  echo "FALLO: las dos horas no coinciden, no me fio"; exit 1
fi
if [ "${hv#0}" -lt 1705 ] && [ "${FORZAR:-0}" != "1" ]; then
  echo "FALLO: mercado abierto (cierra 17:00). FORZAR=1 para saltear."; exit 1
fi

[ -f "$ART" ] || { echo "FALLO: no existe $ART"; exit 1; }
node --check "$ART" || { echo "FALLO: el artefacto no compila"; exit 1; }
md5l=$(md5sum "$ART" | cut -c1-32)

echo "== backup en el VPS =="
$SSH "cd ~/workers/niveles-auto && cp worker.js worker.js.bak-$TAG && echo ok" || exit 1
echo "== subo =="
$SCP "$ART" "$VPS:~/workers/niveles-auto/worker.js" || { echo "FALLO en scp"; exit 1; }
md5v=$($SSH 'md5sum ~/workers/niveles-auto/worker.js | cut -c1-32')
[ "$md5l" = "$md5v" ] || { echo "FALLO: md5 distinto ($md5l vs $md5v)"; exit 1; }
$SSH 'cd ~/workers/niveles-auto && node --check worker.js' || { echo "FALLO: no compila en el VPS, restauro"; $SSH "cd ~/workers/niveles-auto && cp worker.js.bak-$TAG worker.js"; exit 1; }
echo "== restart =="
$SSH 'pm2 restart niveles-auto --update-env >/dev/null && echo reiniciado' || exit 1
sleep 75
echo "== verificacion =="
out=$($SSH 'pm2 jlist | node -e "const a=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const p=a.find(p=>p.name===\"niveles-auto\");console.log(\"pm2:\",p.pm2_env.status)"; f=$(ls -t ~/.pm2/logs/niveles-auto-out-*.log | head -1); grep "MODO REAL ACTIVO" "$f" | tail -1 | sed -E "s/papeles [A-Z0-9, ]+ · /papeles (lista) · /"; e=$(ls -t ~/.pm2/logs/niveles-auto-error-*.log | head -1); echo "errores nuevos: $(find "$e" -mmin -2 | wc -l)"')
echo "$out"
if echo "$out" | grep -q "pm2: online" && echo "$out" | grep -q "MODO REAL ACTIVO"; then
  echo "OK: desplegado (md5 $md5l)"; exit 0
fi
echo "FALLO en la verificacion: restauro worker.js.bak-$TAG y reinicio"
$SSH "cd ~/workers/niveles-auto && cp worker.js.bak-$TAG worker.js && pm2 restart niveles-auto --update-env >/dev/null && sleep 20 && pm2 jlist | node -e 'const a=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));console.log(\"restaurado:\",a.find(p=>p.name===\"niveles-auto\").pm2_env.status)'"
exit 1
