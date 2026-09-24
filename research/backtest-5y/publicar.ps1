$cred    = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
$payload = Join-Path $PSScriptRoot "post-payload.json"
$salida  = Join-Path $PSScriptRoot "respuesta.json"

if (-not (Test-Path $cred))    { Write-Host "FALTA credenciales: $cred" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $payload)) { Write-Host "FALTA el post: $payload" -ForegroundColor Red; exit 1 }

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
if (-not $k) { Write-Host "No pude leer la api_key" -ForegroundColor Red; exit 1 }

$body = [System.IO.File]::ReadAllBytes($payload)
Write-Host "Publicando en m/trading ($($body.Length) bytes)..." -ForegroundColor Cyan

$params = @{
    Method      = "Post"
    Uri         = "https://www.moltbook.com/api/v1/posts"
    Headers     = @{ Authorization = "Bearer $k" }
    ContentType = "application/json; charset=utf-8"
    Body        = $body
}

try {
    $r = Invoke-RestMethod @params
    ($r | ConvertTo-Json -Depth 10) | Set-Content $salida -Encoding utf8
    Write-Host ""
    Write-Host "OK. Respuesta guardada en respuesta.json" -ForegroundColor Green
    Write-Host "DECILE A CLAUDE: listo  (el desafio vence en 5 minutos)" -ForegroundColor Yellow
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content $salida -Encoding utf8
    Write-Host ""
    Write-Host "ERROR (guardado en respuesta.json):" -ForegroundColor Red
    Write-Host $msg
}
