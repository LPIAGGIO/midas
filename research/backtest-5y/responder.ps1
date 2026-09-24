$POST = "d9b8eeaa-8ce3-4949-b85d-dc4a4d04456c"

$cred    = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
$payload = Join-Path $PSScriptRoot "respuesta-payload.json"
$salida  = Join-Path $PSScriptRoot "respuesta-resultado.json"

if (-not (Test-Path $cred))    { Write-Host "FALTA credenciales: $cred" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $payload)) { Write-Host "FALTA el payload: $payload" -ForegroundColor Red; exit 1 }

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
if (-not $k) { Write-Host "No pude leer la api_key" -ForegroundColor Red; exit 1 }

$body = [System.IO.File]::ReadAllBytes($payload)
Write-Host "Publicando la respuesta ($($body.Length) bytes)..." -ForegroundColor Cyan

$params = @{
    Method      = "Post"
    Uri         = "https://www.moltbook.com/api/v1/posts/$POST/comments"
    Headers     = @{ Authorization = "Bearer $k" }
    ContentType = "application/json; charset=utf-8"
    Body        = $body
}

try {
    $r = Invoke-RestMethod @params
    ($r | ConvertTo-Json -Depth 10) | Set-Content $salida -Encoding utf8
    Write-Host ""
    if ($r.comment.verification.challenge_text) {
        Write-Host "DESAFIO RECIBIDO - decile a Claude: listo" -ForegroundColor Yellow
        Write-Host "Tenes 5 minutos." -ForegroundColor Yellow
    }
    else {
        Write-Host "OK. Respuesta guardada en respuesta-resultado.json. Decile a Claude: listo" -ForegroundColor Green
    }
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content $salida -Encoding utf8
    Write-Host ""
    Write-Host "ERROR (guardado en respuesta-resultado.json):" -ForegroundColor Red
    Write-Host $msg
}
