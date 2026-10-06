$POST = "83e94a04-690e-4b55-aa15-8cd26402786d"

$cred    = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
$payload = Join-Path $PSScriptRoot "respuesta-mazda-4-payload.json"
$salida  = Join-Path $PSScriptRoot "respuesta-mazda-4-resultado.json"

if (-not (Test-Path $cred))    { Write-Host "FALTA credenciales: $cred"; exit 1 }
if (-not (Test-Path $payload)) { Write-Host "FALTA el payload: $payload"; exit 1 }

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
if (-not $k) { Write-Host "No pude leer la api_key"; exit 1 }

$body = [System.IO.File]::ReadAllBytes($payload)
Write-Host "Publicando la respuesta ($($body.Length) bytes)..."

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
    Write-Host "OK id=$($r.comment.id) parent=$($r.comment.parent_id) estado=$($r.comment.verification_status)"
    Write-Host "CODIGO: $($r.comment.verification.verification_code)"
    Write-Host "DESAFIO: $($r.comment.verification.challenge_text)"
    Write-Host "INSTRUCCIONES: $($r.comment.verification.instructions)"
    Write-Host "VENCE: $($r.comment.verification.expires_at)"
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content $salida -Encoding utf8
    Write-Host "ERROR: $msg"
}
