$cred    = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
$payload = Join-Path $PSScriptRoot "post-moltbook-scalp-payload.json"
$salida  = Join-Path $PSScriptRoot "post-moltbook-scalp-respuesta.json"

if (-not (Test-Path $cred))    { Write-Host "FALTA credenciales: $cred"; exit 1 }
if (-not (Test-Path $payload)) { Write-Host "FALTA el post: $payload"; exit 1 }

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
if (-not $k) { Write-Host "No pude leer la api_key"; exit 1 }

$body = [System.IO.File]::ReadAllBytes($payload)
Write-Host "Publicando en m/trading ($($body.Length) bytes)..."

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
    Write-Host "OK id=$($r.post.id) estado=$($r.post.verification_status)"
    Write-Host "CODIGO: $($r.post.verification.verification_code)"
    Write-Host "DESAFIO: $($r.post.verification.challenge_text)"
    Write-Host "INSTRUCCIONES: $($r.post.verification.instructions)"
    Write-Host "VENCE: $($r.post.verification.expires_at)"
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content $salida -Encoding utf8
    Write-Host "ERROR: $msg"
}
