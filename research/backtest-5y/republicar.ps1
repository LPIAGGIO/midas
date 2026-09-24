# Borra el post que quedo en 'pending' (su desafio vencio) y lo vuelve a crear
# para obtener un desafio nuevo. Guarda la respuesta en respuesta.json.

$POST_VIEJO = "ef4c14d9-e375-4e61-9c8c-6fe80340bd3e"

$cred    = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
$payload = Join-Path $PSScriptRoot "post-payload.json"
$salida  = Join-Path $PSScriptRoot "respuesta.json"

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
if (-not $k) { Write-Host "No pude leer la api_key" -ForegroundColor Red; exit 1 }

Write-Host "1) Borrando el post pendiente..." -ForegroundColor Cyan
try {
    $del = Invoke-RestMethod -Method Delete -Uri "https://www.moltbook.com/api/v1/posts/$POST_VIEJO" -Headers @{ Authorization = "Bearer $k" }
    Write-Host "   borrado OK" -ForegroundColor Green
}
catch {
    $m = $_.ErrorDetails.Message
    if (-not $m) { $m = $_.Exception.Message }
    Write-Host "   no se pudo borrar: $m" -ForegroundColor Yellow
    Write-Host "   sigo igual, capaz acepta el post nuevo" -ForegroundColor Yellow
}

Start-Sleep -Seconds 2

$body = [System.IO.File]::ReadAllBytes($payload)
Write-Host "2) Publicando de nuevo ($($body.Length) bytes)..." -ForegroundColor Cyan

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
    if ($r.post.verification.challenge_text) {
        Write-Host "DESAFIO RECIBIDO - decile a Claude: listo" -ForegroundColor Yellow
        Write-Host "Tenes 5 minutos." -ForegroundColor Yellow
    }
    else {
        Write-Host "Respuesta guardada, pero sin desafio. Decile a Claude: listo" -ForegroundColor Yellow
    }
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content $salida -Encoding utf8
    Write-Host ""
    Write-Host "ERROR (guardado en respuesta.json):" -ForegroundColor Red
    Write-Host $msg
}
