#!/usr/bin/env bash
# Deja la configuración del martes 13/10/2026 (decisiones de LP del 09/10) en el
# VPS. Solo toca .env y crea carpetas: los bots que corren no cambian hasta que
# se reinicien (leen el .env al arrancar). Corre: bash configurar-martes.sh
#
#  72404: escalón 2x   · compra desde las 12 salvo apertura 1% abajo (regla G) · no vende lo verde
#  3893:  escalón 2,5x · regla G                                               · vende lo verde 16:45
#  Papeles nuevos en las dos: JNJ (lote 36) y NU (lote 81), ~$1M por escalón.
set -eu
W="$HOME/workers"
BK=".env.bak-9oct"
# paso/ganancia BASE (los de la 72404 hasta hoy) por papel
base() { case "$1" in sndk) echo "0.015 0.01";; googl|aapl|msft|amzn|jnj) echo "0.007 0.005";; *) echo "0.01 0.007";; esac; }
mul() { awk -v a="$1" -v m="$2" 'BEGIN{printf "%.4g", a*m}'; }
setvar() { # archivo clave valor
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" >> "$1"; fi
}
configurar() { # dir cuenta papel
  local d="$1" cta="$2" p="$3" m paso gan
  [ "$cta" = 72404 ] && m=2 || m=2.5
  read -r paso gan <<< "$(base "$p")"
  cp -n "$d/.env" "$d/$BK" 2>/dev/null || true
  setvar "$d/.env" SCALP_PASO "$(mul "$paso" "$m")"
  setvar "$d/.env" SCALP_GANANCIA "$(mul "$gan" "$m")"
  setvar "$d/.env" SCALP_HORA_INICIO 1031
  setvar "$d/.env" SCALP_HORA_COMPRAS 1200
  setvar "$d/.env" SCALP_APERTURA_BAJA 0.01
  if [ "$cta" = 3893 ]; then setvar "$d/.env" SCALP_CIERRE_VERDE 1645; else sed -i '/^SCALP_CIERRE_VERDE=/d' "$d/.env"; fi
  sed -i '/^SCALP_PASO_PREVIO=/d;/^SCALP_GANANCIA_PREVIA=/d' "$d/.env"   # el paso del ciclo abierto ya vive en estado.json
}
nuevo() { # cuenta papel lote max
  local cta="$1" p="$2" lote="$3" max="$4" pre d plantilla
  [ "$cta" = 72404 ] && pre="cocos-scalp" || pre="cocos2-scalp"
  d="$W/$pre-$p"; plantilla="$W/$pre-aapl"
  if [ ! -d "$d" ]; then
    mkdir -p "$d/logs"
    ln -s "$W/cocos-scalp/worker.js" "$d/worker.js"
    sed "s/SCALP_TICKER=.*/SCALP_TICKER=$(echo "$p" | tr a-z A-Z)/;s/SCALP_LOTE=.*/SCALP_LOTE=$lote/;s/SCALP_MAX=.*/SCALP_MAX=$max/" "$plantilla/.env" > "$d/.env"
    sed "s/$pre-aapl/$pre-$p/g" "$plantilla/ecosystem.config.js" > "$d/ecosystem.config.js"
    echo "creada $d"
  fi
  configurar "$d" "$cta" "$p"
}
for p in mu sndk nvda googl amd intc meta aapl msft amzn; do
  if [ "$p" = mu ]; then configurar "$W/cocos-scalp" 72404 mu; else configurar "$W/cocos-scalp-$p" 72404 "$p"; fi
  configurar "$W/cocos2-scalp-$p" 3893 "$p"
done
nuevo 72404 jnj 36 180;  nuevo 3893 jnj 36 180
nuevo 72404 nu 81 405;   nuevo 3893 nu 81 405
# encendido de la 3893: sumar los papeles nuevos a la lista por defecto
sed -i 's/^PAPELES="\${\*:-mu sndk nvda googl amd intc meta aapl msft amzn}"/PAPELES="${*:-mu sndk nvda googl amd intc meta aapl msft amzn jnj nu}"/' "$W/cocos-cuenta2/encender-scalps.sh"
echo "== resumen"
for d in "$W"/cocos-scalp "$W"/cocos-scalp-* "$W"/cocos2-scalp-*; do
  [ -f "$d/.env" ] || continue
  printf '%-22s %s\n' "$(basename "$d")" "$(grep -E '^SCALP_(TICKER|LOTE|MAX|PASO|GANANCIA|HORA_COMPRAS|APERTURA_BAJA|CIERRE_VERDE)=' "$d/.env" | sed 's/SCALP_//' | tr '\n' ' ')"
done
