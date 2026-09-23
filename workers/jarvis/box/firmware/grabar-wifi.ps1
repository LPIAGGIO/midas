# Graba las credenciales de WiFi DIRECTO en la memoria de la caja, por USB,
# sin pasar por el formulario web.
#
# Por que existe: el portal de configuracion de la caja fallaba con
# "Failed to connect to the Access Point" y queriamos descartar que el problema
# fuera como llega la clave al firmware. Esto elimina el navegador, el
# formulario y el WiFi del medio: la clave se escribe en la NVS y listo.
#
# La contrasenia se pide ACA, en la terminal. No viaja por ningun chat ni queda
# en el historial de comandos.
#
# Formato tomado de ssid_manager.cc del componente 78__esp-wifi-connect:
#   namespace "wifi", claves `ssid`, `password`, `channel` (indice 0).
# Particion NVS en 0x9000, 16 KB, segun partitions/v2/16m.csv.

$ErrorActionPreference = "Stop"

$PUERTO   = if ($args[0]) { $args[0] } else { "COM3" }
$SSID     = if ($args[1]) { $args[1] } else { "Maiten" }
$IDF      = "C:\esp-idf"
$PY       = "$env:USERPROFILE\.espressif\python_env\idf6.1_py3.12_env\Scripts\python.exe"
$GEN      = "$IDF\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py"
$TMP      = [System.IO.Path]::GetTempPath()
$CSV      = Join-Path $TMP "wifi_nvs.csv"
$BIN      = Join-Path $TMP "wifi_nvs.bin"

Write-Host "Caja en $PUERTO, red '$SSID'." -ForegroundColor Cyan
$sec = Read-Host "Contrasenia de $SSID" -AsSecureString
$pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

if ([string]::IsNullOrEmpty($pass)) { Write-Host "Sin contrasenia, cancelo." -ForegroundColor Red; exit 1 }
Write-Host "Largo de la clave: $($pass.Length) caracteres" -ForegroundColor DarkGray

# Las comillas dobles se escapan duplicandolas, que es como las toma el CSV.
$ssidCsv = '"' + $SSID.Replace('"','""') + '"'
$passCsv = '"' + $pass.Replace('"','""') + '"'

@"
key,type,encoding,value
wifi,namespace,,
ssid,data,string,$ssidCsv
password,data,string,$passCsv
channel,data,u8,0
"@ | Out-File -Encoding ascii -NoNewline $CSV

try {
    Write-Host "`nGenerando la particion NVS..." -ForegroundColor Cyan
    & $PY $GEN generate $CSV $BIN 0x4000
    if ($LASTEXITCODE -ne 0) { throw "fallo el generador de NVS" }

    Write-Host "`nGrabando en la caja (0x9000)..." -ForegroundColor Cyan
    & $PY -m esptool --chip esp32s3 -p $PUERTO --before default-reset --after hard-reset write-flash 0x9000 $BIN
    if ($LASTEXITCODE -ne 0) { throw "fallo el grabado" }

    Write-Host "`nListo. La caja se reinicio con la red ya cargada." -ForegroundColor Green
    Write-Host "Si funciono, NO deberia volver a levantar el WiFi 'Xiaozhi-8855'." -ForegroundColor Green
}
finally {
    # La clave queda en estos archivos: se borran si o si, aunque algo falle.
    Remove-Item $CSV, $BIN -Force -ErrorAction SilentlyContinue
    $pass = $null
    [GC]::Collect()
}
