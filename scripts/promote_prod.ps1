# Asosiy domenni eng yangi Production deployga ulang (lokal).
# Ishlatish:  powershell -File scripts/promote_prod.ps1
$ErrorActionPreference = "Stop"
$scope = "saids-projects-3b125b72"
$domain = "gps-vaksina-med.vercel.app"

Write-Host "Latest deploys..."
$lines = npx vercel ls gps-vaksina-med --scope $scope 2>&1 | Out-String
$url = ($lines -split "`n" | Where-Object { $_ -match "https://gps-vaksina-\S+\.vercel\.app" -and $_ -match "Ready" -and $_ -match "Production" } | Select-Object -First 1)
if (-not $url) { throw "Ready Production deploy topilmadi" }
$m = [regex]::Match($url, "https://gps-vaksina-\S+\.vercel\.app")
if (-not $m.Success) { throw "URL parse xato: $url" }
$dep = $m.Value
Write-Host "Alias $domain -> $dep"
npx vercel alias set $dep $domain --scope $scope
$h = Invoke-RestMethod -Uri "https://$domain/api/health"
Write-Host ($h | ConvertTo-Json -Compress)
