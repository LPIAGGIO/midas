#!/usr/bin/env bash
# Guarda las credenciales de la API de Primary de la SEGUNDA cuenta de Cocos
# (otro usuario de Matriz, otra comitente). Se corre de forma interactiva; la
# clave no se muestra ni queda en el historial. Los valores van en base64 para
# que ningun caracter ($, #, comillas) rompa el archivo. Al terminar prueba el
# login y muestra que cuentas ve ese usuario (sin mostrar clave ni token).
set -u
D="$HOME/workers/cocos-cuenta2"
read -r -p "Usuario de Matriz (cuenta nueva): " U
read -r -s -p "Clave de Matriz (cuenta nueva): " P; echo
[ -n "$U" ] && [ -n "$P" ] || { echo "Faltan datos, no guardo nada"; exit 1; }
umask 077
{
  printf 'COCOS_API_USER_B64=%s\n' "$(printf '%s' "$U" | base64 -w0)"
  printf 'COCOS_API_PASS_B64=%s\n' "$(printf '%s' "$P" | base64 -w0)"
} > "$D/.env"
unset U P
chmod 600 "$D/.env"
echo "guardado. Pruebo el acceso..."
node "$D/verificar.js"
