#!/usr/bin/env bash
# Guarda las credenciales de la API de Primary (Cocos/Matriz) para cocos-sync.
# Se corre de forma interactiva; la clave no se muestra ni queda en el historial.
# Los valores van en base64 para que ningun caracter ($, #, comillas) rompa el archivo.
set -u
read -r -p "Usuario de Matriz: " U
read -r -s -p "Clave de Matriz: " P; echo
[ -n "$U" ] && [ -n "$P" ] || { echo "Faltan datos, no guardo nada"; exit 1; }
umask 077
{
  printf 'COCOS_API_USER_B64=%s\n' "$(printf '%s' "$U" | base64 -w0)"
  printf 'COCOS_API_PASS_B64=%s\n' "$(printf '%s' "$P" | base64 -w0)"
} > "$HOME/workers/cocos-sync/.env"
unset U P
chmod 600 "$HOME/workers/cocos-sync/.env"
echo "guardado"
