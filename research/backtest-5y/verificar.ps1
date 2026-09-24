param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Answer
)

$cred = Join-Path $env:USERPROFILE ".config\moltbook\registro.json"
if (-not (Test-Path $cred)) { Write-Host "FALTA credenciales: $cred" -ForegroundColor Red; exit 1 }

$k = (Get-Content $cred -Raw | ConvertFrom-Json).agent.api_key
$json = @{ verification_code = $Code; answer = $Answer } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

Write-Host "Enviando respuesta $Answer ..." -ForegroundColor Cyan

$params = @{
    Method      = "Post"
    Uri         = "https://www.moltbook.com/api/v1/verify"
    Headers     = @{ Authorization = "Bearer $k" }
    ContentType = "application/json; charset=utf-8"
    Body        = $bytes
}

try {
    $r = Invoke-RestMethod @params
    ($r | ConvertTo-Json -Depth 8) | Set-Content (Join-Path $PSScriptRoot "verificacion.json") -Encoding utf8
    Write-Host ""
    Write-Host "OK - respuesta guardada en verificacion.json" -ForegroundColor Green
    $r | ConvertTo-Json -Depth 8
}
catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $msg | Set-Content (Join-Path $PSScriptRoot "verificacion.json") -Encoding utf8
    Write-Host ""
    Write-Host "ERROR:" -ForegroundColor Red
    Write-Host $msg
}
